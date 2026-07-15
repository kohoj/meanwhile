import { DurableObject } from "cloudflare:workers"
import {
  Sandbox as CloudflareSandbox,
  isPlatformTransientError,
  ContainerProxy as SandboxContainerProxy,
} from "@cloudflare/sandbox"
import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { z } from "zod"

import {
  type AttachCredentialLeaseRequest,
  attachCredentialLeaseRequestSchema,
  BRIDGE_PROTOCOL_VERSION,
  BridgeError,
  CLOUDFLARE_SANDBOX_VERSION,
  type CredentialLeaseSnapshot,
  createRuntimeRequestSchema,
  credentialLeaseIdSchema,
  exposePortParamsSchema,
  listFilesQuerySchema,
  type ProcessSnapshot,
  processEventsQuerySchema,
  processIdFromOperation,
  processIdSchema,
  processInputFingerprint,
  processInputRequestSchema,
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
  type CloudflareRuntimeSandbox,
  createCloudflareRuntimeFactory,
} from "./sandbox"

const SERVICE_NAME = "meanwhile-cloudflare-sandbox-bridge"
const MAX_REQUEST_BYTES = 24 * 1024 * 1024
const MINIMUM_TOKEN_BYTES = 32
const MAXIMUM_TOKEN_BYTES = 512
const PROCESS_TERMINAL_EVIDENCE_GRACE_MS = 30_000

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
  readonly placementId: string | null
  readonly processCount: number
  readonly activeProcessCount: number
}

interface ProcessReservation {
  readonly status: "reserved" | "existing" | "conflict" | "runtime_unavailable"
  readonly runtimeState?: RuntimeRegistryRecord["state"]
}

interface StoredCredentialLease {
  readonly version: 1
  readonly leaseId: string
  readonly runtimeId: string
  readonly fingerprint: string
  readonly state: "active" | "revoked"
  readonly iv?: string
  readonly ciphertext?: string
  readonly environmentNames: readonly string[]
}

interface CredentialAuthorization {
  readonly allowed: boolean
  readonly replacements: readonly { readonly placeholder: string; readonly value: string }[]
}

export interface ProtectedCredentialPayload {
  readonly allowedHosts: readonly string[]
  readonly credentials: readonly {
    readonly environmentVariable: string
    readonly host: string
    readonly methods: readonly string[]
    readonly placeholder: string
    readonly value: string
  }[]
}

export interface BridgeRegistry {
  create(runtimeId: string): Promise<RuntimeSnapshot>
  start(runtimeId: string): Promise<RuntimeSnapshot>
  inspect(runtimeId: string): Promise<RuntimeSnapshot>
  stop(runtimeId: string): Promise<RuntimeSnapshot>
  destroy(runtimeId: string): Promise<RuntimeSnapshot>
  assertActive(runtimeId: string): Promise<string | null>
  reserveProcess(
    runtimeId: string,
    processId: string,
    fingerprint: string,
    recoveryWindowMs: number | null,
  ): Promise<"reserved" | "existing">
  getProcessSnapshot(runtimeId: string, processId: string): Promise<ProcessSnapshot | null>
  getProcessEvidenceDeadline(runtimeId: string, processId: string): Promise<string | null>
  observeProcessSnapshot(runtimeId: string, process: ProcessSnapshot): Promise<ProcessSnapshot>
  reserveProcessInput(
    runtimeId: string,
    processId: string,
    sequence: number,
    fingerprint: string,
  ): Promise<"reserved" | "existing">
  attachCredentialLease(
    runtimeId: string,
    request: AttachCredentialLeaseRequest,
  ): Promise<CredentialLeaseSnapshot>
  revokeCredentialLease(runtimeId: string, leaseId: string): Promise<void>
}

export type BridgeRegistryFactory = (
  runtimeId: string,
  environment: CloudflareBridgeEnvironment,
) => BridgeRegistry

const RUNTIME_RECORD_KEY = "runtime"
const PROCESS_FINGERPRINT_PREFIX = "process:"
const PROCESS_SNAPSHOT_PREFIX = "process-state:"
const PROCESS_EVIDENCE_DEADLINE_PREFIX = "process-evidence-deadline:"
const PROCESS_INPUT_FINGERPRINT_PREFIX = "input:"
const CREDENTIAL_LEASE_PREFIX = "credential:"
const RUNTIME_LEASE_KEY = "meanwhile:runtime-lease:v1"

