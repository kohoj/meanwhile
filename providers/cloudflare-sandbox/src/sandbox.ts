import {
  type Sandbox as CloudflareSandboxClient,
  type ExecutionSession,
  getSandbox,
  isPlatformTransientError,
  type Process,
  ProcessReadyTimeoutError,
  streamFile,
} from "@cloudflare/sandbox"

import {
  type AttachCredentialLeaseRequest,
  BRIDGE_PROTOCOL_VERSION,
  BridgeError,
  decodeEventCursor,
  type ExposedEndpoint,
  encodeEventCursor,
  eventPrefixDigest,
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
const STAGING_ROOT = "/tmp/meanwhile-runtime"
const CONTAINER_INSTANCE_TIMEOUT_MS = 5_000
const CONTAINER_PORT_READY_TIMEOUT_MS = 10_000
const WORKSPACE_PATH_PROBE_TIMEOUT_MS = 5_000
const WORKSPACE_FILE_MODE_TIMEOUT_MS = 5_000
const WORKSPACE_FILE_STAT_TIMEOUT_MS = 5_000
const PROCESS_LOG_REFRESH_INTERVAL_MS = 250
// The public control plane admits run, turn, and session-idle budgets up to
// 24 hours. Cloudflare's activity alarm is only a provider-side safety net;
// it must never expire before the authoritative lease. This non-default value
// is also persisted by the pinned SDK instead of being mistaken for its
// in-memory 10 minute default and skipped.
const SANDBOX_IDLE_SAFETY_WINDOW = "25h"
const PROCESS_EVIDENCE_OPERATION_TIMEOUT_MS = 10_000
const REPLAY_LOG_SETTLE_INTERVAL_MS = 250
const REPLAY_LOG_MAX_READS = 40
const TERMINAL_LOG_SETTLE_INTERVAL_MS = 250
const TERMINAL_LOG_COMPLETE_QUIET_READS = 2
const TERMINAL_LOG_QUIET_READS = 8
const TERMINAL_LOG_MAX_READS = 40
const STAGING_CLEANUP_RETRY_DELAYS_MS = [100, 250, 500] as const
const PROCESS_COMPLETION_PREFIX = "__MEANWHILE_PROCESS_COMPLETE_"
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
const WORKSPACE_FILE_STAT_COMMAND = shellJoin([
  "/bin/sh",
  "-c",
  `set -eu
target=\${MEANWHILE_WORKSPACE_PATH-}
[ -f "$target" ] || exit 45
stat -c %s -- "$target"`,
])
const TERMINAL_PROCESS_STATES = new Set<ProviderProcessStatus>([
  "completed",
  "failed",
  "killed",
  "error",
])
type SandboxFileInfo = Awaited<ReturnType<CloudflareSandboxClient["listFiles"]>>["files"][number]
type RuntimeExecution = Pick<ExecutionSession, "deleteFile" | "exec" | "exists">

export interface CloudflareRuntimeSandbox extends CloudflareSandboxClient {
  setRuntimeLease(active: boolean): Promise<void>
}

interface ProcessEvidenceBudget {
  readonly operationDeadlineMs: number
  readonly processDeadlineMs: number | null
  readonly now: () => number
}

interface ProcessOutputCache {
  readonly stdout: string
  readonly stderr: string
  readonly fetchedAt: number
  readonly terminal: boolean
  readonly exitCode: number | null
}

export interface CloudflareBridgeEnvironment {
  Sandbox: DurableObjectNamespace<CloudflareRuntimeSandbox>
  RuntimeRegistry: DurableObjectNamespace
  BRIDGE_TOKEN: string
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
  placementId(): Promise<string | null>
  assertPlacement(expected: string | null, refresh?: boolean): Promise<void>
  spawn(
    processId: string,
    request: SpawnProcessRequest,
    admission: "initial" | "reconcile",
    known?: ProcessSnapshot,
    evidenceDeadline?: string | null,
  ): Promise<ProcessSnapshot>
  inspectProcess(
    processId: string,
    known?: ProcessSnapshot,
    evidenceDeadline?: string | null,
  ): Promise<ProcessSnapshot>
  events(
    processId: string,
    cursor: string,
    limitChars: number,
    known?: ProcessSnapshot,
    evidenceDeadline?: string | null,
  ): Promise<ProcessEventsResponse>
  signal(
    processId: string,
    signal: ProcessSignal,
    known?: ProcessSnapshot,
  ): Promise<ProcessSnapshot>
  send(processId: string, input: ProcessInputRequest): Promise<void>
  wait(
    processId: string,
    timeoutMs: number,
    known?: ProcessSnapshot,
    evidenceDeadline?: string | null,
  ): Promise<ProcessSnapshot>
  writeFiles(request: WriteFilesRequest): Promise<void>
  listFiles(
    path: string,
    recursive: boolean,
    maxEntries: number,
  ): Promise<readonly RuntimeFileInfo[]>
  readFile(path: string, maxBytes: number): Promise<ReadRuntimeFile>
  expose(port: number, hostname: string): Promise<ExposedEndpoint>
  unexpose(port: number): Promise<void>
  configureCredentialLease(request: AttachCredentialLeaseRequest): Promise<void>
  clearCredentialLease(): Promise<void>
}

export type BridgeRuntimeFactory = (runtimeId: string) => BridgeRuntime

export function createCloudflareRuntimeFactory(
  environment: CloudflareBridgeEnvironment,
): BridgeRuntimeFactory {
  return (runtimeId) => {
    const sandbox = getSandbox(environment.Sandbox, runtimeId, {
      normalizeId: true,
    })

    return new CloudflareBridgeRuntime(
      runtimeId,
      sandbox,
      defaultSleep,
      Date.now,
      SANDBOX_IDLE_SAFETY_WINDOW,
    )
  }
}

export class CloudflareBridgeRuntime implements BridgeRuntime {
  readonly #handle: RuntimeHandle
  readonly #sandbox: CloudflareRuntimeSandbox
  readonly #sleep: (milliseconds: number) => Promise<void>
  readonly #now: () => number
  readonly #sleepAfter: string
  readonly #processOutput = new Map<string, ProcessOutputCache>()
  #configuration: Promise<void> | null = null

  constructor(
    runtimeId: string,
    sandbox: CloudflareRuntimeSandbox,
    sleep: (milliseconds: number) => Promise<void> = defaultSleep,
    now: () => number = Date.now,
    sleepAfter = SANDBOX_IDLE_SAFETY_WINDOW,
  ) {
    this.#handle = { version: BRIDGE_PROTOCOL_VERSION, id: runtimeId }
    this.#sandbox = sandbox
    this.#sleep = sleep
    this.#now = now
    this.#sleepAfter = sleepAfter
  }

  async start(): Promise<RuntimeSnapshot> {
    await this.#configure()
    // Static sandbox configuration and the runtime lease are different
    // lifecycles. Apply transport/timeouts first, then explicitly acquire the
    // bridge-owned lease before materializing compute.
    await this.#sandbox.setRuntimeLease(true)
    // getSandbox derives one deterministic default session from runtimeId.
    // Materialize it here so `start` proves that disposable compute is ready.
    await this.#sandbox.exec("/bin/true", {
      origin: "internal",
      timeout: WORKSPACE_PATH_PROBE_TIMEOUT_MS,
    })
    return this.#snapshot("active")
  }

  async inspect(): Promise<RuntimeSnapshot> {
    const processes = await this.#sandbox.listProcesses()
    try {
      const activeProcessCount = processes.filter(
        (process) => !TERMINAL_PROCESS_STATES.has(process.status),
      ).length

      return {
        handle: this.#handle,
        state: activeProcessCount > 0 ? "active" : "idle",
        processCount: processes.length,
        activeProcessCount,
      }
    } finally {
      disposeProviderProcesses(processes)
    }
  }

  async stop(): Promise<RuntimeSnapshot> {
    const exposed = await this.#sandbox.getExposedPorts("preview.invalid")
    for (const { port } of exposed) await this.#sandbox.unexposePort(port)
    await this.#sandbox.killAllProcesses()
    await this.#sandbox.setRuntimeLease(false)
    await this.#sandbox.stop()

    return this.#snapshot("stopped")
  }

  async destroy(): Promise<RuntimeSnapshot> {
    await this.#sandbox.destroy()
    return this.#snapshot("destroyed")
  }

  async placementId(): Promise<string | null> {
    const placementId = await this.#sandbox.getContainerPlacementId()
    if (placementId === undefined) {
      throw new BridgeError(
        "RUNTIME_IDENTITY_UNAVAILABLE",
        "The provider did not establish a physical runtime identity.",
        503,
        { retryable: true },
      )
    }
    return placementId
  }

  async assertPlacement(expected: string | null, refresh = true): Promise<void> {
    try {
      if (refresh) {
        // A harmless default-session command forces the SDK to complete its
        // current container handshake. The SDK then publishes the observed
        // Cloudflare placement ID through Durable Object storage.
        await this.#sandbox.exec("/bin/true", {
          origin: "internal",
          timeout: WORKSPACE_PATH_PROBE_TIMEOUT_MS,
        })
      }
      if ((await this.placementId()) === expected) return
    } catch {
      // Once durable state binds a physical generation, inability to prove
      // that generation is itself continuity loss. The caller must never
      // reinterpret an unavailable identity check as a retryable operation on
      // possibly different compute.
    }

    await this.#throwRuntimeLost()
  }

  async #throwRuntimeLost(): Promise<never> {
    let replacementDestroyed = false
    try {
      await this.#sandbox.destroy()
      replacementDestroyed = true
    } catch {
      // The durable cleanup owner will retry destruction. Identity mismatch,
      // not this best-effort containment result, is the authoritative failure.
    }
    throw new BridgeError(
      "RUNTIME_LOST",
      "The provider replaced the physical runtime generation.",
      409,
      { retryable: false, replacementDestroyed },
    )
  }

  async spawn(
    processId: string,
    request: SpawnProcessRequest,
    admission: "initial" | "reconcile",
    known?: ProcessSnapshot,
    evidenceDeadline?: string | null,
  ): Promise<ProcessSnapshot> {
    await this.#sandbox.setRuntimeLease(true)
    const execution = this.#sandbox
    const stdinPath = request.stdin === undefined ? undefined : `${STAGING_ROOT}/${processId}.stdin`
    const existing = await execution.getProcess(processId)
    if (existing) {
      try {
        // The durable registry has already bound this process identity to the
        // complete specification fingerprint. The process wrapper owns the
        // read-and-unlink handoff, so an exact retry must not race it by touching
        // the staging path from the control plane.
        return await this.#processSnapshot(existing)
      } finally {
        disposeProviderCapability(existing)
      }
    }

    // The SDK intentionally removes an exited process from getProcess() while
    // retaining its accumulated logs. Recover the exact prior execution before
    // considering a retry; otherwise an admission retry could run the same
    // agent twice after a response-loss window.
    if (known) {
      const recovered = await this.#recoverTerminalProcess(processId, known, false)
      if (recovered) {
        return recovered
      }
    }

    if (admission === "reconcile") {
      assertProcessEvidenceWindow(evidenceDeadline)
      throw new BridgeError(
        "PROCESS_ADMISSION_PENDING",
        "The provider has not resolved the original process admission yet.",
        503,
        { retryable: true },
      )
    }

    const mailboxPath =
      request.input === "mailbox" ? `${STAGING_ROOT}/${processId}.inbox` : undefined
    const command = buildProcessCommand(request.argv, stdinPath, processCompletionMarker(processId))
    let admitted = false
    try {
      if (stdinPath) {
        await execution.mkdir(STAGING_ROOT, { recursive: true })
        await execution.writeFile(stdinPath, request.stdin ?? "", { encoding: "utf-8" })
      }
      if (mailboxPath) await execution.mkdir(mailboxPath, { recursive: true })

      const process = await execution.startProcess(command, {
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
      // From this point the wrapper exclusively owns the input path. Deleting
      // from the bridge would race a child that the provider has admitted but
      // has not yet scheduled.
      admitted = true
      try {
        return await this.#processSnapshot(process)
      } finally {
        disposeProviderCapability(process)
      }
    } finally {
      if (stdinPath && !admitted) {
        await this.#removeStagedInput(execution, stdinPath)
      }
    }
  }

  async inspectProcess(
    processId: string,
    known?: ProcessSnapshot,
    evidenceDeadline?: string | null,
  ): Promise<ProcessSnapshot> {
    return this.#withinProcessEvidenceBudget(evidenceDeadline, (budget) =>
      this.#inspectProcessEvidence(processId, known, budget),
    )
  }

  async #inspectProcessEvidence(
    processId: string,
    known?: ProcessSnapshot,
    budget?: ProcessEvidenceBudget,
  ): Promise<ProcessSnapshot> {
    assertProcessEvidenceBudget(budget)
    const process = await this.#sandbox.getProcess(processId)
    if (!process) {
      const recovered = await this.#recoverTerminalProcess(processId, known, false, budget)
      if (recovered) return recovered
      if (known && !TERMINAL_PROCESS_STATES.has(known.status)) {
        assertProcessEvidenceBudget(budget)
        return known
      }
      throw processNotFound()
    }
    try {
      const observedStatus = await process.getStatus()
      const status =
        observedStatus === "error" && known && !TERMINAL_PROCESS_STATES.has(known.status)
          ? known.status
          : observedStatus
      if (status === "error") {
        const recovered = await this.#recoverTerminalProcess(processId, known, false, budget)
        if (recovered) return recovered
      }
      return await this.#processSnapshot(process, status, budget)
    } finally {
      disposeProviderCapability(process)
    }
  }

  async events(
    processId: string,
    encodedCursor: string,
    limitChars: number,
    known?: ProcessSnapshot,
    evidenceDeadline?: string | null,
  ): Promise<ProcessEventsResponse> {
    return this.#withinProcessEvidenceBudget(evidenceDeadline, (budget) =>
      this.#replayProcessEvents(processId, encodedCursor, limitChars, known, budget),
    )
  }

  async #replayProcessEvents(
    processId: string,
    encodedCursor: string,
    limitChars: number,
    known?: ProcessSnapshot,
    budget?: ProcessEvidenceBudget,
  ): Promise<ProcessEventsResponse> {
    assertProcessEvidenceBudget(budget)
    const process = await this.#sandbox.getProcess(processId)
    try {
      // Observing terminal state must happen before reading accumulated output.
      // Fetching both concurrently can pair a fresh terminal status with stale
      // logs and emit an exit cursor before the provider flushes the last frame.
      const observedStatus = process ? await process.getStatus() : undefined
      const providerStatus =
        (observedStatus === undefined || observedStatus === "error") &&
        known &&
        !TERMINAL_PROCESS_STATES.has(known.status)
          ? known.status
          : (observedStatus ?? known?.status ?? "error")
      const cursor = decodeEventCursor(encodedCursor)
      const logs = await this.#logsForReplay(processId, providerStatus, cursor, budget)
      const snapshot = terminalSnapshot(
        processId,
        this.#handle.id,
        known,
        process,
        providerStatus,
        logs,
      )
      const status = snapshot.status
      if (!process && !logs.terminal && !TERMINAL_PROCESS_STATES.has(status) && known) {
        assertProcessEvidenceBudget(budget)
      }

      const events: ProcessEvent[] = []
      const observedAt = new Date().toISOString()
      let remaining = limitChars
      let next = cursor

      if (remaining > 0 && logs.stdout.length > next.stdoutOffset) {
        const data = logs.stdout.slice(next.stdoutOffset, next.stdoutOffset + remaining)
        next = { ...next, stdoutOffset: next.stdoutOffset + data.length }
        remaining -= data.length
        const encoded = await encodeCursorForLogs(next, logs)
        events.push({
          type: "output",
          cursor: encoded,
          timestamp: observedAt,
          stream: "stdout",
          data,
        })
      }

      if (remaining > 0 && logs.stderr.length > next.stderrOffset) {
        const data = logs.stderr.slice(next.stderrOffset, next.stderrOffset + remaining)
        next = { ...next, stderrOffset: next.stderrOffset + data.length }
        const encoded = await encodeCursorForLogs(next, logs)
        events.push({
          type: "output",
          cursor: encoded,
          timestamp: observedAt,
          stream: "stderr",
          data,
        })
      }

      const outputFullyConsumed =
        next.stdoutOffset === logs.stdout.length && next.stderrOffset === logs.stderr.length
      if (outputFullyConsumed && TERMINAL_PROCESS_STATES.has(status) && !next.terminalSeen) {
        next = { ...next, terminalSeen: true }
        const encoded = await encodeCursorForLogs(next, logs)
        events.push({
          type: "exit",
          cursor: encoded,
          timestamp: snapshot.finishedAt ?? observedAt,
          status,
          exitCode: snapshot.exitCode,
        })
      }

      return { events, nextCursor: await encodeCursorForLogs(next, logs) }
    } finally {
      disposeProviderCapability(process)
    }
  }

  async signal(
    processId: string,
    signal: ProcessSignal,
    known?: ProcessSnapshot,
  ): Promise<ProcessSnapshot> {
    if (signal !== "SIGKILL") {
      throw new BridgeError(
        "PROCESS_SIGNAL_UNSUPPORTED",
        "The Cloudflare Sandbox bridge supports hard process termination only.",
        422,
        { retryable: false, supportedSignals: ["SIGKILL"] },
      )
    }
    const execution = this.#sandbox
    const process = await execution.getProcess(processId)
    if (!process) {
      const recovered = await this.#recoverTerminalProcess(processId, known)
      if (recovered) return recovered
      throw processNotFound()
    }
    try {
      const status = await process.getStatus()
      if (!TERMINAL_PROCESS_STATES.has(status)) {
        // The pinned Sandbox SDK accepts a signal argument in its public type
        // but drops it before calling the container API. Calling the one honest
        // primitive here is therefore deliberately modelled as hard termination.
        await execution.killProcess(processId)
        const killed = await execution.getProcess(processId)
        if (killed) {
          try {
            return await this.#processSnapshot(killed, await killed.getStatus())
          } finally {
            disposeProviderCapability(killed)
          }
        }
        return {
          ...(known ?? (await this.#processSnapshot(process, status))),
          status: "killed",
          finishedAt: new Date().toISOString(),
          exitCode: null,
        }
      }
      return await this.#processSnapshot(process, status)
    } finally {
      disposeProviderCapability(process)
    }
  }

  async send(processId: string, input: ProcessInputRequest): Promise<void> {
    const execution = this.#sandbox
    const process = await execution.getProcess(processId)
    if (!process) throw processNotFound()
    try {
      if (TERMINAL_PROCESS_STATES.has(await process.getStatus())) {
        throw new BridgeError("PROCESS_NOT_RUNNING", "The process is not running.", 409)
      }
    } finally {
      disposeProviderCapability(process)
    }
    const directory = `${STAGING_ROOT}/${processId}.inbox`
    const path = `${directory}/${inputFileName(input.sequence)}`
    const encoded = `${JSON.stringify(input)}\n`
    try {
      const existing = await execution.readFile(path, { encoding: "utf-8" })
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
    await execution.writeFile(path, encoded, { encoding: "utf-8" })
  }

  async wait(
    processId: string,
    timeoutMs: number,
    known?: ProcessSnapshot,
    evidenceDeadline?: string | null,
  ): Promise<ProcessSnapshot> {
    return this.#withinProcessEvidenceBudget(evidenceDeadline, (budget) =>
      this.#waitForProcessEvidence(processId, timeoutMs, known, budget),
    )
  }

  async #waitForProcessEvidence(
    processId: string,
    timeoutMs: number,
    known?: ProcessSnapshot,
    budget?: ProcessEvidenceBudget,
  ): Promise<ProcessSnapshot> {
    const execution = this.#sandbox
    assertProcessEvidenceBudget(budget)
    const process = await execution.getProcess(processId)
    if (!process) {
      const recovered = await this.#recoverTerminalProcess(processId, known, false, budget)
      if (recovered) return recovered
      if (known && !TERMINAL_PROCESS_STATES.has(known.status)) {
        assertProcessEvidenceBudget(budget)
        return known
      }
      throw processNotFound()
    }
    try {
      const status = await process.getStatus()
      if (status === "error") {
        const recovered = await this.#recoverTerminalProcess(processId, known, false, budget)
        if (recovered) return recovered
        if (known && !TERMINAL_PROCESS_STATES.has(known.status)) {
          assertProcessEvidenceBudget(budget)
          return known
        }
      }
      if (!TERMINAL_PROCESS_STATES.has(status)) {
        try {
          await process.waitForExit(processEvidenceWaitMs(timeoutMs, budget))
        } catch (error) {
          if (isProcessReadyTimeoutError(error)) {
            return await this.#processSnapshot(process, status, budget)
          }
          // The SDK resolves getProcess() and opens its exit stream in separate
          // requests. A short-lived process can disappear between them even
          // though its complete logs remain available through getProcessLogs().
          // Recover from that retained provider evidence instead of treating the
          // expected lifecycle race as an opaque platform failure.
          if (isProcessNotFoundError(error)) {
            const recovered = await this.#recoverTerminalProcess(processId, known, false, budget)
            if (recovered) return recovered
            if (known && !TERMINAL_PROCESS_STATES.has(known.status)) {
              assertProcessEvidenceBudget(budget)
              return known
            }
            throw processNotFound()
          }
          throw error
        }
      }
      assertProcessEvidenceBudget(budget)
      const current = await execution.getProcess(processId)
      if (current) {
        try {
          return await this.#processSnapshot(current, await current.getStatus(), budget)
        } finally {
          disposeProviderCapability(current)
        }
      }
      const recovered = await this.#recoverTerminalProcess(processId, known, false, budget)
      if (recovered) return recovered
      if (known && !TERMINAL_PROCESS_STATES.has(known.status)) {
        assertProcessEvidenceBudget(budget)
        return known
      }
      throw processNotFound()
    } finally {
      disposeProviderCapability(process)
    }
  }

  async #withinProcessEvidenceBudget<T>(
    deadline: string | null | undefined,
    operation: (budget: ProcessEvidenceBudget) => Promise<T>,
  ): Promise<T> {
    const now = this.#now()
    assertProcessEvidenceWindow(deadline, now)
    return operation({
      operationDeadlineMs: now + PROCESS_EVIDENCE_OPERATION_TIMEOUT_MS,
      processDeadlineMs: deadline === undefined || deadline === null ? null : Date.parse(deadline),
      now: this.#now,
    })
  }

  async writeFiles(request: WriteFilesRequest): Promise<void> {
    const execution = this.#sandbox
    for (const file of request.files) {
      const path = toWorkspacePath(file.path)
      const parent = path.slice(0, path.lastIndexOf("/"))
      await this.#assertWorkspacePath(execution, path, false)
      if (parent !== WORKSPACE_ROOT) {
        await execution.mkdir(parent, { recursive: true })
      }
      // Re-check after mkdir: an existing workspace component may have been
      // replaced while the provider was creating the missing path.
      await this.#assertWorkspacePath(execution, path, false)
      await execution.writeFile(path, file.contentBase64, { encoding: "base64" })
      await this.#assertWorkspacePath(execution, path, true)
      await this.#applyWorkspaceFileMode(execution, path, file.mode)
    }
  }

  async listFiles(
    path: string,
    recursive: boolean,
    maxEntries: number,
  ): Promise<readonly RuntimeFileInfo[]> {
    const execution = this.#sandbox
    const workspacePath = toWorkspacePath(path)
    await this.#assertWorkspacePath(execution, workspacePath, true)
    const result = await execution.listFiles(workspacePath, {
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
    const execution = this.#sandbox
    const workspacePath = toWorkspacePath(path)
    await this.#assertWorkspacePath(execution, workspacePath, true)
    const size = await this.#workspaceFileSize(execution, workspacePath)
    if (size > maxBytes) {
      throw new BridgeError(
        "FILE_TOO_LARGE",
        "Workspace file exceeds the requested read limit.",
        413,
        { retryable: false },
      )
    }
    const source = await execution.readFileStream(workspacePath)
    return {
      body: decodeWorkspaceFileStream(source, size),
      size,
      mediaType: "application/octet-stream",
    }
  }

  async expose(port: number, hostname: string): Promise<ExposedEndpoint> {
    if (hostname.endsWith(".workers.dev")) {
      throw new BridgeError(
        "PORT_EXPOSURE_REQUIRES_CUSTOM_DOMAIN",
        "Cloudflare port exposure requires a custom domain with wildcard DNS.",
        409,
        { retryable: false },
      )
    }
    const endpoint = await this.#sandbox.exposePort(port, { hostname })
    return { port, url: endpoint.url, expiresOnRuntimeStop: true }
  }

  async unexpose(port: number): Promise<void> {
    await this.#sandbox.unexposePort(port)
  }

  async configureCredentialLease(request: AttachCredentialLeaseRequest): Promise<void> {
    const handlers = Object.fromEntries(
      request.allowedHosts.map((host) => [
        host,
        { method: "credentialEgress", params: { runtimeId: this.#handle.id } },
      ]),
    )
    // Install handlers first. The SDK defers interception until the allowlist
    // enables it, so the single enabling refresh already carries both pieces.
    // Reversing this order creates a brief direct-egress window on recovery.
    await this.#sandbox.setOutboundByHosts(handlers)
    await this.#sandbox.setAllowedHosts(request.allowedHosts)
  }

  async clearCredentialLease(): Promise<void> {
    await this.#sandbox.setAllowedHosts([])
    await this.#sandbox.setOutboundByHosts({})
  }

  #configure(): Promise<void> {
    this.#configuration ??= this.#sandbox.configure({
      sleepAfter: this.#sleepAfter,
      transport: "http",
      containerTimeouts: {
        instanceGetTimeoutMS: CONTAINER_INSTANCE_TIMEOUT_MS,
        portReadyTimeoutMS: CONTAINER_PORT_READY_TIMEOUT_MS,
      },
    })
    return this.#configuration
  }

  async #snapshot(state: RuntimeSnapshot["state"]): Promise<RuntimeSnapshot> {
    // Stopping a Cloudflare container is a terminal provider observation: the
    // process API is no longer available after stop() resolves. Runtime state
    // already owns the zero-process fact for stopped and destroyed snapshots.
    const processes = state === "active" ? await this.#sandbox.listProcesses() : []
    try {
      return {
        handle: this.#handle,
        state,
        processCount: processes.length,
        activeProcessCount: processes.filter(
          (process) => !TERMINAL_PROCESS_STATES.has(process.status),
        ).length,
      }
    } finally {
      disposeProviderProcesses(processes)
    }
  }

  async #logsForReplay(
    processId: string,
    status: ProviderProcessStatus,
    cursor: ReturnType<typeof decodeEventCursor>,
    budget?: ProcessEvidenceBudget,
  ): Promise<ProcessOutputCache> {
    for (let read = 0; ; read += 1) {
      assertProcessEvidenceBudget(budget)
      const logs = await this.#logsForReplayOnce(processId, status, cursor, budget)
      const coversCursor =
        logs.stdout.length >= cursor.stdoutOffset && logs.stderr.length >= cursor.stderrOffset
      if (coversCursor) {
        const [stdoutDigest, stderrDigest] = await Promise.all([
          eventPrefixDigest(logs.stdout.slice(0, cursor.stdoutOffset)),
          eventPrefixDigest(logs.stderr.slice(0, cursor.stderrOffset)),
        ])
        if (stdoutDigest !== cursor.stdoutDigest || stderrDigest !== cursor.stderrDigest) {
          throw eventReplayGap()
        }
        return logs
      }
      if (logs.terminal || read + 1 >= REPLAY_LOG_MAX_READS) throw eventReplayGap()
      this.#processOutput.delete(processId)
      assertProcessEvidenceBudget(budget)
      await this.#sleep(REPLAY_LOG_SETTLE_INTERVAL_MS)
    }
  }

  async #logsForReplayOnce(
    processId: string,
    status: ProviderProcessStatus,
    cursor: ReturnType<typeof decodeEventCursor>,
    budget?: ProcessEvidenceBudget,
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

    let logs: {
      readonly stdout: string
      readonly stderr: string
      readonly processId: string
      readonly exitCode: number | null
    }
    if (terminal) {
      logs = await this.#settledTerminalLogs(processId, status, budget)
    } else {
      // This endpoint is the SDK's retained evidence path after a process
      // leaves getProcess()/listProcesses().
      let retained: { readonly stdout: string; readonly stderr: string; readonly processId: string }
      try {
        retained = await this.#readProcessLogs(processId, budget)
      } catch (error) {
        if (!isProcessNotFoundError(error)) throw error
        retained = { stdout: "", stderr: "", processId }
      }
      const stripped = stripCompletionFrame(retained, processCompletionMarker(processId))
      logs = { ...stripped.logs, exitCode: stripped.exitCode }
    }
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
      terminal: terminal || logs.exitCode !== null,
      exitCode: logs.exitCode,
    }
    this.#processOutput.set(processId, observed)
    return observed
  }

  async #settledTerminalLogs(
    processId: string,
    status: ProviderProcessStatus,
    budget?: ProcessEvidenceBudget,
  ) {
    const marker = processCompletionMarker(processId)
    let current:
      | { readonly stdout: string; readonly stderr: string; readonly processId: string }
      | undefined
    let quietReads = 0
    for (let read = 0; read < TERMINAL_LOG_MAX_READS; read += 1) {
      assertProcessEvidenceBudget(budget)
      let next: { readonly stdout: string; readonly stderr: string; readonly processId: string }
      try {
        next = await this.#readProcessLogs(processId, budget)
      } catch (error) {
        if (!isProcessNotFoundError(error)) throw error
        if (read + 1 < TERMINAL_LOG_MAX_READS) {
          assertProcessEvidenceBudget(budget)
          await this.#sleep(TERMINAL_LOG_SETTLE_INTERVAL_MS)
          continue
        }
        throw processEvidencePending()
      }
      const stripped = stripCompletionFrame(next, marker)
      if (current && next.stdout === current.stdout && next.stderr === current.stderr) {
        quietReads += 1
        if (stripped.complete && quietReads >= TERMINAL_LOG_COMPLETE_QUIET_READS) {
          return { ...stripped.logs, exitCode: stripped.exitCode }
        }
        if (status === "killed" && quietReads >= TERMINAL_LOG_QUIET_READS) {
          return { ...stripCompletionFrame(next, marker).logs, exitCode: null }
        }
      } else {
        quietReads = 0
      }
      current = next
      if (read + 1 < TERMINAL_LOG_MAX_READS) {
        assertProcessEvidenceBudget(budget)
        await this.#sleep(TERMINAL_LOG_SETTLE_INTERVAL_MS)
      }
    }
    if (!current) throw processEvidencePending()
    const stripped = stripCompletionFrame(current, marker)
    if (status === "killed") return { ...stripped.logs, exitCode: null }
    throw new BridgeError(
      "PROCESS_OUTPUT_INCOMPLETE",
      "The provider has not published the complete terminal process output.",
      503,
      {
        retryable: true,
        stdoutBytes: utf8Length(current.stdout),
        completion: completionObservation(current.stderr, marker),
      },
    )
  }

  async #recoverTerminalProcess(
    processId: string,
    known?: ProcessSnapshot,
    waitForPublication = true,
    budget?: ProcessEvidenceBudget,
  ): Promise<ProcessSnapshot | null> {
    if (known && TERMINAL_PROCESS_STATES.has(known.status)) return known
    let logs: {
      readonly stdout: string
      readonly stderr: string
      readonly processId: string
      readonly exitCode: number | null
    }
    try {
      logs = waitForPublication
        ? await this.#settledTerminalLogs(processId, "error", budget)
        : await this.#terminalLogsIfPublished(processId, budget)
    } catch (error) {
      if (isProcessNotFoundError(error)) return null
      throw error
    }
    if (logs.exitCode === null) return null
    return terminalSnapshot(processId, this.#handle.id, known, null, "error", {
      ...logs,
      fetchedAt: Date.now(),
      terminal: true,
    })
  }

  async #terminalLogsIfPublished(processId: string, budget?: ProcessEvidenceBudget) {
    const stripped = stripCompletionFrame(
      await this.#readProcessLogs(processId, budget),
      processCompletionMarker(processId),
    )
    if (!stripped.complete) return { ...stripped.logs, exitCode: null }
    return { ...stripped.logs, exitCode: stripped.exitCode }
  }

  async #readProcessLogs(processId: string, budget?: ProcessEvidenceBudget) {
    assertProcessEvidenceBudget(budget)
    try {
      return await this.#sandbox.getProcessLogs(processId)
    } catch (error) {
      if (isProcessNotFoundError(error)) throw processNotFound()
      throw error
    }
  }

  async #assertWorkspacePath(
    execution: RuntimeExecution,
    path: string,
    requireExisting: boolean,
  ): Promise<void> {
    const result = await execution.exec(WORKSPACE_PATH_PROBE_COMMAND, {
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

  async #applyWorkspaceFileMode(
    execution: RuntimeExecution,
    path: string,
    mode: number,
  ): Promise<void> {
    const result = await execution.exec(WORKSPACE_FILE_MODE_COMMAND, {
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

  async #workspaceFileSize(execution: RuntimeExecution, path: string): Promise<number> {
    const result = await execution.exec(WORKSPACE_FILE_STAT_COMMAND, {
      env: { MEANWHILE_WORKSPACE_PATH: path },
      origin: "internal",
      timeout: WORKSPACE_FILE_STAT_TIMEOUT_MS,
    })
    if (result.exitCode === 45) {
      throw new BridgeError(
        "NOT_REGULAR_FILE",
        "Workspace file reads require a regular file.",
        409,
        { retryable: false },
      )
    }
    const value = result.stdout.trim()
    if (result.exitCode !== 0 || !/^\d+$/.test(value)) {
      throw new BridgeError(
        "WORKSPACE_FILE_INSPECTION_FAILED",
        "Workspace file metadata could not be verified.",
        502,
        {
          providerCode:
            result.exitCode === 0 ? "FILE_STAT_INVALID" : `FILE_STAT_EXIT_${result.exitCode}`,
          retryable: false,
        },
      )
    }
    const size = Number(value)
    if (!Number.isSafeInteger(size)) {
      throw new BridgeError(
        "WORKSPACE_FILE_INSPECTION_FAILED",
        "Workspace file metadata could not be verified.",
        502,
        { providerCode: "FILE_STAT_INVALID", retryable: false },
      )
    }
    return size
  }

  async #removeStagedInput(execution: RuntimeExecution, path: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const stagedInput = await execution.exists(path)
        if (stagedInput.exists) await execution.deleteFile(path)
        return
      } catch (error) {
        const delay = STAGING_CLEANUP_RETRY_DELAYS_MS[attempt]
        if (delay !== undefined && isPlatformTransientError(error)) {
          await this.#sleep(delay)
          continue
        }
        // Runtime lifecycle belongs to the durable registry. The HTTP
        // admission layer will destroy and durably retire this runtime before
        // returning the cleanup failure; the data-plane adapter must not make
        // an unrecorded lifecycle transition on its own.
        throw new BridgeError(
          "STAGING_CLEANUP_FAILED",
          "The staged process input could not be removed.",
          502,
          { retryable: false, runtimeDestroyRequired: true },
        )
      }
    }
  }

  async #processSnapshot(
    process: Process,
    observedStatus?: ProviderProcessStatus,
    budget?: ProcessEvidenceBudget,
  ): Promise<ProcessSnapshot> {
    assertProcessEvidenceBudget(budget)
    const currentProcess = (await this.#sandbox.getProcess(process.id)) ?? process
    try {
      const status = observedStatus ?? currentProcess.status
      return {
        handle: {
          version: BRIDGE_PROTOCOL_VERSION,
          runtimeId: this.#handle.id,
          id: currentProcess.id,
        },
        status,
        pid: currentProcess.pid,
        startedAt: toIsoString(currentProcess.startTime),
        finishedAt: currentProcess.endTime ? toIsoString(currentProcess.endTime) : undefined,
        exitCode: currentProcess.exitCode ?? null,
      }
    } finally {
      if (currentProcess !== process) disposeProviderCapability(currentProcess)
    }
  }
}

