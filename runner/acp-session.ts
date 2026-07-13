import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import * as acp from "@agentclientprotocol/sdk"

import {
  type JsonValue,
  MAX_ACP_LINE_BYTES,
  MAX_SESSION_UPDATE_BYTES,
  MAX_STDERR_CHUNK_BYTES,
  type RunnerEvent,
  type RunnerPermissionPolicy,
  type RunnerSpec,
  type RunnerTerminalPayload,
} from "./protocol"

const CLIENT_NAME = "meanwhile-runner"
const CLIENT_VERSION = "1"
const CANCEL_GRACE_MS = 750
const TERMINATE_GRACE_MS = 1_500
const COMPLETED_PROCESS_EXIT_GRACE_MS = 100
const REDACTED = "[REDACTED]"
const MAX_SDK_DIAGNOSTICS = 32

type RunnerErrorCode = NonNullable<RunnerTerminalPayload["error"]>["code"]

export class RunnerSessionError extends Error {
  constructor(
    readonly code: RunnerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "RunnerSessionError"
  }
}

export class RunnerAbort extends Error {
  constructor(readonly outcome: "cancelled" | "timed_out") {
    super(outcome === "timed_out" ? "Runner deadline reached" : "Runner cancelled")
    this.name = "RunnerAbort"
  }
}

export interface RunnerEventTarget {
  emit(event: RunnerEvent): Promise<void>
}

export interface RunAcpSessionOptions {
  signal: AbortSignal
  events: RunnerEventTarget
  environment?: Readonly<Record<string, string | undefined>>
  cancelGraceMs?: number
  terminateGraceMs?: number
}

interface AgentProcess {
  readonly pid: number
  readonly stdin: Bun.FileSink
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  readonly exitCode: number | null
  readonly signalCode: string | number | null
  readonly killed: boolean
  kill(signal?: number | NodeJS.Signals): void
}

interface AgentExit {
  exitCode: number | null
  signal: string | null
}

interface ActiveAcpSession {
  readonly context: acp.ClientContext | undefined
  readonly sessionId: string | undefined
  readonly supportsClose: boolean
}

class AgentTeardown {
  private completion: Promise<void> | undefined

  constructor(
    private readonly child: AgentProcess,
    private readonly activeSession: () => ActiveAcpSession,
    private readonly stderrPump: Promise<void>,
    private readonly cancelGraceMs: number,
    private readonly terminateGraceMs: number,
  ) {}

  run(cancelPrompt: boolean): Promise<void> {
    this.completion ??= this.execute(cancelPrompt)
    return this.completion
  }

  private async execute(cancelPrompt: boolean): Promise<void> {
    let exited = false
    if (cancelPrompt) {
      const { context, sessionId, supportsClose } = this.activeSession()
      if (context && sessionId) {
        await context.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {})
      }
      if (context && sessionId && supportsClose) {
        await closeAcpSession(context, sessionId, this.cancelGraceMs)
      }
    }
    // The ACP turn is now finished or its bounded cancellation handshake has
    // completed. Closing the transport is the graceful process-exit signal;
    // TERM/KILL remain bounded fallbacks for a non-cooperative agent.
    try {
      await this.child.stdin.end()
    } catch {
      // The process may already have closed its side of the transport.
    }
    exited = await waitForExit(this.child, cancelPrompt ? this.cancelGraceMs : 0)
    if (!exited) {
      signalAgentProcess(this.child, "SIGTERM")
      exited = await waitForExit(
        this.child,
        cancelPrompt ? this.terminateGraceMs : COMPLETED_PROCESS_EXIT_GRACE_MS,
      )
    }
    if (!exited) {
      signalAgentProcess(this.child, "SIGKILL")
      await this.child.exited.catch(() => {})
    }

    await this.stderrPump.catch(() => {})
  }
}

class ExactValueRedactor {
  readonly values: string[]
  readonly longestValueLength: number

  constructor(values: Iterable<string | undefined>) {
    this.values = [...new Set(values)]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .sort((left, right) => right.length - left.length)
    this.longestValueLength = this.values[0]?.length ?? 0
  }

  text(value: string): string {
    let redacted = value
    for (const secret of this.values) {
      redacted = redacted.replaceAll(secret, REDACTED)
    }
    return redacted
  }

