import type { ComponentHealth, ManagedComponent } from "../control-plane"
import type {
  AuditRecord,
  JsonObject,
  RuntimeInstance,
  RuntimeProvisioningIntent,
  StructuredError,
} from "../domain"
import { normalizeError } from "../errors"
import type { Store } from "../persistence/store"
import { observeRuntimeProvider } from "../providers/observed-provider"
import type { RuntimeProviderRegistry } from "../providers/registry"
import {
  RUNTIME_HANDLE_VERSION,
  type RuntimeHandle,
  RuntimeProviderError,
} from "../providers/runtime-provider"
import type { Telemetry } from "../telemetry"

const DEFAULT_BATCH_SIZE = 25
const DEFAULT_BACKOFF_MS = [1_000, 5_000, 30_000, 120_000] as const
const MAX_BACKOFF_STEPS = 10

export type RuntimeCleanupEvent =
  | {
      readonly type: "runtime.cleanup.started"
      readonly runtimeId: string
      readonly runId: string
      readonly ownerId: string
      readonly provider: string
      readonly attempt: number
      readonly at: string
    }
  | {
      readonly type: "runtime.cleanup.succeeded"
      readonly runtimeId: string
      readonly runId: string
      readonly ownerId: string
      readonly provider: string
      readonly attempt: number
      readonly durationMs: number
      readonly at: string
    }
  | {
      readonly type: "runtime.cleanup.failed"
      readonly runtimeId: string
      readonly runId: string
      readonly ownerId: string
      readonly provider: string
      readonly attempt: number
      readonly durationMs: number
      readonly errorCode: string
      readonly exhausted: boolean
      readonly nextAttemptAt: string | null
      readonly at: string
    }

export type RuntimeProvisioningReconciliationEvent =
  | {
      readonly type: "runtime.provisioning.reconcile_started"
      readonly runtimeId: string
      readonly runId: string
      readonly ownerId: string
      readonly provider: string
      readonly attempt: number
      readonly at: string
    }
  | {
      readonly type: "runtime.provisioning.reconciled"
      readonly runtimeId: string
      readonly runId: string
      readonly ownerId: string
      readonly provider: string
      readonly attempt: number
      readonly durationMs: number
      readonly at: string
    }
  | {
      readonly type: "runtime.provisioning.reconcile_failed"
      readonly runtimeId: string
      readonly runId: string
      readonly ownerId: string
      readonly provider: string
      readonly attempt: number
      readonly durationMs: number
      readonly errorCode: string
      readonly exhausted: boolean
      readonly nextAttemptAt: string | null
      readonly at: string
    }

export type RuntimeReaperEvent = RuntimeCleanupEvent | RuntimeProvisioningReconciliationEvent

export interface RuntimeReaperReport {
  readonly recoveredInterrupted: number
  readonly provisioningEligible: number
  readonly provisioningMaterialized: number
  readonly provisioningFailed: number
  readonly provisioningExhausted: number
  readonly eligible: number
  readonly claimed: number
  readonly skippedClaims: number
  readonly succeeded: number
  readonly failed: number
  readonly exhausted: number
  /** Observer failures are isolated from cleanup correctness but never hidden. */
  readonly observerFailures: number
}

export interface RuntimeReaperOptions {
  readonly batchSize?: number
  /** Delays after attempts 1..n. The maximum attempt count is n + 1. */
  readonly backoffMs?: readonly number[]
  readonly clock?: () => Date
  readonly createId?: () => string
  readonly observe?: (event: RuntimeReaperEvent) => void
  readonly telemetry?: Telemetry
}

interface MutableReport {
  recoveredInterrupted: number
  provisioningEligible: number
  provisioningMaterialized: number
  provisioningFailed: number
  provisioningExhausted: number
  eligible: number
  claimed: number
  skippedClaims: number
  succeeded: number
  failed: number
  exhausted: number
  observerFailures: number
}

interface SafeCleanupFailure {
  readonly error: StructuredError
  readonly providerRetryable: boolean
}

/**
 * Reconciles durable cleanup work one bounded batch at a time.
 *
 * There is deliberately no internal timer or retry loop. The control-plane
 * supervisor decides when to call `runOnce`; each call performs at most one
 * destroy attempt for each claimed runtime and persists the next eligible time.
 */
export class RuntimeReaper {
  readonly #store: Store
  readonly #providers: RuntimeProviderRegistry
  readonly #batchSize: number
  readonly #backoffMs: readonly number[]
  readonly #clock: () => Date
  readonly #createId: () => string
  readonly #observe: ((event: RuntimeReaperEvent) => void) | undefined
  readonly #telemetry: Telemetry | undefined
  #reconciled = false