function disposeProviderProcesses(processes: readonly Process[]): void {
  for (const process of processes) disposeProviderCapability(process)
}

function disposeProviderCapability(value: unknown): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return
  const disposable = value as {
    readonly [Symbol.dispose]?: () => void
    readonly dispose?: () => void
  }
  const dispose = disposable[Symbol.dispose] ?? disposable.dispose
  if (typeof dispose === "function") dispose.call(value)
}

function decodeWorkspaceFileStream(
  source: ReadableStream<Uint8Array>,
  expectedSize: number,
): ReadableStream<Uint8Array> {
  const iterator = streamFile(source)
  const encoder = new TextEncoder()
  let byteCount = 0
  const closeIterator = async (): Promise<void> => {
    try {
      await iterator.throw(new DOMException("File stream cancelled.", "AbortError"))
    } catch {
      // The original stream result is authoritative; cancellation is cleanup.
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await iterator.next()
        if (result.done) {
          if (result.value.size !== expectedSize || byteCount !== expectedSize) {
            throw new Error("Workspace file changed while it was being read.")
          }
          controller.close()
          return
        }
        const bytes =
          result.value instanceof Uint8Array ? result.value : encoder.encode(result.value)
        byteCount += bytes.byteLength
        if (!Number.isSafeInteger(byteCount) || byteCount > expectedSize) {
          throw new Error("Workspace file changed while it was being read.")
        }
        controller.enqueue(bytes)
      } catch (error) {
        await closeIterator()
        controller.error(error)
      }
    },
    async cancel() {
      await closeIterator()
    },
  })
}

