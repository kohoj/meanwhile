import {
  assertRuntimeId,
  type CreateRuntimeInput,
  type EventCursor,
  type ExposedEndpoint,
  type ListRuntimeFilesOptions,
  type ProcessEvent,
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
} from "../../src/providers/runtime-provider"

interface MockProcess {
  readonly runtimeId: string
  readonly id: string
  readonly specFingerprint: string
  readonly events: ProcessEvent[]
  readonly eventWaiters: Set<() => void>
  readonly exitWaiters: Set<(exit: ProcessExit) => void>
  exit: ProcessExit | null
}

interface MockRuntime {
  status: "created" | "running" | "stopped"
  readonly files: Map<string, { content: Uint8Array; mode: number }>
  readonly processes: Set<string>
}

export interface MockProviderOperation {
  readonly operation: RuntimeProviderOperation
  readonly runtimeId?: string
  readonly processId?: string
}

/** Deterministic behavioral fake. Tests drive output and completion explicitly. */
export class MockRuntimeProvider implements RuntimeProvider {
  readonly name: string
  readonly provenance = Object.freeze({
    adapterVersion: "test",
    runnerDigest: "2".repeat(64),
    runtimeImageReference: null,
    runtimeImageDigest: null,
    bridgeProtocolVersion: null,
  })
  readonly capabilities = Object.freeze({
    isolation: "none" as const,
    processRecovery: true,
    eventReplay: true,
    processInput: false,
    portExposure: true,
    processSignals: Object.freeze(["SIGINT", "SIGTERM", "SIGKILL"] as const),
  })
  readonly operations: MockProviderOperation[] = []

  readonly #runtimes = new Map<string, MockRuntime>()
  readonly #processes = new Map<string, MockProcess>()
  constructor(name = "mock") {
    this.name = name
  }

