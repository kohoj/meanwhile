import { DurableObject } from "cloudflare:workers"
import { isPlatformTransientError } from "@cloudflare/sandbox"
import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { z } from "zod"

import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeError,
  CLOUDFLARE_SANDBOX_VERSION,
  createRuntimeRequestSchema,
  exposePortParamsSchema,
  listFilesQuerySchema,
  processEventsQuerySchema,
  processIdFromOperation,
  processIdSchema,
  processSpecFingerprint,
  type RuntimeSnapshot,
  readFileQuerySchema,
  runtimeIdFromOperation,
  runtimeIdSchema,
  signalProcessRequestSchema,
  spawnProcessRequestSchema,
  waitProcessQuerySchema,
  writeFilesRequestSchema,
} from "./protocol"
import {
  type BridgeRuntime,
  type BridgeRuntimeFactory,
  type CloudflareBridgeEnvironment,
  createCloudflareRuntimeFactory,
} from "./sandbox"

export { Sandbox } from "@cloudflare/sandbox"

const SERVICE_NAME = "meanwhile-cloudflare-sandbox-bridge"
const MAX_REQUEST_BYTES = 24 * 1024 * 1024
const MINIMUM_TOKEN_BYTES = 32
const MAXIMUM_TOKEN_BYTES = 512

type AppEnvironment = {
  Bindings: CloudflareBridgeEnvironment
  Variables: {
    operation: string
    requestId: string
  }
}

type AppContext = Context<AppEnvironment>

export interface BridgeAppOptions {
  readonly runtimeFactory?: BridgeRuntimeFactory
  readonly registryFactory?: BridgeRegistryFactory
}

interface RuntimeRegistryRecord {
  readonly version: 1
  readonly runtimeId: string
  readonly state: "created" | "active" | "stopped" | "destroyed"
  readonly materialized: boolean
  readonly processCount: number
  readonly activeProcessCount: number
}

interface ProcessReservation {
  readonly status: "reserved" | "existing" | "conflict" | "runtime_unavailable"
  readonly runtimeState?: RuntimeRegistryRecord["state"]
}

export interface BridgeRegistry {
  create(runtimeId: string): Promise<RuntimeSnapshot>
  start(runtimeId: string): Promise<RuntimeSnapshot>
  inspect(runtimeId: string): Promise<RuntimeSnapshot>
  stop(runtimeId: string): Promise<RuntimeSnapshot>
  destroy(runtimeId: string): Promise<RuntimeSnapshot>
  assertActive(runtimeId: string): Promise<void>
  reserveProcess(
    runtimeId: string,
    processId: string,
    fingerprint: string,
  ): Promise<"reserved" | "existing">
}

export type BridgeRegistryFactory = (
  runtimeId: string,
  environment: CloudflareBridgeEnvironment,
) => BridgeRegistry

const RUNTIME_RECORD_KEY = "runtime"
const PROCESS_FINGERPRINT_PREFIX = "process:"

/**
 * Separate durable lifecycle authority for a Sandbox identity. Cloudflare's
 * `getSandbox()` is create-on-reference, so querying that object cannot answer
 * whether Meanwhile previously destroyed a runtime. This Durable Object can.
 */
export class RuntimeRegistry extends DurableObject<CloudflareBridgeEnvironment> {
  readonly #state: DurableObjectState
  readonly #environment: CloudflareBridgeEnvironment

  constructor(state: DurableObjectState, environment: CloudflareBridgeEnvironment) {
    super(state, environment)
    this.#state = state
    this.#environment = environment
  }

  async createRuntime(runtimeId: string): Promise<RuntimeSnapshot> {
    const existing = await this.#record()
    if (existing) return registrySnapshot(existing)

    const record: RuntimeRegistryRecord = {
      version: 1,
      runtimeId,
      state: "created",
      materialized: false,
      processCount: 0,
      activeProcessCount: 0,
    }
    await this.#write(record)
    return registrySnapshot(record)
  }

