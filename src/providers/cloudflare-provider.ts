import type { z } from "zod"
import {
  BRIDGE_PROTOCOL_VERSION,
  bridgeErrorResponseSchema,
  exposedEndpointSchema,
  INITIAL_EVENT_CURSOR,
  processEventsResponseSchema,
  processIdSchema,
  processSnapshotSchema,
  runtimeFileInfoSchema,
  runtimeIdSchema,
  runtimeSnapshotSchema,
} from "../../providers/cloudflare-sandbox/src/protocol"
import { SERVICE_VERSION } from "../version"
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

const PROVIDER_NAME = "cloudflare"
const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_FILE_RESPONSE_BYTES = 64 * 1024 * 1024
const MAX_FILE_ENCODED_BYTES = 8 * 1024 * 1024
const MAX_WRITE_ENCODED_BYTES = 16 * 1024 * 1024
const MAX_FILES_PER_WRITE = 32
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([100, 250, 500, 1_000, 2_000])

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

interface CloudflareProcessIdentity {
  readonly runtimeId: string
  readonly processId: string
}

export interface CloudflareRuntimeProviderOptions {
  readonly bridgeUrl: string
  readonly bridgeToken: string
  readonly fetch?: Fetch
  readonly requestTimeoutMs?: number
  readonly eventPollIntervalMs?: number
  readonly eventPageCharacters?: number
  readonly retryDelaysMs?: readonly number[]
  readonly waitRequestMs?: number
  readonly runtimeImageReference?: string
  readonly runtimeImageDigest?: string
  readonly runnerDigest?: string
}

/**
 * Provider-neutral HTTP client for the independently deployed Cloudflare
 * bridge. Cloudflare SDK types and credentials never cross this module.
 */
export class CloudflareRuntimeProvider implements RuntimeProvider {
  readonly name = PROVIDER_NAME
  readonly provenance: RuntimeProvider["provenance"]
  readonly capabilities = Object.freeze({
    isolation: "container" as const,
    processRecovery: true,
    eventReplay: true,
    portExposure: true,
    // Sandbox SDK 0.12.3 exposes hard termination only. Advertising fewer
    // semantics is safer than pretending its ignored signal argument is real.
    processSignals: Object.freeze(["SIGKILL"] as const),
  })

  readonly #bridgeUrl: URL
  readonly #bridgeToken: string
  readonly #fetch: Fetch
  readonly #requestTimeoutMs: number
  readonly #eventPollIntervalMs: number
  readonly #eventPageCharacters: number
  readonly #retryDelaysMs: readonly number[]
  readonly #waitRequestMs: number