  constructor(
    store: Store,
    providers: RuntimeProviderRegistry,
    options: RuntimeReaperOptions = {},
  ) {
    this.#store = store
    this.#providers = providers
    this.#batchSize = validateBatchSize(options.batchSize ?? DEFAULT_BATCH_SIZE)
    this.#backoffMs = validateBackoff(options.backoffMs ?? DEFAULT_BACKOFF_MS)
    this.#clock = options.clock ?? (() => new Date())
    this.#createId = options.createId ?? (() => crypto.randomUUID())
    this.#observe = options.observe
    this.#telemetry = options.telemetry
  }

  get maxAttempts(): number {
    return this.#backoffMs.length + 1
  }

  async runOnce(): Promise<RuntimeReaperReport> {
    const recoveredInterrupted = this.reconcileInterrupted()
    const eligibleAt = this.#now()
    const report: MutableReport = {
      recoveredInterrupted,
      provisioningEligible: 0,
      provisioningMaterialized: 0,
      provisioningFailed: 0,
      provisioningExhausted: 0,
      eligible: 0,
      claimed: 0,
      skippedClaims: 0,
      succeeded: 0,
      failed: 0,
      exhausted: 0,
      observerFailures: 0,
    }

    const provisioningIntents = this.#store.listTerminalRuntimeProvisioningIntents(
      eligibleAt.toISOString(),
      this.#batchSize,
      this.maxAttempts,
    )
    report.provisioningEligible = provisioningIntents.length
    await this.#reconcileProvisioning(provisioningIntents, report)