  async startRuntime(runtimeId: string): Promise<RuntimeSnapshot> {
    const record = await this.#require(runtimeId)
    if (record.state === "destroyed") return registrySnapshot(record)

    const snapshot = await this.#runtime(runtimeId).start()
    const active = registryRecord(record, {
      state: "active",
      materialized: true,
      processCount: snapshot.processCount,
      activeProcessCount: snapshot.activeProcessCount,
    })
    await this.#write(active)
    return snapshot
  }

  async inspectRuntime(runtimeId: string): Promise<RuntimeSnapshot> {
    const record = await this.#require(runtimeId)
    if (record.state !== "active") return registrySnapshot(record)

    const snapshot = await this.#runtime(runtimeId).inspect()
    await this.#write(
      registryRecord(record, {
        materialized: true,
        processCount: snapshot.processCount,
        activeProcessCount: snapshot.activeProcessCount,
      }),
    )
    return snapshot
  }

  async stopRuntime(runtimeId: string): Promise<RuntimeSnapshot> {
    const record = await this.#require(runtimeId)
    if (record.state === "stopped" || record.state === "destroyed") {
      return registrySnapshot(record)
    }

    if (!record.materialized) {
      const stopped = registryRecord(record, {
        state: "stopped",
        processCount: 0,
        activeProcessCount: 0,
      })
      await this.#write(stopped)
      return registrySnapshot(stopped)
    }

    await this.#runtime(runtimeId).stop()
    const stopped = registryRecord(record, {
      state: "stopped",
      processCount: 0,
      activeProcessCount: 0,
    })
    await this.#write(stopped)
    return registrySnapshot(stopped)
  }

  async destroyRuntime(runtimeId: string): Promise<RuntimeSnapshot> {
    const record = await this.#require(runtimeId)
    if (record.state === "destroyed") return registrySnapshot(record)

    if (record.materialized) await this.#runtime(runtimeId).destroy()
    const destroyed = registryRecord(record, {
      state: "destroyed",
      materialized: false,
      processCount: 0,
      activeProcessCount: 0,
    })
    await this.#write(destroyed)
    return registrySnapshot(destroyed)
  }

  async runtimeState(runtimeId: string): Promise<RuntimeRegistryRecord | null> {
    const record = await this.#record()
    return record?.runtimeId === runtimeId ? record : null
  }

  async reserveProcess(
    runtimeId: string,
    processId: string,
    fingerprint: string,
  ): Promise<ProcessReservation> {
    const runtime = await this.#record()
    if (!runtime || runtime.runtimeId !== runtimeId || runtime.state !== "active") {
      return runtime
        ? { status: "runtime_unavailable", runtimeState: runtime.state }
        : { status: "runtime_unavailable" }
    }

    const key = `${PROCESS_FINGERPRINT_PREFIX}${processId}`
    const existing = await this.#state.storage.get<string>(key)
    if (existing === fingerprint) return { status: "existing" }
    if (existing !== undefined) return { status: "conflict" }
    await this.#state.storage.put(key, fingerprint)
    return { status: "reserved" }
  }

  async #record(): Promise<RuntimeRegistryRecord | null> {
    return (await this.#state.storage.get<RuntimeRegistryRecord>(RUNTIME_RECORD_KEY)) ?? null
  }

  async #require(runtimeId: string): Promise<RuntimeRegistryRecord> {
    const record = await this.#record()
    if (!record || record.runtimeId !== runtimeId) {
      throw new Error("RUNTIME_REGISTRY_RECORD_MISSING")
    }
    return record
  }

  async #write(record: RuntimeRegistryRecord): Promise<void> {
    await this.#state.storage.put(RUNTIME_RECORD_KEY, record)
  }

  #runtime(runtimeId: string): BridgeRuntime {
    return createCloudflareRuntimeFactory(this.#environment)(runtimeId)
  }
}

