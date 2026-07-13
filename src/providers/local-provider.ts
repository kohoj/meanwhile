import { randomUUID } from "node:crypto"
import { closeSync, constants, type Dirent, openSync, readFileSync } from "node:fs"
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises"
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path"
import { SERVICE_VERSION } from "../version"
import {
  assertRuntimeId,
  type CreateRuntimeInput,
  type EventCursor,
  type ExposedEndpoint,
  type ListRuntimeFilesOptions,
  type ProcessExit,
  type ProcessHandle,
  type ProcessSignal,
  type ProcessSpec,
  type ProcessState,
  type ProviderHealth,
  processHandle,
  processHardTimeoutMs,
  processSpecFingerprint,
  type ReadRuntimeFileOptions,
  type RelativePath,
  type RuntimeFile,
  type RuntimeFileInfo,
  type RuntimeHandle,
  type RuntimeProvider,
  RuntimeProviderError,
  type RuntimeProviderOperation,
  type RuntimeState,
  relativePath,
  runtimeHandle,
} from "./runtime-provider"

const PROVIDER_NAME = "local"
const LOCAL_RUNTIME_STATE_VERSION = 1 as const
const LOCAL_PROCESS_STATE_VERSION = 2 as const
const OUTPUT_CHUNK_BYTES = 64 * 1024
const MAX_TIMER_DELAY_MS = 2_147_000_000

interface RuntimeMetadata {
  readonly version: typeof LOCAL_RUNTIME_STATE_VERSION
  readonly runtimeId: string
  readonly status: "created" | "running" | "stopped"
  readonly createdAt: string
  readonly updatedAt: string
}

interface ProcessMetadata {
  readonly version: typeof LOCAL_PROCESS_STATE_VERSION
  readonly runtimeId: string
  readonly processId: string
  readonly specFingerprint: string
  readonly pid: number
  readonly startToken: string | null
  readonly startedAt: string
}

interface LiveProcess {
  readonly pid: number
  readonly exited: Promise<number>
  readonly killLeader: (signal: ProcessSignal) => void
  readonly killGroup: (signal: ProcessSignal) => void
  readonly unref: () => void
  readonly getSignalCode: () => string | null
  completion: Promise<ProcessExit>
  cancelHardTimeout: (() => void) | null
  requestedSignal: ProcessSignal | null
  timedOut: boolean
}

interface ProcessIdentity {
  readonly runtimeId: string
  readonly processId: string
}

interface LocalCursor {
  stdout: number
  stderr: number
}

export interface LocalRuntimeProviderOptions {
  readonly rootDirectory: string
  readonly pollIntervalMs?: number
  readonly stopGraceMs?: number
  readonly maxReadBytes?: number
  /** Explicit non-secret values inherited by every local runtime process. */
  readonly baseEnvironment?: Readonly<Record<string, string>>
  /** Host path used only when argv[0] is the reserved `meanwhile-runner`. */
  readonly runnerExecutable?: string
  readonly runnerDigest?: string
}

/**
 * Complete no-account provider. It deliberately offers process semantics and
 * replay, but no security isolation from the host running the control plane.
 */
export class LocalRuntimeProvider implements RuntimeProvider {
  readonly name = PROVIDER_NAME
  readonly provenance: RuntimeProvider["provenance"]
  readonly capabilities = Object.freeze({
    isolation: "none" as const,
    processRecovery: globalThis.process.platform !== "win32",
    eventReplay: true,
    portExposure: true,
    processSignals: Object.freeze(["SIGINT", "SIGTERM", "SIGKILL"] as const),
  })

  readonly #rootDirectory: string
  readonly #pollIntervalMs: number
  readonly #stopGraceMs: number
  readonly #maxReadBytes: number
  readonly #baseEnvironment: Readonly<Record<string, string>>
  readonly #runnerExecutable: string | null
  readonly #liveProcesses = new Map<string, LiveProcess>()