  constructor(options: CloudflareRuntimeProviderOptions) {
    if (
      options.runtimeImageReference !== undefined &&
      (!/^\S+$/.test(options.runtimeImageReference) || options.runtimeImageReference.length > 512)
    ) {
      throw new TypeError("runtimeImageReference must be a non-empty custom image reference")
    }
    if (
      options.runtimeImageDigest !== undefined &&
      !/^sha256:[a-f0-9]{64}$/.test(options.runtimeImageDigest)
    ) {
      throw new TypeError("runtimeImageDigest must be a sha256: digest")
    }
    if (options.runnerDigest !== undefined && !/^[a-f0-9]{64}$/.test(options.runnerDigest)) {
      throw new TypeError("runnerDigest must be a SHA-256 digest")
    }
    this.provenance = Object.freeze({
      adapterVersion: SERVICE_VERSION,
      runnerDigest: options.runnerDigest ?? null,
      runtimeImageReference: options.runtimeImageReference ?? null,
      runtimeImageDigest: options.runtimeImageDigest ?? null,
      bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
    })
    this.#bridgeUrl = parseBridgeUrl(options.bridgeUrl)
    if (new TextEncoder().encode(options.bridgeToken).byteLength < 32) {
      throw new TypeError("bridgeToken must contain at least 32 UTF-8 bytes")
    }
    this.#bridgeToken = options.bridgeToken
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? 30_000, "requestTimeoutMs")
    this.#eventPollIntervalMs = positiveInteger(
      options.eventPollIntervalMs ?? 250,
      "eventPollIntervalMs",
    )
    this.#eventPageCharacters = positiveInteger(
      options.eventPageCharacters ?? 65_536,
      "eventPageCharacters",
    )
    if (this.#eventPageCharacters > 262_144) {
      throw new TypeError("eventPageCharacters must not exceed the bridge limit")
    }
    this.#retryDelaysMs = retryDelays(options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS)
    this.#waitRequestMs = positiveInteger(options.waitRequestMs ?? 20_000, "waitRequestMs")
    if (this.#waitRequestMs > 25_000) {
      throw new TypeError("waitRequestMs must not exceed the bridge limit")
    }
  }

  async create(input: CreateRuntimeInput): Promise<RuntimeHandle> {
    try {
      assertRuntimeId(input.runtimeId)
    } catch (cause) {
      throw this.#error("create", "INVALID_RUNTIME_ID", "Runtime identifier is invalid", cause)
    }
    const operationId = await deterministicUuid(`runtime:${input.runtimeId}`)
    const snapshot = requireValue(
      await this.#snapshotRequest(
        "create",
        "POST",
        "v1/runtimes",
        { operationId },
        "runtime",
        runtimeSnapshotSchema,
      ),
      () => this.#error("create", "BRIDGE_PROTOCOL_ERROR", "Cloudflare bridge returned no runtime"),
    )
    return runtimeHandle(this.name, snapshot.handle.id)
  }

  async start(runtime: RuntimeHandle): Promise<void> {
    const runtimeId = this.#runtimeId(runtime, "start")
    await this.#snapshotRequest(
      "start",
      "POST",
      `v1/runtimes/${runtimeId}/start`,
      undefined,
      "runtime",
      runtimeSnapshotSchema,
    )
  }

  async inspect(runtime: RuntimeHandle): Promise<RuntimeState> {
    const runtimeId = this.#runtimeId(runtime, "inspect")
    const snapshot = await this.#snapshotRequest(
      "inspect",
      "GET",
      `v1/runtimes/${runtimeId}`,
      undefined,
      "runtime",
      runtimeSnapshotSchema,
      true,
    )
    const observedAt = new Date().toISOString()
    if (snapshot === null || snapshot.state === "destroyed")
      return { status: "missing", observedAt }
    if (snapshot.state === "unknown") {
      throw this.#error(
        "inspect",
        "RUNTIME_STATE_UNKNOWN",
        "Cloudflare runtime state is temporarily unknown",
        undefined,
        true,
      )
    }
    return {
      status:
        snapshot.state === "created"
          ? "created"
          : snapshot.state === "stopped"
            ? "stopped"
            : "running",
      observedAt,
    }
  }

  async stop(runtime: RuntimeHandle): Promise<void> {
    const runtimeId = this.#runtimeId(runtime, "stop")
    await this.#snapshotRequest(
      "stop",
      "POST",
      `v1/runtimes/${runtimeId}/stop`,
      undefined,
      "runtime",
      runtimeSnapshotSchema,
      true,
    )
  }

  async destroy(runtime: RuntimeHandle): Promise<void> {
    const runtimeId = this.#runtimeId(runtime, "destroy")
    await this.#snapshotRequest(
      "destroy",
      "DELETE",
      `v1/runtimes/${runtimeId}`,
      undefined,
      "runtime",
      runtimeSnapshotSchema,
      true,
    )
  }

  async spawn(runtime: RuntimeHandle, spec: ProcessSpec): Promise<ProcessHandle> {
    const runtimeId = this.#runtimeId(runtime, "spawn")
    validateProcessSpec(spec, (code, message, cause) => this.#error("spawn", code, message, cause))
    const operationId = await deterministicUuid(`process:${runtimeId}:${spec.processId}`)
    const snapshot = requireValue(
      await this.#snapshotRequest(
        "spawn",
        "POST",
        `v1/runtimes/${runtimeId}/processes`,
        {
          operationId,
          argv: [...spec.argv],
          cwd: spec.cwd,
          ...(spec.env === undefined ? {} : { env: spec.env }),
          ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
          ...(spec.terminationGraceMs === undefined
            ? {}
            : { terminationGraceMs: spec.terminationGraceMs }),
          ...(spec.initialStdin === undefined ? {} : { stdin: spec.initialStdin }),
        },
        "process",
        processSnapshotSchema,
      ),
      () => this.#error("spawn", "BRIDGE_PROTOCOL_ERROR", "Cloudflare bridge returned no process"),
    )
    if (snapshot.handle.runtimeId !== runtimeId) {
      throw this.#error(
        "spawn",
        "BRIDGE_PROTOCOL_ERROR",
        "Cloudflare bridge returned a process for another runtime",
      )
    }
    return processHandle(
      this.name,
      encodeProcessIdentity({ runtimeId, processId: snapshot.handle.id }),
    )
  }

  async inspectProcess(process: ProcessHandle): Promise<ProcessState> {
    const identity = this.#processIdentity(process, "inspectProcess")
    const snapshot = await this.#snapshotRequest(
      "inspectProcess",
      "GET",
      this.#processPath(identity),
      undefined,
      "process",
      processSnapshotSchema,
      true,
    )
    const observedAt = new Date().toISOString()
    if (snapshot === null) return { status: "missing", observedAt }
    return processState(snapshot, observedAt)
  }

  async *events(
    process: ProcessHandle,
    cursor: EventCursor,
    signal?: AbortSignal,
  ): AsyncIterable<ProcessEvent> {
    throwIfAborted(signal)
    const identity = this.#processIdentity(process, "events")
    let position = cursor ?? INITIAL_EVENT_CURSOR

    while (true) {
      throwIfAborted(signal)
      const query = new URLSearchParams({
        cursor: position,
        limitChars: String(this.#eventPageCharacters),
      })
      const response = await this.#validatedJsonRequest(
        "events",
        "GET",
        `${this.#processPath(identity)}/events?${query}`,
        undefined,
        processEventsResponseSchema,
        undefined,
        signal,
      )
      position = response.nextCursor
      let terminal = false
      for (const event of response.events) {
        if (event.type === "exit") {
          terminal = true
          continue
        }
        yield {
          cursor: event.cursor,
          timestamp: event.timestamp,
          stream: event.stream,
          data: event.data,
        }
        throwIfAborted(signal)
      }
      if (terminal) return
      if (response.events.length > 0) continue

      const snapshot = await this.#snapshotRequest(
        "events",
        "GET",
        this.#processPath(identity),
        undefined,
        "process",
        processSnapshotSchema,
        true,
        undefined,
        signal,
      )
      if (snapshot === null || (snapshot.status !== "starting" && snapshot.status !== "running")) {
        return
      }
      await abortableDelay(this.#eventPollIntervalMs, signal)
    }
  }

  async signal(process: ProcessHandle, signal: ProcessSignal): Promise<void> {
    const identity = this.#processIdentity(process, "signal")
    if (!this.capabilities.processSignals.includes(signal as "SIGKILL")) {
      throw this.#error(
        "signal",
        "PROCESS_SIGNAL_UNSUPPORTED",
        "Cloudflare runtime supports hard process termination only",
      )
    }
    await this.#snapshotRequest(
      "signal",
      "POST",
      `${this.#processPath(identity)}/signal`,
      { signal },
      "process",
      processSnapshotSchema,
      true,
    )
  }

  async wait(process: ProcessHandle): Promise<ProcessExit> {
    const identity = this.#processIdentity(process, "wait")
    while (true) {
      const query = new URLSearchParams({ timeoutMs: String(this.#waitRequestMs) })
      const snapshot = requireValue(
        await this.#snapshotRequest(
          "wait",
          "GET",
          `${this.#processPath(identity)}/wait?${query}`,
          undefined,
          "process",
          processSnapshotSchema,
          true,
          this.#waitRequestMs + 5_000,
        ),
        () => this.#error("wait", "PROCESS_NOT_FOUND", "Cloudflare process does not exist"),
      )
      const state = processState(snapshot, new Date().toISOString())
      if (state.status === "exited" && state.exit !== undefined) return state.exit
    }
  }

  async writeFiles(runtime: RuntimeHandle, files: readonly RuntimeFile[]): Promise<void> {
    const runtimeId = this.#runtimeId(runtime, "writeFiles")
    if (files.length === 0) return
    const encoded = files.map((file) => {
      const mode = file.mode ?? 0o600
      if (!Number.isInteger(mode) || mode < 0 || mode > 0o777 || (mode & 0o600) !== 0o600) {
        throw this.#error(
          "writeFiles",
          "INVALID_FILE_MODE",
          "Workspace file mode must preserve owner read and write access",
        )
      }
      let path: RelativePath
      try {
        path = relativePath(String(file.path))
      } catch (cause) {
        throw this.#error("writeFiles", "INVALID_PATH", "Workspace file path is invalid", cause)
      }
      if (path === ".") {
        throw this.#error("writeFiles", "INVALID_FILE_PATH", "Workspace file path must not be root")
      }
      const contentBase64 = Buffer.from(file.content).toString("base64")
      if (contentBase64.length > MAX_FILE_ENCODED_BYTES) {
        throw this.#error(
          "writeFiles",
          "FILE_TOO_LARGE",
          "Workspace file exceeds the bridge write limit",
        )
      }
      return { path, contentBase64, mode }
    })

    for (const batch of fileBatches(encoded)) {
      await this.#jsonRequest("writeFiles", "PUT", `v1/runtimes/${runtimeId}/files`, {
        files: batch,
      })
    }
  }

  async listFiles(
    runtime: RuntimeHandle,
    path: RelativePath,
    options: ListRuntimeFilesOptions,
  ): Promise<RuntimeFileInfo[]> {
    const runtimeId = this.#runtimeId(runtime, "listFiles")
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 0) {
      throw this.#error("listFiles", "INVALID_LIMIT", "Workspace entry limit is invalid")
    }
    let logicalPath: RelativePath
    try {
      logicalPath = relativePath(String(path))
    } catch (cause) {
      throw this.#error("listFiles", "INVALID_PATH", "Workspace directory path is invalid", cause)
    }
    const query = new URLSearchParams({
      path: logicalPath,
      recursive: "false",
      maxEntries: String(options.maxEntries),
    })
    const payload = await this.#jsonRequest(
      "listFiles",
      "GET",
      `v1/runtimes/${runtimeId}/files?${query}`,
    )
    const files = selectAndParse(payload, "files", runtimeFileInfoSchema.array(), (cause) =>
      this.#error(
        "listFiles",
        "BRIDGE_PROTOCOL_ERROR",
        "Cloudflare bridge returned invalid file metadata",
        cause,
      ),
    )
    if (files.length > options.maxEntries) {
      throw this.#error(
        "listFiles",
        "BRIDGE_PROTOCOL_ERROR",
        "Cloudflare bridge exceeded the requested entry limit",
      )
    }
    return files.map((file) => ({
      path: relativePath(file.path),
      type: file.type,
      size: file.size,
      modifiedAt: file.modifiedAt,
    }))
  }

  async readFile(
    runtime: RuntimeHandle,
    path: RelativePath,
    options: ReadRuntimeFileOptions,
  ): Promise<Uint8Array> {
    const runtimeId = this.#runtimeId(runtime, "readFile")
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
      throw this.#error("readFile", "INVALID_LIMIT", "Workspace read limit is invalid")
    }
    const maxBytes = Math.min(options.maxBytes, MAX_FILE_RESPONSE_BYTES)
    let logicalPath: RelativePath
    try {
      logicalPath = relativePath(String(path))
    } catch (cause) {
      throw this.#error("readFile", "INVALID_PATH", "Workspace file path is invalid", cause)
    }
    if (logicalPath === ".") {
      throw this.#error("readFile", "INVALID_FILE_PATH", "Workspace file path must not be root")
    }
    const query = new URLSearchParams({ path: logicalPath, maxBytes: String(maxBytes) })
    const response = await this.#request(
      "readFile",
      "GET",
      `v1/runtimes/${runtimeId}/file?${query}`,
      undefined,
      true,
    )
    if (response === null) {
      throw this.#error("readFile", "FILE_NOT_FOUND", "Workspace file does not exist")
    }
    const declaredLength = Number(response.headers.get("content-length"))
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw this.#error(
        "readFile",
        "FILE_TOO_LARGE",
        "Workspace file exceeds the provider read limit",
      )
    }
    return readBoundedResponse(response, maxBytes, () =>
      this.#error("readFile", "FILE_TOO_LARGE", "Workspace file exceeds the provider read limit"),
    )
  }

  async expose(runtime: RuntimeHandle, port: number): Promise<ExposedEndpoint> {
    const runtimeId = this.#runtimeId(runtime, "expose")
    if (!Number.isInteger(port) || port < 1_024 || port > 65_535 || port === 3_000) {
      throw this.#error(
        "expose",
        "INVALID_PORT",
        "Cloudflare preview port must be between 1024 and 65535 and must not use reserved port 3000",
      )
    }
    const payload = await this.#jsonRequest(
      "expose",
      "POST",
      `v1/runtimes/${runtimeId}/ports/${port}/expose`,
    )
    const endpoint = selectAndParse(payload, "endpoint", exposedEndpointSchema, (cause) =>
      this.#error(
        "expose",
        "BRIDGE_PROTOCOL_ERROR",
        "Cloudflare bridge returned an invalid endpoint",
        cause,
      ),
    )
    return { port: endpoint.port, url: endpoint.url }
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString()
    try {
      const payload = await this.#jsonRequest("health", "GET", "v1/health")
      if (
        !isRecord(payload) ||
        Reflect.get(payload, "status") !== "ok" ||
        Reflect.get(payload, "protocolVersion") !== BRIDGE_PROTOCOL_VERSION
      ) {
        return {
          status: "unavailable",
          checkedAt,
          message: "Cloudflare bridge protocol is incompatible",
        }
      }
      return { status: "healthy", checkedAt }
    } catch (cause) {
      return {
        status:
          cause instanceof RuntimeProviderError && cause.retryable ? "degraded" : "unavailable",
        checkedAt,
        message:
          cause instanceof RuntimeProviderError
            ? cause.message
            : "Cloudflare bridge is unavailable",
      }
    }
  }

  async #snapshotRequest<Output>(
    operation: RuntimeProviderOperation,
    method: string,
    path: string,
    body: unknown,
    key: string,
    schema: z.ZodType<Output>,
    allowNotFound = false,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<Output | null> {
    const rawResponse = await this.#request(
      operation,
      method,
      path,
      body,
      allowNotFound,
      timeoutMs,
      signal,
    )
    if (rawResponse === null) return null
    const response = await parseJsonBody(rawResponse, (code, message, cause) =>
      this.#error(operation, code, message, cause),
    )
    return selectAndParse(response, key, schema, (cause) =>
      this.#error(
        operation,
        "BRIDGE_PROTOCOL_ERROR",
        "Cloudflare bridge returned an invalid response",
        cause,
      ),
    )
  }

  async #jsonRequest(
    operation: RuntimeProviderOperation,
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.#request(operation, method, path, body, false, timeoutMs, signal)
    if (response === null) {
      throw this.#error(
        operation,
        "BRIDGE_PROTOCOL_ERROR",
        "Cloudflare bridge returned no response",
      )
    }
    const value = await parseJsonBody(response, (code, message, cause) =>
      this.#error(operation, code, message, cause),
    )
    return value
  }

  async #validatedJsonRequest<Output>(
    operation: RuntimeProviderOperation,
    method: string,
    path: string,
    body: unknown,
    schema: z.ZodType<Output>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<Output> {
    const value = await this.#jsonRequest(operation, method, path, body, timeoutMs, signal)
    const result = schema.safeParse(value)
    if (!result.success) {
      throw this.#error(
        operation,
        "BRIDGE_PROTOCOL_ERROR",
        "Cloudflare bridge returned an invalid response",
        result.error,
      )
    }
    return result.data
  }

  async #request(
    operation: RuntimeProviderOperation,
    method: string,
    path: string,
    body?: unknown,
    allowNotFound = false,
    timeoutMs = this.#requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<Response | null> {
    const requestId = randomUuid()
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#requestOnce(
          operation,
          method,
          path,
          body,
          allowNotFound,
          timeoutMs,
          requestId,
          signal,
        )
      } catch (error) {
        const delay = this.#retryDelaysMs[attempt]
        if (!(error instanceof RuntimeProviderError) || !error.retryable || delay === undefined) {
          throw error
        }
        await abortableDelay(delay, signal)
      }
    }
  }

  async #requestOnce(
    operation: RuntimeProviderOperation,
    method: string,
    path: string,
    body: unknown,
    allowNotFound: boolean,
    timeoutMs: number,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<Response | null> {
    throwIfAborted(signal)
    const url = new URL(path, this.#bridgeUrl)
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${this.#bridgeToken}`,
      "x-meanwhile-protocol-version": String(BRIDGE_PROTOCOL_VERSION),
      "x-request-id": requestId,
    })
    if (body !== undefined) headers.set("content-type", "application/json")

    let response: Response
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs)
      response = await this.#fetch(url, {
        method,
        headers,
        signal: signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (cause) {
      throwIfAborted(signal)
      const timedOut = cause instanceof DOMException && cause.name === "TimeoutError"
      throw this.#error(
        operation,
        timedOut ? "BRIDGE_TIMEOUT" : "BRIDGE_UNAVAILABLE",
        timedOut ? "Cloudflare bridge request timed out" : "Cloudflare bridge is unavailable",
        cause,
        true,
      )
    }

    throwIfAborted(signal)
    if (response.ok) return response
    if (allowNotFound && response.status === 404) return null
    const retryableStatus = response.status === 429 || response.status >= 500
    const value = await parseJsonBody(response, (code, message, cause) =>
      this.#error(operation, code, message, cause, retryableStatus),
    )
    const parsed = bridgeErrorResponseSchema.safeParse(value)
    if (!parsed.success) {
      throw this.#error(
        operation,
        "BRIDGE_PROTOCOL_ERROR",
        "Cloudflare bridge returned an invalid error response",
        parsed.error,
        retryableStatus,
      )
    }
    const bridgeError = parsed.data.error
    const retryable = Reflect.get(bridgeError.details, "retryable") === true || retryableStatus
    throw this.#error(operation, bridgeError.code, bridgeError.message, undefined, retryable)
  }

  #runtimeId(handle: RuntimeHandle, operation: RuntimeProviderOperation): string {
    if (handle.kind !== "runtime" || handle.version !== 1 || handle.provider !== this.name) {
      throw this.#error(
        operation,
        "INVALID_RUNTIME_HANDLE",
        "Runtime handle does not belong to this provider",
      )
    }
    const result = runtimeIdSchema.safeParse(handle.opaque)
    if (!result.success) {
      throw this.#error(
        operation,
        "INVALID_RUNTIME_HANDLE",
        "Runtime handle is invalid",
        result.error,
      )
    }
    return result.data
  }

  #processIdentity(
    handle: ProcessHandle,
    operation: RuntimeProviderOperation,
  ): CloudflareProcessIdentity {
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

  #processPath(identity: CloudflareProcessIdentity): string {
    return `v1/runtimes/${identity.runtimeId}/processes/${identity.processId}`
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

function parseBridgeUrl(value: string): URL {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("bridgeUrl must not contain credentials, a query, or a fragment")
  }
  const local =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new TypeError("bridgeUrl must use HTTPS except on loopback development hosts")
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/"
  return url
}