interface RuntimeRegistryStub {
  createRuntime(runtimeId: string): Promise<RuntimeSnapshot>
  startRuntime(runtimeId: string): Promise<RuntimeSnapshot>
  inspectRuntime(runtimeId: string): Promise<RuntimeSnapshot>
  stopRuntime(runtimeId: string): Promise<RuntimeSnapshot>
  destroyRuntime(runtimeId: string): Promise<RuntimeSnapshot>
  runtimeState(runtimeId: string): Promise<RuntimeRegistryRecord | null>
  reserveProcess(
    runtimeId: string,
    processId: string,
    fingerprint: string,
  ): Promise<ProcessReservation>
}

class DurableBridgeRegistry implements BridgeRegistry {
  readonly #stub: RuntimeRegistryStub

  constructor(runtimeId: string, environment: CloudflareBridgeEnvironment) {
    if (!environment.RuntimeRegistry) {
      throw new BridgeError(
        "BRIDGE_MISCONFIGURED",
        "The bridge runtime registry is not configured.",
        503,
      )
    }
    this.#stub = environment.RuntimeRegistry.getByName(runtimeId) as unknown as RuntimeRegistryStub
  }

  create(runtimeId: string): Promise<RuntimeSnapshot> {
    return this.#stub.createRuntime(runtimeId)
  }

  async start(runtimeId: string): Promise<RuntimeSnapshot> {
    const record = await this.#stub.runtimeState(runtimeId)
    if (!record || record.state === "destroyed") throw runtimeNotFound()
    return this.#stub.startRuntime(runtimeId)
  }