  constructor(options: LocalRuntimeProviderOptions) {
    if (options.rootDirectory.length === 0) {
      throw new TypeError("rootDirectory is required")
    }
    this.#rootDirectory = resolve(options.rootDirectory)
    this.#pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 25, "pollIntervalMs")
    this.#stopGraceMs = positiveInteger(options.stopGraceMs ?? 5_000, "stopGraceMs")
    this.#maxReadBytes = positiveInteger(options.maxReadBytes ?? 64 * 1024 * 1024, "maxReadBytes")
    if (options.runnerExecutable !== undefined && !isAbsolute(options.runnerExecutable)) {
      throw new TypeError("runnerExecutable must be an absolute host path")
    }
    this.#runnerExecutable = options.runnerExecutable ?? null
    if (options.runnerDigest !== undefined && !/^[a-f0-9]{64}$/.test(options.runnerDigest)) {
      throw new TypeError("runnerDigest must be a SHA-256 digest")
    }
    this.provenance = Object.freeze({
      adapterVersion: SERVICE_VERSION,
      runnerDigest: options.runnerDigest ?? null,
      runtimeImageReference: null,
      runtimeImageDigest: null,
      bridgeProtocolVersion: null,
    })
    const configuredEnvironment = validateEnvironment(options.baseEnvironment ?? {})
    const inheritedPath = String(Reflect.get(Bun.env, "PATH") ?? "/usr/local/bin:/usr/bin:/bin")
    const executablePath = configuredEnvironment["PATH"] ?? inheritedPath
    this.#baseEnvironment = Object.freeze({
      LANG: String(Reflect.get(Bun.env, "LANG") ?? "C.UTF-8"),
      ...configuredEnvironment,
      PATH:
        this.#runnerExecutable === null
          ? executablePath
          : `${dirname(this.#runnerExecutable)}${delimiter}${executablePath}`,
    })
  }

  async create(input: CreateRuntimeInput): Promise<RuntimeHandle> {
    try {
      assertRuntimeId(input.runtimeId)
    } catch (cause) {
      throw this.#error("create", "INVALID_RUNTIME_ID", "Runtime identifier is invalid", cause)
    }

    await this.#ensureRoot("create")
    const handle = runtimeHandle(this.name, input.runtimeId)
    const existing = await this.#readRuntimeMetadata(input.runtimeId, "create", true)
    if (existing !== null) return handle

    const directory = this.#runtimeDirectory(input.runtimeId)
    try {
      await mkdir(this.#workspaceDirectory(input.runtimeId), { recursive: true, mode: 0o700 })
      await mkdir(this.#homeDirectory(input.runtimeId), { recursive: true, mode: 0o700 })
      await mkdir(this.#temporaryDirectory(input.runtimeId), { recursive: true, mode: 0o700 })
      await mkdir(this.#processesDirectory(input.runtimeId), { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700)
      const now = new Date().toISOString()
      await writeJsonAtomic(this.#runtimeMetadataPath(input.runtimeId), {
        version: LOCAL_RUNTIME_STATE_VERSION,
        runtimeId: input.runtimeId,
        status: "created",
        createdAt: now,
        updatedAt: now,
      } satisfies RuntimeMetadata)
      return handle
    } catch (cause) {
      await rm(directory, { recursive: true, force: true })
      throw this.#error(
        "create",
        "RUNTIME_CREATE_FAILED",
        "Local runtime could not be created",
        cause,
      )
    }
  }

  async start(runtime: RuntimeHandle): Promise<void> {
    const runtimeId = this.#runtimeId(runtime, "start")
    const metadata = await this.#requireRuntime(runtimeId, "start")
    if (metadata.status === "running") return
    await this.#writeRuntimeStatus(metadata, "running", "start")
  }

  async inspect(runtime: RuntimeHandle): Promise<RuntimeState> {
    const runtimeId = this.#runtimeId(runtime, "inspect")
    const metadata = await this.#readRuntimeMetadata(runtimeId, "inspect", true)
    return {
      status: metadata?.status ?? "missing",
      observedAt: new Date().toISOString(),
    }
  }

  async stop(runtime: RuntimeHandle): Promise<void> {
    const runtimeId = this.#runtimeId(runtime, "stop")
    const metadata = await this.#readRuntimeMetadata(runtimeId, "stop", true)
    if (metadata === null || metadata.status === "stopped") return

    for (const processId of await this.#listProcessIds(runtimeId, "stop")) {
      await this.#terminate({ runtimeId, processId }, "stop")
    }
    await this.#writeRuntimeStatus(metadata, "stopped", "stop")
  }

  async destroy(runtime: RuntimeHandle): Promise<void> {
    const runtimeId = this.#runtimeId(runtime, "destroy")
    const metadata = await this.#readRuntimeMetadata(runtimeId, "destroy", true)
    if (metadata === null) return
    await this.stop(runtime)
    try {
      await rm(this.#runtimeDirectory(runtimeId), { recursive: true, force: true })
    } catch (cause) {
      throw this.#error(
        "destroy",
        "RUNTIME_DESTROY_FAILED",
        "Local runtime could not be destroyed",
        cause,
        true,
      )
    }
  }

  async spawn(runtime: RuntimeHandle, spec: ProcessSpec): Promise<ProcessHandle> {
    const runtimeId = this.#runtimeId(runtime, "spawn")
    const metadata = await this.#requireRuntime(runtimeId, "spawn")
    if (metadata.status !== "running") {
      throw this.#error(
        "spawn",
        "RUNTIME_NOT_RUNNING",
        "Runtime must be running before spawning a process",
      )
    }
    validateProcessSpec(spec, (code, message, cause) => this.#error("spawn", code, message, cause))
    let hardTimeoutMs: number | undefined
    try {
      hardTimeoutMs = processHardTimeoutMs(spec)
    } catch (cause) {
      throw this.#error("spawn", "INVALID_PROCESS_SPEC", "Process timeout policy is invalid", cause)
    }
    const specFingerprint = await processSpecFingerprint(spec)

    const cwd = await this.#workspacePath(runtimeId, spec.cwd, "spawn", false)
    const cwdState = await safeLstat(cwd)
    if (cwdState === null || !cwdState.isDirectory()) {
      throw this.#error(
        "spawn",
        "WORKING_DIRECTORY_NOT_FOUND",
        "Process working directory does not exist",
      )
    }

    try {
      assertRuntimeId(spec.processId)
    } catch (cause) {
      throw this.#error("spawn", "INVALID_PROCESS_ID", "Process identifier is invalid", cause)
    }
    const processId = spec.processId
    const identity = { runtimeId, processId }
    const directory = this.#processDirectory(identity)
    const existing = await this.#readProcessMetadata(identity, "spawn", true)
    if (existing !== null) {
      if (existing.specFingerprint !== specFingerprint) {
        throw this.#error(
          "spawn",
          "PROCESS_CONFLICT",
          "Process identifier is already bound to a different specification",
        )
      }
      return processHandle(this.name, encodeProcessIdentity(identity))
    }
    await mkdir(directory, { recursive: false, mode: 0o700 })
    const stdoutPath = this.#outputPath(identity, "stdout")
    const stderrPath = this.#outputPath(identity, "stderr")
    let stdoutDescriptor: number | null = null
    let stderrDescriptor: number | null = null

    try {
      stdoutDescriptor = openSync(stdoutPath, "wx", 0o600)
      stderrDescriptor = openSync(stderrPath, "wx", 0o600)
      const argv = [...spec.argv]
      if (argv[0] === "meanwhile-runner") {
        if (this.#runnerExecutable === null) {
          throw this.#error(
            "spawn",
            "RUNNER_NOT_CONFIGURED",
            "Local runner executable is not configured",
          )
        }
        argv[0] = this.#runnerExecutable
      }
      const child = Bun.spawn({
        cmd: argv,
        cwd,
        env: {
          ...this.#baseEnvironment,
          ...spec.env,
          HOME: this.#homeDirectory(runtimeId),
          TMPDIR: this.#temporaryDirectory(runtimeId),
        },
        stdin: spec.initialStdin === undefined ? "ignore" : "pipe",
        stdout: stdoutDescriptor,
        stderr: stderrDescriptor,
        detached: globalThis.process.platform !== "win32",
      })
      closeSync(stdoutDescriptor)
      closeSync(stderrDescriptor)
      stdoutDescriptor = null
      stderrDescriptor = null

      const startedAt = new Date().toISOString()
      const processMetadata: ProcessMetadata = {
        version: LOCAL_PROCESS_STATE_VERSION,
        runtimeId,
        processId,
        specFingerprint,
        pid: child.pid,
        startToken: processStartToken(child.pid),
        startedAt,
      }
      try {
        await writeJsonAtomic(this.#processMetadataPath(identity), processMetadata)
      } catch (cause) {
        killProcessGroup(child.pid, "SIGKILL", () => child.kill("SIGKILL"))
        await child.exited
        throw this.#error(
          "spawn",
          "LOCAL_STATE_WRITE_FAILED",
          "Local process identity could not be persisted",
          cause,
        )
      }

      const live: LiveProcess = {
        pid: child.pid,
        exited: child.exited,
        killLeader: (signal) => child.kill(signal),
        killGroup: (signal) => killProcessGroup(child.pid, signal, () => child.kill(signal)),
        unref: () => child.unref(),
        getSignalCode: () => normalizeSignal(child.signalCode),
        completion: Promise.resolve({
          exitCode: null,
          signal: null,
          reason: "unknown",
          exitedAt: startedAt,
        }),
        cancelHardTimeout: null,
        requestedSignal: null,
        timedOut: false,
      }
      this.#liveProcesses.set(this.#processKey(identity), live)
      live.completion = this.#recordLiveExit(identity, live)

      if (hardTimeoutMs !== undefined) {
        live.cancelHardTimeout = scheduleLongTimeout(hardTimeoutMs, () => {
          live.timedOut = true
          live.requestedSignal = "SIGKILL"
          live.killGroup("SIGKILL")
        })
      }

      if (spec.initialStdin !== undefined) {
        try {
          const stdin = child.stdin
          if (stdin === undefined || typeof stdin === "number") {
            throw new TypeError("spawned process has no writable stdin")
          }
          stdin.write(spec.initialStdin)
          stdin.end()
        } catch (cause) {
          live.requestedSignal = "SIGKILL"
          live.killGroup("SIGKILL")
          await live.completion
          await rm(directory, { recursive: true, force: true })
          throw this.#error(
            "spawn",
            "PROCESS_STDIN_FAILED",
            "Initial process input could not be written",
            cause,
          )
        }
      }

      live.unref()
      return processHandle(this.name, encodeProcessIdentity(identity))
    } catch (cause) {
      if (stdoutDescriptor !== null) closeSync(stdoutDescriptor)
      if (stderrDescriptor !== null) closeSync(stderrDescriptor)
      if (cause instanceof RuntimeProviderError) throw cause
      await rm(directory, { recursive: true, force: true })
      throw this.#error(
        "spawn",
        "PROCESS_START_FAILED",
        "Local process could not be started",
        cause,
      )
    }
  }

  async inspectProcess(process: ProcessHandle): Promise<ProcessState> {
    const identity = this.#processIdentity(process, "inspectProcess")
    const metadata = await this.#readProcessMetadata(identity, "inspectProcess", true)
    const observedAt = new Date().toISOString()
    if (metadata === null) return { status: "missing", observedAt }

    const exit = await this.#readProcessExit(identity, "inspectProcess", true)
    if (exit !== null) return { status: "exited", observedAt, exit }
    if (this.#isLive(identity, metadata)) return { status: "running", observedAt }

    // Another provider instance in this process may own the original child
    // watcher. Give that authoritative observer one poll turn to publish the
    // exact exit before recovery falls back to an unknown terminal fact.
    await Bun.sleep(this.#pollIntervalMs)
    const observedExit = await this.#readProcessExit(identity, "inspectProcess", true)
    if (observedExit !== null) {
      return { status: "exited", observedAt: new Date().toISOString(), exit: observedExit }
    }

    // A recovered leader may have exited while descendants in its provider-owned
    // group remain. Reap the group before publishing the terminal observation.
    killProcessGroup(metadata.pid, "SIGKILL")
    const unknownExit: ProcessExit = {
      exitCode: null,
      signal: null,
      reason: "unknown",
      exitedAt: observedAt,
    }
    await this.#writeExitOnce(identity, unknownExit)
    return { status: "exited", observedAt, exit: unknownExit }
  }

  async *events(
    process: ProcessHandle,
    cursor: EventCursor,
    signal?: AbortSignal,
  ): AsyncIterable<import("./runtime-provider").ProcessEvent> {
    throwIfAborted(signal)
    const identity = this.#processIdentity(process, "events")
    await this.#requireProcess(identity, "events")
    const position = parseLocalCursor(cursor, (code, message, cause) =>
      this.#error("events", code, message, cause),
    )

    while (true) {
      throwIfAborted(signal)
      let emitted = false
      for (const stream of ["stdout", "stderr"] as const) {
        const path = this.#outputPath(identity, stream)
        const size = (await stat(path)).size
        const offset = position[stream]
        if (offset > size) {
          throw this.#error(
            "events",
            "PROCESS_OUTPUT_TRUNCATED",
            "Process replay output was truncated",
          )
        }
        if (offset === size) continue

        const requestedBytes = Math.min(OUTPUT_CHUNK_BYTES, size - offset)
        const bytes = await readBytes(path, offset, requestedBytes)
        const processState = await this.inspectProcess(process)
        const completeBytes =
          processState.status === "exited" ? bytes.byteLength : completeUtf8Length(bytes)
        if (completeBytes === 0) continue

        position[stream] += completeBytes
        emitted = true
        yield {
          cursor: formatLocalCursor(position),
          timestamp: new Date().toISOString(),
          stream,
          data: new TextDecoder().decode(bytes.subarray(0, completeBytes)),
        }
        throwIfAborted(signal)
      }

      const processState = await this.inspectProcess(process)
      if (processState.status !== "running") {
        const stdoutSize = (await stat(this.#outputPath(identity, "stdout"))).size
        const stderrSize = (await stat(this.#outputPath(identity, "stderr"))).size
        if (position.stdout >= stdoutSize && position.stderr >= stderrSize) return
      }
      if (!emitted) await abortableDelay(this.#pollIntervalMs, signal)
    }
  }

  async signal(handle: ProcessHandle, signal: ProcessSignal): Promise<void> {
    const identity = this.#processIdentity(handle, "signal")
    const metadata = await this.#requireProcess(identity, "signal")
    if (await this.#readProcessExit(identity, "signal", true)) return

    const live = this.#liveProcesses.get(this.#processKey(identity))
    try {
      if (live !== undefined) {
        live.requestedSignal = signal
        if (signal === "SIGKILL") {
          live.killGroup(signal)
        } else {
          live.killLeader(signal)
        }
        return
      }
      if (!sameProcess(metadata)) return
      if (signal === "SIGKILL") {
        killProcessGroup(metadata.pid, signal, () => globalThis.process.kill(metadata.pid, signal))
      } else {
        globalThis.process.kill(metadata.pid, signal)
      }
    } catch (cause) {
      if (isErrno(cause, "ESRCH")) return
      throw this.#error(
        "signal",
        "PROCESS_SIGNAL_FAILED",
        "Local process could not be signalled",
        cause,
        true,
      )
    }
  }

  async wait(process: ProcessHandle): Promise<ProcessExit> {
    const identity = this.#processIdentity(process, "wait")
    await this.#requireProcess(identity, "wait")
    const existing = await this.#readProcessExit(identity, "wait", true)
    if (existing !== null) return existing

    const live = this.#liveProcesses.get(this.#processKey(identity))
    if (live !== undefined) return live.completion

    while (true) {
      const state = await this.inspectProcess(process)
      if (state.status === "missing") {
        throw this.#error("wait", "PROCESS_NOT_FOUND", "Local process does not exist")
      }
      if (state.status === "exited" && state.exit !== undefined) return state.exit
      await Bun.sleep(this.#pollIntervalMs)
    }
  }

  async writeFiles(runtime: RuntimeHandle, files: readonly RuntimeFile[]): Promise<void> {
    const runtimeId = this.#runtimeId(runtime, "writeFiles")
    await this.#requireRuntime(runtimeId, "writeFiles")
    const seen = new Set<string>()

    for (const file of files) {
      const logicalPath = this.#validatedPath(file.path, "writeFiles")
      if (logicalPath === "." || seen.has(logicalPath)) {
        throw this.#error(
          "writeFiles",
          "INVALID_FILE_PATH",
          "File paths must be unique non-root paths",
        )
      }
      seen.add(logicalPath)
      validateMode(file.mode, (code, message, cause) =>
        this.#error("writeFiles", code, message, cause),
      )
      const destination = await this.#workspacePath(runtimeId, logicalPath, "writeFiles", true)
      const parent = destination.slice(0, destination.lastIndexOf(sep))
      await mkdir(parent, { recursive: true, mode: 0o700 })
      await this.#assertNoSymlinkPath(runtimeId, logicalPath, "writeFiles", true)
      await writeBytesAtomic(destination, file.content, file.mode ?? 0o600)
    }
  }

  async listFiles(
    runtime: RuntimeHandle,
    path: RelativePath,
    options: ListRuntimeFilesOptions,
  ): Promise<RuntimeFileInfo[]> {
    const runtimeId = this.#runtimeId(runtime, "listFiles")
    await this.#requireRuntime(runtimeId, "listFiles")
    const maxEntries = nonNegativeInteger(options.maxEntries, "maxEntries")
    const logicalPath = this.#validatedPath(path, "listFiles")
    const directory = await this.#workspacePath(runtimeId, logicalPath, "listFiles", false)
    const directoryState = await safeLstat(directory)
    if (directoryState === null || !directoryState.isDirectory()) {
      throw this.#error("listFiles", "DIRECTORY_NOT_FOUND", "Workspace directory does not exist")
    }

    const entries: Dirent[] = []
    const handle = await opendir(directory)
    for await (const entry of handle) {
      if (entries.length >= maxEntries) {
        throw this.#error(
          "listFiles",
          "ENTRY_LIMIT_EXCEEDED",
          "Workspace directory exceeds the requested entry limit",
        )
      }
      entries.push(entry)
    }
    const result: RuntimeFileInfo[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      let childPath: RelativePath
      try {
        childPath = relativePath(logicalPath === "." ? entry.name : `${logicalPath}/${entry.name}`)
      } catch (cause) {
        throw this.#error(
          "listFiles",
          "INVALID_FILE_PATH",
          "Workspace contains a non-portable path",
          cause,
        )
      }
      const childState = await lstat(join(directory, entry.name))
      result.push({
        path: childPath,
        type: childState.isFile()
          ? "file"
          : childState.isDirectory()
            ? "directory"
            : childState.isSymbolicLink()
              ? "symlink"
              : "other",
        size: childState.size,
        modifiedAt: childState.mtime.toISOString(),
      })
    }
    return result
  }

  async readFile(
    runtime: RuntimeHandle,
    path: RelativePath,
    options: ReadRuntimeFileOptions,
  ): Promise<Uint8Array> {
    const runtimeId = this.#runtimeId(runtime, "readFile")
    await this.#requireRuntime(runtimeId, "readFile")
    const requestedMaxBytes = nonNegativeInteger(options.maxBytes, "maxBytes")
    const maxBytes = Math.min(requestedMaxBytes, this.#maxReadBytes)
    const logicalPath = this.#validatedPath(path, "readFile")
    if (logicalPath === ".") {
      throw this.#error("readFile", "FILE_NOT_FOUND", "Workspace file does not exist")
    }
    const filePath = await this.#workspacePath(runtimeId, logicalPath, "readFile", false)
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) {
        throw this.#error("readFile", "FILE_NOT_FOUND", "Workspace file does not exist")
      }
      if (isErrno(cause, "ELOOP")) {
        throw this.#error("readFile", "SYMLINK_NOT_ALLOWED", "Workspace file is a symbolic link")
      }
      throw this.#error("readFile", "LOCAL_STATE_READ_FAILED", "Workspace file could not be opened")
    }
    try {
      const fileState = await handle.stat()
      if (!fileState.isFile()) {
        throw this.#error("readFile", "FILE_NOT_FOUND", "Workspace file does not exist")
      }
      if (fileState.size > maxBytes) {
        throw this.#error(
          "readFile",
          "FILE_TOO_LARGE",
          "Workspace file exceeds the requested read limit",
        )
      }
      const bytes = new Uint8Array(await handle.readFile())
      if (bytes.byteLength > maxBytes || bytes.byteLength !== fileState.size) {
        throw this.#error(
          "readFile",
          "FILE_CHANGED",
          "Workspace file changed while it was being read",
        )
      }
      return bytes
    } finally {
      await handle.close()
    }
  }

  async expose(runtime: RuntimeHandle, port: number): Promise<ExposedEndpoint> {
    const runtimeId = this.#runtimeId(runtime, "expose")
    const metadata = await this.#requireRuntime(runtimeId, "expose")
    if (metadata.status !== "running") {
      throw this.#error(
        "expose",
        "RUNTIME_NOT_RUNNING",
        "Runtime must be running before exposing a port",
      )
    }
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw this.#error("expose", "INVALID_PORT", "Port must be an integer between 1 and 65535")
    }
    return { port, url: `http://127.0.0.1:${port}` }
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString()
    try {
      await this.#ensureRoot("health")
      await access(this.#rootDirectory, constants.R_OK | constants.W_OK | constants.X_OK)
      return {
        status: "healthy",
        checkedAt,
        message: "Local execution is operational and provides no host isolation",
      }
    } catch (cause) {
      if (cause instanceof RuntimeProviderError) {
        return { status: "unavailable", checkedAt, message: cause.message }
      }
      return { status: "unavailable", checkedAt, message: "Local runtime storage is unavailable" }
    }
  }

  async #ensureRoot(operation: RuntimeProviderOperation): Promise<void> {
    try {
      await mkdir(this.#rootDirectory, { recursive: true, mode: 0o700 })
      const rootState = await lstat(this.#rootDirectory)
      if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
        throw new TypeError("local runtime root is not a real directory")
      }
      await chmod(this.#rootDirectory, 0o700)
    } catch (cause) {
      throw this.#error(
        operation,
        "LOCAL_STORAGE_UNAVAILABLE",
        "Local runtime storage is unavailable",
        cause,
        true,
      )
    }
  }

  #runtimeId(handle: RuntimeHandle, operation: RuntimeProviderOperation): string {
    if (handle.kind !== "runtime" || handle.version !== 1 || handle.provider !== this.name) {
      throw this.#error(
        operation,
        "INVALID_RUNTIME_HANDLE",
        "Runtime handle does not belong to this provider",
      )
    }
    try {
      assertRuntimeId(handle.opaque)
      return handle.opaque
    } catch (cause) {
      throw this.#error(operation, "INVALID_RUNTIME_HANDLE", "Runtime handle is invalid", cause)
    }
  }

  #processIdentity(handle: ProcessHandle, operation: RuntimeProviderOperation): ProcessIdentity {
    if (handle.kind !== "process" || handle.version !== 1 || handle.provider !== this.name) {
      throw this.#error(
        operation,
        "INVALID_PROCESS_HANDLE",
        "Process handle does not belong to this provider",
      )
    }
    try {
      return decodeProcessIdentity(handle.opaque)
    } catch (cause) {
      throw this.#error(operation, "INVALID_PROCESS_HANDLE", "Process handle is invalid", cause)
    }
  }

  #validatedPath(path: RelativePath, operation: RuntimeProviderOperation): RelativePath {
    try {
      return relativePath(String(path))
    } catch (cause) {
      throw this.#error(operation, "INVALID_PATH", "Workspace path is invalid", cause)
    }
  }

  async #workspacePath(
    runtimeId: string,
    path: RelativePath,
    operation: RuntimeProviderOperation,
    allowMissingTail: boolean,
  ): Promise<string> {
    const logicalPath = this.#validatedPath(path, operation)
    await this.#assertNoSymlinkPath(runtimeId, logicalPath, operation, allowMissingTail)
    const workspace = this.#workspaceDirectory(runtimeId)
    const candidate = logicalPath === "." ? workspace : resolve(workspace, logicalPath)
    if (candidate !== workspace && !candidate.startsWith(`${workspace}${sep}`)) {
      throw this.#error(operation, "PATH_ESCAPE", "Workspace path escapes the runtime root")
    }
    return candidate
  }

  async #assertNoSymlinkPath(
    runtimeId: string,
    path: RelativePath,
    operation: RuntimeProviderOperation,
    allowMissingTail: boolean,
  ): Promise<void> {
    const workspace = this.#workspaceDirectory(runtimeId)
    const workspaceState = await safeLstat(workspace)
    if (
      workspaceState === null ||
      !workspaceState.isDirectory() ||
      workspaceState.isSymbolicLink()
    ) {
      throw this.#error(operation, "WORKSPACE_UNAVAILABLE", "Runtime workspace is unavailable")
    }
    if (path === ".") return

    let current = workspace
    for (const segment of path.split("/")) {
      current = join(current, segment)
      const currentState = await safeLstat(current)
      if (currentState === null) {
        if (allowMissingTail) return
        throw this.#error(operation, "PATH_NOT_FOUND", "Workspace path does not exist")
      }
      if (currentState.isSymbolicLink()) {
        throw this.#error(
          operation,
          "SYMLINK_NOT_ALLOWED",
          "Workspace path crosses a symbolic link",
        )
      }
    }
  }

  async #requireRuntime(
    runtimeId: string,
    operation: RuntimeProviderOperation,
  ): Promise<RuntimeMetadata> {
    const metadata = await this.#readRuntimeMetadata(runtimeId, operation, true)
    if (metadata === null) {
      throw this.#error(operation, "RUNTIME_NOT_FOUND", "Local runtime does not exist")
    }
    return metadata
  }

  async #readRuntimeMetadata(
    runtimeId: string,
    operation: RuntimeProviderOperation,
    missingAllowed: boolean,
  ): Promise<RuntimeMetadata | null> {
    const value = await readJson(this.#runtimeMetadataPath(runtimeId), missingAllowed)
    if (value === null) return null
    if (!isRuntimeMetadata(value, runtimeId)) {
      throw this.#error(operation, "LOCAL_STATE_CORRUPT", "Local runtime metadata is invalid")
    }
    return value
  }

  async #writeRuntimeStatus(
    metadata: RuntimeMetadata,
    status: RuntimeMetadata["status"],
    operation: RuntimeProviderOperation,
  ): Promise<void> {
    try {
      await writeJsonAtomic(this.#runtimeMetadataPath(metadata.runtimeId), {
        ...metadata,
        status,
        updatedAt: new Date().toISOString(),
      } satisfies RuntimeMetadata)
    } catch (cause) {
      throw this.#error(
        operation,
        "LOCAL_STATE_WRITE_FAILED",
        "Local runtime state could not be persisted",
        cause,
        true,
      )
    }
  }

  async #readProcessMetadata(
    identity: ProcessIdentity,
    operation: RuntimeProviderOperation,
    missingAllowed: boolean,
  ): Promise<ProcessMetadata | null> {
    const value = await readJson(this.#processMetadataPath(identity), missingAllowed)
    if (value === null) return null
    if (!isProcessMetadata(value, identity)) {
      throw this.#error(operation, "LOCAL_STATE_CORRUPT", "Local process metadata is invalid")
    }
    return value
  }

  async #requireProcess(
    identity: ProcessIdentity,
    operation: RuntimeProviderOperation,
  ): Promise<ProcessMetadata> {
    const metadata = await this.#readProcessMetadata(identity, operation, true)
    if (metadata === null) {
      throw this.#error(operation, "PROCESS_NOT_FOUND", "Local process does not exist")
    }
    return metadata
  }

  async #readProcessExit(
    identity: ProcessIdentity,
    operation: RuntimeProviderOperation,
    missingAllowed: boolean,
  ): Promise<ProcessExit | null> {
    const value = await readJson(this.#exitPath(identity), missingAllowed)
    if (value === null) return null
    if (!isProcessExit(value)) {
      throw this.#error(operation, "LOCAL_STATE_CORRUPT", "Local process exit metadata is invalid")
    }
    return value
  }

  async #recordLiveExit(identity: ProcessIdentity, live: LiveProcess): Promise<ProcessExit> {
    const exitCode = await live.exited
    live.cancelHardTimeout?.()
    live.cancelHardTimeout = null
    // The provider process is a session leader. Once it exits, no descendant
    // may outlive the provider-owned process lifecycle.
    live.killGroup("SIGKILL")
    const signal = normalizeProcessSignal(live.getSignalCode()) ?? live.requestedSignal
    const exit: ProcessExit = {
      exitCode: signal === null ? exitCode : null,
      signal,
      reason: live.timedOut ? "timed_out" : signal === null ? "exited" : "signaled",
      exitedAt: new Date().toISOString(),
    }
    await this.#writeExitOnce(identity, exit)
    this.#liveProcesses.delete(this.#processKey(identity))
    return exit
  }

  async #writeExitOnce(identity: ProcessIdentity, exit: ProcessExit): Promise<void> {
    await writeJsonExclusiveAtomic(this.#exitPath(identity), exit)
  }

  #isLive(identity: ProcessIdentity, metadata: ProcessMetadata): boolean {
    const live = this.#liveProcesses.get(this.#processKey(identity))
    return live !== undefined ? live.pid === metadata.pid : sameProcess(metadata)
  }

  async #terminate(identity: ProcessIdentity, operation: "stop" | "destroy"): Promise<void> {
    const handle = processHandle(this.name, encodeProcessIdentity(identity))
    const state = await this.inspectProcess(handle)
    if (state.status !== "running") return
    await this.signal(handle, "SIGTERM")
    if (await this.#waitUntilExited(handle, this.#stopGraceMs)) return
    await this.signal(handle, "SIGKILL")
    if (!(await this.#waitUntilExited(handle, Math.max(1_000, this.#pollIntervalMs * 4)))) {
      throw this.#error(
        operation,
        "PROCESS_STOP_FAILED",
        "Local process did not stop after SIGKILL",
      )
    }
  }

  async #waitUntilExited(handle: ProcessHandle, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await this.inspectProcess(handle)).status !== "running") return true
      await Bun.sleep(Math.min(this.#pollIntervalMs, Math.max(1, deadline - Date.now())))
    }
    return (await this.inspectProcess(handle)).status !== "running"
  }

  async #listProcessIds(runtimeId: string, operation: RuntimeProviderOperation): Promise<string[]> {
    try {
      const entries = await readdir(this.#processesDirectory(runtimeId), { withFileTypes: true })
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) return []
      throw this.#error(
        operation,
        "LOCAL_STATE_READ_FAILED",
        "Local process state could not be read",
        cause,
        true,
      )
    }
  }

  #runtimeDirectory(runtimeId: string): string {
    return join(this.#rootDirectory, runtimeId)
  }

  #runtimeMetadataPath(runtimeId: string): string {
    return join(this.#runtimeDirectory(runtimeId), "runtime.json")
  }

  #workspaceDirectory(runtimeId: string): string {
    return join(this.#runtimeDirectory(runtimeId), "workspace")
  }

  #homeDirectory(runtimeId: string): string {
    return join(this.#runtimeDirectory(runtimeId), "home")
  }

  #temporaryDirectory(runtimeId: string): string {
    return join(this.#runtimeDirectory(runtimeId), "tmp")
  }

  #processesDirectory(runtimeId: string): string {
    return join(this.#runtimeDirectory(runtimeId), "processes")
  }

  #processDirectory(identity: ProcessIdentity): string {
    return join(this.#processesDirectory(identity.runtimeId), identity.processId)
  }

  #processMetadataPath(identity: ProcessIdentity): string {
    return join(this.#processDirectory(identity), "process.json")
  }

  #exitPath(identity: ProcessIdentity): string {
    return join(this.#processDirectory(identity), "exit.json")
  }

  #outputPath(identity: ProcessIdentity, stream: "stdout" | "stderr"): string {
    return join(this.#processDirectory(identity), `${stream}.log`)
  }

  #processKey(identity: ProcessIdentity): string {
    return `${identity.runtimeId}/${identity.processId}`
  }

  #error(
    operation: RuntimeProviderOperation,
    code: string,
    message: string,
    cause?: unknown,
    retryable = false,
  ): RuntimeProviderError {
    return new RuntimeProviderError({
      provider: this.name,
      operation,
      code,
      message,
      retryable,
      cause,
    })
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

function validateEnvironment(
  environment: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes("\0")) {
      throw new TypeError("environment contains an invalid name or value")
    }
    result[name] = value
  }
  return result
}