  json(value: unknown, depth = 0): JsonValue {
    if (depth > 32) {
      return "[DEPTH_LIMIT]"
    }
    if (value === null || typeof value === "boolean") {
      return value
    }
    if (typeof value === "string") {
      return this.text(value)
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : String(value)
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.json(item, depth + 1))
    }
    if (typeof value === "object") {
      const result: Record<string, JsonValue> = {}
      for (const [key, item] of Object.entries(value)) {
        if (item !== undefined) {
          result[this.text(key)] = this.json(item, depth + 1)
        }
      }
      return result
    }
    return String(value)
  }
}

class StreamingExactValueRedactor {
  private buffered = ""

  constructor(private readonly redactor: ExactValueRedactor) {}

  push(chunk: string, final = false): string {
    this.buffered += chunk
    if (this.redactor.values.length === 0) {
      const output = this.buffered
      this.buffered = ""
      return output
    }

    const safeStartLimit = final
      ? this.buffered.length
      : Math.max(0, this.buffered.length - this.redactor.longestValueLength + 1)
    let output = ""
    let index = 0

    while (index < safeStartLimit) {
      const match = this.redactor.values.find((secret) => this.buffered.startsWith(secret, index))
      if (match) {
        output += REDACTED
        index += match.length
      } else {
        output += this.buffered[index]
        index += 1
      }
    }

    this.buffered = this.buffered.slice(index)
    return output
  }
}

class SdkConsoleBoundary {
  private readonly original = {
    debug: console.debug,
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  }
  private pending = Promise.resolve()
  private diagnosticCount = 0

  constructor(private readonly events: RunnerEventTarget) {}

  install(): void {
    console.debug = () => this.capture("info")
    console.info = () => this.capture("info")
    console.log = () => this.capture("info")
    console.warn = () => this.capture("warning")
    console.error = () => this.capture("error")
  }

  restore(): void {
    Object.assign(console, this.original)
  }

  async drain(): Promise<void> {
    await this.pending
  }

  private capture(severity: "info" | "warning" | "error"): void {
    const count = this.diagnosticCount++
    if (count > MAX_SDK_DIAGNOSTICS) {
      return
    }
    const code =
      count === MAX_SDK_DIAGNOSTICS ? "ACP_SDK_DIAGNOSTICS_SUPPRESSED" : "ACP_SDK_DIAGNOSTIC"
    this.pending = this.pending
      .then(() => this.events.emit({ type: "runner.diagnostic", payload: { code, severity } }))
      .catch(() => {})
  }
}