  async inspect(runtimeId: string): Promise<RuntimeSnapshot> {
    if (!(await this.#stub.runtimeState(runtimeId))) throw runtimeNotFound()
    return this.#stub.inspectRuntime(runtimeId)
  }

  async stop(runtimeId: string): Promise<RuntimeSnapshot> {
    if (!(await this.#stub.runtimeState(runtimeId))) throw runtimeNotFound()
    return this.#stub.stopRuntime(runtimeId)
  }

  async destroy(runtimeId: string): Promise<RuntimeSnapshot> {
    if (!(await this.#stub.runtimeState(runtimeId))) throw runtimeNotFound()
    return this.#stub.destroyRuntime(runtimeId)
  }

  async assertActive(runtimeId: string): Promise<void> {
    const record = await this.#stub.runtimeState(runtimeId)
    assertRegistryActive(record)
  }

  async reserveProcess(
    runtimeId: string,
    processId: string,
    fingerprint: string,
  ): Promise<"reserved" | "existing"> {
    return requireProcessReservation(
      await this.#stub.reserveProcess(runtimeId, processId, fingerprint),
    )
  }
}

/** Deterministic test double for the same lifecycle contract. */
export class InMemoryBridgeRegistry implements BridgeRegistry {
  readonly #runtimeFactory: BridgeRuntimeFactory
  readonly #records = new Map<string, RuntimeRegistryRecord>()
  readonly #fingerprints = new Map<string, string>()

  constructor(runtimeFactory: BridgeRuntimeFactory) {
    this.#runtimeFactory = runtimeFactory
  }

  seed(runtimeId: string, state: RuntimeRegistryRecord["state"] = "active"): void {
    this.#records.set(runtimeId, {
      version: 1,
      runtimeId,
      state,
      materialized: state === "active" || state === "stopped",
      processCount: 0,
      activeProcessCount: 0,
    })
  }

  async create(runtimeId: string): Promise<RuntimeSnapshot> {
    const existing = this.#records.get(runtimeId)
    if (existing) return registrySnapshot(existing)
    const record: RuntimeRegistryRecord = {
      version: 1,
      runtimeId,
      state: "created",
      materialized: false,
      processCount: 0,
      activeProcessCount: 0,
    }
    this.#records.set(runtimeId, record)
    return registrySnapshot(record)
  }

  async start(runtimeId: string): Promise<RuntimeSnapshot> {
    const record = this.#require(runtimeId)
    if (record.state === "destroyed") throw runtimeNotFound()
    const snapshot = await this.#runtimeFactory(runtimeId).start()
    this.#records.set(
      runtimeId,
      registryRecord(record, {
        state: "active",
        materialized: true,
        processCount: snapshot.processCount,
        activeProcessCount: snapshot.activeProcessCount,
      }),
    )
    return snapshot
  }

  async inspect(runtimeId: string): Promise<RuntimeSnapshot> {
    const record = this.#require(runtimeId)
    return record.state === "active"
      ? this.#runtimeFactory(runtimeId).inspect()
      : registrySnapshot(record)
  }

  async stop(runtimeId: string): Promise<RuntimeSnapshot> {
    const record = this.#require(runtimeId)
    if (record.state === "stopped" || record.state === "destroyed") {
      return registrySnapshot(record)
    }
    if (record.materialized) await this.#runtimeFactory(runtimeId).stop()
    const stopped = registryRecord(record, {
      state: "stopped",
      processCount: 0,
      activeProcessCount: 0,
    })
    this.#records.set(runtimeId, stopped)
    return registrySnapshot(stopped)
  }

  async destroy(runtimeId: string): Promise<RuntimeSnapshot> {
    const record = this.#require(runtimeId)
    if (record.state === "destroyed") return registrySnapshot(record)
    if (record.materialized) await this.#runtimeFactory(runtimeId).destroy()
    const destroyed = registryRecord(record, {
      state: "destroyed",
      materialized: false,
      processCount: 0,
      activeProcessCount: 0,
    })
    this.#records.set(runtimeId, destroyed)
    return registrySnapshot(destroyed)
  }

  async assertActive(runtimeId: string): Promise<void> {
    assertRegistryActive(this.#records.get(runtimeId) ?? null)
  }

  async reserveProcess(
    runtimeId: string,
    processId: string,
    fingerprint: string,
  ): Promise<"reserved" | "existing"> {
    await this.assertActive(runtimeId)
    const key = `${runtimeId}:${processId}`
    const existing = this.#fingerprints.get(key)
    if (existing === fingerprint) return "existing"
    if (existing !== undefined) {
      throw new BridgeError(
        "PROCESS_CONFLICT",
        "The process operation already identifies a different process specification.",
        409,
        { retryable: false },
      )
    }
    this.#fingerprints.set(key, fingerprint)
    return "reserved"
  }

  #require(runtimeId: string): RuntimeRegistryRecord {
    const record = this.#records.get(runtimeId)
    if (!record) throw runtimeNotFound()
    return record
  }
}

export function createBridgeApp(options: BridgeAppOptions = {}): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>()

  app.use("*", async (context, next) => {
    const candidate = context.req.header("x-request-id")
    const requestId =
      candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate) ? candidate : crypto.randomUUID()
    context.set("requestId", requestId)
    context.set("operation", "request")
    await next()
    context.header("x-request-id", requestId)
  })

  app.get("/healthz", (context) =>
    context.json({ service: SERVICE_NAME, status: "ok", protocolVersion: BRIDGE_PROTOCOL_VERSION }),
  )

  app.use("/v1/*", async (context, next) => {
    const configuredToken = context.env.BRIDGE_TOKEN
    if (
      !configuredToken ||
      encodedLength(configuredToken) < MINIMUM_TOKEN_BYTES ||
      encodedLength(configuredToken) > MAXIMUM_TOKEN_BYTES
    ) {
      throw new BridgeError(
        "BRIDGE_MISCONFIGURED",
        "The bridge authentication secret is not configured.",
        503,
      )
    }

    const authorization = context.req.header("authorization")
    const suppliedToken = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : ""
    if (
      !suppliedToken ||
      encodedLength(suppliedToken) > MAXIMUM_TOKEN_BYTES ||
      !(await secureEqual(suppliedToken, configuredToken))
    ) {
      throw new BridgeError("UNAUTHORIZED", "Authentication is required.", 401)
    }
    if (context.req.header("x-meanwhile-protocol-version") !== String(BRIDGE_PROTOCOL_VERSION)) {
      throw new BridgeError(
        "BRIDGE_PROTOCOL_UNSUPPORTED",
        "The requested bridge protocol version is not supported.",
        409,
        { expectedVersion: BRIDGE_PROTOCOL_VERSION, retryable: false },
      )
    }
    await next()
  })

  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: MAX_REQUEST_BYTES,
      onError: (context) =>
        errorResponse(
          context,
          new BridgeError("PAYLOAD_TOO_LARGE", "The request body exceeds the bridge limit.", 413),
        ),
    }),
  )

  app.get("/v1/health", (context) => {
    context.set("operation", "health")
    return context.json({
      service: SERVICE_NAME,
      status: "ok",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sandboxSdkVersion: CLOUDFLARE_SANDBOX_VERSION,
      capabilities: {
        binaryFiles: true,
        eventReplay: true,
        portExposure: true,
        processRecovery: true,
        processTermination: "hard",
        processSignals: ["SIGKILL"],
      },
    })
  })

  app.post("/v1/runtimes", async (context) => {
    context.set("operation", "runtime.create")
    const request = await parseJson(context, createRuntimeRequestSchema)
    const id = runtimeIdFromOperation(request.operationId)
    return context.json({ runtime: await getRegistry(context, options, id).create(id) }, 201)
  })

  app.post("/v1/runtimes/:runtimeId/start", async (context) => {
    context.set("operation", "runtime.start")
    const runtimeId = getRuntimeId(context)
    return context.json({
      runtime: await getRegistry(context, options, runtimeId).start(runtimeId),
    })
  })

  app.get("/v1/runtimes/:runtimeId", async (context) => {
    context.set("operation", "runtime.inspect")
    const runtimeId = getRuntimeId(context)
    return context.json({
      runtime: await getRegistry(context, options, runtimeId).inspect(runtimeId),
    })
  })

  app.post("/v1/runtimes/:runtimeId/stop", async (context) => {
    context.set("operation", "runtime.stop")
    const runtimeId = getRuntimeId(context)
    return context.json({ runtime: await getRegistry(context, options, runtimeId).stop(runtimeId) })
  })

  app.delete("/v1/runtimes/:runtimeId", async (context) => {
    context.set("operation", "runtime.destroy")
    const runtimeId = getRuntimeId(context)
    return context.json({
      runtime: await getRegistry(context, options, runtimeId).destroy(runtimeId),
    })
  })

  app.post("/v1/runtimes/:runtimeId/processes", async (context) => {
    context.set("operation", "process.spawn")
    const request = await parseJson(context, spawnProcessRequestSchema)
    const processId = processIdFromOperation(request.operationId)
    const runtimeId = getRuntimeId(context)
    const registry = getRegistry(context, options, runtimeId)
    await registry.assertActive(runtimeId)
    await registry.reserveProcess(runtimeId, processId, await processSpecFingerprint(request))
    const process = await getRuntime(context, options, runtimeId).spawn(processId, request)
    return context.json({ process }, 201)
  })

  app.get("/v1/runtimes/:runtimeId/processes/:processId", async (context) => {
    context.set("operation", "process.inspect")
    const processId = parseValue(processIdSchema, context.req.param("processId"))
    const runtimeId = await assertRuntimeActive(context, options)
    return context.json({
      process: await getRuntime(context, options, runtimeId).inspectProcess(processId),
    })
  })

  app.get("/v1/runtimes/:runtimeId/processes/:processId/events", async (context) => {
    context.set("operation", "process.events")
    const processId = parseValue(processIdSchema, context.req.param("processId"))
    const query = parseValue(processEventsQuerySchema, context.req.query())
    const runtimeId = await assertRuntimeActive(context, options)
    return context.json(
      await getRuntime(context, options, runtimeId).events(
        processId,
        query.cursor,
        query.limitChars,
      ),
    )
  })

  app.post("/v1/runtimes/:runtimeId/processes/:processId/signal", async (context) => {
    context.set("operation", "process.signal")
    const processId = parseValue(processIdSchema, context.req.param("processId"))
    const request = await parseJson(context, signalProcessRequestSchema)
    const runtimeId = await assertRuntimeActive(context, options)
    return context.json({
      process: await getRuntime(context, options, runtimeId).signal(processId, request.signal),
    })
  })

  app.get("/v1/runtimes/:runtimeId/processes/:processId/wait", async (context) => {
    context.set("operation", "process.wait")
    const processId = parseValue(processIdSchema, context.req.param("processId"))
    const query = parseValue(waitProcessQuerySchema, context.req.query())
    const runtimeId = await assertRuntimeActive(context, options)
    return context.json({
      process: await getRuntime(context, options, runtimeId).wait(processId, query.timeoutMs),
    })
  })

  app.put("/v1/runtimes/:runtimeId/files", async (context) => {
    context.set("operation", "files.write")
    const request = await parseJson(context, writeFilesRequestSchema)
    const runtimeId = await assertRuntimeActive(context, options)
    await getRuntime(context, options, runtimeId).writeFiles(request)
    return context.json({ written: request.files.map((file) => file.path) })
  })

  app.get("/v1/runtimes/:runtimeId/files", async (context) => {
    context.set("operation", "files.list")
    const query = parseValue(listFilesQuerySchema, context.req.query())
    const runtimeId = await assertRuntimeActive(context, options)
    return context.json({
      files: await getRuntime(context, options, runtimeId).listFiles(
        query.path,
        query.recursive,
        query.maxEntries,
      ),
    })
  })

  app.get("/v1/runtimes/:runtimeId/file", async (context) => {
    context.set("operation", "files.read")
    const query = parseValue(readFileQuerySchema, context.req.query())
    const runtimeId = await assertRuntimeActive(context, options)
    const file = await getRuntime(context, options, runtimeId).readFile(query.path, query.maxBytes)
    return new Response(file.body, {
      headers: {
        "cache-control": "private, no-store",
        "content-length": String(file.size),
        "content-type": file.mediaType,
        "x-content-type-options": "nosniff",
      },
    })
  })

  app.post("/v1/runtimes/:runtimeId/ports/:port/expose", async (context) => {
    context.set("operation", "port.expose")
    const params = parseValue(exposePortParamsSchema, context.req.param())
    await getRegistry(context, options, params.runtimeId).assertActive(params.runtimeId)
    return context.json(
      { endpoint: await getRuntime(context, options, params.runtimeId).expose(params.port) },
      201,
    )
  })

  app.delete("/v1/runtimes/:runtimeId/ports/:port/expose", async (context) => {
    context.set("operation", "port.unexpose")
    const params = parseValue(exposePortParamsSchema, context.req.param())
    await getRegistry(context, options, params.runtimeId).assertActive(params.runtimeId)
    await getRuntime(context, options, params.runtimeId).unexpose(params.port)
    return context.json({ unexposed: true, port: params.port })
  })

  app.notFound((context) =>
    errorResponse(
      context,
      new BridgeError("NOT_FOUND", "The requested bridge resource does not exist.", 404),
    ),
  )

  app.onError((error, context) => {
    if (error instanceof BridgeError) {
      if (error.status >= 500) {
        logFailure(context, error.name, error.details.retryable === true)
      }
      return errorResponse(context, error)
    }

    const retryable = isPlatformTransientError(error)
    logFailure(context, safeErrorName(error), retryable)
    return errorResponse(
      context,
      new BridgeError(
        "PROVIDER_OPERATION_FAILED",
        "The Cloudflare provider operation failed.",
        502,
        {
          operation: context.get("operation"),
          provider: "cloudflare",
          providerCode: safeProviderCode(error),
          retryable,
        },
      ),
    )
  })

  return app
}

