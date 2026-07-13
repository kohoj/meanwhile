/**
 * The stable compute boundary. Everything crossing it is provider-neutral,
 * persistable, and safe to validate without a provider SDK.
 */

export const RUNTIME_HANDLE_VERSION = 1 as const
export const PROCESS_HANDLE_VERSION = 1 as const
export const PROCESS_SPEC_FINGERPRINT_VERSION = 1 as const
export const MAX_PROCESS_TIMEOUT_MS = 24 * 60 * 60 * 1_000
export const MAX_PROCESS_TERMINATION_GRACE_MS = 60_000

export type RuntimeIsolation = "none" | "container" | "virtual-machine"
export type ProcessSignal = "SIGINT" | "SIGTERM" | "SIGKILL"

export interface RuntimeCapabilities {
  readonly isolation: RuntimeIsolation
  readonly processRecovery: boolean
  readonly eventReplay: boolean
  /** Ordered, idempotent input delivery to an already-running process. */
  readonly processInput: boolean
  readonly portExposure: boolean
  /** Signals delivered with their exact POSIX meaning by this adapter. */
  readonly processSignals: readonly ProcessSignal[]
}

export interface RuntimeProviderProvenance {
  readonly adapterVersion: string
  readonly runnerDigest: string | null
  readonly runtimeImageReference: string | null
  /** Digest of the deployed provider image when the deployment system exposes it. */
  readonly runtimeImageDigest: string | null
  readonly bridgeProtocolVersion: number | null
}

export interface RuntimeHandle {
  readonly kind: "runtime"
  readonly version: typeof RUNTIME_HANDLE_VERSION
  readonly provider: string
  readonly opaque: string
}

export interface ProcessHandle {
  readonly kind: "process"
  readonly version: typeof PROCESS_HANDLE_VERSION
  readonly provider: string
  readonly opaque: string
}

export interface CreateRuntimeInput {
  /** A stable, control-plane-generated identifier. It contains no owner data. */
  readonly runtimeId: string
}

export type RuntimeStatus = "created" | "running" | "stopped" | "missing"

export interface RuntimeState {
  readonly status: RuntimeStatus
  readonly observedAt: string
}

declare const relativePathBrand: unique symbol
export type RelativePath = string & { readonly [relativePathBrand]: true }

export interface ProcessSpec {
  /** Stable control-plane/session identifier used for idempotent spawn. */
  readonly processId: string
  readonly argv: readonly [string, ...string[]]
  readonly cwd: RelativePath
  readonly env?: Readonly<Record<string, string>>
  readonly initialStdin?: string
  /** Keeps a provider-private command mailbox open for later input. */
  readonly input?: "closed" | "mailbox"
  /** Time until the runner/control-plane policy deadline, measured from spawn. */
  readonly timeoutMs?: number
  /**
   * Explicit bounded grace after `timeoutMs`. The provider may hard-kill only
   * after both intervals have elapsed; it is a last-resort safety net rather
   * than the owner of run timeout policy.
   */
  readonly terminationGraceMs?: number
}

export type ProcessStatus = "running" | "exited" | "missing"
export type ProcessExitReason = "exited" | "signaled" | "timed_out" | "unknown"

export interface ProcessExit {
  readonly exitCode: number | null
  readonly signal: ProcessSignal | null
  readonly reason: ProcessExitReason
  readonly exitedAt: string
}

export interface ProcessState {
  readonly status: ProcessStatus
  readonly observedAt: string
  readonly exit?: ProcessExit
}

/**
 * Provider-owned, opaque replay position. `null` means the beginning. Callers
 * persist and return it unchanged; only the originating provider interprets it.
 */
export type EventCursor = string | null

export interface ProcessEvent {
  readonly cursor: Exclude<EventCursor, null>
  readonly timestamp: string
  readonly stream: "stdout" | "stderr"
  /** UTF-8 text. The runner protocol guarantees bounded textual frames. */
  readonly data: string
}

export interface ProcessInput {
  readonly sequence: number
  readonly id: string
  readonly data: string
}

export function assertProcessInput(input: ProcessInput): void {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new TypeError("process input sequence must be a positive safe integer")
  }
  if (!/^[0-9a-f-]{36}$/.test(input.id)) {
    throw new TypeError("process input id must be a lowercase UUID")
  }
  if (new TextEncoder().encode(input.data).byteLength > 1024 * 1024 || input.data.includes("\0")) {
    throw new TypeError("process input data is invalid or exceeds 1 MiB")
  }
}

export interface RuntimeFile {
  readonly path: RelativePath
  readonly content: Uint8Array
  readonly mode?: number
}