function validateProcessSpec(
  spec: ProcessSpec,
  error: (code: string, message: string, cause?: unknown) => RuntimeProviderError,
): void {
  try {
    assertRuntimeId(spec.processId)
    relativePath(String(spec.cwd))
  } catch (cause) {
    throw error("INVALID_PROCESS_SPEC", "Process identifier or working directory is invalid", cause)
  }
  if (spec.argv[0].length === 0 || spec.argv.some((value) => value.includes("\0"))) {
    throw error(
      "INVALID_PROCESS_SPEC",
      "Process executable must be non-empty and argv must be NUL-free",
    )
  }
  for (const [name, value] of Object.entries(spec.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes("\0")) {
      throw error("INVALID_PROCESS_SPEC", "Process environment contains an invalid name or value")
    }
  }
  try {
    processHardTimeoutMs(spec)
  } catch (cause) {
    throw error("INVALID_PROCESS_SPEC", "Process timeout configuration is invalid", cause)
  }
}

function processState(
  snapshot: z.infer<typeof processSnapshotSchema>,
  observedAt: string,
): ProcessState {
  if (snapshot.status === "starting" || snapshot.status === "running") {
    return { status: "running", observedAt }
  }
  const exit: ProcessExit = {
    exitCode: snapshot.exitCode,
    signal: snapshot.status === "killed" ? "SIGKILL" : null,
    reason: snapshot.status === "killed" ? "signaled" : "exited",
    exitedAt: snapshot.finishedAt ?? observedAt,
  }
  return { status: "exited", observedAt, exit }
}

