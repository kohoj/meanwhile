import type { z } from "zod"
import {
  type Artifact,
  ArtifactPageSchema,
  type CreateDeploymentRequest,
  CreateDeploymentRequestSchema,
  type CreateRunRequest,
  CreateRunRequestSchema,
  type Deployment,
  type DeploymentLogPage,
  DeploymentLogPageSchema,
  DeploymentResponseSchema,
  ErrorEnvelopeSchema,
  IdentifierSchema,
  type ProviderDiagnostics,
  ProviderDiagnosticsSchema,
  ProviderTestRequestSchema,
  type Run,
  type RunLog,
  type RunLogPage,
  RunLogPageSchema,
  RunLogSchema,
  type RunPage,
  RunPageSchema,
  RunResponseSchema,
} from "./api/contracts"

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_SSE_EVENT_BYTES = 2 * 1024 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_WAIT_TIMEOUT_MS = 60 * 60_000
const DEFAULT_POLL_INTERVAL_MS = 250
const DEFAULT_SSE_RETRY_MS = 1_000
const MIN_SSE_RETRY_MS = 100
const MAX_SSE_RETRY_MS = 10_000
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"])
const TERMINAL_DEPLOYMENT_STATUSES = new Set(["succeeded", "failed"])

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export type Wait = (milliseconds: number, signal: AbortSignal) => Promise<void>

export interface ClientResponseEvidence {
  readonly method: "GET" | "POST"
  readonly path: string
  readonly status: number
  readonly requestId: string
}

export interface MeanwhileOptions {
  readonly baseUrl: string | URL
  readonly apiKey: string
  readonly fetch?: Fetch
  readonly requestTimeoutMs?: number
  readonly wait?: Wait
  readonly onResponse?: (evidence: ClientResponseEvidence) => void
  readonly dangerouslyAllowBrowser?: boolean
}

export interface RequestOptions {
  readonly signal?: AbortSignal
}

export interface CreateRunOptions extends RequestOptions {
  readonly idempotencyKey?: string
}

export interface ListRunsOptions extends RequestOptions {
  readonly limit?: number
  readonly before?: string
}

export interface ListLogsOptions extends RequestOptions {
  readonly after?: number
  readonly limit?: number
}

export interface FollowLogsOptions extends ListLogsOptions {}

export interface WaitOptions extends RequestOptions {
  readonly timeoutMs?: number
  readonly pollIntervalMs?: number
}

export interface RunsClient {
  create(input: CreateRunRequest, options?: CreateRunOptions): Promise<Run>
  list(options?: ListRunsOptions): Promise<RunPage>
  get(id: string, options?: RequestOptions): Promise<Run>
  cancel(id: string, options?: RequestOptions): Promise<Run>
  logs(id: string, options?: ListLogsOptions): Promise<RunLogPage>
  followLogs(id: string, options?: FollowLogsOptions): AsyncIterable<RunLog>
  artifacts(id: string, options?: RequestOptions): Promise<readonly Artifact[]>
  wait(id: string, options?: WaitOptions): Promise<Run>
}

export interface DeploymentsClient {
  create(input: CreateDeploymentRequest, options?: RequestOptions): Promise<Deployment>
  get(id: string, options?: RequestOptions): Promise<Deployment>
  logs(id: string, options?: ListLogsOptions): Promise<DeploymentLogPage>
  wait(id: string, options?: WaitOptions): Promise<Deployment>
}

export interface ProvidersClient {
  test(name: string, options?: RequestOptions): Promise<ProviderDiagnostics>
}

interface MeanwhileErrorInput {
  readonly code: string
  readonly message: string
  readonly status?: number
  readonly requestId?: string
  readonly details?: Readonly<Record<string, unknown>>
}

/** The only public failure type: safe, structured, and free of credentials and response bodies. */
export class MeanwhileError extends Error {
  readonly code: string
  readonly status: number | undefined
  readonly requestId: string | undefined
  readonly details: Readonly<Record<string, unknown>>

