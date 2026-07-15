import type { ComponentHealth, ManagedComponent } from "../control-plane"
import {
  CREDENTIAL_LEASE_HANDLE_VERSION,
  CredentialBrokerError,
  type CredentialLease,
  type CredentialLeaseHandle,
  runtimeCredentialBroker,
} from "../credentials"
import type { AuditRecord, JsonObject, StructuredError } from "../domain"
import type { Store } from "../persistence/store"
import type { RuntimeProviderRegistry } from "../providers/registry"
import {
  RUNTIME_HANDLE_VERSION,
  type RuntimeHandle,
  RuntimeProviderError,
} from "../providers/runtime-provider"

const DEFAULT_INTERVAL_MS = 1_000
const DEFAULT_BATCH_SIZE = 25
const BACKOFF_MS = [1_000, 5_000, 30_000, 120_000] as const

/** Durable, bounded credential revocation. Runtime destruction is gated on this lifecycle. */
export class CredentialLeaseReaper implements ManagedComponent {
  readonly name = "credential-lease-reaper"
  readonly #store: Store
  readonly #providers: RuntimeProviderRegistry
  readonly #intervalMs: number
  readonly #batchSize: number
  readonly #clock: () => Date
  #timer: ReturnType<typeof setTimeout> | null = null
  #inFlight: Promise<void> | null = null
  #running = false
  #lastFailure: string | null = null

  constructor(
    store: Store,
    providers: RuntimeProviderRegistry,
    options: {
      readonly intervalMs?: number
      readonly batchSize?: number
      readonly clock?: () => Date
    } = {},
  ) {
    this.#store = store
    this.#providers = providers
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
    this.#clock = options.clock ?? (() => new Date())
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 100) {
      throw new TypeError("Credential reaper interval must be at least 100ms")
    }
    if (!Number.isSafeInteger(this.#batchSize) || this.#batchSize < 1 || this.#batchSize > 100) {
      throw new TypeError("Credential reaper batch size must be between 1 and 100")
    }
  }

  async start(): Promise<void> {
    if (this.#running) return
    this.#running = true
    this.#store.recoverInterruptedCredentialRevocations(this.#now())
    await this.#runTick()
    this.#schedule()
  }

  async stop(): Promise<void> {
    this.#running = false
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    await this.#inFlight
  }

  health(): ComponentHealth {
    if (!this.#running) return { status: "unavailable", message: "Credential reaper is stopped" }
    return this.#lastFailure === null
      ? { status: "healthy" }
      : { status: "degraded", message: this.#lastFailure }
  }

  async runOnce(): Promise<void> {
    const at = this.#now()
    for (const candidate of this.#store.listCredentialRevocationCandidates(at, this.#batchSize)) {
      const lease = this.#store.claimCredentialRevocation(candidate.id, this.#now())
      if (lease === null) continue
      await this.#revoke(lease)
    }
  }

  async #revoke(lease: CredentialLease): Promise<void> {
    const at = this.#now()
    let error: StructuredError | null = null
    try {
      const provider = this.#providers.get(lease.provider)
      const broker = runtimeCredentialBroker(provider)
      if (broker === null) {
        throw new CredentialBrokerError({
          provider: lease.provider,
          operation: "revoke",
          code: "CREDENTIAL_BROKER_UNAVAILABLE",
          message: "The accepted credential broker is unavailable",
        })
      }
      await broker.revoke({
        leaseId: lease.id,
        runtime: runtimeHandle(lease),
        handle: credentialHandle(lease),
      })
    } catch (cause) {
      error = safeRevocationError(cause, lease.provider)
    }
    const delay = error?.retryable === true ? BACKOFF_MS[lease.attempts - 1] : undefined
    const nextAttemptAt =
      delay === undefined ? null : new Date(Date.parse(at) + delay).toISOString()
    this.#store.finishCredentialRevocation({
      leaseId: lease.id,
      at,
      error,
      nextAttemptAt,
      audit: revocationAudit(lease, error, nextAttemptAt, at),
    })
  }