export class Sandbox
  extends CloudflareSandbox<CloudflareBridgeEnvironment>
  implements CloudflareRuntimeSandbox
{
  readonly #state: DurableObjectState<Record<never, never>>
  override interceptHttps = true

  constructor(
    state: DurableObjectState<Record<never, never>>,
    environment: CloudflareBridgeEnvironment,
  ) {
    super(state, environment)
    this.#state = state
  }

  async setRuntimeLease(active: boolean): Promise<void> {
    await this.#state.storage.put(RUNTIME_LEASE_KEY, active)
    if (active) this.renewActivityTimeout()
  }

  override async onActivityExpired(): Promise<void> {
    const runtimeLeaseActive = (await this.#state.storage.get<boolean>(RUNTIME_LEASE_KEY)) === true
    console.log(
      JSON.stringify({
        event: "meanwhile.runtime_lease.activity_expired",
        runtimeLeaseActive,
      }),
    )
    if (runtimeLeaseActive) {
      this.renewActivityTimeout()
      return
    }
    await super.onActivityExpired()
  }

  override async onStop(stop?: Readonly<{ exitCode: number; reason: string }>): Promise<void> {
    console.log(
      JSON.stringify({
        event: "meanwhile.runtime_lease.container_stopped",
        exitCode: stop?.exitCode ?? null,
        reason: stop?.reason ?? null,
      }),
    )
    await super.onStop()
  }

  override async destroy(): Promise<void> {
    await this.#state.storage.delete(RUNTIME_LEASE_KEY)
    await super.destroy()
  }
}

Sandbox.outboundHandlers = { credentialEgress }
Sandbox.outbound = () => deniedEgress()

export class ContainerProxy extends SandboxContainerProxy {
  override fetch(request: Request): Promise<Response> {
    const props = this.ctx.props as unknown as {
      readonly containerId?: string
      readonly outboundByHostOverrides?: Readonly<
        Record<string, { readonly method: string; readonly params?: unknown }>
      >
    }
    const host = new URL(request.url).hostname
    const override = props.outboundByHostOverrides?.[host]
    if (override?.method === "credentialEgress") {
      return credentialEgress(request, this.env as CloudflareBridgeEnvironment, {
        containerId: props.containerId ?? "",
        params: override.params,
      })
    }
    return Promise.resolve(deniedEgress())
  }
}

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
      placementId: null,
      processCount: 0,
      activeProcessCount: 0,
    }
    await this.#write(record)
    return registrySnapshot(record)
  }

  async startRuntime(runtimeId: string): Promise<RuntimeSnapshot> {
    const record = await this.#require(runtimeId)
    if (record.state === "destroyed") return registrySnapshot(record)

    const runtime = this.#runtime(runtimeId)
    const snapshot = await runtime.start()
    const placementId = await runtime.placementId()
    if (record.materialized) await runtime.assertPlacement(record.placementId, false)
    const active = registryRecord(record, {
      state: "active",
      materialized: true,
      placementId,
      processCount: snapshot.processCount,
      activeProcessCount: snapshot.activeProcessCount,
    })
    await this.#write(active)
    return snapshot
  }

  async inspectRuntime(runtimeId: string): Promise<RuntimeSnapshot> {
    const record = await this.#require(runtimeId)
    if (record.state !== "active") return registrySnapshot(record)

    const runtime = this.#runtime(runtimeId)
    const snapshot = await withRuntimePlacement(
      runtime,
      record.placementId,
      () => runtime.inspect(),
      "observe",
    )
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

    await this.#revokeAllCredentials(runtimeId, record)
    if (record.materialized) await this.#runtime(runtimeId).destroy()
    const destroyed = registryRecord(record, {
      state: "destroyed",
      materialized: false,
      placementId: null,
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
    recoveryWindowMs: number | null,
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
    await this.#state.storage.put({
      [key]: fingerprint,
      [`${PROCESS_SNAPSHOT_PREFIX}${processId}`]: provisionalProcessSnapshot(runtimeId, processId),
      [`${PROCESS_EVIDENCE_DEADLINE_PREFIX}${processId}`]:
        processEvidenceDeadline(recoveryWindowMs),
    })
    return { status: "reserved" }
  }

  async processSnapshot(runtimeId: string, processId: string): Promise<ProcessSnapshot | null> {
    await this.#require(runtimeId)
    return (
      (await this.#state.storage.get<ProcessSnapshot>(`${PROCESS_SNAPSHOT_PREFIX}${processId}`)) ??
      null
    )
  }

  async processEvidenceDeadline(runtimeId: string, processId: string): Promise<string | null> {
    await this.#require(runtimeId)
    return (
      (await this.#state.storage.get<string | null>(
        `${PROCESS_EVIDENCE_DEADLINE_PREFIX}${processId}`,
      )) ?? null
    )
  }

  async observeProcessSnapshot(
    runtimeId: string,
    process: ProcessSnapshot,
  ): Promise<ProcessSnapshot> {
    await this.#require(runtimeId)
    const key = `${PROCESS_SNAPSHOT_PREFIX}${process.handle.id}`
    const existing = await this.#state.storage.get<ProcessSnapshot>(key)
    if (!existing) throw new Error("PROCESS_RESERVATION_MISSING")
    const observed = mergeProcessSnapshot(runtimeId, existing, process)
    if (observed !== existing) await this.#state.storage.put(key, observed)
    return observed
  }

  async reserveProcessInput(
    runtimeId: string,
    processId: string,
    sequence: number,
    fingerprint: string,
  ): Promise<ProcessReservation> {
    const runtime = await this.#record()
    if (!runtime || runtime.runtimeId !== runtimeId || runtime.state !== "active") {
      return runtime
        ? { status: "runtime_unavailable", runtimeState: runtime.state }
        : { status: "runtime_unavailable" }
    }
    const key = `${PROCESS_INPUT_FINGERPRINT_PREFIX}${processId}:${sequence}`
    const existing = await this.#state.storage.get<string>(key)
    if (existing === fingerprint) return { status: "existing" }
    if (existing !== undefined) return { status: "conflict" }
    await this.#state.storage.put(key, fingerprint)
    return { status: "reserved" }
  }

  async attachCredentialLease(
    runtimeId: string,
    request: AttachCredentialLeaseRequest,
  ): Promise<CredentialLeaseSnapshot> {
    const runtime = await this.#require(runtimeId)
    if (runtime.state !== "active") throw new Error("RUNTIME_NOT_ACTIVE")
    const key = `${CREDENTIAL_LEASE_PREFIX}${request.leaseId}`
    const fingerprint = await keyedDigest(
      this.#environment.BRIDGE_TOKEN,
      `credential-fingerprint\0${canonicalJson(request)}`,
    )
    const existing = await this.#state.storage.get<StoredCredentialLease>(key)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint || existing.runtimeId !== runtimeId) {
        throw new BridgeError(
          "CREDENTIAL_LEASE_CONFLICT",
          "The credential lease identity is already bound to different policy.",
          409,
        )
      }
      if (existing.state === "revoked") {
        throw new BridgeError(
          "CREDENTIAL_LEASE_REVOKED",
          "The credential lease has already been revoked.",
          409,
        )
      }
      const providerRuntime = this.#runtime(runtimeId)
      await withRuntimePlacement(providerRuntime, runtime.placementId, () =>
        providerRuntime.configureCredentialLease(request),
      )
      return credentialSnapshot(runtimeId, request, this.#environment.BRIDGE_TOKEN)
    }

    const snapshot = await credentialSnapshot(runtimeId, request, this.#environment.BRIDGE_TOKEN)
    const protectedPayload = await encryptCredentialPayload(
      this.#environment.BRIDGE_TOKEN,
      request.leaseId,
      {
        allowedHosts: request.allowedHosts,
        credentials: request.credentials.map((credential) => ({
          environmentVariable: credential.environmentVariable,
          host: credential.host,
          methods: credential.methods,
          placeholder: snapshot.environment[credential.environmentVariable] as string,
          value: credential.value,
        })),
      },
    )
    await this.#state.storage.put(key, {
      version: 1,
      leaseId: request.leaseId,
      runtimeId,
      fingerprint,
      state: "active",
      ...protectedPayload,
      environmentNames: Object.keys(snapshot.environment).sort(),
    } satisfies StoredCredentialLease)
    const providerRuntime = this.#runtime(runtimeId)
    await withRuntimePlacement(providerRuntime, runtime.placementId, () =>
      providerRuntime.configureCredentialLease(request),
    )
    return snapshot
  }

  async revokeCredentialLease(runtimeId: string, leaseId: string): Promise<void> {
    const runtime = await this.#require(runtimeId)
    const key = `${CREDENTIAL_LEASE_PREFIX}${leaseId}`
    const existing = await this.#state.storage.get<StoredCredentialLease>(key)
    if (existing === undefined || existing.state === "revoked") return
    if (existing.runtimeId !== runtimeId) {
      throw new BridgeError(
        "CREDENTIAL_LEASE_CONFLICT",
        "The credential lease belongs to another runtime.",
        409,
      )
    }
    if (runtime.state === "active") {
      const providerRuntime = this.#runtime(runtimeId)
      await withRuntimePlacement(providerRuntime, runtime.placementId, () =>
        providerRuntime.clearCredentialLease(),
      )
    }
    await this.#state.storage.put(key, {
      version: 1,
      leaseId,
      runtimeId,
      fingerprint: existing.fingerprint,
      state: "revoked",
      environmentNames: existing.environmentNames,
    } satisfies StoredCredentialLease)
  }

  async authorizeCredentialRequest(
    runtimeId: string,
    host: string,
    method: string,
  ): Promise<CredentialAuthorization> {
    const runtime = await this.#record()
    if (!runtime || runtime.runtimeId !== runtimeId || runtime.state !== "active") {
      return { allowed: false, replacements: [] }
    }
    const records = await this.#state.storage.list<StoredCredentialLease>({
      prefix: CREDENTIAL_LEASE_PREFIX,
    })
    const active = [...records.values()].filter(
      (record) => record.runtimeId === runtimeId && record.state === "active",
    )
    if (active.length !== 1) return { allowed: false, replacements: [] }
    const record = active[0] as StoredCredentialLease
    if (record.iv === undefined || record.ciphertext === undefined) {
      return { allowed: false, replacements: [] }
    }
    const payload = await decryptCredentialPayload(
      this.#environment.BRIDGE_TOKEN,
      record.leaseId,
      record.iv,
      record.ciphertext,
    )
    if (!payload.allowedHosts.includes(host)) return { allowed: false, replacements: [] }
    return {
      allowed: true,
      replacements: payload.credentials
        .filter((credential) => credential.host === host && credential.methods.includes(method))
        .map(({ placeholder, value }) => ({ placeholder, value })),
    }
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

  async #revokeAllCredentials(runtimeId: string, runtime: RuntimeRegistryRecord): Promise<void> {
    const records = await this.#state.storage.list<StoredCredentialLease>({
      prefix: CREDENTIAL_LEASE_PREFIX,
    })
    const active = [...records.values()].filter(
      (record) => record.runtimeId === runtimeId && record.state === "active",
    )
    if (active.length > 0 && runtime.state === "active") {
      await this.#runtime(runtimeId).clearCredentialLease()
    }
    for (const record of active) {
      await this.#state.storage.put(`${CREDENTIAL_LEASE_PREFIX}${record.leaseId}`, {
        version: 1,
        leaseId: record.leaseId,
        runtimeId,
        fingerprint: record.fingerprint,
        state: "revoked",
        environmentNames: record.environmentNames,
      } satisfies StoredCredentialLease)
    }
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
    recoveryWindowMs: number | null,
  ): Promise<ProcessReservation>
  processSnapshot(runtimeId: string, processId: string): Promise<ProcessSnapshot | null>
  processEvidenceDeadline(runtimeId: string, processId: string): Promise<string | null>
  observeProcessSnapshot(runtimeId: string, process: ProcessSnapshot): Promise<ProcessSnapshot>
  reserveProcessInput(
    runtimeId: string,
    processId: string,
    sequence: number,
    fingerprint: string,
  ): Promise<ProcessReservation>
  attachCredentialLease(
    runtimeId: string,
    request: AttachCredentialLeaseRequest,
  ): Promise<CredentialLeaseSnapshot>
  revokeCredentialLease(runtimeId: string, leaseId: string): Promise<void>
  authorizeCredentialRequest(
    runtimeId: string,
    host: string,
    method: string,
  ): Promise<CredentialAuthorization>
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

  async assertActive(runtimeId: string): Promise<string | null> {
    const record = await this.#stub.runtimeState(runtimeId)
    assertRegistryActive(record)
    return record.placementId
  }

  async reserveProcess(
    runtimeId: string,
    processId: string,
    fingerprint: string,
    recoveryWindowMs: number | null,
  ): Promise<"reserved" | "existing"> {
    return requireProcessReservation(
      await this.#stub.reserveProcess(runtimeId, processId, fingerprint, recoveryWindowMs),
    )
  }

  getProcessSnapshot(runtimeId: string, processId: string): Promise<ProcessSnapshot | null> {
    return this.#stub.processSnapshot(runtimeId, processId)
  }

  getProcessEvidenceDeadline(runtimeId: string, processId: string): Promise<string | null> {
    return this.#stub.processEvidenceDeadline(runtimeId, processId)
  }

  observeProcessSnapshot(runtimeId: string, process: ProcessSnapshot): Promise<ProcessSnapshot> {
    return this.#stub.observeProcessSnapshot(runtimeId, process)
  }

  async reserveProcessInput(
    runtimeId: string,
    processId: string,
    sequence: number,
    fingerprint: string,
  ): Promise<"reserved" | "existing"> {
    return requireProcessReservation(
      await this.#stub.reserveProcessInput(runtimeId, processId, sequence, fingerprint),
      "PROCESS_INPUT_CONFLICT",
    )
  }

  attachCredentialLease(
    runtimeId: string,
    request: AttachCredentialLeaseRequest,
  ): Promise<CredentialLeaseSnapshot> {
    return this.#stub.attachCredentialLease(runtimeId, request)
  }

  revokeCredentialLease(runtimeId: string, leaseId: string): Promise<void> {
    return this.#stub.revokeCredentialLease(runtimeId, leaseId)
  }
}