function validateProcessSpec(
  spec: ProcessSpec,
  error: (code: string, message: string, cause?: unknown) => RuntimeProviderError,
): void {
  if (spec.argv[0].length === 0 || spec.argv.some((argument) => argument.includes("\0"))) {
    throw error(
      "INVALID_PROCESS_SPEC",
      "Process executable must be non-empty and argv must be NUL-free",
    )
  }
  try {
    relativePath(String(spec.cwd))
    validateEnvironment(spec.env ?? {})
  } catch (cause) {
    throw error("INVALID_PROCESS_SPEC", "Process specification is invalid", cause)
  }
  if (spec.initialStdin?.includes("\0")) {
    throw error("INVALID_PROCESS_SPEC", "Initial process input must not contain NUL bytes")
  }
  if (
    spec.timeoutMs !== undefined &&
    (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs <= 0)
  ) {
    throw error("INVALID_PROCESS_SPEC", "Process timeout must be a positive safe integer")
  }
}

function validateMode(
  mode: number | undefined,
  error: (code: string, message: string, cause?: unknown) => RuntimeProviderError,
): void {
  if (mode !== undefined && (!Number.isInteger(mode) || mode < 0 || mode > 0o777)) {
    throw error("INVALID_FILE_MODE", "File mode must contain only Unix permission bits")
  }
}