function encodeProcessIdentity(identity: CloudflareProcessIdentity): string {
  return `${identity.runtimeId}.${identity.processId}`
}

function decodeProcessIdentity(value: string): CloudflareProcessIdentity {
  const separator = value.indexOf(".")
  if (separator <= 0 || separator === value.length - 1)
    throw new TypeError("invalid process handle")
  const runtimeId = value.slice(0, separator)
  const processId = value.slice(separator + 1)
  if (
    !runtimeIdSchema.safeParse(runtimeId).success ||
    !processIdSchema.safeParse(processId).success
  ) {
    throw new TypeError("invalid process handle")
  }
  return { runtimeId, processId }
}

function fileBatches<T extends { readonly contentBase64: string }>(files: readonly T[]): T[][] {
  const batches: T[][] = []
  let current: T[] = []
  let encodedBytes = 0
  for (const file of files) {
    if (
      current.length === MAX_FILES_PER_WRITE ||
      (current.length > 0 && encodedBytes + file.contentBase64.length > MAX_WRITE_ENCODED_BYTES)
    ) {
      batches.push(current)
      current = []
      encodedBytes = 0
    }
    current.push(file)
    encodedBytes += file.contentBase64.length
  }
  if (current.length > 0) batches.push(current)
  return batches
}

async function deterministicUuid(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  )
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x80
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80
  return formatUuid(digest)
}