/** Deterministic test double for the same lifecycle contract. */
export class InMemoryBridgeRegistry implements BridgeRegistry {
  readonly #runtimeFactory: BridgeRuntimeFactory
  readonly #records = new Map<string, RuntimeRegistryRecord>()
  readonly #fingerprints = new Map<string, string>()
  readonly #processSnapshots = new Map<string, ProcessSnapshot>()
  readonly #processEvidenceDeadlines = new Map<string, string | null>()
  readonly #inputFingerprints = new Map<string, string>()
  readonly #credentialLeases = new Map<
    string,
    { readonly fingerprint: string; readonly snapshot: CredentialLeaseSnapshot; revoked: boolean }
  >()

  constructor(runtimeFactory: BridgeRuntimeFactory) {
    this.#runtimeFactory = runtimeFactory
  }

  seed(
    runtimeId: string,
    state: RuntimeRegistryRecord["state"] = "active",
    placementId: string | null = null,
  ): void {
    this.#records.set(runtimeId, {
      version: 1,
      runtimeId,
      state,
      materialized: state === "active" || state === "stopped",
      placementId,
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
      placementId: null,
      processCount: 0,
      activeProcessCount: 0,
    }
    this.#records.set(runtimeId, record)
    return registrySnapshot(record)
  }

  async start(runtimeId: string): Promise<RuntimeSnapshot> {
    const record = this.#require(runtimeId)
    if (record.state === "destroyed") throw runtimeNotFound()
    const runtime = this.#runtimeFactory(runtimeId)
    const snapshot = await runtime.start()
    const placementId = await runtime.placementId()
    if (record.materialized) await runtime.assertPlacement(record.placementId, false)
    this.#records.set(
      runtimeId,
      registryRecord(record, {
        state: "active",
        materialized: true,
        placementId,
        processCount: snapshot.processCount,
        activeProcessCount: snapshot.activeProcessCount,
      }),
    )
    return snapshot
  }

  async inspect(runtimeId: string): Promise<RuntimeSnapshot> {
    const record = this.#require(runtimeId)
    if (record.state !== "active") return registrySnapshot(record)
    const runtime = this.#runtimeFactory(runtimeId)
    return withRuntimePlacement(runtime, record.placementId, () => runtime.inspect(), "observe")
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
    const activeCredentialLeases = [...this.#credentialLeases.entries()].filter(
      ([key, lease]) => key.startsWith(`${runtimeId}:`) && !lease.revoked,
    )
    if (activeCredentialLeases.length > 0 && record.state === "active") {
      await this.#runtimeFactory(runtimeId).clearCredentialLease()
    }
    for (const [, lease] of activeCredentialLeases) lease.revoked = true
    if (record.materialized) await this.#runtimeFactory(runtimeId).destroy()
    const destroyed = registryRecord(record, {
      state: "destroyed",
      materialized: false,
      placementId: null,
      processCount: 0,
      activeProcessCount: 0,
    })
    this.#records.set(runtimeId, destroyed)
    return registrySnapshot(destroyed)
  }

  async assertActive(runtimeId: string): Promise<string | null> {
    const record = this.#records.get(runtimeId) ?? null
    assertRegistryActive(record)
    return record.placementId
  }

  async reserveProcess(
    runtimeId: string,
    processId: string,
    fingerprint: string,
    recoveryWindowMs: number | null,
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
    this.#processSnapshots.set(key, provisionalProcessSnapshot(runtimeId, processId))
    this.#processEvidenceDeadlines.set(key, processEvidenceDeadline(recoveryWindowMs))
    return "reserved"
  }

  async getProcessSnapshot(runtimeId: string, processId: string): Promise<ProcessSnapshot | null> {
    await this.assertActive(runtimeId)
    return this.#processSnapshots.get(`${runtimeId}:${processId}`) ?? null
  }

  async getProcessEvidenceDeadline(runtimeId: string, processId: string): Promise<string | null> {
    await this.assertActive(runtimeId)
    return this.#processEvidenceDeadlines.get(`${runtimeId}:${processId}`) ?? null
  }

  async observeProcessSnapshot(
    runtimeId: string,
    process: ProcessSnapshot,
  ): Promise<ProcessSnapshot> {
    await this.assertActive(runtimeId)
    const key = `${runtimeId}:${process.handle.id}`
    const existing = this.#processSnapshots.get(key)
    if (!existing) throw new Error("PROCESS_RESERVATION_MISSING")
    const observed = mergeProcessSnapshot(runtimeId, existing, process)
    this.#processSnapshots.set(key, observed)
    return observed
  }

  async reserveProcessInput(
    runtimeId: string,
    processId: string,
    sequence: number,
    fingerprint: string,
  ): Promise<"reserved" | "existing"> {
    await this.assertActive(runtimeId)
    const key = `${runtimeId}:${processId}:${sequence}`
    const existing = this.#inputFingerprints.get(key)
    if (existing === fingerprint) return "existing"
    if (existing !== undefined) {
      throw new BridgeError(
        "PROCESS_INPUT_CONFLICT",
        "The process input sequence is already bound to different data.",
        409,
        { retryable: false },
      )
    }
    this.#inputFingerprints.set(key, fingerprint)
    return "reserved"
  }

  async attachCredentialLease(
    runtimeId: string,
    request: AttachCredentialLeaseRequest,
  ): Promise<CredentialLeaseSnapshot> {
    const placementId = await this.assertActive(runtimeId)
    const runtime = this.#runtimeFactory(runtimeId)
    const key = `${runtimeId}:${request.leaseId}`
    const fingerprint = canonicalJson(request)
    const existing = this.#credentialLeases.get(key)
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.revoked) {
        throw new BridgeError(
          existing.revoked ? "CREDENTIAL_LEASE_REVOKED" : "CREDENTIAL_LEASE_CONFLICT",
          "The credential lease cannot be reused.",
          409,
        )
      }
      await withRuntimePlacement(runtime, placementId, () =>
        runtime.configureCredentialLease(request),
      )
      return existing.snapshot
    }
    const environment = Object.fromEntries(
      [...new Set(request.credentials.map(({ environmentVariable }) => environmentVariable))].map(
        (name) => [name, `mwcap_test_${request.leaseId}_${name}`],
      ),
    )
    const snapshot: CredentialLeaseSnapshot = {
      version: BRIDGE_PROTOCOL_VERSION,
      id: request.leaseId,
      runtimeId,
      environment,
    }
    this.#credentialLeases.set(key, { fingerprint, snapshot, revoked: false })
    await withRuntimePlacement(runtime, placementId, () =>
      runtime.configureCredentialLease(request),
    )
    return snapshot
  }

  async revokeCredentialLease(runtimeId: string, leaseId: string): Promise<void> {
    const existing = this.#credentialLeases.get(`${runtimeId}:${leaseId}`)
    if (!existing || existing.revoked) return
    const placementId = await this.assertActive(runtimeId)
    const runtime = this.#runtimeFactory(runtimeId)
    await withRuntimePlacement(runtime, placementId, () => runtime.clearCredentialLease())
    existing.revoked = true
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
        networkPolicy: "exact-host-default-deny",
        credentialMediation: "http-placeholder",
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

  app.post("/v1/runtimes/:runtimeId/credential-leases", async (context) => {
    context.set("operation", "credential.attach")
    const request = await parseJson(context, attachCredentialLeaseRequestSchema)
    const runtimeId = getRuntimeId(context)
    return context.json(
      {
        credentialLease: await getRegistry(context, options, runtimeId).attachCredentialLease(
          runtimeId,
          request,
        ),
      },
      201,
    )
  })

  app.delete("/v1/runtimes/:runtimeId/credential-leases/:leaseId", async (context) => {
    context.set("operation", "credential.revoke")
    const runtimeId = getRuntimeId(context)
    const leaseId = parseValue(credentialLeaseIdSchema, context.req.param("leaseId"))
    await getRegistry(context, options, runtimeId).revokeCredentialLease(runtimeId, leaseId)
    return context.json({ revoked: true })
  })

  app.post("/v1/runtimes/:runtimeId/processes", async (context) => {
    context.set("operation", "process.spawn")
    const request = await parseJson(context, spawnProcessRequestSchema)
    const processId = processIdFromOperation(request.operationId)
    const runtimeId = getRuntimeId(context)
    const registry = getRegistry(context, options, runtimeId)
    const placementId = await registry.assertActive(runtimeId)
    const runtime = getRuntime(context, options, runtimeId)
    let process: ProcessSnapshot
    try {
      process = await withRuntimePlacement(runtime, placementId, async () => {
        const reservation = await registry.reserveProcess(
          runtimeId,
          processId,
          await processSpecFingerprint(request),
          request.timeoutMs === undefined
            ? null
            : request.timeoutMs + (request.terminationGraceMs ?? 0),
        )
        const known = await registry.getProcessSnapshot(runtimeId, processId)
        return runtime.spawn(
          processId,
          request,
          reservation === "reserved" ? "initial" : "reconcile",
          known ?? undefined,
          await registry.getProcessEvidenceDeadline(runtimeId, processId),
        )
      })
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== "STAGING_CLEANUP_FAILED") throw error
      let runtimeDestroyed = false
      try {
        await registry.destroy(runtimeId)
        runtimeDestroyed = true
      } catch {}
      throw new BridgeError(
        "STAGING_CLEANUP_FAILED",
        runtimeDestroyed
          ? `${error.message} The runtime was destroyed.`
          : `${error.message} Runtime destruction also failed.`,
        502,
        { retryable: false, runtimeDestroyed },
      )
    }
    await registry.observeProcessSnapshot(runtimeId, process)
    return context.json({ process }, 201)
  })

  app.get("/v1/runtimes/:runtimeId/processes/:processId", async (context) => {
    context.set("operation", "process.inspect")
    const processId = parseValue(processIdSchema, context.req.param("processId"))
    const runtimeId = getRuntimeId(context)
    const registry = getRegistry(context, options, runtimeId)
    const placementId = await registry.assertActive(runtimeId)
    const known = await registry.getProcessSnapshot(runtimeId, processId)
    if (!known) throw new BridgeError("PROCESS_NOT_FOUND", "The process does not exist.", 404)
    const runtime = getRuntime(context, options, runtimeId)
    const evidenceDeadline = await registry.getProcessEvidenceDeadline(runtimeId, processId)
    const process = await withRuntimePlacement(
      runtime,
      placementId,
      () => runtime.inspectProcess(processId, known, evidenceDeadline),
      "observe",
    )
    await registry.observeProcessSnapshot(runtimeId, process)
    return context.json({
      process,
    })
  })

  app.get("/v1/runtimes/:runtimeId/processes/:processId/events", async (context) => {
    context.set("operation", "process.events")
    const processId = parseValue(processIdSchema, context.req.param("processId"))
    const query = parseValue(processEventsQuerySchema, context.req.query())
    const runtimeId = getRuntimeId(context)
    const registry = getRegistry(context, options, runtimeId)
    const placementId = await registry.assertActive(runtimeId)
    const known = await registry.getProcessSnapshot(runtimeId, processId)
    if (!known) throw new BridgeError("PROCESS_NOT_FOUND", "The process does not exist.", 404)
    const runtime = getRuntime(context, options, runtimeId)
    const evidenceDeadline = await registry.getProcessEvidenceDeadline(runtimeId, processId)
    const response = await withRuntimePlacement(
      runtime,
      placementId,
      () => runtime.events(processId, query.cursor, query.limitChars, known, evidenceDeadline),
      "observe",
    )
    const exit = response.events.find((event) => event.type === "exit")
    if (exit) {
      await registry.observeProcessSnapshot(runtimeId, {
        ...known,
        status: exit.status,
        finishedAt: exit.timestamp,
        exitCode: exit.exitCode,
      })
    }
    return context.json(response)
  })

  app.post("/v1/runtimes/:runtimeId/processes/:processId/signal", async (context) => {
    context.set("operation", "process.signal")
    const processId = parseValue(processIdSchema, context.req.param("processId"))
    const request = await parseJson(context, signalProcessRequestSchema)
    const runtimeId = getRuntimeId(context)
    const registry = getRegistry(context, options, runtimeId)
    const placementId = await registry.assertActive(runtimeId)
    const known = await registry.getProcessSnapshot(runtimeId, processId)
    if (!known) throw new BridgeError("PROCESS_NOT_FOUND", "The process does not exist.", 404)
    const runtime = getRuntime(context, options, runtimeId)
    const process = isTerminalProcessStatus(known.status)
      ? known
      : await withRuntimePlacement(runtime, placementId, () =>
          runtime.signal(processId, request.signal, known),
        )
    await registry.observeProcessSnapshot(runtimeId, process)
    return context.json({
      process,
    })
  })

  app.post("/v1/runtimes/:runtimeId/processes/:processId/input", async (context) => {
    context.set("operation", "process.input")
    const processId = parseValue(processIdSchema, context.req.param("processId"))
    const request = await parseJson(context, processInputRequestSchema)
    const runtimeId = getRuntimeId(context)
    const registry = getRegistry(context, options, runtimeId)
    const placementId = await registry.assertActive(runtimeId)
    const runtime = getRuntime(context, options, runtimeId)
    await withRuntimePlacement(runtime, placementId, async () => {
      await registry.reserveProcessInput(
        runtimeId,
        processId,
        request.sequence,
        await processInputFingerprint(request),
      )
      await runtime.send(processId, request)
    })
    return context.json({ accepted: true })
  })

  app.get("/v1/runtimes/:runtimeId/processes/:processId/wait", async (context) => {
    context.set("operation", "process.wait")
    const processId = parseValue(processIdSchema, context.req.param("processId"))
    const query = parseValue(waitProcessQuerySchema, context.req.query())
    const runtimeId = getRuntimeId(context)
    const registry = getRegistry(context, options, runtimeId)
    const placementId = await registry.assertActive(runtimeId)
    const known = await registry.getProcessSnapshot(runtimeId, processId)
    if (!known) throw new BridgeError("PROCESS_NOT_FOUND", "The process does not exist.", 404)
    const runtime = getRuntime(context, options, runtimeId)
    const evidenceDeadline = await registry.getProcessEvidenceDeadline(runtimeId, processId)
    const process = isTerminalProcessStatus(known.status)
      ? known
      : await withRuntimePlacement(
          runtime,
          placementId,
          () => runtime.wait(processId, query.timeoutMs, known, evidenceDeadline),
          "observe",
        )
    await registry.observeProcessSnapshot(runtimeId, process)
    return context.json({
      process,
    })
  })

  app.put("/v1/runtimes/:runtimeId/files", async (context) => {
    context.set("operation", "files.write")
    const request = await parseJson(context, writeFilesRequestSchema)
    const runtimeId = getRuntimeId(context)
    const registry = getRegistry(context, options, runtimeId)
    const placementId = await registry.assertActive(runtimeId)
    const runtime = getRuntime(context, options, runtimeId)
    await withRuntimePlacement(runtime, placementId, () => runtime.writeFiles(request))
    return context.json({ written: request.files.map((file) => file.path) })
  })

  app.get("/v1/runtimes/:runtimeId/files", async (context) => {
    context.set("operation", "files.list")
    const query = parseValue(listFilesQuerySchema, context.req.query())
    const runtimeId = getRuntimeId(context)
    const registry = getRegistry(context, options, runtimeId)
    const placementId = await registry.assertActive(runtimeId)
    const runtime = getRuntime(context, options, runtimeId)
    return context.json({
      files: await withRuntimePlacement(
        runtime,
        placementId,
        () => runtime.listFiles(query.path, query.recursive, query.maxEntries),
        "observe",
      ),
    })
  })

  app.get("/v1/runtimes/:runtimeId/file", async (context) => {
    context.set("operation", "files.read")
    const query = parseValue(readFileQuerySchema, context.req.query())
    const runtimeId = getRuntimeId(context)
    const registry = getRegistry(context, options, runtimeId)
    const placementId = await registry.assertActive(runtimeId)
    const runtime = getRuntime(context, options, runtimeId)
    const file = await withRuntimePlacement(
      runtime,
      placementId,
      () => runtime.readFile(query.path, query.maxBytes),
      "observe",
    )
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
    const registry = getRegistry(context, options, params.runtimeId)
    const placementId = await registry.assertActive(params.runtimeId)
    const runtime = getRuntime(context, options, params.runtimeId)
    return context.json(
      {
        endpoint: await withRuntimePlacement(runtime, placementId, () =>
          runtime.expose(params.port, new URL(context.req.url).hostname),
        ),
      },
      201,
    )
  })

  app.delete("/v1/runtimes/:runtimeId/ports/:port/expose", async (context) => {
    context.set("operation", "port.unexpose")
    const params = parseValue(exposePortParamsSchema, context.req.param())
    const registry = getRegistry(context, options, params.runtimeId)
    const placementId = await registry.assertActive(params.runtimeId)
    const runtime = getRuntime(context, options, params.runtimeId)
    await withRuntimePlacement(runtime, placementId, () => runtime.unexpose(params.port))
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
        logFailure(context, error.name, error.details.retryable === true, error.code)
      }
      return errorResponse(context, error)
    }

    // The pinned SDK deliberately rejects in-isolate retries after a Durable
    // Object interruption because mutation admission may be unknown. The
    // bridge returns control to a fresh HTTP request instead; every public
    // operation is bound to a durable identity and is idempotent at that
    // boundary, so the provider client can safely reconcile it there.
    const retryable =
      isPlatformTransientError(error) || safeErrorName(error) === "OperationInterruptedError"
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