  constructor(input: MeanwhileErrorInput, options?: ErrorOptions) {
    super(input.message, options)
    this.name = "MeanwhileError"
    this.code = input.code
    this.status = input.status
    this.requestId = input.requestId
    this.details = input.details ?? {}
  }
}

/** A Web-standard client for the complete public Meanwhile control-plane contract. */
export class Meanwhile {
  readonly runs: RunsClient
  readonly deployments: DeploymentsClient
  readonly providers: ProvidersClient

  constructor(options: MeanwhileOptions) {
    const transport = new Transport(options)
    this.runs = new Runs(transport)
    this.deployments = new Deployments(transport)
    this.providers = new Providers(transport)
  }
}

class Runs implements RunsClient {
  constructor(private readonly transport: Transport) {}

  async create(input: CreateRunRequest, options: CreateRunOptions = {}): Promise<Run> {
    const body = parseInput(CreateRunRequestSchema, input)
    const headers = new Headers()
    if (options.idempotencyKey !== undefined) {
      if (options.idempotencyKey.length < 1 || options.idempotencyKey.length > 255) {
        throw invalidArgument("Idempotency key must contain between 1 and 255 characters", {
          field: "idempotencyKey",
        })
      }
      headers.set("Idempotency-Key", options.idempotencyKey)
    }
    const result = await this.transport.json("runs", RunResponseSchema, {
      method: "POST",
      headers,
      body,
      ...signalInput(options.signal),
    })
    return result.run
  }

  async list(options: ListRunsOptions = {}): Promise<RunPage> {
    const limit = boundedInteger(options.limit ?? 50, 1, 100, "limit")
    const query = new URLSearchParams({ limit: String(limit) })
    if (options.before !== undefined) query.set("before", options.before)
    return this.transport.json(`runs?${query}`, RunPageSchema, signalInput(options.signal))
  }

  async get(id: string, options: RequestOptions = {}): Promise<Run> {
    const result = await this.transport.json(
      runPath(id),
      RunResponseSchema,
      signalInput(options.signal),
    )
    return result.run
  }

  async cancel(id: string, options: RequestOptions = {}): Promise<Run> {
    const result = await this.transport.json(`${runPath(id)}/cancel`, RunResponseSchema, {
      method: "POST",
      ...signalInput(options.signal),
    })
    return result.run
  }

  logs(id: string, options: ListLogsOptions = {}): Promise<RunLogPage> {
    return this.transport.json(logPath(id, options), RunLogPageSchema, signalInput(options.signal))
  }

  async *followLogs(id: string, options: FollowLogsOptions = {}): AsyncIterable<RunLog> {
    const signal = options.signal ?? new AbortController().signal
    const after = boundedInteger(options.after ?? 0, 0, Number.MAX_SAFE_INTEGER, "after")
    const limit = boundedInteger(options.limit ?? 100, 1, 1_000, "limit")
    const query = new URLSearchParams({
      after: String(after),
      limit: String(limit),
      follow: "true",
    })
    const path = `${runPath(id)}/logs?${query}`
    let cursor = after
    let retryMilliseconds = DEFAULT_SSE_RETRY_MS
    let consecutiveEmptyConnections = 0

    while (!signal.aborted) {
      let response: Response
      try {
        response = await this.transport.response(path, {
          headers: new Headers({ Accept: "text/event-stream", "Last-Event-ID": String(cursor) }),
          signal,
          timeout: false,
        })
      } catch (error) {
        if (signal.aborted) return
        throw error
      }
      if (!isEventStreamResponse(response)) {
        await response.body?.cancel().catch(() => undefined)
        throw protocolError("Log stream has an invalid content type", {
          path,
          status: response.status,
        })
      }
      if (response.body === null) {
        throw protocolError("Log stream has no body", { path, status: response.status })
      }

      let madeProgress = false
      for await (const event of sseEvents(response.body, signal)) {
        if (event.retryMilliseconds !== undefined) {
          retryMilliseconds = boundedSseRetry(event.retryMilliseconds)
        }
        if (event.type === "end") return
        if (event.type === "error") throw errorFromEnvelope(parseJson(event.data), response.status)
        if (event.type !== "log") continue

        const sequence = parseSseSequence(event.id)
        const value = parseProtocol(RunLogSchema, parseJson(event.data), "Invalid run log event")
        if (value.sequence !== sequence) {
          throw protocolError("Log stream event identity is inconsistent")
        }
        if (sequence <= cursor) continue
        if (sequence !== cursor + 1) {
          throw protocolError("Log stream sequence is not contiguous", {
            expected: cursor + 1,
            received: sequence,
          })
        }
        cursor = sequence
        madeProgress = true
        yield value
      }
      if (signal.aborted) return

      consecutiveEmptyConnections = madeProgress ? 0 : consecutiveEmptyConnections + 1
      const delay = Math.min(
        retryMilliseconds * 2 ** Math.min(Math.max(consecutiveEmptyConnections - 1, 0), 10),
        MAX_SSE_RETRY_MS,
      )
      await this.transport.delay(delay, signal)
    }
  }