    const candidates = this.#store.listCleanupEligible(
      this.#now().toISOString(),
      this.#batchSize,
      this.maxAttempts,
    )
    report.eligible = candidates.length

    for (const runtime of candidates) {
      const startedAt = this.#now()
      if (!this.#store.claimRuntimeCleanup(runtime.id, startedAt.toISOString())) {
        report.skippedClaims += 1
        continue
      }

      report.claimed += 1
      const attempt = runtime.cleanupAttempts + 1
      this.#emit(
        {
          type: "runtime.cleanup.started",
          runtimeId: runtime.id,
          runId: runtime.runId,
          ownerId: runtime.ownerId,
          provider: runtime.provider,
          attempt,
          at: startedAt.toISOString(),
        },
        report,
      )

      const requestId = `cleanup:${this.#createId()}`
      const attemptResult = await this.#destroy(runtime, requestId)
      const failure = attemptResult.failure

      const finishedAt = this.#now()
      const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime())
      if (failure === undefined) {
        this.#store.finishRuntimeCleanup({
          runtimeId: runtime.id,
          at: finishedAt.toISOString(),
          succeeded: true,
          audit: cleanupAudit({
            id: this.#createId(),
            requestId,
            traceId: attemptResult.traceId,
            runtime,
            attempt,
            outcome: "succeeded",
            at: finishedAt.toISOString(),
          }),
        })
        report.succeeded += 1
        this.#emit(
          {
            type: "runtime.cleanup.succeeded",
            runtimeId: runtime.id,
            runId: runtime.runId,
            ownerId: runtime.ownerId,
            provider: runtime.provider,
            attempt,
            durationMs,
            at: finishedAt.toISOString(),
          },
          report,
        )
        continue
      }

      const nextDelayMs = this.#backoffMs[attempt - 1]
      const nextAttemptAt =
        nextDelayMs === undefined
          ? undefined
          : new Date(finishedAt.getTime() + nextDelayMs).toISOString()
      const exhausted = nextAttemptAt === undefined
      const persistedError: StructuredError = {
        ...failure.error,
        retryable: !exhausted,
        details: {
          ...failure.error.details,
          providerRetryable: failure.providerRetryable,
        },
      }

      this.#store.finishRuntimeCleanup({
        runtimeId: runtime.id,
        at: finishedAt.toISOString(),
        succeeded: false,
        error: persistedError,
        ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
        audit: cleanupAudit({
          id: this.#createId(),
          requestId,
          traceId: attemptResult.traceId,
          runtime,
          attempt,
          outcome: "failed",
          at: finishedAt.toISOString(),
          errorCode: persistedError.code,
          exhausted,
          nextAttemptAt: nextAttemptAt ?? null,
        }),
      })
      report.failed += 1
      if (exhausted) report.exhausted += 1
      this.#emit(
        {
          type: "runtime.cleanup.failed",
          runtimeId: runtime.id,
          runId: runtime.runId,
          ownerId: runtime.ownerId,
          provider: runtime.provider,
          attempt,
          durationMs,
          errorCode: persistedError.code,
          exhausted,
          nextAttemptAt: nextAttemptAt ?? null,
          at: finishedAt.toISOString(),
        },
        report,
      )
    }

    return Object.freeze({ ...report })
  }

  async #reconcileProvisioning(
    intents: readonly RuntimeProvisioningIntent[],
    report: MutableReport,
  ): Promise<void> {
    for (const intent of intents) {
      const startedAt = this.#now()
      const claimed = this.#store.claimRuntimeProvisioning(
        intent.runtimeId,
        startedAt.toISOString(),
        "terminal",
      )
      if (claimed === null) continue

      this.#emit(
        {
          type: "runtime.provisioning.reconcile_started",
          runtimeId: claimed.runtimeId,
          runId: claimed.runId,
          ownerId: claimed.ownerId,
          provider: claimed.provider,
          attempt: claimed.attempts,
          at: startedAt.toISOString(),
        },
        report,
      )

      const requestId = `provisioning-reconcile:${this.#createId()}`
      try {
        const created = await this.#createForReconciliation(claimed, requestId)
        const finishedAt = this.#now()
        const runtime: RuntimeInstance = {
          id: claimed.runtimeId,
          ownerId: claimed.ownerId,
          runId: claimed.runId,
          provider: claimed.provider,
          handle: jsonObject(created.runtime),
          processHandle: null,
          cleanupStatus: "pending",
          cleanupAttempts: 0,
          cleanupLastError: null,
          cleanupNextAttemptAt: finishedAt.toISOString(),
          createdAt: finishedAt.toISOString(),
          updatedAt: finishedAt.toISOString(),
          destroyedAt: null,
        }
        this.#store.materializeRuntimeProvisioning(
          runtime,
          runtimeProvisioningAudit({
            id: this.#createId(),
            requestId,
            traceId: created.traceId,
            intent: claimed,
            outcome: "materialized",
            at: finishedAt.toISOString(),
          }),
        )
        report.provisioningMaterialized += 1
        this.#emit(
          {
            type: "runtime.provisioning.reconciled",
            runtimeId: claimed.runtimeId,
            runId: claimed.runId,
            ownerId: claimed.ownerId,
            provider: claimed.provider,
            attempt: claimed.attempts,
            durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
            at: finishedAt.toISOString(),
          },
          report,
        )
      } catch (error) {
        const finishedAt = this.#now()
        const normalized = normalizeError(error)
        const nextDelayMs = this.#backoffMs[claimed.attempts - 1]
        // A failed create response cannot prove that allocation did not occur.
        // Exact-id retries are therefore bounded by policy even when the
        // provider classifies the original request as non-retryable.
        const canRetry = nextDelayMs !== undefined
        const nextAttemptAt = canRetry
          ? new Date(finishedAt.getTime() + nextDelayMs).toISOString()
          : null
        const persistedError: StructuredError = {
          ...normalized.toStructuredError(),
          retryable: canRetry,
          details: {
            ...normalized.details,
            providerRetryable: normalized.retryable,
          },
        }
        this.#store.failRuntimeProvisioning({
          runtimeId: claimed.runtimeId,
          error: persistedError,
          at: finishedAt.toISOString(),
          nextAttemptAt,
          audit: runtimeProvisioningAudit({
            id: this.#createId(),
            requestId,
            traceId: null,
            intent: claimed,
            outcome: "failed",
            errorCode: persistedError.code,
            exhausted: !canRetry,
            nextAttemptAt,
            at: finishedAt.toISOString(),
          }),
        })
        report.provisioningFailed += 1
        if (!canRetry) report.provisioningExhausted += 1
        this.#emit(
          {
            type: "runtime.provisioning.reconcile_failed",
            runtimeId: claimed.runtimeId,
            runId: claimed.runId,
            ownerId: claimed.ownerId,
            provider: claimed.provider,
            attempt: claimed.attempts,
            durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
            errorCode: persistedError.code,
            exhausted: !canRetry,
            nextAttemptAt,
            at: finishedAt.toISOString(),
          },
          report,
        )
      }
    }
  }

  async #createForReconciliation(
    intent: RuntimeProvisioningIntent,
    requestId: string,
  ): Promise<{ readonly runtime: RuntimeHandle; readonly traceId: string | null }> {
    if (this.#telemetry === undefined) {
      return {
        runtime: await this.#providers.get(intent.provider).create({
          runtimeId: intent.runtimeId,
        }),
        traceId: null,
      }
    }

    return this.#telemetry.span(
      "meanwhile.runtime.provisioning.reconcile",
      {
        "runtime.id": intent.runtimeId,
        "run.id": intent.runId,
        "provider.name": intent.provider,
      },
      async (span) => {
        const provider = observeRuntimeProvider(
          this.#providers.get(intent.provider),
          span.child({
            requestId,
            ownerId: intent.ownerId,
            runId: intent.runId,
            runtimeId: intent.runtimeId,
          }),
          { runId: intent.runId, runtimeId: intent.runtimeId },
          () => this.#clock().getTime(),
        )
        const runtime = await provider.create({ runtimeId: intent.runtimeId })
        span.setOutcome("succeeded")
        return { runtime, traceId: span.traceId }
      },
    )
  }

  async #destroy(
    runtime: RuntimeInstance,
    requestId: string,
  ): Promise<{ readonly failure?: SafeCleanupFailure; readonly traceId: string | null }> {
    const execute = async (
      provider = this.#providers.get(runtime.provider),
    ): Promise<SafeCleanupFailure | undefined> => {
      try {
        await provider.destroy(runtimeHandleFromRecord(runtime))
        return undefined
      } catch (error) {
        return safeCleanupFailure(error, runtime.provider)
      }
    }
    if (this.#telemetry === undefined) {
      const failure = await execute()
      return failure === undefined ? { traceId: null } : { failure, traceId: null }
    }

    let traceId: string | null = null
    const failure = await this.#telemetry.span(
      "meanwhile.runtime.cleanup",
      {
        "runtime.id": runtime.id,
        "run.id": runtime.runId,
        "provider.name": runtime.provider,
      },
      async (span) => {
        traceId = span.traceId
        const scope = span.child({
          requestId,
          ownerId: runtime.ownerId,
          runId: runtime.runId,
          runtimeId: runtime.id,
        })
        const provider = observeRuntimeProvider(
          this.#providers.get(runtime.provider),
          scope,
          { runId: runtime.runId, runtimeId: runtime.id },
          () => this.#clock().getTime(),
        )
        const result = await execute(provider)
        if (result === undefined) span.setOutcome("succeeded")
        else span.setOutcome("failed", stableCleanupTelemetryCode(result.error.code))
        return result
      },
    )
    return failure === undefined ? { traceId } : { failure, traceId }
  }

  /**
   * Releases claims left by an interrupted control-plane process. It runs once
   * per reaper instance and is also public so startup composition can make the
   * reconciliation boundary explicit before scheduling periodic work.
   */
  reconcileInterrupted(): number {
    if (this.#reconciled) return 0
    const at = this.#now().toISOString()
    const recovered =
      this.#store.recoverInterruptedRuntimeCleanups(at) +
      this.#store.recoverInterruptedRuntimeProvisioning(at)
    this.#reconciled = true
    return recovered
  }

  #now(): Date {
    const value = this.#clock()
    if (!Number.isFinite(value.getTime()))
      throw new TypeError("Runtime reaper clock returned an invalid date")
    return new Date(value.getTime())
  }

  #emit(event: RuntimeReaperEvent, report: MutableReport): void {
    if (this.#observe === undefined) return
    try {
      this.#observe(event)
    } catch {
      // Telemetry must not change cleanup state. The returned report makes the
      // instrumentation failure visible to the process-level supervisor.
      report.observerFailures += 1
    }
  }
}