export async function runAcpSession(
  spec: RunnerSpec,
  options: RunAcpSessionOptions,
): Promise<RunnerTerminalPayload> {
  const ambientEnvironment = options.environment ?? Bun.env
  const redactor = new ExactValueRedactor(
    spec.secretEnvironmentNames.map((name) => ambientEnvironment[name]),
  )

  if (options.signal.aborted) {
    return abortTerminal(options.signal.reason)
  }

  let workingDirectory: string
  try {
    workingDirectory = await resolveAgentWorkingDirectory(spec)
  } catch (error) {
    return failureTerminal(normalizeError(error, "WORKSPACE_INVALID"))
  }

  let child: AgentProcess
  try {
    child = spawnAgent(spec, ambientEnvironment, workingDirectory)
  } catch (error) {
    const sessionError = normalizeError(error, "AGENT_SPAWN_FAILED")
    return failureTerminal(sessionError)
  }

  const stderrPump = forwardStderr(child.stderr, redactor, options.events)
  let activeAgentContext: acp.ClientContext | undefined
  let activeSessionId: string | undefined
  let activeSessionSupportsClose = false
  let promptCompleted = false
  const teardown = new AgentTeardown(
    child,
    () => ({
      context: activeAgentContext,
      sessionId: activeSessionId,
      supportsClose: activeSessionSupportsClose,
    }),
    stderrPump,
    options.cancelGraceMs ?? CANCEL_GRACE_MS,
    options.terminateGraceMs ?? TERMINATE_GRACE_MS,
  )
  const requestTeardown = () => void teardown.run(true)
  options.signal.addEventListener("abort", requestTeardown, { once: true })
  const sdkConsole = new SdkConsoleBoundary(options.events)
  sdkConsole.install()

  try {
    const client = acp
      .client({ name: CLIENT_NAME })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        const resolution = resolvePermission(spec.permissionPolicy, params)
        await options.events.emit({
          type: "permission.resolved",
          payload: {
            toolCallId: params.toolCall.toolCallId,
            ...(params.toolCall.kind ? { toolKind: params.toolCall.kind } : {}),
            decision: resolution.decision,
            ...(resolution.optionKind ? { selectedOptionKind: resolution.optionKind } : {}),
          },
        })
        return resolution.response
      })

    const stream = acp.ndJsonStream(
      fileSinkWritable(child.stdin),
      boundedAcpInput(child.stdout, MAX_ACP_LINE_BYTES),
    )

    const terminal = await client.connectWith(stream, async (agent) => {
      activeAgentContext = agent
      let initialized: acp.InitializeResponse
      try {
        initialized = await agent.request(
          acp.methods.agent.initialize,
          {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: {
              name: CLIENT_NAME,
              title: "Meanwhile Runner",
              version: CLIENT_VERSION,
            },
          },
          { cancellationSignal: options.signal },
        )
      } catch (error) {
        throw normalizeError(error, "ACP_CONNECTION_FAILED")
      }

      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new RunnerSessionError(
          "ACP_PROTOCOL_UNSUPPORTED",
          "Agent selected an unsupported ACP protocol version",
        )
      }
      activeSessionSupportsClose = initialized.agentCapabilities?.sessionCapabilities?.close != null

      await options.events.emit({
        type: "agent.initialized",
        payload: {
          protocolVersion: initialized.protocolVersion,
          ...(initialized.agentInfo
            ? {
                agentInfo: {
                  name: redactor.text(initialized.agentInfo.name),
                  ...(initialized.agentInfo.title
                    ? { title: redactor.text(initialized.agentInfo.title) }
                    : {}),
                  version: redactor.text(initialized.agentInfo.version),
                },
              }
            : {}),
          capabilities: summarizeCapabilities(initialized.agentCapabilities),
        },
      })

      let session: acp.ActiveSession
      try {
        session = await agent
          .buildSession({ cwd: workingDirectory, mcpServers: [] })
          .start({ cancellationSignal: options.signal })
      } catch (error) {
        throw normalizeError(error, "ACP_SESSION_FAILED")
      }

      activeSessionId = session.sessionId
      try {
        await options.events.emit({
          type: "session.started",
          payload: {
            sessionId: redactor.text(session.sessionId),
            ...(session.modes?.currentModeId
              ? { modeId: redactor.text(session.modes.currentModeId) }
              : {}),
          },
        })

        void session.prompt(spec.prompt, { cancellationSignal: options.signal })
        for (;;) {
          const message = await session.nextUpdate()
          if (message.kind === "stop") {
            promptCompleted = true
            if (activeSessionSupportsClose) {
              await closeAcpSession(
                agent,
                session.sessionId,
                options.cancelGraceMs ?? CANCEL_GRACE_MS,
              )
            }
            if (options.signal.aborted) {
              return abortTerminal(options.signal.reason)
            }
            return terminalForStopReason(message.stopReason)
          }

          const bounded = boundedSessionUpdate(redactor.json(message.update))
          await options.events.emit({
            type: "session.update",
            payload: {
              sessionId: redactor.text(message.notification.sessionId),
              update: bounded.update,
              truncated: bounded.truncated,
              ...(bounded.originalBytes ? { originalBytes: bounded.originalBytes } : {}),
            },
          })
        }
      } catch (error) {
        if (!options.signal.aborted && activeSessionSupportsClose) {
          await closeAcpSession(agent, session.sessionId, options.cancelGraceMs ?? CANCEL_GRACE_MS)
        }
        throw error
      } finally {
        session.dispose()
      }
    })

    return terminal
  } catch (error) {
    if (options.signal.aborted) {
      return abortTerminal(options.signal.reason)
    }

    const exit = childExit(child)
    if (!promptCompleted && (child.exitCode !== null || child.signalCode !== null)) {
      return {
        outcome: "failed",
        error: {
          code: "AGENT_EXITED",
          message: "The ACP agent exited before the prompt completed",
        },
        agentExit: exit,
      }
    }

    return failureTerminal(normalizeError(error, "ACP_SESSION_FAILED"))
  } finally {
    options.signal.removeEventListener("abort", requestTeardown)
    await teardown.run(!promptCompleted)
    sdkConsole.restore()
    await sdkConsole.drain()
  }
}