  async artifacts(id: string, options: RequestOptions = {}): Promise<readonly Artifact[]> {
    const result = await this.transport.json(
      `${runPath(id)}/artifacts`,
      ArtifactPageSchema,
      signalInput(options.signal),
    )
    return result.items
  }

  wait(id: string, options: WaitOptions = {}): Promise<Run> {
    return waitForTerminal(
      "run",
      validId(id),
      () => this.get(id, signalInput(options.signal)),
      (run) => TERMINAL_RUN_STATUSES.has(run.status),
      this.transport,
      options,
    )
  }
}

class Deployments implements DeploymentsClient {
  constructor(private readonly transport: Transport) {}

  async create(input: CreateDeploymentRequest, options: RequestOptions = {}): Promise<Deployment> {
    const body = parseInput(CreateDeploymentRequestSchema, input)
    const result = await this.transport.json("deployments", DeploymentResponseSchema, {
      method: "POST",
      body,
      ...signalInput(options.signal),
    })
    return result.deployment
  }

  async get(id: string, options: RequestOptions = {}): Promise<Deployment> {
    const result = await this.transport.json(
      deploymentPath(id),
      DeploymentResponseSchema,
      signalInput(options.signal),
    )
    return result.deployment
  }

  logs(id: string, options: ListLogsOptions = {}): Promise<DeploymentLogPage> {
    const query = cursorQuery(options)
    return this.transport.json(
      `${deploymentPath(id)}/logs?${query}`,
      DeploymentLogPageSchema,
      signalInput(options.signal),
    )
  }

  wait(id: string, options: WaitOptions = {}): Promise<Deployment> {
    return waitForTerminal(
      "deployment",
      validId(id),
      () => this.get(id, signalInput(options.signal)),
      (deployment) => TERMINAL_DEPLOYMENT_STATUSES.has(deployment.status),
      this.transport,
      options,
    )
  }
}

class Providers implements ProvidersClient {
  constructor(private readonly transport: Transport) {}

  test(name: string, options: RequestOptions = {}): Promise<ProviderDiagnostics> {
    const body = parseInput(ProviderTestRequestSchema, { provider: name })
    return this.transport.json("providers/test", ProviderDiagnosticsSchema, {
      method: "POST",
      body,
      ...signalInput(options.signal),
    })
  }
}

interface TransportRequest {
  readonly method?: "GET" | "POST"
  readonly headers?: Headers
  readonly body?: unknown
  readonly signal?: AbortSignal
  readonly timeout?: boolean
}

class Transport {
  readonly baseUrl: URL
  readonly apiKey: string
  readonly fetch: Fetch
  readonly requestTimeoutMs: number
  readonly wait: Wait
  readonly onResponse: ((evidence: ClientResponseEvidence) => void) | undefined