export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ")
}

function shellQuote(argument: string): string {
  return `'${argument.replaceAll("'", `'"'"'`)}'`
}

function buildProcessCommand(
  argv: readonly string[],
  stdinPath: string | undefined,
  completionMarker: string,
): string {
  const command = shellJoin(argv)
  const invocation = stdinPath
    ? shellJoin([
        "/bin/sh",
        "-c",
        `${command} < ${shellQuote(stdinPath)}; meanwhile_input_status=$?; /bin/rm -f -- ${shellQuote(stdinPath)}; exit "$meanwhile_input_status"`,
      ])
    : command
  const marker = shellQuote(completionMarker)
  return `{ ${invocation}; meanwhile_status=$?; /usr/bin/printf '\n%s%s__\n' ${marker} "$meanwhile_status"; /usr/bin/printf '\n%s%s__\n' ${marker} "$meanwhile_status" >&2; (exit "$meanwhile_status"); }`
}

export function processCompletionMarker(processId: string): string {
  return `${PROCESS_COMPLETION_PREFIX}${processId}_`
}

function terminalSnapshot(
  processId: string,
  runtimeId: string,
  known: ProcessSnapshot | undefined,
  process: Process | null,
  providerStatus: ProviderProcessStatus,
  logs: ProcessOutputCache,
): ProcessSnapshot {
  const observedAt = new Date().toISOString()
  const markerStatus =
    logs.exitCode === null
      ? null
      : logs.exitCode === 0
        ? ("completed" as const)
        : ("failed" as const)
  const status = markerStatus ?? providerStatus
  const providerExitCode = process?.exitCode ?? null

  if (logs.exitCode !== null && providerExitCode !== null && providerExitCode !== logs.exitCode) {
    throw processEvidenceConflict()
  }
  if (
    markerStatus !== null &&
    providerStatus !== "error" &&
    TERMINAL_PROCESS_STATES.has(providerStatus) &&
    providerStatus !== markerStatus
  ) {
    throw processEvidenceConflict()
  }

  const snapshot: ProcessSnapshot = {
    handle: { version: BRIDGE_PROTOCOL_VERSION, runtimeId, id: processId },
    status,
    ...((process?.pid ?? known?.pid) === undefined ? {} : { pid: process?.pid ?? known?.pid }),
    startedAt: process ? toIsoString(process.startTime) : (known?.startedAt ?? observedAt),
    ...(TERMINAL_PROCESS_STATES.has(status)
      ? {
          finishedAt: process?.endTime
            ? toIsoString(process.endTime)
            : (known?.finishedAt ?? observedAt),
        }
      : {}),
    exitCode: logs.exitCode ?? providerExitCode,
  }

  if (known && TERMINAL_PROCESS_STATES.has(known.status)) {
    if (
      snapshot.status !== known.status ||
      snapshot.exitCode !== known.exitCode ||
      snapshot.handle.id !== known.handle.id ||
      snapshot.handle.runtimeId !== known.handle.runtimeId
    ) {
      throw processEvidenceConflict()
    }
    return known
  }
  return snapshot
}