async function withRuntimePlacement<T>(
  runtime: BridgeRuntime,
  placementId: string | null,
  operation: () => Promise<T>,
  mode: "mutate" | "observe" = "mutate",
): Promise<T> {
  // Mutations prove the accepted generation before their side effect. Pure
  // observations let their own provider request perform the handshake, then
  // verify the resulting cached placement; this avoids manufacturing an
  // extra container command for every log poll while preserving fail-closed
  // generation semantics.
  await runtime.assertPlacement(placementId, mode === "mutate")
  let result: T
  try {
    result = await operation()
  } catch (error) {
    // A failed provider call may be the first evidence that the container
    // stopped or was replaced. Force one harmless handshake before preserving
    // the original error so a generation change is reported as RUNTIME_LOST.
    await runtime.assertPlacement(placementId)
    throw error
  }
  await runtime.assertPlacement(placementId, false)
  return result
}

function provisionalProcessSnapshot(runtimeId: string, processId: string): ProcessSnapshot {
  return {
    handle: { version: BRIDGE_PROTOCOL_VERSION, runtimeId, id: processId },
    status: "starting",
    startedAt: new Date().toISOString(),
    exitCode: null,
  }
}

function processEvidenceDeadline(recoveryWindowMs: number | null): string | null {
  return recoveryWindowMs === null
    ? null
    : new Date(Date.now() + recoveryWindowMs + PROCESS_TERMINAL_EVIDENCE_GRACE_MS).toISOString()
}