  constructor(options: MeanwhileOptions) {
    if (isBrowser() && options.dangerouslyAllowBrowser !== true) {
      throw invalidArgument(
        "Browser use is disabled because it exposes the Meanwhile API key; set dangerouslyAllowBrowser only when that exposure is intentional",
      )
    }
    if (options.apiKey.length === 0) throw invalidArgument("API key must not be empty")
    this.baseUrl = parseBaseUrl(options.baseUrl)
    this.apiKey = options.apiKey
    this.fetch = options.fetch ?? globalThis.fetch
    this.requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      1,
      24 * 60 * 60_000,
      "requestTimeoutMs",
    )
    this.wait = options.wait ?? abortableDelay
    this.onResponse = options.onResponse
  }

  async json<Schema extends z.ZodType>(
    path: string,
    schema: Schema,
    options: TransportRequest = {},
  ): Promise<z.output<Schema>> {
    const response = await this.response(path, options)
    const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase()
    if (contentType !== "application/json") {
      await response.body?.cancel().catch(() => undefined)
      throw protocolError("Meanwhile returned a non-JSON response", {
        path,
        status: response.status,
      })
    }
    const content = await readBoundedBody(response, MAX_RESPONSE_BYTES)
    const value = parseJson(content)
    return parseProtocol(
      schema,
      value,
      "Meanwhile returned a response that violates its contract",
      {
        path,
        status: response.status,
      },
    )
  }

  async response(path: string, options: TransportRequest = {}): Promise<Response> {
    const method = options.method ?? "GET"
    const requestId = crypto.randomUUID()
    const headers = new Headers(options.headers)
    headers.set("Authorization", `Bearer ${this.apiKey}`)
    headers.set("X-Request-ID", requestId)
    if (!headers.has("Accept")) headers.set("Accept", "application/json")
    if (options.body !== undefined) headers.set("Content-Type", "application/json")

    const timeoutSignal =
      options.timeout === false ? undefined : AbortSignal.timeout(this.requestTimeoutMs)
    const signal = combineSignals(options.signal, timeoutSignal)
    let response: Response
    try {
      response = await this.fetch(new URL(path, this.baseUrl), {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (options.signal?.aborted) {
        throw new MeanwhileError(
          { code: "REQUEST_ABORTED", message: "Meanwhile request was aborted", requestId },
          { cause: error },
        )
      }
      if (timeoutSignal?.aborted) {
        throw new MeanwhileError(
          { code: "REQUEST_TIMEOUT", message: "Meanwhile request timed out", requestId },
          { cause: error },
        )
      }
      throw new MeanwhileError(
        { code: "API_UNREACHABLE", message: "Meanwhile control plane is unreachable", requestId },
        { cause: error },
      )
    }

    const responseRequestId = response.headers.get("X-Request-ID") ?? requestId
    this.onResponse?.({ method, path, status: response.status, requestId: responseRequestId })
    if (!response.ok) {
      const contentType = response.headers
        .get("Content-Type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase()
      if (contentType !== "application/json") {
        await response.body?.cancel().catch(() => undefined)
        throw protocolError("Meanwhile returned a non-structured error", {
          path,
          status: response.status,
        })
      }
      const content = await readBoundedBody(response, MAX_RESPONSE_BYTES)
      throw errorFromEnvelope(parseJson(content), response.status)
    }
    return response
  }

  delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return this.wait(milliseconds, signal)
  }
}

async function waitForTerminal<Value>(
  resource: "run" | "deployment",
  id: string,
  read: () => Promise<Value>,
  terminal: (value: Value) => boolean,
  transport: Transport,
  options: WaitOptions,
): Promise<Value> {
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
    1,
    24 * 60 * 60_000,
    "timeoutMs",
  )
  const pollIntervalMs = boundedInteger(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    1,
    60_000,
    "pollIntervalMs",
  )
  const signal = options.signal ?? new AbortController().signal
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal.aborted) throw abortedError()
    const value = await read()
    if (terminal(value)) return value
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new MeanwhileError({
        code: "CLIENT_WAIT_TIMEOUT",
        message: `The ${resource} did not become terminal before the client deadline`,
        details: { resource, id, timeoutMs },
      })
    }
    await transport.delay(Math.min(pollIntervalMs, remaining), signal)
  }
}