function processNotFound(): BridgeError {
  return new BridgeError("PROCESS_NOT_FOUND", "The process does not exist.", 404)
}

function processEvidenceConflict(): BridgeError {
  return new BridgeError(
    "PROCESS_EVIDENCE_CONFLICT",
    "The observed process evidence conflicts with its durable terminal result.",
    409,
    { retryable: false },
  )
}

function processEvidencePending(): BridgeError {
  return new BridgeError(
    "PROCESS_EVIDENCE_PENDING",
    "The provider has not published retained process evidence yet.",
    503,
    { retryable: true },
  )
}

function assertProcessEvidenceWindow(deadline: string | null | undefined, now = Date.now()): void {
  if (deadline === undefined || deadline === null || now < Date.parse(deadline)) return
  throw processLost()
}

function assertProcessEvidenceBudget(budget: ProcessEvidenceBudget | undefined): void {
  if (!budget) return
  const now = budget.now()
  if (budget.processDeadlineMs !== null && now >= budget.processDeadlineMs) throw processLost()
  if (now >= budget.operationDeadlineMs) throw processEvidencePending()
}

function processEvidenceWaitMs(
  requestedMs: number,
  budget: ProcessEvidenceBudget | undefined,
): number {
  if (!budget) return requestedMs
  assertProcessEvidenceBudget(budget)
  return Math.max(1, Math.min(requestedMs, budget.operationDeadlineMs - budget.now()))
}