function mergeProcessSnapshot(
  runtimeId: string,
  existing: ProcessSnapshot,
  observed: ProcessSnapshot,
): ProcessSnapshot {
  if (
    existing.handle.runtimeId !== runtimeId ||
    observed.handle.runtimeId !== runtimeId ||
    existing.handle.id !== observed.handle.id
  ) {
    throw processEvidenceConflict()
  }

  const existingTerminal = isTerminalProcessStatus(existing.status)
  const observedTerminal = isTerminalProcessStatus(observed.status)
  if (existingTerminal) {
    if (
      !observedTerminal ||
      existing.status !== observed.status ||
      existing.exitCode !== observed.exitCode
    ) {
      throw processEvidenceConflict()
    }
    return existing
  }
  return observed
}

function isTerminalProcessStatus(status: ProcessSnapshot["status"]): boolean {
  return status === "completed" || status === "failed" || status === "killed" || status === "error"
}

function processEvidenceConflict(): BridgeError {
  return new BridgeError(
    "PROCESS_EVIDENCE_CONFLICT",
    "The process observation conflicts with its durable lifecycle evidence.",
    409,
    { retryable: false },
  )
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

function requireProcessReservation(
  reservation: ProcessReservation,
  conflictCode = "PROCESS_CONFLICT",
): "reserved" | "existing" {
  if (reservation.status === "reserved" || reservation.status === "existing") {
    return reservation.status
  }
  if (reservation.status === "conflict") {
    throw new BridgeError(
      conflictCode,
      conflictCode === "PROCESS_INPUT_CONFLICT"
        ? "The process input sequence is already bound to different data."
        : "The process operation already identifies a different process specification.",
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

function logFailure(
  context: AppContext,
  errorName: string,
  retryable: boolean,
  errorCode?: string,
): void {
  console.error(
    JSON.stringify({
      event: "cloudflare_bridge.operation_failed",
      requestId: context.get("requestId"),
      operation: context.get("operation"),
      errorName,
      ...(errorCode ? { errorCode } : {}),
      retryable,
    }),
  )
}

async function credentialEgress(
  request: Request,
  environment: CloudflareBridgeEnvironment,
  context: { readonly containerId: string; readonly params?: unknown },
): Promise<Response> {
  const url = new URL(request.url)
  const runtimeId =
    typeof context.params === "object" &&
    context.params !== null &&
    typeof Reflect.get(context.params, "runtimeId") === "string"
      ? String(Reflect.get(context.params, "runtimeId"))
      : ""
  if (
    !context.containerId ||
    !runtimeId ||
    !environment.RuntimeRegistry ||
    !environment.Sandbox ||
    environment.Sandbox.idFromName(runtimeId).toString() !== context.containerId
  ) {
    return deniedEgress()
  }
  const registry = environment.RuntimeRegistry.getByName(runtimeId) as unknown as Pick<
    RuntimeRegistryStub,
    "authorizeCredentialRequest"
  >
  const authorization = await registry.authorizeCredentialRequest(
    runtimeId,
    url.hostname,
    request.method.toUpperCase(),
  )
  if (!authorization.allowed) return deniedEgress()

  const replace = (value: string): string =>
    authorization.replacements.reduce(
      (result, replacement) => result.split(replacement.placeholder).join(replacement.value),
      value,
    )
  const headers = new Headers()
  for (const [name, value] of request.headers) {
    if (name.toLowerCase() !== "content-length") headers.append(name, replace(value))
  }
  headers.set("accept-encoding", "identity")
  const rewrittenUrl = replace(request.url)
  let body: BodyInit | undefined
  if (request.method !== "GET" && request.method !== "HEAD") {
    const declared = Number(request.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return oversizedEgress()
    const bytes = await request.arrayBuffer()
    if (bytes.byteLength > MAX_REQUEST_BYTES) return oversizedEgress()
    const contentType = request.headers.get("content-type") ?? ""
    body = /(?:json|text|xml|x-www-form-urlencoded)/i.test(contentType)
      ? replace(new TextDecoder().decode(bytes))
      : bytes
  }
  const response = await fetch(rewrittenUrl, {
    method: request.method,
    headers,
    redirect: "manual",
    ...(body === undefined ? {} : { body }),
  })
  return redactCredentialResponse(response, authorization.replacements)
}

/** Keeps an authorized destination from reflecting broker-held values into the sandbox. */
export function redactCredentialResponse(
  response: Response,
  replacements: readonly { readonly placeholder: string; readonly value: string }[],
): Response {
  if (replacements.length === 0) return response
  const headers = new Headers()
  const redact = (value: string): string =>
    replacements.reduce(
      (result, replacement) => result.split(replacement.value).join(replacement.placeholder),
      value,
    )
  for (const [name, value] of response.headers) {
    if (!["content-encoding", "content-length", "transfer-encoding"].includes(name.toLowerCase())) {
      headers.append(name, redact(value))
    }
  }
  return new Response(
    response.body === null
      ? null
      : response.body.pipeThrough(credentialResponseRedactor(replacements)),
    { status: response.status, statusText: response.statusText, headers },
  )
}

function credentialResponseRedactor(
  replacements: readonly { readonly placeholder: string; readonly value: string }[],
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder()
  const patterns = [
    ...new Map(
      replacements.map(({ placeholder, value }) => [
        value,
        { source: encoder.encode(value), replacement: encoder.encode(placeholder) },
      ]),
    ).values(),
  ].sort((left, right) => right.source.byteLength - left.source.byteLength)
  const maximumPatternBytes = patterns[0]?.source.byteLength ?? 1
  let pending: Uint8Array = new Uint8Array()
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending = concatenateBytes(pending, chunk)
      const boundary = Math.max(0, pending.byteLength - maximumPatternBytes + 1)
      const rewritten = rewriteCredentialBytes(pending, boundary, patterns)
      if (rewritten.output.byteLength > 0) controller.enqueue(rewritten.output)
      pending = pending.slice(rewritten.consumed)
    },
    flush(controller) {
      const rewritten = rewriteCredentialBytes(pending, pending.byteLength, patterns)
      if (rewritten.output.byteLength > 0) controller.enqueue(rewritten.output)
    },
  })
}

function rewriteCredentialBytes(
  input: Uint8Array,
  boundary: number,
  patterns: readonly { readonly source: Uint8Array; readonly replacement: Uint8Array }[],
): { readonly output: Uint8Array; readonly consumed: number } {
  const output: number[] = []
  let offset = 0
  while (offset < boundary) {
    const pattern = patterns.find(({ source }) => bytesMatch(input, offset, source))
    if (pattern === undefined) {
      output.push(input[offset] as number)
      offset += 1
      continue
    }
    output.push(...pattern.replacement)
    offset += pattern.source.byteLength
  }
  return { output: Uint8Array.from(output), consumed: offset }
}

function bytesMatch(input: Uint8Array, offset: number, pattern: Uint8Array): boolean {
  if (offset + pattern.byteLength > input.byteLength) return false
  for (let index = 0; index < pattern.byteLength; index += 1) {
    if (input[offset + index] !== pattern[index]) return false
  }
  return true
}

function concatenateBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right
  const result = new Uint8Array(left.byteLength + right.byteLength)
  result.set(left)
  result.set(right, left.byteLength)
  return result
}

function deniedEgress(): Response {
  return new Response("Outbound destination is not authorized", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  })
}