const app = createBridgeApp()

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<CloudflareBridgeEnvironment>

function getRuntime(
  context: AppContext,
  options: BridgeAppOptions,
  runtimeId = getRuntimeId(context),
): BridgeRuntime {
  const factory = options.runtimeFactory ?? createCloudflareRuntimeFactory(context.env)
  return factory(runtimeId)
}

function getRuntimeId(context: AppContext): string {
  return parseValue(runtimeIdSchema, context.req.param("runtimeId"))
}

function getRegistry(
  context: AppContext,
  options: BridgeAppOptions,
  runtimeId = getRuntimeId(context),
): BridgeRegistry {
  const factory =
    options.registryFactory ??
    ((id: string, environment: CloudflareBridgeEnvironment) =>
      new DurableBridgeRegistry(id, environment))
  return factory(runtimeId, context.env)
}

async function assertRuntimeActive(
  context: AppContext,
  options: BridgeAppOptions,
): Promise<string> {
  const runtimeId = getRuntimeId(context)
  await getRegistry(context, options, runtimeId).assertActive(runtimeId)
  return runtimeId
}

function registryRecord(
  record: RuntimeRegistryRecord,
  update: Partial<Omit<RuntimeRegistryRecord, "version" | "runtimeId">>,
): RuntimeRegistryRecord {
  return { ...record, ...update }
}