  async #tick(): Promise<void> {
    try {
      await this.runOnce()
      this.#lastFailure = null
    } catch (error) {
      this.#lastFailure = error instanceof Error ? error.name : "CREDENTIAL_REAPER_FAILED"
    }
  }

  #runTick(): Promise<void> {
    if (!this.#running) return Promise.resolve()
    if (this.#inFlight !== null) return this.#inFlight
    const inFlight = this.#tick().finally(() => {
      if (this.#inFlight === inFlight) this.#inFlight = null
    })
    this.#inFlight = inFlight
    return inFlight
  }

  #schedule(): void {
    if (!this.#running || this.#timer !== null) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.#runTick().then(() => this.#schedule())
    }, this.#intervalMs)
  }

  #now(): string {
    const date = this.#clock()
    if (!Number.isFinite(date.getTime())) throw new TypeError("Credential reaper clock is invalid")
    return date.toISOString()
  }
}

const runtimeHandle = (lease: CredentialLease): RuntimeHandle => {
  const { kind, version, provider, opaque } = lease.runtimeHandle
  if (
    kind !== "runtime" ||
    version !== RUNTIME_HANDLE_VERSION ||
    provider !== lease.provider ||
    typeof opaque !== "string" ||
    opaque.length === 0
  ) {
    throw new CredentialBrokerError({
      provider: lease.provider,
      operation: "revoke",
      code: "INVALID_RUNTIME_HANDLE",
      message: "Persisted credential runtime handle is invalid",
    })
  }
  return { kind, version, provider, opaque }
}

const credentialHandle = (lease: CredentialLease): CredentialLeaseHandle | null => {
  if (lease.handle === null) return null
  const { kind, version, provider, opaque } = lease.handle
  if (
    kind !== "credential_lease" ||
    version !== CREDENTIAL_LEASE_HANDLE_VERSION ||
    provider !== lease.provider ||
    typeof opaque !== "string" ||
    opaque.length === 0
  ) {
    throw new CredentialBrokerError({
      provider: lease.provider,
      operation: "revoke",
      code: "INVALID_CREDENTIAL_LEASE_HANDLE",
      message: "Persisted credential lease handle is invalid",
    })
  }
  return { kind, version, provider, opaque }
}

const safeRevocationError = (error: unknown, provider: string): StructuredError => {
  if (error instanceof CredentialBrokerError) {
    return {
      code: "CREDENTIAL_REVOCATION_FAILED",
      message: "The runtime credential lease could not be revoked.",
      retryable: error.retryable,
      details: { provider, providerCode: error.code },
    }
  }
  if (error instanceof RuntimeProviderError) {
    return {
      code: "CREDENTIAL_REVOCATION_FAILED",
      message: "The runtime provider could not revoke its credential lease.",
      retryable: error.retryable,
      details: { provider, providerCode: error.code },
    }
  }
  return {
    code: "CREDENTIAL_REVOCATION_FAILED",
    message: "The runtime credential lease could not be revoked.",
    retryable: false,
    details: { provider },
  }
}

const revocationAudit = (
  lease: CredentialLease,
  error: StructuredError | null,
  nextAttemptAt: string | null,
  at: string,
): AuditRecord => ({
  id: crypto.randomUUID(),
  ownerId: lease.ownerId,
  actorApiKeyId: null,
  action: "credential.revoke",
  resourceType: "credential_lease",
  resourceId: lease.id,
  requestId: `credential-reaper:${crypto.randomUUID()}`,
  traceId: null,
  metadata: {
    resourceType: lease.resourceType,
    resourceId: lease.resourceId,
    provider: lease.provider,
    attempt: lease.attempts,
    outcome: error === null ? "succeeded" : "failed",
    ...(error === null ? {} : { errorCode: error.code, nextAttemptAt }),
  } satisfies JsonObject,
  createdAt: at,
})