function oversizedEgress(): Response {
  return new Response("Outbound request exceeds the mediation limit", {
    status: 413,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  })
}

export async function credentialSnapshot(
  runtimeId: string,
  request: AttachCredentialLeaseRequest,
  key: string,
): Promise<CredentialLeaseSnapshot> {
  const environment = Object.fromEntries(
    await Promise.all(
      [...new Set(request.credentials.map(({ environmentVariable }) => environmentVariable))]
        .sort()
        .map(async (name) => [
          name,
          `mwcap_v1_${await keyedDigest(key, `credential-placeholder\0${runtimeId}\0${request.leaseId}\0${name}`)}`,
        ]),
    ),
  )
  return {
    version: BRIDGE_PROTOCOL_VERSION,
    id: request.leaseId,
    runtimeId,
    environment,
  }
}

export async function encryptCredentialPayload(
  secret: string,
  leaseId: string,
  payload: ProtectedCredentialPayload,
): Promise<{ readonly iv: string; readonly ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(`meanwhile-credential-lease-v1\0${leaseId}`),
    },
    await credentialEncryptionKey(secret),
    new TextEncoder().encode(canonicalJson(payload)),
  )
  return { iv: base64Url(iv), ciphertext: base64Url(new Uint8Array(ciphertext)) }
}

export async function decryptCredentialPayload(
  secret: string,
  leaseId: string,
  iv: string,
  ciphertext: string,
): Promise<ProtectedCredentialPayload> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64Url(iv),
      additionalData: new TextEncoder().encode(`meanwhile-credential-lease-v1\0${leaseId}`),
    },
    await credentialEncryptionKey(secret),
    fromBase64Url(ciphertext),
  )
  return JSON.parse(new TextDecoder().decode(plaintext)) as ProtectedCredentialPayload
}

async function credentialEncryptionKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`meanwhile-credential-store-v1\0${secret}`),
  )
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"])
}

async function keyedDigest(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return base64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))),
  )
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const record = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`
}

function base64Url(value: Uint8Array): string {
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