function parseInput<Schema extends z.ZodType>(
  schema: Schema,
  value: z.input<Schema>,
): z.output<Schema> {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  throw invalidArgument("Client input violates the Meanwhile API contract", {
    issues: result.error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map(String),
      message: issue.message,
    })),
  })
}

function parseProtocol<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): z.output<Schema> {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  throw protocolError(message, {
    ...details,
    issues: result.error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map(String),
    })),
  })
}

function errorFromEnvelope(value: unknown, status?: number): MeanwhileError {
  const result = ErrorEnvelopeSchema.safeParse(value)
  if (!result.success) {
    return protocolError("Meanwhile returned an invalid error envelope", {
      ...(status === undefined ? {} : { status }),
    })
  }
  return new MeanwhileError({
    code: result.data.error.code,
    message: result.data.error.message,
    ...(status === undefined ? {} : { status }),
    requestId: result.data.error.requestId,
    details: result.data.error.details,
  })
}

function parseBaseUrl(value: string | URL): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalidArgument("baseUrl must be an absolute HTTP URL", { field: "baseUrl" })
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw invalidArgument("baseUrl must be an origin without credentials, query, or path", {
      field: "baseUrl",
    })
  }
  url.pathname = "/"
  return url
}

function runPath(id: string): string {
  return `runs/${encodeURIComponent(validId(id))}`
}

function deploymentPath(id: string): string {
  return `deployments/${encodeURIComponent(validId(id))}`
}

function validId(id: string): string {
  const result = IdentifierSchema.safeParse(id)
  if (!result.success) throw invalidArgument("Resource id must be a UUID", { field: "id" })
  return result.data
}

function logPath(id: string, options: ListLogsOptions): string {
  return `${runPath(id)}/logs?${cursorQuery(options)}`
}

function cursorQuery(options: ListLogsOptions): URLSearchParams {
  return new URLSearchParams({
    after: String(boundedInteger(options.after ?? 0, 0, Number.MAX_SAFE_INTEGER, "after")),
    limit: String(boundedInteger(options.limit ?? 100, 1, 1_000, "limit")),
  })
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidArgument(`${field} must be an integer between ${minimum} and ${maximum}`, {
      field,
    })
  }
  return value
}

function invalidArgument(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): MeanwhileError {
  return new MeanwhileError({ code: "INVALID_ARGUMENT", message, details })
}

function protocolError(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): MeanwhileError {
  return new MeanwhileError({ code: "API_PROTOCOL_ERROR", message, details })
}

function abortedError(): MeanwhileError {
  return new MeanwhileError({ code: "REQUEST_ABORTED", message: "Meanwhile request was aborted" })
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string> {
  if (response.body === null) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let result = ""
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value === undefined) continue
      bytes += value.byteLength
      if (bytes > maximumBytes) throw protocolError("API response is too large")
      result += decoder.decode(value, { stream: true })
    }
    result += decoder.decode()
    return result
  } finally {
    reader.releaseLock()
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (error) {
    throw new MeanwhileError(
      { code: "API_PROTOCOL_ERROR", message: "Meanwhile returned invalid JSON" },
      { cause: error },
    )
  }
}

interface ParsedSseEvent {
  readonly type: string
  readonly data: string
  readonly id?: string
  readonly retryMilliseconds?: number
}

