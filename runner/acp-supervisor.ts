import { opendir, unlink } from "node:fs/promises"
import * as acp from "@agentclientprotocol/sdk"
import {
  boundedAcpInput,
  boundedSessionUpdate,
  closeAcpSession,
  ExactValueRedactor,
  fileSinkWritable,
  resolveAgentWorkingDirectory,
  resolvePermission,
  spawnAgent,
  summarizeCapabilities,
} from "./acp-session"
import {
  MAX_ACP_LINE_BYTES,
  MAX_STDERR_CHUNK_BYTES,
  type RunnerTerminalPayload,
  type SessionRunnerCommand,
  type SessionRunnerEvent,
  type SessionRunnerSpec,
  sessionRunnerCommandSchema,
} from "./protocol"

const CLIENT_NAME = "meanwhile-runner"
const CLIENT_VERSION = "1"
const MAILBOX_POLL_MS = 50
const CLOSE_GRACE_MS = 750

export interface SessionEventTarget {
  emit(event: SessionRunnerEvent): Promise<void>
}

export async function runAcpSupervisor(
  spec: SessionRunnerSpec,
  events: SessionEventTarget,
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): Promise<void> {
  const mailboxPath = environment["MEANWHILE_PROCESS_INBOX"]
  if (!mailboxPath) throw new Error("Session runner mailbox is unavailable")
  const mailbox = new CommandMailbox(mailboxPath)
  const redactor = new ExactValueRedactor(
    spec.credentialEnvironmentNames.map((name) => environment[name]),
  )
  const workingDirectory = await resolveAgentWorkingDirectory()
  const child = spawnAgent(spec, environment, workingDirectory)
  const stderr = forwardStderr(child.stderr, redactor, events)
  let activeTurnId: string | null = null
  let closeReason: "requested" | "idle_timeout" | "agent_exit" | "failed" = "failed"

  const client = acp
    .client({ name: CLIENT_NAME })
    .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
      const resolution = resolvePermission(spec.permissionPolicy, params)
      if (activeTurnId !== null) {
        await events.emit({
          type: "turn.permission",
          payload: {
            turnId: activeTurnId,
            toolCallId: redactor.text(params.toolCall.toolCallId),
            ...(params.toolCall.kind ? { toolKind: params.toolCall.kind } : {}),
            decision: resolution.decision,
            ...(resolution.optionKind ? { selectedOptionKind: resolution.optionKind } : {}),
          },
        })
      }
      return resolution.response
    })

  try {
    const stream = acp.ndJsonStream(
      fileSinkWritable(child.stdin),
      boundedAcpInput(child.stdout, MAX_ACP_LINE_BYTES),
    )
    await client.connectWith(stream, async (agent) => {
      const initialized = await agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: {
          name: CLIENT_NAME,
          title: "Meanwhile Runner",
          version: CLIENT_VERSION,
        },
      })
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error("Agent selected an unsupported ACP protocol version")
      }
      const session = await agent.buildSession({ cwd: workingDirectory, mcpServers: [] }).start()
      try {
        await events.emit({
          type: "session.ready",
          payload: {
            agentSessionId: redactor.text(session.sessionId),
            capabilities: summarizeCapabilities(initialized.agentCapabilities),
          },
        })

        for (;;) {
          const command = await mailbox.next(spec.idleTimeoutMs)
          if (command === null) {
            closeReason = "idle_timeout"
            break
          }
          if (command.type === "session.close") {
            closeReason = "requested"
            break
          }
          if (command.type === "turn.interrupt") continue

          activeTurnId = command.turnId
          await events.emit({ type: "turn.started", payload: { turnId: command.turnId } })
          const result = await runTurn({
            agent,
            session,
            command,
            mailbox,
            redactor,
            events,
          })
          activeTurnId = null
          await events.emit({
            type: "turn.terminal",
            payload: { turnId: command.turnId, result: result.terminal },
          })
          if (result.close) {
            closeReason = "requested"
            break
          }
        }

        if (initialized.agentCapabilities?.sessionCapabilities?.close != null) {
          await closeAcpSession(agent, session.sessionId, CLOSE_GRACE_MS)
        }
      } finally {
        session.dispose()
      }
    })
    if (closeReason === "failed") closeReason = "agent_exit"
  } finally {
    try {
      await child.stdin.end()
    } catch {}
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    await Promise.race([child.exited.catch(() => 1), Bun.sleep(CLOSE_GRACE_MS)])
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await child.exited.catch(() => 1)
    await stderr.catch(() => {})
    await events.emit({ type: "session.closed", payload: { reason: closeReason } })
  }
}