function spawnAgent(
  spec: RunnerSpec,
  ambient: Readonly<Record<string, string | undefined>>,
  workingDirectory: string,
): AgentProcess {
  const environment = buildAgentEnvironment(spec, ambient)
  return Bun.spawn({
    cmd: [spec.agent.executable, ...spec.agent.args],
    cwd: workingDirectory,
    env: environment,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as AgentProcess
}

function buildAgentEnvironment(
  spec: RunnerSpec,
  ambient: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) {
    const value = ambient[name]
    if (value !== undefined) {
      environment[name] = value
    }
  }

  Object.assign(environment, spec.environment)
  environment["TZ"] = "UTC"
  for (const name of spec.secretEnvironmentNames) {
    const value = ambient[name]
    if (value === undefined) {
      throw new RunnerSessionError(
        "MISSING_SECRET_ENVIRONMENT",
        `Required secret environment variable is unavailable: ${name}`,
      )
    }
    environment[name] = value
  }
  return environment
}

async function resolveAgentWorkingDirectory(spec: RunnerSpec): Promise<string> {
  const workspaceRoot = await realpath(process.cwd())
  const requested = resolve(workspaceRoot, spec.agent.workingDirectory ?? ".")
  const workingDirectory = await realpath(requested)
  const relation = relative(workspaceRoot, workingDirectory)
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new RunnerSessionError(
      "WORKSPACE_INVALID",
      "The agent working directory escapes the provider workspace",
    )
  }
  return workingDirectory
}

function fileSinkWritable(sink: Bun.FileSink): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      sink.write(chunk)
      await sink.flush()
    },
    async close() {
      await sink.end()
    },
    async abort() {
      await sink.end()
    },
  })
}

function boundedAcpInput(
  input: ReadableStream<Uint8Array>,
  maximumLineBytes: number,
): ReadableStream<Uint8Array> {
  let pendingLineBytes = 0
  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        let start = 0
        for (;;) {
          const newline = chunk.indexOf(0x0a, start)
          const end = newline < 0 ? chunk.byteLength : newline
          const segmentBytes = end - start
          if (pendingLineBytes + segmentBytes > maximumLineBytes) {
            throw new RunnerSessionError(
              "ACP_OUTPUT_LIMIT_EXCEEDED",
              "The ACP agent emitted a message larger than the allowed limit",
            )
          }

          if (newline < 0) {
            pendingLineBytes += segmentBytes
            if (segmentBytes > 0) {
              controller.enqueue(chunk.subarray(start))
            }
            return
          }

          controller.enqueue(chunk.subarray(start, newline + 1))
          pendingLineBytes = 0
          start = newline + 1
          if (start === chunk.byteLength) {
            return
          }
        }
      },
    }),
  )
}

function resolvePermission(
  policy: RunnerPermissionPolicy,
  request: acp.RequestPermissionRequest,
): {
  response: acp.RequestPermissionResponse
  decision: "allowed" | "denied"
  optionKind?: "allow_once" | "reject_once" | "reject_always"
} {
  const mayAllow =
    policy.mode === "allow-once" &&
    request.toolCall.kind !== undefined &&
    request.toolCall.kind !== null &&
    policy.toolKinds.includes(request.toolCall.kind)

  if (mayAllow) {
    const option = request.options.find((candidate) => candidate.kind === "allow_once")
    if (option) {
      return {
        response: {
          outcome: { outcome: "selected", optionId: option.optionId },
        },
        decision: "allowed",
        optionKind: "allow_once",
      }
    }
  }

  const rejection =
    request.options.find((candidate) => candidate.kind === "reject_once") ??
    request.options.find((candidate) => candidate.kind === "reject_always")
  if (rejection) {
    const optionKind = rejection.kind === "reject_always" ? "reject_always" : "reject_once"
    return {
      response: {
        outcome: { outcome: "selected", optionId: rejection.optionId },
      },
      decision: "denied",
      optionKind,
    }
  }

  return {
    response: { outcome: { outcome: "cancelled" } },
    decision: "denied",
  }
}