function registrySnapshot(record: RuntimeRegistryRecord): RuntimeSnapshot {
  return {
    handle: { version: BRIDGE_PROTOCOL_VERSION, id: record.runtimeId },
    state: record.state,
    processCount: record.processCount,
    activeProcessCount: record.activeProcessCount,
  }
}

function assertRegistryActive(record: RuntimeRegistryRecord | null): asserts record {
  if (!record || record.state === "destroyed") throw runtimeNotFound()
  if (record.state !== "active") {
    throw new BridgeError(
      "RUNTIME_NOT_ACTIVE",
      "The runtime must be started before this operation.",
      409,
      { retryable: false, runtimeState: record.state },
    )
  }
}

function requireProcessReservation(reservation: ProcessReservation): "reserved" | "existing" {
  if (reservation.status === "reserved" || reservation.status === "existing") {
    return reservation.status
  }
  if (reservation.status === "conflict") {
    throw new BridgeError(
      "PROCESS_CONFLICT",
      "The process operation already identifies a different process specification.",
      409,
      { retryable: false },
    )
  }
  if (reservation.runtimeState === "destroyed" || reservation.runtimeState === undefined) {
    throw runtimeNotFound()
  }
  throw new BridgeError(
    "RUNTIME_NOT_ACTIVE",
    "The runtime must be started before this operation.",
    409,
    { retryable: false, runtimeState: reservation.runtimeState },
  )
}