interface RunTurnInput {
  readonly agent: acp.ClientContext
  readonly session: acp.ActiveSession
  readonly command: Extract<SessionRunnerCommand, { type: "turn.start" }>
  readonly mailbox: CommandMailbox
  readonly redactor: ExactValueRedactor
  readonly events: SessionEventTarget
}

async function runTurn(input: RunTurnInput): Promise<{
  readonly terminal: RunnerTerminalPayload
  readonly close: boolean
}> {
  const cancellation = new AbortController()
  let interrupted = false
  let close = false
  let timedOut = false
  const commandObservation = new AbortController()
  let processCommand:
    | Promise<{ readonly kind: "command"; readonly value: SessionRunnerCommand | null }>
    | undefined
  const timer = setTimeout(() => {
    timedOut = true
    cancellation.abort()
    void input.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: input.session.sessionId,
    })
  }, input.command.timeoutBudgetMs)

  try {
    void input.session.prompt(input.command.prompt, { cancellationSignal: cancellation.signal })
    let agentUpdate = input.session
      .nextUpdate()
      .then((value) => ({ kind: "agent" as const, value }))
    processCommand = input.mailbox
      .next(undefined, commandObservation.signal)
      .then((value) => ({ kind: "command" as const, value }))
    for (;;) {
      const result = await Promise.race([agentUpdate, processCommand])
      if (result.kind === "command") {
        processCommand = input.mailbox
          .next(undefined, commandObservation.signal)
          .then((value) => ({ kind: "command" as const, value }))
        const command = result.value
        if (command === null) continue
        if (command.type === "session.close") {
          close = true
          interrupted = true
        } else if (command.type === "turn.interrupt" && command.turnId === input.command.turnId) {
          interrupted = true
        } else {
          input.mailbox.defer(command)
          continue
        }
        cancellation.abort()
        await input.agent
          .notify(acp.methods.agent.session.cancel, { sessionId: input.session.sessionId })
          .catch(() => {})
        continue
      }
      if (result.value.kind === "stop") {
        return {
          close,
          terminal: timedOut
            ? { outcome: "timed_out" }
            : interrupted
              ? { outcome: "cancelled", stopReason: "cancelled" }
              : terminalForStopReason(result.value.stopReason),
        }
      }

      const bounded = boundedSessionUpdate(input.redactor.json(result.value.update))
      await input.events.emit({
        type: "turn.update",
        payload: {
          turnId: input.command.turnId,
          update: bounded.update,
          truncated: bounded.truncated,
          ...(bounded.originalBytes ? { originalBytes: bounded.originalBytes } : {}),
        },
      })
      agentUpdate = input.session.nextUpdate().then((value) => ({ kind: "agent" as const, value }))
    }
  } catch (error) {
    if (timedOut) return { close, terminal: { outcome: "timed_out" } }
    if (interrupted) {
      return { close, terminal: { outcome: "cancelled", stopReason: "cancelled" } }
    }
    return {
      close,
      terminal: {
        outcome: "failed",
        error: {
          code: "ACP_SESSION_FAILED",
          message: input.redactor.text(safeErrorMessage(error)),
        },
      },
    }
  } finally {
    clearTimeout(timer)
    commandObservation.abort()
    const pendingCommand = await processCommand?.catch(() => undefined)
    if (pendingCommand?.value) input.mailbox.defer(pendingCommand.value)
  }
}

class CommandMailbox {
  readonly #deferred: SessionRunnerCommand[] = []
  #lastSequence = 0

  constructor(private readonly path: string) {}

  defer(command: SessionRunnerCommand): void {
    this.#deferred.unshift(command)
  }