  async create(input: CreateRuntimeInput): Promise<RuntimeHandle> {
    try {
      assertRuntimeId(input.runtimeId)
    } catch (cause) {
      throw this.#error("create", "INVALID_RUNTIME_ID", "Runtime identifier is invalid", cause)
    }
    if (!this.#runtimes.has(input.runtimeId)) {
      this.#runtimes.set(input.runtimeId, {
        status: "created",
        files: new Map(),
        processes: new Set(),
      })
    }
    this.#record("create", input.runtimeId)
    return runtimeHandle(this.name, input.runtimeId)
  }

  async start(runtime: RuntimeHandle): Promise<void> {
    const [runtimeId, state] = this.#runtime(runtime, "start")
    state.status = "running"
    this.#record("start", runtimeId)
  }

  async inspect(runtime: RuntimeHandle, signal?: AbortSignal): Promise<RuntimeState> {
    throwIfAborted(signal)
    const runtimeId = this.#runtimeId(runtime, "inspect")
    const state = this.#runtimes.get(runtimeId)
    this.#record("inspect", runtimeId)
    throwIfAborted(signal)
    return { status: state?.status ?? "missing", observedAt: new Date().toISOString() }
  }

  async stop(runtime: RuntimeHandle): Promise<void> {
    const runtimeId = this.#runtimeId(runtime, "stop")
    const state = this.#runtimes.get(runtimeId)
    if (state === undefined || state.status === "stopped") return
    for (const processId of state.processes) {
      const process = this.#processes.get(processId)
      if (process !== undefined && process.exit === null)
        this.#complete(process, null, "SIGTERM", "signaled")
    }
    state.status = "stopped"
    this.#record("stop", runtimeId)
  }

  async destroy(runtime: RuntimeHandle): Promise<void> {
    const runtimeId = this.#runtimeId(runtime, "destroy")
    const state = this.#runtimes.get(runtimeId)
    if (state === undefined) return
    await this.stop(runtime)
    for (const processId of state.processes) this.#processes.delete(processId)
    this.#runtimes.delete(runtimeId)
    this.#record("destroy", runtimeId)
  }

  async spawn(runtime: RuntimeHandle, spec: ProcessSpec): Promise<ProcessHandle> {
    const [runtimeId, state] = this.#runtime(runtime, "spawn")
    if (state.status !== "running") {
      throw this.#error(
        "spawn",
        "RUNTIME_NOT_RUNNING",
        "Runtime must be running before spawning a process",
      )
    }
    if (spec.argv[0].length === 0 || spec.argv.some((argument) => argument.includes("\0"))) {
      throw this.#error(
        "spawn",
        "INVALID_PROCESS_SPEC",
        "Process executable must be non-empty and argv must be NUL-free",
      )
    }
    try {
      relativePath(String(spec.cwd))
    } catch (cause) {
      throw this.#error(
        "spawn",
        "INVALID_PROCESS_SPEC",
        "Process working directory is invalid",
        cause,
      )
    }
    try {
      assertRuntimeId(spec.processId)
    } catch (cause) {
      throw this.#error("spawn", "INVALID_PROCESS_ID", "Process identifier is invalid", cause)
    }
    const id = spec.processId
    try {
      processHardTimeoutMs(spec)
    } catch (cause) {
      throw this.#error("spawn", "INVALID_PROCESS_SPEC", "Process timing is invalid", cause)
    }
    const specFingerprint = await processSpecFingerprint(spec)
    const existing = this.#processes.get(id)
    if (existing !== undefined && existing.runtimeId === runtimeId) {
      if (existing.specFingerprint !== specFingerprint) {
        throw this.#error(
          "spawn",
          "PROCESS_CONFLICT",
          "Process identifier already belongs to a different specification",
        )
      }
      return processHandle(this.name, `${runtimeId}.${id}`)
    }
    this.#processes.set(id, {
      runtimeId,
      id,
      specFingerprint,
      events: [],
      eventWaiters: new Set(),
      exitWaiters: new Set(),
      exit: null,
    })
    state.processes.add(id)
    this.#record("spawn", runtimeId, id)
    return processHandle(this.name, `${runtimeId}.${id}`)
  }

  async inspectProcess(handle: ProcessHandle): Promise<ProcessState> {
    const process = this.#findProcess(handle, "inspectProcess")
    const observedAt = new Date().toISOString()
    if (process === null) return { status: "missing", observedAt }
    this.#record("inspectProcess", process.runtimeId, process.id)
    return process.exit === null
      ? { status: "running", observedAt }
      : { status: "exited", observedAt, exit: process.exit }
  }

  async *events(
    handle: ProcessHandle,
    cursor: EventCursor,
    signal?: AbortSignal,
  ): AsyncIterable<ProcessEvent> {
    throwIfAborted(signal)
    const process = this.#process(handle, "events")
    let index = parseCursor(cursor, process.events.length, (code, message) =>
      this.#error("events", code, message),
    )
    this.#record("events", process.runtimeId, process.id)

    while (true) {
      throwIfAborted(signal)
      while (index < process.events.length) {
        const event = process.events[index]
        index += 1
        if (event !== undefined) yield event
        throwIfAborted(signal)
      }
      if (process.exit !== null) return
      await waitForEvent(process.eventWaiters, signal)
    }
  }

  async signal(handle: ProcessHandle, signal: ProcessSignal): Promise<void> {
    const process = this.#process(handle, "signal")
    if (process.exit === null) this.#complete(process, null, signal, "signaled")
    this.#record("signal", process.runtimeId, process.id)
  }

  async wait(handle: ProcessHandle): Promise<ProcessExit> {
    const process = this.#process(handle, "wait")
    this.#record("wait", process.runtimeId, process.id)
    if (process.exit !== null) return process.exit
    return new Promise<ProcessExit>((resolve) => process.exitWaiters.add(resolve))
  }

  async writeFiles(runtime: RuntimeHandle, files: readonly RuntimeFile[]): Promise<void> {
    const [runtimeId, state] = this.#runtime(runtime, "writeFiles")
    for (const file of files) {
      const path = relativePath(String(file.path))
      if (path === ".")
        throw this.#error("writeFiles", "INVALID_FILE_PATH", "File path must not be root")
      state.files.set(path, { content: file.content.slice(), mode: file.mode ?? 0o600 })
    }
    this.#record("writeFiles", runtimeId)
  }

  async listFiles(
    runtime: RuntimeHandle,
    path: RelativePath,
    options: ListRuntimeFilesOptions,
    signal?: AbortSignal,
  ): Promise<RuntimeFileInfo[]> {
    throwIfAborted(signal)
    const [runtimeId, state] = this.#runtime(runtime, "listFiles")
    assertNonNegativeLimit(options.maxEntries, "maxEntries")
    const directory = relativePath(String(path))
    const prefix = directory === "." ? "" : `${directory}/`
    const children = new Map<string, "file" | "directory">()
    for (const filePath of state.files.keys()) {
      if (!filePath.startsWith(prefix)) continue
      const remainder = filePath.slice(prefix.length)
      const separator = remainder.indexOf("/")
      const child = separator === -1 ? remainder : remainder.slice(0, separator)
      if (!children.has(child) && children.size >= options.maxEntries) {
        throw this.#error(
          "listFiles",
          "ENTRY_LIMIT_EXCEEDED",
          "Workspace directory exceeds the requested entry limit",
        )
      }
      children.set(child, separator === -1 ? "file" : "directory")
    }
    this.#record("listFiles", runtimeId)
    const result = [...children.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, type]) => {
        const childPath = relativePath(directory === "." ? name : `${directory}/${name}`)
        const file = state.files.get(childPath)
        return {
          path: childPath,
          type,
          size: type === "file" ? (file?.content.byteLength ?? 0) : 0,
          modifiedAt: new Date(0).toISOString(),
        }
      })
    throwIfAborted(signal)
    return result
  }

  async readFile(
    runtime: RuntimeHandle,
    path: RelativePath,
    options: ReadRuntimeFileOptions,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    throwIfAborted(signal)
    const [runtimeId, state] = this.#runtime(runtime, "readFile")
    assertNonNegativeLimit(options.maxBytes, "maxBytes")
    const file = state.files.get(relativePath(String(path)))
    if (file === undefined)
      throw this.#error("readFile", "FILE_NOT_FOUND", "Workspace file does not exist")
    if (file.content.byteLength > options.maxBytes) {
      throw this.#error(
        "readFile",
        "FILE_TOO_LARGE",
        "Workspace file exceeds the requested read limit",
      )
    }
    this.#record("readFile", runtimeId)
    const result = file.content.slice()
    throwIfAborted(signal)
    return result
  }

  async expose(runtime: RuntimeHandle, port: number): Promise<ExposedEndpoint> {
    const [runtimeId, state] = this.#runtime(runtime, "expose")
    if (state.status !== "running") {
      throw this.#error(
        "expose",
        "RUNTIME_NOT_RUNNING",
        "Runtime must be running before exposing a port",
      )
    }
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw this.#error("expose", "INVALID_PORT", "Port is invalid")
    }
    this.#record("expose", runtimeId)
    return { port, url: `http://127.0.0.1:${port}` }
  }

  async health(): Promise<ProviderHealth> {
    this.#record("health")
    return { status: "healthy", checkedAt: new Date().toISOString() }
  }

  emit(handle: ProcessHandle, stream: ProcessEvent["stream"], data: string): ProcessEvent {
    const process = this.#process(handle, "events")
    if (process.exit !== null) throw new Error("cannot emit after process completion")
    const event: ProcessEvent = {
      cursor: String(process.events.length + 1),
      timestamp: new Date().toISOString(),
      stream,
      data,
    }
    process.events.push(event)
    wake(process.eventWaiters)
    return event
  }

  complete(handle: ProcessHandle, exitCode = 0): ProcessExit {
    return this.#complete(this.#process(handle, "wait"), exitCode, null, "exited")
  }

  #complete(
    process: MockProcess,
    exitCode: number | null,
    signal: ProcessSignal | null,
    reason: ProcessExit["reason"],
  ): ProcessExit {
    if (process.exit !== null) return process.exit
    const exit: ProcessExit = {
      exitCode,
      signal,
      reason,
      exitedAt: new Date().toISOString(),
    }
    process.exit = exit
    wake(process.eventWaiters)
    for (const resolve of process.exitWaiters) resolve(exit)
    process.exitWaiters.clear()
    return exit
  }

  #runtimeId(handle: RuntimeHandle, operation: RuntimeProviderOperation): string {
    if (handle.kind !== "runtime" || handle.version !== 1 || handle.provider !== this.name) {
      throw this.#error(
        operation,
        "INVALID_RUNTIME_HANDLE",
        "Runtime handle does not belong to this provider",
      )
    }
    return handle.opaque
  }

  #runtime(handle: RuntimeHandle, operation: RuntimeProviderOperation): [string, MockRuntime] {
    const id = this.#runtimeId(handle, operation)
    const state = this.#runtimes.get(id)
    if (state === undefined)
      throw this.#error(operation, "RUNTIME_NOT_FOUND", "Runtime does not exist")
    return [id, state]
  }

  #process(handle: ProcessHandle, operation: RuntimeProviderOperation): MockProcess {
    const process = this.#findProcess(handle, operation)
    if (process === null) {
      throw this.#error(operation, "PROCESS_NOT_FOUND", "Process does not exist")
    }
    return process
  }

  #findProcess(handle: ProcessHandle, operation: RuntimeProviderOperation): MockProcess | null {
    if (handle.kind !== "process" || handle.version !== 1 || handle.provider !== this.name) {
      throw this.#error(
        operation,
        "INVALID_PROCESS_HANDLE",
        "Process handle does not belong to this provider",
      )
    }
    const separator = handle.opaque.lastIndexOf(".")
    const id = separator === -1 ? "" : handle.opaque.slice(separator + 1)
    const process = this.#processes.get(id) ?? null
    return process
  }

  #record(operation: RuntimeProviderOperation, runtimeId?: string, processId?: string): void {
    this.operations.push({
      operation,
      ...(runtimeId === undefined ? {} : { runtimeId }),
      ...(processId === undefined ? {} : { processId }),
    })
  }

  #error(
    operation: RuntimeProviderOperation,
    code: string,
    message: string,
    cause?: unknown,
  ): RuntimeProviderError {
    return new RuntimeProviderError({ provider: this.name, operation, code, message, cause })
  }
}

function parseCursor(
  cursor: EventCursor,
  length: number,
  error: (code: string, message: string) => RuntimeProviderError,
): number {
  if (cursor === null) return 0
  if (!/^\d+$/.test(cursor)) throw error("INVALID_EVENT_CURSOR", "Event cursor is invalid")
  const index = Number(cursor)
  if (!Number.isSafeInteger(index) || index < 0 || index > length) {
    throw error("INVALID_EVENT_CURSOR", "Event cursor is outside retained output")
  }
  return index
}

function assertNonNegativeLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }
}

function wake(waiters: Set<() => void>): void {
  for (const resolve of waiters) resolve()
  waiters.clear()
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason
}

function waitForEvent(waiters: Set<() => void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return new Promise((resolve) => waiters.add(resolve))
  throwIfAborted(signal)
  return new Promise<void>((resolve, reject) => {
    const wake = () => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }
    const onAbort = () => {
      waiters.delete(wake)
      signal.removeEventListener("abort", onAbort)
      reject(signal.reason)
    }
    waiters.add(wake)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