function summarizeCapabilities(capabilities: acp.AgentCapabilities | undefined): {
  loadSession: boolean
  session: { close: boolean }
  prompt: { image: boolean; audio: boolean; embeddedContext: boolean }
  mcp: { http: boolean; sse: boolean }
} {
  return {
    loadSession: capabilities?.loadSession === true,
    session: {
      close: capabilities?.sessionCapabilities?.close != null,
    },
    prompt: {
      image: capabilities?.promptCapabilities?.image === true,
      audio: capabilities?.promptCapabilities?.audio === true,
      embeddedContext: capabilities?.promptCapabilities?.embeddedContext === true,
    },
    mcp: {
      http: capabilities?.mcpCapabilities?.http === true,
      sse: capabilities?.mcpCapabilities?.sse === true,
    },
  }
}

function boundedSessionUpdate(value: JsonValue): {
  update: Record<string, JsonValue>
  truncated: boolean
  originalBytes?: number
} {
  const update = isJsonObject(value) ? value : { value }
  const originalBytes = jsonBytes(update)
  if (originalBytes <= MAX_SESSION_UPDATE_BYTES) {
    return { update, truncated: false }
  }

  const limited = limitJson(update, 0)
  if (isJsonObject(limited) && jsonBytes(limited) <= MAX_SESSION_UPDATE_BYTES) {
    return { update: limited, truncated: true, originalBytes }
  }

  const sessionUpdateKey = "sessionUpdate"
  const sessionUpdate =
    typeof update[sessionUpdateKey] === "string"
      ? truncateUtf8(update[sessionUpdateKey], 256)
      : "unknown"
  return {
    update: { sessionUpdate, omitted: true },
    truncated: true,
    originalBytes,
  }
}

function limitJson(value: JsonValue, depth: number): JsonValue {
  if (typeof value === "string") {
    return truncateUtf8(value, 4_096)
  }
  if (value === null || typeof value !== "object") {
    return value
  }
  if (depth >= 12) {
    return "[DEPTH_LIMIT]"
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 64).map((item) => limitJson(item, depth + 1))
    if (value.length > items.length) {
      items.push(`[${value.length - items.length} ITEMS OMITTED]`)
    }
    return items
  }

  const result: Record<string, JsonValue> = {}
  const entries = Object.entries(value)
  for (const [key, item] of entries.slice(0, 64)) {
    result[truncateUtf8(key, 256)] = limitJson(item, depth + 1)
  }
  if (entries.length > 64) {
    const omittedFieldsKey = "omittedFields"
    result[omittedFieldsKey] = entries.length - 64
  }
  return result
}

async function forwardStderr(
  stream: ReadableStream<Uint8Array>,
  redactor: ExactValueRedactor,
  events: RunnerEventTarget,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const streamingRedactor = new StreamingExactValueRedactor(redactor)
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      if (value) {
        const safe = streamingRedactor.push(decoder.decode(value, { stream: true }))
        await emitStderrChunks(safe, events)
      }
    }
    const tail = streamingRedactor.push(decoder.decode(), true)
    await emitStderrChunks(tail, events)
  } finally {
    reader.releaseLock()
  }
}

async function emitStderrChunks(text: string, events: RunnerEventTarget): Promise<void> {
  const chunks = splitUtf8(text, MAX_STDERR_CHUNK_BYTES)
  for (const chunk of chunks) {
    await events.emit({
      type: "agent.stderr",
      payload: { chunk, truncated: chunks.length > 1 },
    })
  }
}

async function closeAcpSession(
  context: acp.ClientContext,
  sessionId: string,
  graceMs: number,
): Promise<void> {
  await Promise.race([
    context.request(acp.methods.agent.session.close, { sessionId }).then(
      () => undefined,
      () => undefined,
    ),
    delay(graceMs),
  ])
}

async function waitForExit(child: AgentProcess, graceMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await child.exited.catch(() => {})
    return true
  }

  return Promise.race([
    child.exited.then(
      () => true,
      () => true,
    ),
    delay(graceMs).then(() => false),
  ])
}