function encodeProcessIdentity(identity: ProcessIdentity): string {
  return `${identity.runtimeId}.${identity.processId}`
}

function decodeProcessIdentity(value: string): ProcessIdentity {
  const separator = value.lastIndexOf(".")
  if (separator <= 0 || separator === value.length - 1)
    throw new TypeError("invalid process identity")
  const runtimeId = value.slice(0, separator)
  const processId = value.slice(separator + 1)
  assertRuntimeId(runtimeId)
  assertRuntimeId(processId)
  return { runtimeId, processId }
}

function parseLocalCursor(
  cursor: EventCursor,
  error: (code: string, message: string, cause?: unknown) => RuntimeProviderError,
): LocalCursor {
  if (cursor === null) return { stdout: 0, stderr: 0 }
  const match = /^local-v1:(\d+):(\d+)$/.exec(cursor)
  if (match === null)
    throw error("INVALID_EVENT_CURSOR", "Event cursor does not belong to the local provider")
  const stdout = Number(match[1])
  const stderr = Number(match[2])
  if (!Number.isSafeInteger(stdout) || !Number.isSafeInteger(stderr)) {
    throw error("INVALID_EVENT_CURSOR", "Event cursor exceeds the supported range")
  }
  return { stdout, stderr }
}

function formatLocalCursor(cursor: LocalCursor): string {
  return `local-v1:${cursor.stdout}:${cursor.stderr}`
}