function processLost(): BridgeError {
  return new BridgeError(
    "PROCESS_LOST",
    "The provider no longer has the process or complete terminal evidence.",
    409,
    { retryable: false },
  )
}

function eventReplayGap(): BridgeError {
  return new BridgeError(
    "EVENT_REPLAY_GAP",
    "Provider log history no longer contains the requested cursor.",
    409,
    { recoverable: false },
  )
}

async function encodeCursorForLogs(
  cursor: ReturnType<typeof decodeEventCursor>,
  logs: Pick<ProcessOutputCache, "stdout" | "stderr">,
): Promise<string> {
  const [stdoutDigest, stderrDigest] = await Promise.all([
    eventPrefixDigest(logs.stdout.slice(0, cursor.stdoutOffset)),
    eventPrefixDigest(logs.stderr.slice(0, cursor.stderrOffset)),
  ])
  return encodeEventCursor({ ...cursor, stdoutDigest, stderrDigest })
}

function isProcessNotFoundError(error: unknown): boolean {
  if (error instanceof BridgeError) return error.code === "PROCESS_NOT_FOUND"
  if (typeof error !== "object" || error === null) return false
  const candidate = error as {
    readonly name?: unknown
    readonly code?: unknown
    readonly errorResponse?: { readonly code?: unknown }
  }
  // The Worker boundary preserves the pinned SDK class name even when
  // prototype getters such as `code` do not survive serialization.
  return (
    candidate.name === "ProcessNotFoundError" ||
    candidate.code === "PROCESS_NOT_FOUND" ||
    candidate.errorResponse?.code === "PROCESS_NOT_FOUND"
  )
}