function runtimeNotFound(): BridgeError {
  return new BridgeError("RUNTIME_NOT_FOUND", "The runtime does not exist.", 404, {
    retryable: false,
  })
}

async function parseJson<Schema extends z.ZodType>(
  context: AppContext,
  schema: Schema,
): Promise<z.output<Schema>> {
  let value: unknown
  try {
    value = await context.req.json()
  } catch {
    throw new BridgeError("INVALID_REQUEST", "The request body must be valid JSON.", 400)
  }
  return parseValue(schema, value)
}

function parseValue<Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new BridgeError(
      "INVALID_REQUEST",
      "The request does not match the bridge protocol.",
      400,
      {
        issues: result.error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.join("."),
        })),
      },
    )
  }
  return result.data
}

function errorResponse(context: AppContext, error: BridgeError): Response {
  return context.json(
    {
      error: {
        code: error.code,
        message: error.message,
        requestId: context.get("requestId"),
        details: error.details,
      },
    },
    error.status as ContentfulStatusCode,
  )
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)])
  let difference = 0
  for (let index = 0; index < leftDigest.length; index += 1) {
    difference |= (leftDigest[index] ?? 0) ^ (rightDigest[index] ?? 0)
  }
  return difference === 0
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
}

function encodedLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function safeProviderCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined
  }
  const code = Reflect.get(error, "code")
  return typeof code === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : undefined
}

function safeErrorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z0-9_.:-]{1,64}$/.test(error.name)
    ? error.name
    : "UnknownError"
}

function logFailure(context: AppContext, errorName: string, retryable: boolean): void {
  console.error(
    JSON.stringify({
      event: "cloudflare_bridge.operation_failed",
      requestId: context.get("requestId"),
      operation: context.get("operation"),
      errorName,
      retryable,
    }),
  )
}