export class RuntimeReaperLoop implements ManagedComponent {
  readonly name = "runtime-reaper"
  #timer: ReturnType<typeof setTimeout> | null = null
  #inFlight: Promise<void> | null = null
  #running = false
  #lastFailure: string | null = null

  constructor(
    private readonly reaper: Pick<RuntimeReaper, "runOnce">,
    private readonly intervalMs = 2_000,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100) {
      throw new TypeError("Runtime reaper interval must be at least 100ms")
    }
  }

  async start(): Promise<void> {
    if (this.#running) return
    this.#running = true
    await this.#runTick()
    this.#scheduleNext()
  }

  async stop(): Promise<void> {
    this.#running = false
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    await this.#inFlight
  }

  health(): ComponentHealth {
    if (!this.#running) return { status: "unavailable", message: "Runtime reaper is stopped" }
    return this.#lastFailure === null
      ? { status: "healthy" }
      : { status: "degraded", message: this.#lastFailure }
  }

  async #tick(): Promise<void> {
    try {
      await this.reaper.runOnce()
      this.#lastFailure = null
    } catch (error) {
      this.#lastFailure = error instanceof Error ? error.name : "RUNTIME_REAPER_FAILED"
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

  #scheduleNext(): void {
    if (!this.#running || this.#timer !== null) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.#runTick().then(() => this.#scheduleNext())
    }, this.intervalMs)
  }
}

function runtimeHandleFromRecord(runtime: RuntimeInstance): RuntimeHandle {
  const { kind, version, provider, opaque } = runtime.handle
  if (
    kind !== "runtime" ||
    version !== RUNTIME_HANDLE_VERSION ||
    provider !== runtime.provider ||
    typeof opaque !== "string" ||
    opaque.length === 0
  ) {
    throw new RuntimeProviderError({
      provider: runtime.provider,
      operation: "destroy",
      code: "INVALID_RUNTIME_HANDLE",
      message: "Persisted runtime handle is invalid",
      retryable: false,
    })
  }

  return {
    kind: "runtime",
    version: RUNTIME_HANDLE_VERSION,
    provider: runtime.provider,
    opaque,
  }
}

function safeCleanupFailure(error: unknown, provider: string): SafeCleanupFailure {
  if (error instanceof RuntimeProviderError) {
    return {
      providerRetryable: error.retryable,
      error: {
        code: "PROVIDER_UNAVAILABLE",
        message: "The runtime provider could not destroy the runtime.",
        retryable: error.retryable,
        details: {
          provider,
          operation: "destroy",
          providerCode: error.code,
        },
      },
    }
  }

  return {
    providerRetryable: false,
    error: {
      code: "RUNTIME_CLEANUP_FAILED",
      message: "The runtime could not be destroyed.",
      retryable: false,
      details: { provider, operation: "destroy" },
    },
  }
}

function cleanupAudit(input: {
  readonly id: string
  readonly requestId: string
  readonly traceId: string | null
  readonly runtime: RuntimeInstance
  readonly attempt: number
  readonly outcome: "succeeded" | "failed"
  readonly at: string
  readonly errorCode?: string
  readonly exhausted?: boolean
  readonly nextAttemptAt?: string | null
}): AuditRecord {
  const metadata: JsonObject = {
    provider: input.runtime.provider,
    runId: input.runtime.runId,
    attempt: input.attempt,
    outcome: input.outcome,
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(input.exhausted === undefined ? {} : { exhausted: input.exhausted }),
    ...(input.nextAttemptAt === undefined ? {} : { nextAttemptAt: input.nextAttemptAt }),
  }
  return {
    id: input.id,
    ownerId: input.runtime.ownerId,
    actorApiKeyId: null,
    action: "runtime.destroy",
    resourceType: "runtime",
    resourceId: input.runtime.id,
    requestId: input.requestId,
    traceId: input.traceId,
    metadata,
    createdAt: input.at,
  }
}

function runtimeProvisioningAudit(input: {
  readonly id: string
  readonly requestId: string
  readonly traceId: string | null
  readonly intent: RuntimeProvisioningIntent
  readonly outcome: "materialized" | "failed"
  readonly at: string
  readonly errorCode?: string
  readonly exhausted?: boolean
  readonly nextAttemptAt?: string | null
}): AuditRecord {
  return {
    id: input.id,
    ownerId: input.intent.ownerId,
    actorApiKeyId: null,
    action: "runtime.create_reconcile",
    resourceType: "runtime",
    resourceId: input.intent.runtimeId,
    requestId: input.requestId,
    traceId: input.traceId,
    metadata: {
      provider: input.intent.provider,
      runId: input.intent.runId,
      attempt: input.intent.attempts,
      outcome: input.outcome,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(input.exhausted === undefined ? {} : { exhausted: input.exhausted }),
      ...(input.nextAttemptAt === undefined ? {} : { nextAttemptAt: input.nextAttemptAt }),
    },
    createdAt: input.at,
  }
}

function jsonObject(value: object): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

const stableCleanupTelemetryCode = (value: string): string =>
  /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : "RUNTIME_CLEANUP_FAILED"

function validateBatchSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new TypeError("Runtime reaper batchSize must be an integer from 1 to 100")
  }
  return value
}

function validateBackoff(value: readonly number[]): readonly number[] {
  if (value.length > MAX_BACKOFF_STEPS) {
    throw new TypeError(`Runtime reaper backoff supports at most ${MAX_BACKOFF_STEPS} delays`)
  }
  if (value.some((delay) => !Number.isSafeInteger(delay) || delay <= 0)) {
    throw new TypeError("Runtime reaper backoff delays must be positive safe integers")
  }
  return Object.freeze([...value])
}