async function* sseEvents(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<ParsedSseEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let lineParts: string[] = []
  let lineBytes = 0
  let eventType = "message"
  let data: string[] = []
  let eventId: string | undefined
  let retryMilliseconds: number | undefined
  let eventBytes = 0
  let finished = false

  const appendLinePart = (value: string) => {
    if (value.length === 0) return
    lineParts.push(value)
    if (lineParts.length >= 64) lineParts = [lineParts.join("")]
  }
  const dispatch = (): ParsedSseEvent | undefined => {
    const shouldDispatch = data.length > 0 || eventType === "end" || retryMilliseconds !== undefined
    const event = shouldDispatch
      ? {
          type: eventType,
          data: data.join("\n"),
          ...(eventId === undefined ? {} : { id: eventId }),
          ...(retryMilliseconds === undefined ? {} : { retryMilliseconds }),
        }
      : undefined
    eventType = "message"
    data = []
    eventId = undefined
    retryMilliseconds = undefined
    eventBytes = 0
    return event
  }
  const processLine = (raw: string, rawBytes: number): ParsedSseEvent | undefined => {
    eventBytes += rawBytes + 1
    if (eventBytes > MAX_SSE_EVENT_BYTES) throw protocolError("Log stream event is too large")
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (line.length === 0) return dispatch()
    if (line.startsWith(":")) return
    const separator = line.indexOf(":")
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? "" : line.slice(separator + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") eventType = value
    if (field === "data") data.push(value)
    if (field === "id" && !value.includes("\0")) eventId = value
    if (field === "retry" && /^\d+$/.test(value)) {
      const parsed = Number(value)
      if (Number.isSafeInteger(parsed)) retryMilliseconds = parsed
    }
  }
  const cancel = () => reader.cancel().catch(() => undefined)
  const abort = () => {
    void cancel()
  }
  signal.addEventListener("abort", abort, { once: true })

  try {
    if (signal.aborted) return
    for (;;) {
      let read: Awaited<ReturnType<typeof reader.read>>
      try {
        read = await reader.read()
      } catch {
        return
      }
      if (signal.aborted) return
      if (read.done) {
        finished = true
        return
      }
      const value = read.value
      if (value.byteLength === 0) continue
      let start = 0
      for (let index = 0; index < value.byteLength; index += 1) {
        if (value[index] !== 10) continue
        const part = value.subarray(start, index)
        lineBytes += part.byteLength
        if (lineBytes > MAX_SSE_EVENT_BYTES) throw protocolError("Log stream event is too large")
        try {
          appendLinePart(decoder.decode(part, { stream: true }))
          appendLinePart(decoder.decode())
        } catch {
          throw protocolError("Log stream is not valid UTF-8")
        }
        const event = processLine(lineParts.join(""), lineBytes)
        lineParts = []
        lineBytes = 0
        start = index + 1
        if (event !== undefined) yield event
      }
      const remainder = value.subarray(start)
      lineBytes += remainder.byteLength
      if (lineBytes > MAX_SSE_EVENT_BYTES) throw protocolError("Log stream event is too large")
      if (remainder.byteLength > 0) {
        try {
          appendLinePart(decoder.decode(remainder, { stream: true }))
        } catch {
          throw protocolError("Log stream is not valid UTF-8")
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", abort)
    if (!finished) await cancel()
    reader.releaseLock()
  }
}

function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get("Content-Type")
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream"
}

function parseSseSequence(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    throw protocolError("Log stream event has an invalid id")
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw protocolError("Log stream event id is out of range")
  return parsed
}

function boundedSseRetry(milliseconds: number): number {
  return Math.min(Math.max(milliseconds, MIN_SSE_RETRY_MS), MAX_SSE_RETRY_MS)
}

function combineSignals(
  caller: AbortSignal | undefined,
  timeout: AbortSignal | undefined,
): AbortSignal | undefined {
  if (caller === undefined) return timeout
  if (timeout === undefined) return caller
  return AbortSignal.any([caller, timeout])
}

function signalInput(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortedError())
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", abort)
      resolve()
    }
    const abort = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", abort)
      reject(abortedError())
    }
    const timeout = setTimeout(finish, milliseconds)
    signal.addEventListener("abort", abort, { once: true })
  })
}

function isBrowser(): boolean {
  return typeof globalThis === "object" && "window" in globalThis && "document" in globalThis
}
