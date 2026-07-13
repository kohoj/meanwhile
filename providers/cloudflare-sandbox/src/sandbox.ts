import {
  getSandbox,
  type Process,
  ProcessReadyTimeoutError,
  type Sandbox,
} from "@cloudflare/sandbox"

import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeError,
  decodeEventCursor,
  type ExposedEndpoint,
  encodeEventCursor,
  MAX_PROCESS_OUTPUT_BYTES,
  type ProcessEvent,
  type ProcessEventsResponse,
  type ProcessInputRequest,
  type ProcessSignal,
  type ProcessSnapshot,
  type ProviderProcessStatus,
  type RuntimeFileInfo,
  type RuntimeHandle,
  type RuntimeSnapshot,
  type SpawnProcessRequest,
  type WriteFilesRequest,
} from "./protocol"

const WORKSPACE_ROOT = "/workspace"
const STAGING_ROOT = "/tmp/meanwhile-bridge"
const WORKSPACE_PATH_PROBE_TIMEOUT_MS = 5_000
const WORKSPACE_FILE_MODE_TIMEOUT_MS = 5_000
const PROCESS_LOG_REFRESH_INTERVAL_MS = 250
const TERMINAL_LOG_SETTLE_INTERVAL_MS = 100
const TERMINAL_LOG_QUIET_READS = 5
const TERMINAL_LOG_MAX_READS = 20
const WORKSPACE_PATH_PROBE_COMMAND = shellJoin([
  "/bin/sh",
  "-c",
  `set -eu
root=/workspace
target=\${MEANWHILE_WORKSPACE_PATH-}
require_existing=\${MEANWHILE_REQUIRE_EXISTING-0}

case "$target" in
  "$root"|"$root"/*) ;;
  *) exit 43 ;;
esac

if [ -L "$root" ]; then
  exit 42
fi
if [ ! -d "$root" ]; then
  exit 46
fi

current=$root
relative=\${target#"$root"}
relative=\${relative#/}
while [ -n "$relative" ]; do
  case "$relative" in
    */*) segment=\${relative%%/*}; relative=\${relative#*/} ;;
    *) segment=$relative; relative= ;;
  esac
  current="$current/$segment"
  if [ -L "$current" ]; then
    exit 42
  fi
done

resolved=$(realpath -m -- "$target") || exit 46
case "$resolved" in
  "$root"|"$root"/*) ;;
  *) exit 43 ;;
esac

if [ "$require_existing" = 1 ] && [ ! -e "$target" ]; then
  exit 44
fi`,
])
const WORKSPACE_FILE_MODE_COMMAND = shellJoin([
  "/bin/sh",
  "-c",
  `set -eu
target=\${MEANWHILE_WORKSPACE_PATH-}
mode=\${MEANWHILE_FILE_MODE-}
chmod -- "$mode" "$target"
actual=$(stat -c %a -- "$target")
[ "$actual" = "$mode" ]`,
])
const TERMINAL_PROCESS_STATES = new Set<ProviderProcessStatus>([
  "completed",
  "failed",
  "killed",
  "error",
])
type SandboxFileInfo = Awaited<ReturnType<Sandbox["listFiles"]>>["files"][number]

interface ProcessOutputCache {
  readonly stdout: string
  readonly stderr: string
  readonly fetchedAt: number
  readonly terminal: boolean
}

export interface CloudflareBridgeEnvironment {
  Sandbox: DurableObjectNamespace<Sandbox>
  RuntimeRegistry: DurableObjectNamespace
  BRIDGE_TOKEN: string
  SANDBOX_SLEEP_AFTER?: string
}

export interface ReadRuntimeFile {
  readonly body: ReadableStream<Uint8Array>
  readonly size: number
  readonly mediaType: string
}