  async next(timeoutMs?: number, signal?: AbortSignal): Promise<SessionRunnerCommand | null> {
    const deferred = this.#deferred.shift()
    if (deferred) return deferred
    const startedAt = performance.now()
    for (;;) {
      if (signal?.aborted) return null
      const command = await this.#readNext()
      if (command) return command
      if (timeoutMs !== undefined && performance.now() - startedAt >= timeoutMs) return null
      await Bun.sleep(MAILBOX_POLL_MS)
    }
  }

  async #readNext(): Promise<SessionRunnerCommand | null> {
    const directory = await opendir(this.path)
    const names: string[] = []
    for await (const entry of directory) {
      if (entry.isFile() && /^\d{16}\.json$/.test(entry.name)) names.push(entry.name)
    }
    names.sort()
    for (const name of names) {
      const path = `${this.path}/${name}`
      const envelope = processInputEnvelopeSchema(await Bun.file(path).json())
      if (envelope.sequence <= this.#lastSequence) {
        await unlink(path)
        continue
      }
      if (envelope.sequence !== this.#lastSequence + 1) return null
      const command = sessionRunnerCommandSchema.parse(JSON.parse(envelope.data))
      if (command.sequence !== envelope.sequence || command.id !== envelope.id) {
        throw new Error("Session command identity does not match its process input")
      }
      this.#lastSequence = envelope.sequence
      await unlink(path)
      return command
    }
    return null
  }
}

const processInputEnvelopeSchema = (
  value: unknown,
): {
  readonly sequence: number
  readonly id: string
  readonly data: string
} => {
  if (typeof value !== "object" || value === null) throw new Error("Invalid process input")
  const sequence = Reflect.get(value, "sequence")
  const id = Reflect.get(value, "id")
  const data = Reflect.get(value, "data")
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    typeof id !== "string" ||
    typeof data !== "string"
  ) {
    throw new Error("Invalid process input")
  }
  return { sequence, id, data }
}

const terminalForStopReason = (stopReason: string): RunnerTerminalPayload => {
  if (stopReason === "end_turn") return { outcome: "succeeded", stopReason }
  if (stopReason === "cancelled") return { outcome: "cancelled", stopReason }
  if (stopReason === "max_tokens") {
    return {
      outcome: "failed",
      stopReason,
      error: { code: "ACP_MAX_TOKENS", message: "Agent reached its token limit" },
    }
  }
  if (stopReason === "max_turn_requests") {
    return {
      outcome: "failed",
      stopReason,
      error: { code: "ACP_MAX_TURN_REQUESTS", message: "Agent reached its turn request limit" },
    }
  }
  return {
    outcome: "failed",
    stopReason: "refusal",
    error: { code: "ACP_REFUSAL", message: "Agent refused the turn" },
  }
}

async function forwardStderr(
  stream: ReadableStream<Uint8Array>,
  redactor: ExactValueRedactor,
  events: SessionEventTarget,
): Promise<void> {
  const decoder = new TextDecoder()
  for await (const bytes of stream) {
    const text = redactor.text(decoder.decode(bytes, { stream: true }))
    for (const chunk of splitUtf8(text, MAX_STDERR_CHUNK_BYTES)) {
      await events.emit({ type: "agent.stderr", payload: { chunk, truncated: text !== chunk } })
    }
  }
  const tail = redactor.text(decoder.decode())
  if (tail) await events.emit({ type: "agent.stderr", payload: { chunk: tail, truncated: false } })
}

function splitUtf8(text: string, maxBytes: number): string[] {
  if (new TextEncoder().encode(text).byteLength <= maxBytes) return text ? [text] : []
  const result: string[] = []
  let remaining = text
  while (remaining) {
    let end = Math.min(remaining.length, maxBytes)
    while (new TextEncoder().encode(remaining.slice(0, end)).byteLength > maxBytes) end -= 1
    result.push(remaining.slice(0, end))
    remaining = remaining.slice(end)
  }
  return result
}

const safeErrorMessage = (error: unknown): string =>
  error instanceof Error && error.message.length > 0
    ? error.message.slice(0, 512)
    : "ACP session failed"