export interface RuntimeFileInfo {
  readonly path: RelativePath
  readonly type: "file" | "directory" | "symlink" | "other"
  readonly size: number
  readonly modifiedAt: string
}

export interface ListRuntimeFilesOptions {
  /** Maximum direct children returned by this operation. */
  readonly maxEntries: number
}

export interface ReadRuntimeFileOptions {
  /** Maximum bytes the provider may allocate or return for this read. */
  readonly maxBytes: number
}

export interface ExposedEndpoint {
  readonly port: number
  readonly url: string
  readonly expiresAt?: string
}

export interface ProviderHealth {
  readonly status: "healthy" | "degraded" | "unavailable"
  readonly checkedAt: string
  readonly message?: string
}

export type RuntimeProviderOperation =
  | "resolve"
  | "create"
  | "start"
  | "inspect"
  | "stop"
  | "destroy"
  | "spawn"
  | "inspectProcess"
  | "events"
  | "send"
  | "signal"
  | "wait"
  | "writeFiles"
  | "listFiles"
  | "readFile"
  | "expose"
  | "health"

export interface RuntimeProviderErrorInput {
  readonly provider: string
  readonly operation: RuntimeProviderOperation
  readonly code: string
  readonly message: string
  readonly retryable?: boolean
  readonly cause?: unknown
}

/** Provider failures retain useful provenance without exposing raw bodies. */
export class RuntimeProviderError extends Error {
  readonly provider: string
  readonly operation: RuntimeProviderOperation
  readonly code: string
  readonly retryable: boolean

  constructor(input: RuntimeProviderErrorInput) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = "RuntimeProviderError"
    this.provider = input.provider
    this.operation = input.operation
    this.code = input.code
    this.retryable = input.retryable ?? false
  }

  toJSON(): Omit<RuntimeProviderErrorInput, "cause"> {
    return {
      provider: this.provider,
      operation: this.operation,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    }
  }
}

export interface RuntimeProvider {
  readonly name: string
  readonly capabilities: RuntimeCapabilities
  readonly provenance: RuntimeProviderProvenance

  create(input: CreateRuntimeInput): Promise<RuntimeHandle>
  start(runtime: RuntimeHandle): Promise<void>
  inspect(runtime: RuntimeHandle): Promise<RuntimeState>
  stop(runtime: RuntimeHandle): Promise<void>
  destroy(runtime: RuntimeHandle): Promise<void>

  spawn(runtime: RuntimeHandle, process: ProcessSpec): Promise<ProcessHandle>
  inspectProcess(process: ProcessHandle): Promise<ProcessState>
  /**
   * Observes replayable process output. Aborting observation must only release
   * the caller: it must never signal or otherwise change the process.
   */
  events(
    process: ProcessHandle,
    cursor: EventCursor,
    signal?: AbortSignal,
  ): AsyncIterable<ProcessEvent>
  signal(process: ProcessHandle, signal: ProcessSignal): Promise<void>
  wait(process: ProcessHandle): Promise<ProcessExit>
  /** Available only when `capabilities.processInput` is true. */
  send?(process: ProcessHandle, input: ProcessInput): Promise<void>

  writeFiles(runtime: RuntimeHandle, files: readonly RuntimeFile[]): Promise<void>
  listFiles(
    runtime: RuntimeHandle,
    path: RelativePath,
    options: ListRuntimeFilesOptions,
  ): Promise<RuntimeFileInfo[]>
  readFile(
    runtime: RuntimeHandle,
    path: RelativePath,
    options: ReadRuntimeFileOptions,
  ): Promise<Uint8Array>

  expose?(runtime: RuntimeHandle, port: number): Promise<ExposedEndpoint>
  health(): Promise<ProviderHealth>
}

const RUNTIME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function assertRuntimeId(value: string): void {
  if (!RUNTIME_ID_PATTERN.test(value)) {
    throw new TypeError("runtimeId must be 1-128 ASCII letters, digits, underscores, or hyphens")
  }
}

/**
 * Converts an external path into the only path form accepted by providers.
 * It rejects instead of normalizing so aliases and traversal never cross the
 * boundary silently. `.` denotes the workspace root.
 */
export function relativePath(value: string): RelativePath {
  if (value === ".") return value as RelativePath
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new TypeError("path must be a portable relative workspace path")
  }

  const segments = value.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TypeError("path must not contain empty, current, or parent segments")
  }

  return value as RelativePath
}

export function runtimeHandle(provider: string, opaque: string): RuntimeHandle {
  assertHandleParts(provider, opaque)
  return Object.freeze({
    kind: "runtime",
    version: RUNTIME_HANDLE_VERSION,
    provider,
    opaque,
  })
}