export interface BridgeRuntime {
  start(): Promise<RuntimeSnapshot>
  inspect(): Promise<RuntimeSnapshot>
  stop(): Promise<RuntimeSnapshot>
  destroy(): Promise<RuntimeSnapshot>
  spawn(processId: string, request: SpawnProcessRequest): Promise<ProcessSnapshot>
  inspectProcess(processId: string): Promise<ProcessSnapshot>
  events(processId: string, cursor: string, limitChars: number): Promise<ProcessEventsResponse>
  signal(processId: string, signal: ProcessSignal): Promise<ProcessSnapshot>
  send(processId: string, input: ProcessInputRequest): Promise<void>
  wait(processId: string, timeoutMs: number): Promise<ProcessSnapshot>
  writeFiles(request: WriteFilesRequest): Promise<void>
  listFiles(
    path: string,
    recursive: boolean,
    maxEntries: number,
  ): Promise<readonly RuntimeFileInfo[]>
  readFile(path: string, maxBytes: number): Promise<ReadRuntimeFile>
  expose(port: number): Promise<ExposedEndpoint>
  unexpose(port: number): Promise<void>
}

export type BridgeRuntimeFactory = (runtimeId: string) => BridgeRuntime

export function createCloudflareRuntimeFactory(
  environment: CloudflareBridgeEnvironment,
): BridgeRuntimeFactory {
  return (runtimeId) => {
    const sandbox = getSandbox(environment.Sandbox, runtimeId, {
      enableDefaultSession: false,
      normalizeId: true,
      sleepAfter: environment.SANDBOX_SLEEP_AFTER ?? "10m",
      transport: "rpc",
    })

    return new CloudflareBridgeRuntime(runtimeId, sandbox)
  }
}

export class CloudflareBridgeRuntime implements BridgeRuntime {
  readonly #handle: RuntimeHandle
  readonly #sandbox: Sandbox
  readonly #sleep: (milliseconds: number) => Promise<void>
  readonly #processOutput = new Map<string, ProcessOutputCache>()

  constructor(
    runtimeId: string,
    sandbox: Sandbox,
    sleep: (milliseconds: number) => Promise<void> = defaultSleep,
  ) {
    this.#handle = { version: BRIDGE_PROTOCOL_VERSION, id: runtimeId }
    this.#sandbox = sandbox
    this.#sleep = sleep
  }

  async start(): Promise<RuntimeSnapshot> {
    await this.#sandbox.setKeepAlive(true)
    return this.#snapshot("active")
  }

  async inspect(): Promise<RuntimeSnapshot> {
    const processes = await this.#sandbox.listProcesses()
    const activeProcessCount = processes.filter(
      (process) => !TERMINAL_PROCESS_STATES.has(process.status),
    ).length

    return {
      handle: this.#handle,
      state: activeProcessCount > 0 ? "active" : "idle",
      processCount: processes.length,
      activeProcessCount,
    }
  }

  async stop(): Promise<RuntimeSnapshot> {
    await this.#sandbox.killAllProcesses()
    try {
      const tunnels = await this.#sandbox.tunnels.list()
      for (const tunnel of tunnels) {
        await this.#sandbox.tunnels.destroy(tunnel)
      }
    } finally {
      await this.#sandbox.setKeepAlive(false)
    }

    return this.#snapshot("stopped")
  }

  async destroy(): Promise<RuntimeSnapshot> {
    await this.#sandbox.destroy()
    return this.#snapshot("destroyed")
  }