function randomUuid(): string {
  return crypto.randomUUID()
}

function formatUuid(bytes: Uint8Array): string {
  const hex = [...bytes.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${name} must be a positive safe integer`)
  return value
}

function retryDelays(values: readonly number[]): readonly number[] {
  if (values.length > 8) throw new TypeError("retryDelaysMs supports at most eight delays")
  return Object.freeze(
    values.map((value, index) => positiveInteger(value, `retryDelaysMs[${index}]`)),
  )
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  tooLarge: () => RuntimeProviderError,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        await reader.cancel()
        throw tooLarge()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function parseJsonBody(
  response: Response,
  error: (code: string, message: string, cause?: unknown) => RuntimeProviderError,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_RESPONSE_BYTES) {
    throw error("BRIDGE_RESPONSE_TOO_LARGE", "Cloudflare bridge response exceeds the client limit")
  }
  const source = await response.text()
  if (new TextEncoder().encode(source).byteLength > MAX_JSON_RESPONSE_BYTES) {
    throw error("BRIDGE_RESPONSE_TOO_LARGE", "Cloudflare bridge response exceeds the client limit")
  }
  try {
    return JSON.parse(source) as unknown
  } catch (cause) {
    throw error("BRIDGE_PROTOCOL_ERROR", "Cloudflare bridge returned invalid JSON", cause)
  }
}

function selectAndParse<Output>(
  value: unknown,
  key: string,
  schema: z.ZodType<Output>,
  error: (cause: unknown) => RuntimeProviderError,
): Output {
  if (!isRecord(value)) throw error(new TypeError("response is not an object"))
  const result = schema.safeParse(value[key])
  if (!result.success) throw error(result.error)
  return result.data
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireValue<Output>(value: Output | null, error: () => RuntimeProviderError): Output {
  if (value === null) throw error()
  return value
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