function isProcessReadyTimeoutError(error: unknown): boolean {
  if (error instanceof ProcessReadyTimeoutError) return true
  if (typeof error !== "object" || error === null) return false
  const candidate = error as {
    readonly name?: unknown
    readonly code?: unknown
    readonly errorResponse?: { readonly code?: unknown }
  }
  return (
    candidate.name === "ProcessReadyTimeoutError" ||
    candidate.code === "PROCESS_READY_TIMEOUT" ||
    candidate.errorResponse?.code === "PROCESS_READY_TIMEOUT"
  )
}

function stripCompletionFrame(
  logs: { readonly stdout: string; readonly stderr: string; readonly processId: string },
  marker: string,
): {
  readonly complete: boolean
  readonly exitCode: number | null
  readonly logs: { readonly stdout: string; readonly stderr: string; readonly processId: string }
} {
  const stdout = stripCompletionMarker(logs.stdout, marker)
  const completion = stripCompletionMarker(logs.stderr, marker)
  if (stdout.complete && completion.complete && stdout.exitCode !== completion.exitCode) {
    throw new BridgeError(
      "PROCESS_EVIDENCE_CONFLICT",
      "The process completion frames disagree across output streams.",
      409,
      { retryable: false },
    )
  }
  return {
    complete: completion.complete,
    exitCode: completion.exitCode,
    logs: {
      ...logs,
      stdout: stdout.value,
      stderr: completion.value,
    },
  }
}