export function processHandle(provider: string, opaque: string): ProcessHandle {
  assertHandleParts(provider, opaque)
  return Object.freeze({
    kind: "process",
    version: PROCESS_HANDLE_VERSION,
    provider,
    opaque,
  })
}

/**
 * Returns the provider hard deadline and enforces the paired timeout contract.
 * A caller that supplies a policy timeout must choose its termination grace
 * explicitly; providers never hide a second timing policy in defaults.
 */
export function processHardTimeoutMs(spec: ProcessSpec): number | undefined {
  if (spec.timeoutMs === undefined && spec.terminationGraceMs === undefined) return undefined
  if (
    !Number.isSafeInteger(spec.timeoutMs) ||
    (spec.timeoutMs ?? 0) <= 0 ||
    (spec.timeoutMs ?? 0) > MAX_PROCESS_TIMEOUT_MS ||
    !Number.isSafeInteger(spec.terminationGraceMs) ||
    (spec.terminationGraceMs ?? 0) <= 0 ||
    (spec.terminationGraceMs ?? 0) > MAX_PROCESS_TERMINATION_GRACE_MS
  ) {
    throw new TypeError(
      `timeoutMs and terminationGraceMs must be paired positive safe integers; timeoutMs must not exceed ${MAX_PROCESS_TIMEOUT_MS} and terminationGraceMs must not exceed ${MAX_PROCESS_TERMINATION_GRACE_MS}`,
    )
  }
  const hardTimeoutMs = (spec.timeoutMs as number) + (spec.terminationGraceMs as number)
  if (!Number.isSafeInteger(hardTimeoutMs)) {
    throw new TypeError("process hard timeout exceeds the supported range")
  }
  return hardTimeoutMs
}

/**
 * Stable idempotency identity without persisting argv, environment values, or
 * initial stdin. Environment entries are sorted and values are independently
 * hashed before the final digest so names remain order-independent and no
 * secret-bearing value crosses the persistence boundary.
 */
export async function processSpecFingerprint(spec: ProcessSpec): Promise<string> {
  const environment = await Promise.all(
    Object.entries(spec.env ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([name, value]) => [name, await sha256(value)] as const),
  )
  const canonical = JSON.stringify({
    version: PROCESS_SPEC_FINGERPRINT_VERSION,
    argv: spec.argv,
    cwd: spec.cwd,
    environment,
    initialStdin: spec.initialStdin === undefined ? null : await sha256(spec.initialStdin),
    input: spec.input ?? "closed",
    timeoutMs: spec.timeoutMs ?? null,
    terminationGraceMs: spec.terminationGraceMs ?? null,
  })
  return `sha256:${await sha256(canonical)}`
}

/** Validates an opaque runtime handle read from durable storage. */
export function restoreRuntimeHandle(value: unknown): RuntimeHandle {
  const kind = isRecord(value) ? Reflect.get(value, "kind") : undefined
  const version = isRecord(value) ? Reflect.get(value, "version") : undefined
  const provider = isRecord(value) ? Reflect.get(value, "provider") : undefined
  const opaque = isRecord(value) ? Reflect.get(value, "opaque") : undefined
  if (
    kind !== "runtime" ||
    version !== RUNTIME_HANDLE_VERSION ||
    typeof provider !== "string" ||
    typeof opaque !== "string"
  ) {
    throw new TypeError("persisted runtime handle is invalid")
  }
  return runtimeHandle(provider, opaque)
}

/** Validates an opaque process handle read from durable storage. */
export function restoreProcessHandle(value: unknown): ProcessHandle {
  const kind = isRecord(value) ? Reflect.get(value, "kind") : undefined
  const version = isRecord(value) ? Reflect.get(value, "version") : undefined
  const provider = isRecord(value) ? Reflect.get(value, "provider") : undefined
  const opaque = isRecord(value) ? Reflect.get(value, "opaque") : undefined
  if (
    kind !== "process" ||
    version !== PROCESS_HANDLE_VERSION ||
    typeof provider !== "string" ||
    typeof opaque !== "string"
  ) {
    throw new TypeError("persisted process handle is invalid")
  }
  return processHandle(provider, opaque)
}

function assertHandleParts(provider: string, opaque: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(provider)) {
    throw new TypeError("provider name must be a canonical lowercase identifier")
  }
  if (opaque.length === 0 || opaque.length > 4096 || opaque.includes("\0")) {
    throw new TypeError("opaque handle must be 1-4096 characters")
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  )
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