function signalAgentProcess(child: AgentProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal)
      } catch {
        // Idempotent teardown: the process has already disappeared.
      }
    }
  }
}

function abortTerminal(reason: unknown): RunnerTerminalPayload {
  const outcome = reason instanceof RunnerAbort ? reason.outcome : "cancelled"
  return { outcome, stopReason: "cancelled" }
}

function terminalForStopReason(stopReason: acp.StopReason): RunnerTerminalPayload {
  switch (stopReason) {
    case "end_turn":
      return { outcome: "succeeded", stopReason }
    case "max_tokens":
      return failureTerminal(
        new RunnerSessionError("ACP_MAX_TOKENS", safeMessageFor("ACP_MAX_TOKENS")),
        stopReason,
      )
    case "max_turn_requests":
      return failureTerminal(
        new RunnerSessionError("ACP_MAX_TURN_REQUESTS", safeMessageFor("ACP_MAX_TURN_REQUESTS")),
        stopReason,
      )
    case "refusal":
      return failureTerminal(
        new RunnerSessionError("ACP_REFUSAL", safeMessageFor("ACP_REFUSAL")),
        stopReason,
      )
    case "cancelled":
      return { outcome: "cancelled", stopReason }
  }
}

function failureTerminal(
  error: RunnerSessionError,
  stopReason?: Extract<acp.StopReason, "max_tokens" | "max_turn_requests" | "refusal">,
): RunnerTerminalPayload {
  return {
    outcome: "failed",
    ...(stopReason ? { stopReason } : {}),
    error: { code: error.code, message: error.message },
  }
}

function normalizeError(error: unknown, fallbackCode: RunnerErrorCode): RunnerSessionError {
  if (error instanceof RunnerSessionError) {
    return error
  }
  return new RunnerSessionError(fallbackCode, safeMessageFor(fallbackCode), {
    cause: error,
  })
}

function safeMessageFor(code: RunnerErrorCode): string {
  switch (code) {
    case "AGENT_SPAWN_FAILED":
      return "The configured ACP agent could not be started"
    case "ACP_MAX_TOKENS":
      return "The ACP agent reached its token limit before completing the turn"
    case "ACP_MAX_TURN_REQUESTS":
      return "The ACP agent reached its turn-request limit before completing the turn"
    case "ACP_REFUSAL":
      return "The ACP agent refused to continue the turn"
    case "ACP_OUTPUT_LIMIT_EXCEEDED":
      return "The ACP agent emitted a message larger than the allowed limit"
    case "ACP_CONNECTION_FAILED":
      return "The ACP agent did not complete protocol initialization"
    case "ACP_PROTOCOL_UNSUPPORTED":
      return "The ACP agent selected an unsupported protocol version"
    case "ACP_SESSION_FAILED":
      return "The ACP session failed before producing a terminal result"
    case "AGENT_EXITED":
      return "The ACP agent exited before the prompt completed"
    case "MISSING_SECRET_ENVIRONMENT":
      return "A required secret environment variable is unavailable"
    case "WORKSPACE_INVALID":
      return "The provider workspace or agent working directory is invalid"
    case "RUNNER_INTERNAL_ERROR":
      return "The runner failed internally"
  }
}

function childExit(child: AgentProcess): AgentExit {
  return {
    exitCode: child.exitCode,
    signal: child.signalCode === null ? null : String(child.signalCode),
  }
}

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function jsonBytes(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength <= maxBytes) {
    return value
  }
  const suffix = "…"
  const suffixBytes = new TextEncoder().encode(suffix).byteLength
  return `${new TextDecoder().decode(encoded.slice(0, maxBytes - suffixBytes))}${suffix}`
}

function splitUtf8(value: string, maxBytes: number): string[] {
  if (value.length === 0) {
    return []
  }
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= maxBytes) {
    return [value]
  }

  const decoder = new TextDecoder()
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += maxBytes) {
    chunks.push(
      decoder.decode(bytes.slice(offset, offset + maxBytes), {
        stream: offset + maxBytes < bytes.byteLength,
      }),
    )
  }
  chunks.push(decoder.decode())
  return chunks.filter((chunk) => chunk.length > 0)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)))
}