async function readBytes(path: string, offset: number, length: number): Promise<Uint8Array> {
  const handle = await open(path, "r")
  try {
    const buffer = new Uint8Array(length)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function completeUtf8Length(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0
  let lead = bytes.length - 1
  while (lead >= 0 && ((bytes[lead] ?? 0) & 0xc0) === 0x80) lead -= 1
  if (lead < 0) return 0
  const byte = bytes[lead] ?? 0
  const expected = byte < 0x80 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
  return bytes.length - lead < expected ? lead : bytes.length
}

function processStartToken(pid: number): string | null {
  if (globalThis.process.platform === "linux") {
    try {
      // Field 22 is the kernel start tick. Parsing after the final `)` keeps
      // process names containing spaces or parentheses from shifting fields.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      const commandEnd = stat.lastIndexOf(")")
      if (commandEnd < 0) return null
      const fieldsAfterCommand = stat
        .slice(commandEnd + 1)
        .trim()
        .split(/\s+/)
      const startTicks = fieldsAfterCommand[19]
      return startTicks === undefined || startTicks.length === 0 ? null : `linux:${startTicks}`
    } catch {
      return null
    }
  }

  try {
    const result = Bun.spawnSync({
      cmd: ["ps", "-o", "lstart=", "-p", String(pid)],
      stdout: "pipe",
      stderr: "ignore",
    })
    if (result.exitCode !== 0) return null
    const token = result.stdout.toString().trim()
    return token.length === 0 ? null : token
  } catch {
    return null
  }
}

function sameProcess(metadata: ProcessMetadata): boolean {
  if (metadata.startToken === null) return false
  return processStartToken(metadata.pid) === metadata.startToken
}

function normalizeSignal(value: string | null): string | null {
  return value === null || value.length === 0 ? null : value
}

function normalizeProcessSignal(value: string | null): ProcessSignal | null {
  return value === "SIGINT" || value === "SIGTERM" || value === "SIGKILL" ? value : null
}

function killProcessGroup(leaderPid: number, signal: ProcessSignal, fallback?: () => void): void {
  try {
    if (globalThis.process.platform !== "win32") {
      globalThis.process.kill(-leaderPid, signal)
      return
    }
    fallback?.()
  } catch (cause) {
    if (isErrno(cause, "ESRCH")) return
    if (fallback !== undefined) {
      try {
        fallback()
        return
      } catch (fallbackCause) {
        if (isErrno(fallbackCause, "ESRCH")) return
        throw fallbackCause
      }
    }
    throw cause
  }
}

function isRuntimeMetadata(value: unknown, runtimeId: string): value is RuntimeMetadata {
  if (!isRecord(value)) return false
  const version = Reflect.get(value, "version")
  const persistedRuntimeId = Reflect.get(value, "runtimeId")
  const status = Reflect.get(value, "status")
  const createdAt = Reflect.get(value, "createdAt")
  const updatedAt = Reflect.get(value, "updatedAt")
  return (
    version === LOCAL_RUNTIME_STATE_VERSION &&
    persistedRuntimeId === runtimeId &&
    (status === "created" || status === "running" || status === "stopped") &&
    typeof createdAt === "string" &&
    typeof updatedAt === "string"
  )
}

function isProcessMetadata(value: unknown, identity: ProcessIdentity): value is ProcessMetadata {
  if (!isRecord(value)) return false
  const version = Reflect.get(value, "version")
  const runtimeId = Reflect.get(value, "runtimeId")
  const processId = Reflect.get(value, "processId")
  const specFingerprint = Reflect.get(value, "specFingerprint")
  const pid = Reflect.get(value, "pid")
  const startToken = Reflect.get(value, "startToken")
  const startedAt = Reflect.get(value, "startedAt")
  return (
    version === LOCAL_PROCESS_STATE_VERSION &&
    runtimeId === identity.runtimeId &&
    processId === identity.processId &&
    typeof specFingerprint === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(specFingerprint) &&
    typeof pid === "number" &&
    (typeof startToken === "string" || startToken === null) &&
    typeof startedAt === "string"
  )
}

function isProcessExit(value: unknown): value is ProcessExit {
  if (!isRecord(value)) return false
  const exitCode = Reflect.get(value, "exitCode")
  const signal = Reflect.get(value, "signal")
  const reason = Reflect.get(value, "reason")
  const exitedAt = Reflect.get(value, "exitedAt")
  return (
    (typeof exitCode === "number" || exitCode === null) &&
    (signal === "SIGINT" || signal === "SIGTERM" || signal === "SIGKILL" || signal === null) &&
    (reason === "exited" ||
      reason === "signaled" ||
      reason === "timed_out" ||
      reason === "unknown") &&
    typeof exitedAt === "string"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function readJson(path: string, missingAllowed: boolean): Promise<unknown | null> {
  let source: string
  try {
    source = await Bun.file(path).text()
  } catch (cause) {
    if (missingAllowed && isErrno(cause, "ENOENT")) return null
    throw cause
  }
  return JSON.parse(source) as unknown
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    })
    await rename(temporaryPath, path)
  } finally {
    await unlink(temporaryPath).catch((cause: unknown) => {
      if (!isErrno(cause, "ENOENT")) throw cause
    })
  }
}

async function writeJsonExclusiveAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    })
    try {
      await link(temporaryPath, path)
    } catch (cause) {
      if (isErrno(cause, "EEXIST")) return
      throw cause
    }
  } finally {
    await unlink(temporaryPath).catch((cause: unknown) => {
      if (!isErrno(cause, "ENOENT")) throw cause
    })
  }
}

async function writeBytesAtomic(path: string, content: Uint8Array, mode: number): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, content, { mode, flag: "wx" })
    await chmod(temporaryPath, mode)
    await rename(temporaryPath, path)
  } finally {
    await unlink(temporaryPath).catch((cause: unknown) => {
      if (!isErrno(cause, "ENOENT")) throw cause
    })
  }
}

async function safeLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path)
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) return null
    throw cause
  }
}

function isErrno(value: unknown, code: string): boolean {
  return value instanceof Error && "code" in value && value.code === code
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await Bun.sleep(milliseconds)
    return
  }
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      reject(signal.reason)
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function scheduleLongTimeout(milliseconds: number, callback: () => void): () => void {
  let remaining = milliseconds
  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelled = false

  const scheduleNext = () => {
    if (cancelled) return
    const delay = Math.min(remaining, MAX_TIMER_DELAY_MS)
    remaining -= delay
    timer = setTimeout(() => {
      timer = null
      if (cancelled) return
      if (remaining === 0) {
        callback()
      } else {
        scheduleNext()
      }
    }, delay)
    timer.unref()
  }

  scheduleNext()
  return () => {
    cancelled = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
}