function stripCompletionMarker(
  value: string,
  marker: string,
): { readonly complete: boolean; readonly exitCode: number | null; readonly value: string } {
  const boundary = `\n${marker}`
  const markerIndex = value.lastIndexOf(boundary)
  if (markerIndex < 0) return { complete: false, exitCode: null, value }
  const suffix = value.slice(markerIndex + boundary.length)
  const match = /^(\d{1,3})__[\r\n]*$/.exec(suffix)
  if (!match) return { complete: false, exitCode: null, value }
  const exitCode = Number(match[1])
  if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    return { complete: false, exitCode: null, value }
  }
  return { complete: true, exitCode, value: value.slice(0, markerIndex) }
}

function completionObservation(
  value: string,
  marker: string,
): {
  readonly bytes: number
  readonly markerSeen: boolean
  readonly precededByLineBreak: boolean
  readonly suffixCodeUnits: number | null
  readonly suffixContainsOnlyLineBreaks: boolean | null
} {
  const markerIndex = value.lastIndexOf(marker)
  if (markerIndex < 0) {
    return {
      bytes: utf8Length(value),
      markerSeen: false,
      precededByLineBreak: false,
      suffixCodeUnits: null,
      suffixContainsOnlyLineBreaks: null,
    }
  }
  const suffix = value.slice(markerIndex + marker.length)
  return {
    bytes: utf8Length(value),
    markerSeen: true,
    precededByLineBreak: value[markerIndex - 1] === "\n",
    suffixCodeUnits: suffix.length,
    suffixContainsOnlyLineBreaks: /^[\r\n]*$/.test(suffix),
  }
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