  async spawn(processId: string, request: SpawnProcessRequest): Promise<ProcessSnapshot> {
    await this.#sandbox.setKeepAlive(true)

    const existing = await this.#sandbox.getProcess(processId)
    if (existing) {
      // The durable registry has already bound this process identity to the
      // complete specification fingerprint. A retry must not restage stdin.
      return this.#processSnapshot(existing)
    }

    const stdinPath =
      request.stdin === undefined ? undefined : `${STAGING_ROOT}/${crypto.randomUUID()}.stdin`
    const mailboxPath =
      request.input === "mailbox" ? `${STAGING_ROOT}/${processId}.inbox` : undefined
    const command = buildProcessCommand(request.argv, stdinPath)
    try {
      if (stdinPath) {
        await this.#sandbox.mkdir(STAGING_ROOT, { recursive: true })
        await this.#sandbox.writeFile(stdinPath, request.stdin ?? "", { encoding: "utf-8" })
      }
      if (mailboxPath) await this.#sandbox.mkdir(mailboxPath, { recursive: true })

      const process = await this.#sandbox.startProcess(command, {
        autoCleanup: false,
        cwd: toWorkspacePath(request.cwd ?? "."),
        processId,
        ...(request.env || mailboxPath
          ? {
              env: {
                ...request.env,
                ...(mailboxPath ? { MEANWHILE_PROCESS_INBOX: mailboxPath } : {}),
              },
            }
          : {}),
        ...(request.timeoutMs === undefined
          ? {}
          : { timeout: request.timeoutMs + (request.terminationGraceMs ?? 0) }),
      })
      return await this.#processSnapshot(process)
    } finally {
      if (stdinPath) {
        await this.#removeStagedInput(stdinPath)
      }
    }
  }

  async inspectProcess(processId: string): Promise<ProcessSnapshot> {
    return this.#processSnapshot(await this.#requireProcess(processId))
  }

  async events(
    processId: string,
    encodedCursor: string,
    limitChars: number,
  ): Promise<ProcessEventsResponse> {
    const process = await this.#requireProcess(processId)
    // Observing terminal state must happen before reading accumulated output.
    // Fetching both concurrently can pair a fresh terminal status with stale
    // logs and emit an exit cursor before the provider flushes the last frame.
    const status = await process.getStatus()
    const cursor = decodeEventCursor(encodedCursor)
    const logs = await this.#logsForReplay(processId, status, cursor)

    if (logs.stdout.length < cursor.stdoutOffset || logs.stderr.length < cursor.stderrOffset) {
      throw new BridgeError(
        "EVENT_REPLAY_GAP",
        "Provider log history no longer contains the requested cursor.",
        409,
        {
          recoverable: false,
        },
      )
    }

    const events: ProcessEvent[] = []
    const observedAt = new Date().toISOString()
    let remaining = limitChars
    let next = cursor

    if (remaining > 0 && logs.stdout.length > next.stdoutOffset) {
      const data = logs.stdout.slice(next.stdoutOffset, next.stdoutOffset + remaining)
      next = { ...next, stdoutOffset: next.stdoutOffset + data.length }
      remaining -= data.length
      events.push({
        type: "output",
        cursor: encodeEventCursor(next),
        timestamp: observedAt,
        stream: "stdout",
        data,
      })
    }

    if (remaining > 0 && logs.stderr.length > next.stderrOffset) {
      const data = logs.stderr.slice(next.stderrOffset, next.stderrOffset + remaining)
      next = { ...next, stderrOffset: next.stderrOffset + data.length }
      events.push({
        type: "output",
        cursor: encodeEventCursor(next),
        timestamp: observedAt,
        stream: "stderr",
        data,
      })
    }

    const outputFullyConsumed =
      next.stdoutOffset === logs.stdout.length && next.stderrOffset === logs.stderr.length
    if (outputFullyConsumed && TERMINAL_PROCESS_STATES.has(status) && !next.terminalSeen) {
      const currentProcess = (await this.#sandbox.getProcess(processId)) ?? process
      next = { ...next, terminalSeen: true }
      events.push({
        type: "exit",
        cursor: encodeEventCursor(next),
        timestamp: currentProcess.endTime ? toIsoString(currentProcess.endTime) : observedAt,
        status,
        exitCode: currentProcess.exitCode ?? null,
      })
    }

    return { events, nextCursor: encodeEventCursor(next) }
  }

  async signal(processId: string, signal: ProcessSignal): Promise<ProcessSnapshot> {
    if (signal !== "SIGKILL") {
      throw new BridgeError(
        "PROCESS_SIGNAL_UNSUPPORTED",
        "The Cloudflare Sandbox bridge supports hard process termination only.",
        422,
        { retryable: false, supportedSignals: ["SIGKILL"] },
      )
    }
    const process = await this.#requireProcess(processId)
    const status = await process.getStatus()
    if (!TERMINAL_PROCESS_STATES.has(status)) {
      // Sandbox 0.12.3 accepts a signal argument in its public type but drops
      // it before calling the container API. Calling the one honest primitive
      // here is therefore deliberately modelled as hard termination.
      await this.#sandbox.killProcess(processId)
    }
    return this.#processSnapshot(process)
  }

  async send(processId: string, input: ProcessInputRequest): Promise<void> {
    const process = await this.#requireProcess(processId)
    if (TERMINAL_PROCESS_STATES.has(await process.getStatus())) {
      throw new BridgeError("PROCESS_NOT_RUNNING", "The process is not running.", 409)
    }
    const directory = `${STAGING_ROOT}/${processId}.inbox`
    const path = `${directory}/${inputFileName(input.sequence)}`
    const encoded = `${JSON.stringify(input)}\n`
    try {
      const existing = await this.#sandbox.readFile(path, { encoding: "utf-8" })
      const text = await new Response(existing.content).text()
      if (text !== encoded) {
        throw new BridgeError(
          "PROCESS_INPUT_CONFLICT",
          "The process input sequence is already bound to different data.",
          409,
        )
      }
      return
    } catch (error) {
      if (error instanceof BridgeError) throw error
    }
    await this.#sandbox.writeFile(path, encoded, { encoding: "utf-8" })
  }

  async wait(processId: string, timeoutMs: number): Promise<ProcessSnapshot> {
    const process = await this.#requireProcess(processId)
    const status = await process.getStatus()
    if (!TERMINAL_PROCESS_STATES.has(status)) {
      try {
        await process.waitForExit(timeoutMs)
      } catch (error) {
        if (error instanceof ProcessReadyTimeoutError) {
          return this.#processSnapshot(process)
        }
        throw error
      }
    }
    return this.#processSnapshot(process)
  }

  async writeFiles(request: WriteFilesRequest): Promise<void> {
    for (const file of request.files) {
      const path = toWorkspacePath(file.path)
      const parent = path.slice(0, path.lastIndexOf("/"))
      await this.#assertWorkspacePath(path, false)
      if (parent !== WORKSPACE_ROOT) {
        await this.#sandbox.mkdir(parent, { recursive: true })
      }
      // Re-check after mkdir: an existing workspace component may have been
      // replaced while the provider was creating the missing path.
      await this.#assertWorkspacePath(path, false)
      await this.#sandbox.writeFile(path, file.contentBase64, { encoding: "base64" })
      await this.#assertWorkspacePath(path, true)
      await this.#applyWorkspaceFileMode(path, file.mode)
    }
  }

  async listFiles(
    path: string,
    recursive: boolean,
    maxEntries: number,
  ): Promise<readonly RuntimeFileInfo[]> {
    const workspacePath = toWorkspacePath(path)
    await this.#assertWorkspacePath(workspacePath, true)
    const result = await this.#sandbox.listFiles(workspacePath, {
      includeHidden: true,
      recursive,
    })
    if (result.files.length > maxEntries) {
      throw new BridgeError(
        "ENTRY_LIMIT_EXCEEDED",
        "Workspace directory exceeds the requested entry limit.",
        413,
        { retryable: false },
      )
    }

    return result.files.map(toRuntimeFileInfo)
  }

  async readFile(path: string, maxBytes: number): Promise<ReadRuntimeFile> {
    const workspacePath = toWorkspacePath(path)
    await this.#assertWorkspacePath(workspacePath, true)
    const result = await this.#sandbox.readFile(workspacePath, { encoding: "none" })
    if (result.size > maxBytes) {
      await result.content.cancel().catch(() => undefined)
      throw new BridgeError(
        "FILE_TOO_LARGE",
        "Workspace file exceeds the requested read limit.",
        413,
        { retryable: false },
      )
    }
    return {
      body: result.content,
      size: result.size,
      mediaType: result.mimeType || "application/octet-stream",
    }
  }

  async expose(port: number): Promise<ExposedEndpoint> {
    const tunnel = await this.#sandbox.tunnels.get(port)
    return { port, url: tunnel.url, expiresOnRuntimeStop: true }
  }

  async unexpose(port: number): Promise<void> {
    await this.#sandbox.tunnels.destroy(port)
  }

  async #snapshot(state: RuntimeSnapshot["state"]): Promise<RuntimeSnapshot> {
    const processes = state === "destroyed" ? [] : await this.#sandbox.listProcesses()
    return {
      handle: this.#handle,
      state,
      processCount: processes.length,
      activeProcessCount: processes.filter(
        (process) => !TERMINAL_PROCESS_STATES.has(process.status),
      ).length,
    }
  }

  async #logsForReplay(
    processId: string,
    status: ProviderProcessStatus,
    cursor: ReturnType<typeof decodeEventCursor>,
  ): Promise<ProcessOutputCache> {
    const cached = this.#processOutput.get(processId)
    const cacheHasUnreadOutput =
      cached !== undefined &&
      (cursor.stdoutOffset < cached.stdout.length || cursor.stderrOffset < cached.stderr.length)
    const cacheIsFresh =
      cached !== undefined && Date.now() - cached.fetchedAt < PROCESS_LOG_REFRESH_INTERVAL_MS
    const terminal = TERMINAL_PROCESS_STATES.has(status)

    // Serve all already-observed pages before asking the SDK for its full
    // accumulated log buffer again. The pinned SDK exposes no range/cursor
    // read, so this warm-isolate cache is an optimization only; replay
    // correctness remains entirely cursor-based.
    if (cached?.terminal || (!terminal && (cacheHasUnreadOutput || cacheIsFresh))) {
      return cached
    }

    const logs =
      terminal && cached !== undefined && !cached.terminal
        ? await this.#settledTerminalLogs(processId)
        : await this.#sandbox.getProcessLogs(processId)
    if (utf8Length(logs.stdout) + utf8Length(logs.stderr) > MAX_PROCESS_OUTPUT_BYTES) {
      throw new BridgeError(
        "PROCESS_OUTPUT_LIMIT_EXCEEDED",
        "The process output exceeds the Cloudflare bridge replay limit.",
        413,
        {
          limitBytes: MAX_PROCESS_OUTPUT_BYTES,
          retryable: false,
        },
      )
    }
    if (
      cached &&
      (!logs.stdout.startsWith(cached.stdout) || !logs.stderr.startsWith(cached.stderr))
    ) {
      throw new BridgeError(
        "EVENT_REPLAY_GAP",
        "Provider log history no longer contains the previously observed output.",
        409,
        { recoverable: false },
      )
    }

    const observed = {
      stdout: logs.stdout,
      stderr: logs.stderr,
      fetchedAt: Date.now(),
      terminal,
    }
    this.#processOutput.set(processId, observed)
    return observed
  }

  async #settledTerminalLogs(processId: string) {
    let current = await this.#sandbox.getProcessLogs(processId)
    let quietReads = 0
    for (let read = 1; read < TERMINAL_LOG_MAX_READS; read += 1) {
      await this.#sleep(TERMINAL_LOG_SETTLE_INTERVAL_MS)
      const next = await this.#sandbox.getProcessLogs(processId)
      if (next.stdout === current.stdout && next.stderr === current.stderr) {
        quietReads += 1
        if (quietReads >= TERMINAL_LOG_QUIET_READS) return next
      } else {
        quietReads = 0
      }
      current = next
    }
    return current
  }

  async #requireProcess(processId: string): Promise<Process> {
    const process = await this.#sandbox.getProcess(processId)
    if (!process) {
      throw new BridgeError("PROCESS_NOT_FOUND", "The process does not exist.", 404)
    }
    return process
  }

  async #assertWorkspacePath(path: string, requireExisting: boolean): Promise<void> {
    const result = await this.#sandbox.exec(WORKSPACE_PATH_PROBE_COMMAND, {
      env: {
        MEANWHILE_WORKSPACE_PATH: path,
        MEANWHILE_REQUIRE_EXISTING: requireExisting ? "1" : "0",
      },
      origin: "internal",
      timeout: WORKSPACE_PATH_PROBE_TIMEOUT_MS,
    })

    switch (result.exitCode) {
      case 0:
        return
      case 42:
        throw new BridgeError(
          "SYMLINK_NOT_ALLOWED",
          "Workspace paths cannot cross symbolic links.",
          409,
          { retryable: false },
        )
      case 43:
        throw new BridgeError(
          "PATH_ESCAPE",
          "The workspace path resolves outside the runtime workspace.",
          409,
          { retryable: false },
        )
      case 44:
        throw new BridgeError("PATH_NOT_FOUND", "The workspace path does not exist.", 404, {
          retryable: false,
        })
      default:
        throw new BridgeError(
          "WORKSPACE_PATH_INSPECTION_FAILED",
          "Workspace path safety could not be verified.",
          502,
          {
            providerCode: `PATH_PROBE_EXIT_${result.exitCode}`,
            retryable: false,
          },
        )
    }
  }

  async #applyWorkspaceFileMode(path: string, mode: number): Promise<void> {
    const result = await this.#sandbox.exec(WORKSPACE_FILE_MODE_COMMAND, {
      env: {
        MEANWHILE_FILE_MODE: mode.toString(8),
        MEANWHILE_WORKSPACE_PATH: path,
      },
      origin: "internal",
      timeout: WORKSPACE_FILE_MODE_TIMEOUT_MS,
    })
    if (result.exitCode !== 0) {
      throw new BridgeError(
        "FILE_MODE_APPLY_FAILED",
        "The workspace file mode could not be applied exactly.",
        502,
        { retryable: false },
      )
    }
  }

  async #removeStagedInput(path: string): Promise<void> {
    try {
      const stagedInput = await this.#sandbox.exists(path)
      if (stagedInput.exists) {
        await this.#sandbox.deleteFile(path)
      }
    } catch {
      try {
        await this.#sandbox.destroy()
      } catch {
        throw new BridgeError(
          "STAGING_CLEANUP_FAILED",
          "The staged process input could not be removed and runtime destruction failed.",
          502,
          { retryable: false, runtimeDestroyed: false },
        )
      }
      throw new BridgeError(
        "STAGING_CLEANUP_FAILED",
        "The staged process input could not be removed; the runtime was destroyed.",
        502,
        { retryable: false, runtimeDestroyed: true },
      )
    }
  }

  async #processSnapshot(process: Process): Promise<ProcessSnapshot> {
    const currentProcess = (await this.#sandbox.getProcess(process.id)) ?? process
    return {
      handle: {
        version: BRIDGE_PROTOCOL_VERSION,
        runtimeId: this.#handle.id,
        id: currentProcess.id,
      },
      status: currentProcess.status,
      pid: currentProcess.pid,
      startedAt: toIsoString(currentProcess.startTime),
      finishedAt: currentProcess.endTime ? toIsoString(currentProcess.endTime) : undefined,
      exitCode: currentProcess.exitCode ?? null,
    }
  }
}

export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ")
}

function shellQuote(argument: string): string {
  return `'${argument.replaceAll("'", `'"'"'`)}'`
}

function buildProcessCommand(argv: readonly string[], stdinPath: string | undefined): string {
  const command = shellJoin(argv)
  return stdinPath ? `${command} < ${shellQuote(stdinPath)}` : command
}

function toWorkspacePath(relativePath: string): string {
  return relativePath === "." ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}/${relativePath}`
}

function toRuntimeFileInfo(file: SandboxFileInfo): RuntimeFileInfo {
  const prefix = `${WORKSPACE_ROOT}/`
  if (!file.absolutePath.startsWith(prefix)) {
    throw new BridgeError(
      "PROVIDER_PROTOCOL_ERROR",
      "The provider returned a file outside the workspace.",
      502,
      {
        retryable: false,
      },
    )
  }

  return {
    path: file.absolutePath.slice(prefix.length),
    type: file.type,
    size: file.size,
    modifiedAt: file.modifiedAt,
  }
}

function inputFileName(sequence: number): string {
  return `${String(sequence).padStart(16, "0")}.json`
}

function toIsoString(value: Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
