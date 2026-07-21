import {
  type ArtifactBlob,
  type ArtifactStore,
  asSha256Digest,
  decodeArtifactManifest,
  type Sha256Digest,
} from "../artifacts/artifact-store"
import type { ComponentHealth, ManagedComponent } from "../control-plane"
import {
  DeployAdapterError as DeployAdapterFailure,
  type DeploymentAdapterEvent,
  type DeploymentLogLevel,
  type ImmutableDeploymentSource,
} from "../deployments/deploy-adapter"
import type { DeployAdapterRegistry } from "../deployments/registry"
import type {
  AuditRecord,
  Deployment,
  DeploymentLogChunk,
  DeploymentStatus,
  JsonObject,
  JsonValue,
  RequestContext,
  Run,
} from "../domain"
import { AppError } from "../errors"
import { hashCanonical } from "../idempotency"
import type { Store } from "../persistence/store"
import {
  type ResolvedSecretMaterial,
  type SecretRedactor,
  SecretResolutionError,
  type SecretResolver,
} from "../secrets"
import type { StructuredLogger, Telemetry } from "../telemetry"
import { normalizeArtifactPath } from "./artifact-collector"

export type DeploymentSourceSelector =
  | { artifactPath: string; workspacePath?: never }
  | { artifactPath?: never; workspacePath: string }

export interface DeploymentSourceReference {
  artifactId: string
  manifestDigest: Sha256Digest
  logicalPath: string
}

export interface DeploymentSourceResolver {
  /** Authorizes owner/run/path and captures workspace bytes when required. */
  resolve(input: {
    ownerId: string
    runId: string
    selector: DeploymentSourceSelector
  }): Promise<DeploymentSourceReference>
  /** Reopens only the already-authorized immutable source recorded at creation. */
  open(input: {
    ownerId: string
    runId: string
    artifactId: string
  }): Promise<ImmutableDeploymentSource>
}

export interface DurableArtifactMetadata {
  id: string
  ownerId: string
  runId: string
  logicalPath: string
  digest: string
  byteSize: number
  storageKey: string
}

/** Structural subset implemented by the persistence Store. */
export interface DeploymentArtifactCatalog {
  findArtifactByPath(
    ownerId: string,
    runId: string,
    logicalPath: string,
  ): DurableArtifactMetadata | null
  getArtifact(ownerId: string, artifactId: string): DurableArtifactMetadata | null
}

/** Reconstructs a deployment source after restart from DB metadata + manifest. */
export class StoreDeploymentSourceResolver implements DeploymentSourceResolver {
  readonly #catalog: DeploymentArtifactCatalog
  readonly #artifacts: ArtifactStore

  constructor(catalog: DeploymentArtifactCatalog, artifacts: ArtifactStore) {
    this.#catalog = catalog
    this.#artifacts = artifacts
  }

  async resolve(input: {
    ownerId: string
    runId: string
    selector: DeploymentSourceSelector
  }): Promise<DeploymentSourceReference> {
    assertSourceSelector(input.selector)
    const selected =
      "artifactPath" in input.selector ? input.selector.artifactPath : input.selector.workspacePath
    let logicalPath: string
    try {
      logicalPath = normalizeArtifactPath(selected, true)
    } catch (error) {
      throw invalidInput("Deployment source path is invalid.", error)
    }
    const artifact = this.#catalog.findArtifactByPath(input.ownerId, input.runId, logicalPath)
    if (artifact === null) throw sourceUnavailable()
    return {
      artifactId: artifact.id,
      manifestDigest: parseDigest(artifact.digest),
      logicalPath: artifact.logicalPath,
    }
  }

  async open(input: {
    ownerId: string
    runId: string
    artifactId: string
  }): Promise<ImmutableDeploymentSource> {
    const artifact = this.#catalog.getArtifact(input.ownerId, input.artifactId)
    if (artifact === null || artifact.runId !== input.runId) {
      throw sourceUnavailable()
    }

    const digest = parseDigest(artifact.digest)
    let manifestBytes: Uint8Array
    try {
      manifestBytes = await this.#artifacts.read(input.ownerId, {
        storageKey: artifact.storageKey,
        digest,
        size: artifact.byteSize,
      })
    } catch (error) {
      throw sourceUnavailable(error)
    }
    let manifest: ReturnType<typeof decodeArtifactManifest>
    try {
      manifest = decodeArtifactManifest(manifestBytes)
    } catch (error) {
      throw sourceUnavailable(error)
    }
    if (manifest.runId !== input.runId || manifest.logicalPath !== artifact.logicalPath) {
      throw sourceUnavailable()
    }

    const entries: ImmutableDeploymentSource["entries"][number][] = []
    for (const entry of manifest.entries) {
      try {
        normalizeArtifactPath(entry.path)
        normalizeArtifactPath(entry.logicalPath, true)
      } catch (error) {
        throw new DeploymentExecutionError(
          "DEPLOYMENT_SOURCE_UNAVAILABLE",
          "Deployment artifact manifest contains an invalid path.",
          {},
          { cause: error },
        )
      }
      let blob: ArtifactBlob | null
      try {
        blob = await this.#artifacts.resolve(input.ownerId, {
          digest: entry.digest,
          size: entry.size,
        })
      } catch (error) {
        throw sourceUnavailable(error)
      }
      if (blob === null) throw sourceUnavailable()
      entries.push({
        path: entry.path,
        mediaType: entry.mediaType,
        blob,
      })
    }
    const byPath = new Map(entries.map((entry) => [entry.path, entry]))

    return {
      artifactId: artifact.id,
      manifestDigest: digest,
      logicalPath: artifact.logicalPath,
      entries,
      read: async (requested) => {
        const authorized = byPath.get(requested.path)
        if (
          authorized === undefined ||
          requested.mediaType !== authorized.mediaType ||
          requested.blob.storageKey !== authorized.blob.storageKey ||
          requested.blob.digest !== authorized.blob.digest ||
          requested.blob.size !== authorized.blob.size
        ) {
          throw sourceUnavailable()
        }
        try {
          return await this.#artifacts.read(input.ownerId, authorized.blob)
        } catch (error) {
          throw sourceUnavailable(error)
        }
      },
    }
  }
}

export interface DeploymentFailure {
  code: string
  message: string
  retryable: boolean
  details: Readonly<Record<string, string | number | boolean>>
}

export type DeploymentRecord = Deployment

export interface DeploymentLogRecord {
  deploymentId: string
  sequence: number
  level: DeploymentLogLevel
  event: string
  message: string
  fields: Readonly<Record<string, SafeJsonValue>>
  createdAt: string
}

export interface DeploymentLogPage {
  items: readonly DeploymentLogRecord[]
  nextCursor: number | null
}

export type DeploymentAuditRecord = AuditRecord & {
  action: "deployment.create" | "deployment.start" | "deployment.succeed" | "deployment.fail"
}

export interface DeploymentRepository {
  findIdempotent(input: {
    ownerId: string
    principalId?: string
    idempotencyKey: string
    requestHash: string
  }): Promise<DeploymentRecord | null>
  createWithAudit(input: {
    deployment: DeploymentRecord
    audit: DeploymentAuditRecord
    idempotencyKey: string
    requestHash: string
    principalId?: string
  }): Promise<CreateDeploymentResult>
  getForOwner(ownerId: string, deploymentId: string): Promise<DeploymentRecord | null>
  getForPrincipal?(
    ownerId: string,
    principalId: string,
    deploymentId: string,
  ): Promise<DeploymentRecord | null>
  getForExecution(deploymentId: string): Promise<DeploymentRecord | null>
  listForOwner(input: {
    ownerId: string
    limit: number
    before?: string
  }): Promise<{ readonly items: readonly DeploymentRecord[]; readonly nextCursor: string | null }>
  listForPrincipal?(input: {
    ownerId: string
    principalId: string
    limit: number
    before?: string
  }): Promise<{ readonly items: readonly DeploymentRecord[]; readonly nextCursor: string | null }>
  transitionWithAudit(input: {
    deploymentId: string
    fromStatus: DeploymentStatus
    toStatus: DeploymentStatus
    at: string
    url?: string | null
    error?: DeploymentFailure | null
    audit: DeploymentAuditRecord
  }): Promise<DeploymentRecord | null>
  appendLog(input: Omit<DeploymentLogRecord, "sequence">): Promise<DeploymentLogRecord>
  listLogsForOwner(input: {
    ownerId: string
    deploymentId: string
    after: number
    limit: number
  }): Promise<DeploymentLogPage | null>
  listLogsForPrincipal?(input: {
    ownerId: string
    principalId: string
    deploymentId: string
    after: number
    limit: number
  }): Promise<DeploymentLogPage | null>
}

/** Owner-scoped authorization boundary checked before target or source resolution. */
export interface DeploymentRunCatalog {
  getRun(
    ownerId: string,
    runId: string,
  ): Pick<Run, "id" | "ownerId"> | null | Promise<Pick<Run, "id" | "ownerId"> | null>
  getRunForPrincipal?(
    ownerId: string,
    principalId: string,
    runId: string,
  ):
    | Pick<Run, "id" | "ownerId" | "delegatedBy">
    | null
    | Promise<Pick<Run, "id" | "ownerId" | "delegatedBy"> | null>
}

/** The production deployment persistence adapter; all SQL remains inside Store. */
export class StoreDeploymentRepository implements DeploymentRepository {
  readonly #store: Store

  constructor(store: Store) {
    this.#store = store
  }

  async findIdempotent(input: {
    ownerId: string
    principalId?: string
    idempotencyKey: string
    requestHash: string
  }): Promise<DeploymentRecord | null> {
    return this.#store.getIdempotentDeployment(
      input.ownerId,
      input.principalId ?? this.#deploymentPrincipal(input.ownerId, input.idempotencyKey),
      input.idempotencyKey,
      input.requestHash,
    )
  }

  async createWithAudit(input: {
    deployment: DeploymentRecord
    audit: DeploymentAuditRecord
    idempotencyKey: string
    requestHash: string
    principalId?: string
  }): Promise<CreateDeploymentResult> {
    return this.#store.createDeployment(input.deployment, input.audit, {
      ...(input.principalId === undefined ? {} : { principalId: input.principalId }),
      key: input.idempotencyKey,
      requestHash: input.requestHash,
    })
  }

  async getForOwner(ownerId: string, deploymentId: string): Promise<DeploymentRecord | null> {
    return this.#store.getDeployment(ownerId, deploymentId)
  }

  async getForPrincipal(ownerId: string, principalId: string, deploymentId: string) {
    return this.#store.getDeploymentForPrincipal(ownerId, principalId, deploymentId)
  }

  async getForExecution(deploymentId: string): Promise<DeploymentRecord | null> {
    return this.#store.getDeploymentInternal(deploymentId)
  }

  async listForOwner(input: {
    ownerId: string
    limit: number
    before?: string
  }): Promise<{ readonly items: readonly DeploymentRecord[]; readonly nextCursor: string | null }> {
    return this.#store.listDeployments(input.ownerId, {
      limit: input.limit,
      ...(input.before === undefined ? {} : { before: input.before }),
    })
  }

  async listForPrincipal(input: {
    ownerId: string
    principalId: string
    limit: number
    before?: string
  }) {
    return this.#store.listDeploymentsForPrincipal(input.ownerId, input.principalId, {
      limit: input.limit,
      ...(input.before === undefined ? {} : { before: input.before }),
    })
  }

  async transitionWithAudit(input: {
    deploymentId: string
    fromStatus: DeploymentStatus
    toStatus: DeploymentStatus
    at: string
    url?: string | null
    error?: DeploymentFailure | null
    audit: DeploymentAuditRecord
  }): Promise<DeploymentRecord | null> {
    return this.#store.transitionDeployment({
      deploymentId: input.deploymentId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      at: input.at,
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.error === undefined ? {} : { error: input.error }),
      audit: input.audit,
    })
  }

  async appendLog(input: Omit<DeploymentLogRecord, "sequence">): Promise<DeploymentLogRecord> {
    const deployment = this.#store.getDeploymentInternal(input.deploymentId)
    if (deployment === null) throw notFound()
    const encoded: EncodedDeploymentLog = {
      version: 1,
      level: input.level,
      event: input.event,
      message: input.message,
      fields: input.fields,
    }
    const stored = this.#store.appendDeploymentLogNext({
      ownerId: deployment.ownerId,
      deploymentId: input.deploymentId,
      stream: input.level === "error" ? "stderr" : "system",
      data: JSON.stringify(encoded),
      createdAt: input.createdAt,
    })
    return decodeStoredDeploymentLog(stored)
  }

  async listLogsForOwner(input: {
    ownerId: string
    deploymentId: string
    after: number
    limit: number
  }): Promise<DeploymentLogPage | null> {
    if (this.#store.getDeployment(input.ownerId, input.deploymentId) === null) {
      return null
    }
    const items = this.#store
      .listDeploymentLogs(input.ownerId, input.deploymentId, input.after, input.limit)
      .map(decodeStoredDeploymentLog)
    return {
      items,
      nextCursor: items.length === input.limit ? (items.at(-1)?.sequence ?? null) : null,
    }
  }

  async listLogsForPrincipal(input: {
    ownerId: string
    principalId: string
    deploymentId: string
    after: number
    limit: number
  }): Promise<DeploymentLogPage | null> {
    if (
      this.#store.getDeploymentForPrincipal(
        input.ownerId,
        input.principalId,
        input.deploymentId,
      ) === null
    ) {
      return null
    }
    const items = this.#store
      .listDeploymentLogs(input.ownerId, input.deploymentId, input.after, input.limit)
      .map(decodeStoredDeploymentLog)
    return {
      items,
      nextCursor: items.length === input.limit ? (items.at(-1)?.sequence ?? null) : null,
    }
  }

  #deploymentPrincipal(ownerId: string, _key: string): string {
    const principals = this.#store
      .listPrincipals(ownerId)
      .filter((principal) => principal.disabledAt === null)
    if (principals.length !== 1) {
      throw new AppError({
        code: "PRINCIPAL_REQUIRED",
        message: "Deployment Principal is required",
      })
    }
    return (principals[0] as (typeof principals)[number]).id
  }
}

interface EncodedDeploymentLog {
  version: 1
  level: DeploymentLogLevel
  event: string
  message: string
  fields: Readonly<Record<string, SafeJsonValue>>
}

export interface DeploymentMutationContext {
  requestId: string
  traceId?: string
  actorApiKeyId?: string
}

interface DeploymentExecutionOptions {
  /** Used only by graceful control-plane shutdown; leaves work recoverable. */
  preserveRunningOnAbort?: boolean
}

export interface CreateDeploymentInput extends DeploymentMutationContext {
  ownerId: string
  principalId?: string
  idempotencyKey: string
  runId: string
  source: DeploymentSourceSelector
  targetName: string
  targetConfig?: Readonly<Record<string, unknown>>
  secretRefs?: Readonly<Record<string, string>>
}

export interface CreateDeploymentResult {
  readonly deployment: DeploymentRecord
  readonly replayed: boolean
}

export interface DeploymentExecutorOptions {
  repository: DeploymentRepository
  runs: DeploymentRunCatalog
  sourceResolver: DeploymentSourceResolver
  secretResolver: SecretResolver
  adapters: DeployAdapterRegistry
  now?: () => Date
  id?: () => string
}

export type SafeJsonValue = JsonValue

export type DeploymentExecutionErrorCode =
  | "DEPLOYMENT_NOT_FOUND"
  | "DEPLOYMENT_SOURCE_UNAVAILABLE"
  | "DEPLOYMENT_STATE_CONFLICT"
  | "DEPLOYMENT_INPUT_INVALID"
  | "DEPLOYMENT_RESULT_INVALID"

export class DeploymentExecutionError extends Error {
  override readonly name = "DeploymentExecutionError"

  constructor(
    readonly code: DeploymentExecutionErrorCode,
    message: string,
    readonly safeDetails: Readonly<Record<string, string | number | boolean>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export class DeploymentExecutor {
  readonly #repository: DeploymentRepository
  readonly #runs: DeploymentRunCatalog
  readonly #sourceResolver: DeploymentSourceResolver
  readonly #secretResolver: SecretResolver
  readonly #adapters: DeployAdapterRegistry
  readonly #now: () => Date
  readonly #id: () => string

  constructor(options: DeploymentExecutorOptions) {
    this.#repository = options.repository
    this.#runs = options.runs
    this.#sourceResolver = options.sourceResolver
    this.#secretResolver = options.secretResolver
    this.#adapters = options.adapters
    this.#now = options.now ?? (() => new Date())
    this.#id = options.id ?? (() => crypto.randomUUID())
  }

  async create(input: CreateDeploymentInput): Promise<CreateDeploymentResult> {
    assertIdempotencyKey(input.idempotencyKey)
    const sourceSelector = canonicalSourceSelector(input.source)
    const requestedTargetConfig = input.targetConfig ?? {}
    assertJsonObject(requestedTargetConfig)
    const targetConfigInput = structuredClone(requestedTargetConfig) as JsonObject
    const secretRefs = { ...(input.secretRefs ?? {}) }
    assertSecretReferences(secretRefs)
    const requestHash = hashCanonical({
      version: 1,
      runId: input.runId,
      source: sourceSelector,
      target: input.targetName,
      targetConfig: targetConfigInput,
      secretRefs,
    })
    const existing = await this.#repository.findIdempotent({
      ownerId: input.ownerId,
      ...(input.principalId === undefined ? {} : { principalId: input.principalId }),
      idempotencyKey: input.idempotencyKey,
      requestHash,
    })
    if (existing !== null) return { deployment: existing, replayed: true }

    if (input.principalId === undefined) {
      if ((await this.#runs.getRun(input.ownerId, input.runId)) === null) throw notFound()
    } else {
      const run = await this.#runs.getRunForPrincipal?.(
        input.ownerId,
        input.principalId,
        input.runId,
      )
      if (run == null || run.delegatedBy.id !== input.principalId) throw notFound()
    }
    const adapter = this.#adapters.get(input.targetName)
    let targetConfig: Readonly<Record<string, unknown>>
    try {
      targetConfig = adapter.validate(targetConfigInput)
    } catch (error) {
      if (error instanceof DeployAdapterFailure) {
        throw new DeploymentExecutionError(
          "DEPLOYMENT_INPUT_INVALID",
          error.message,
          error.safeDetails,
          { cause: error },
        )
      }
      throw error
    }
    assertJsonObject(targetConfig)
    assertAdapterSecretTargets(adapter.secretEnvNames, secretRefs)
    try {
      this.#secretResolver.validate(secretRefs, {
        ownerId: input.ownerId,
        purpose: "deployment",
      })
    } catch (error) {
      if (error instanceof SecretResolutionError) throw invalidInput(error.message, error)
      throw error
    }
    const source = await this.#sourceResolver.resolve({
      ownerId: input.ownerId,
      runId: input.runId,
      selector: sourceSelector,
    })
    const timestamp = this.#now().toISOString()
    const id = this.#id()
    const deployment: DeploymentRecord = {
      id,
      ownerId: input.ownerId,
      runId: input.runId,
      artifactId: source.artifactId,
      target: input.targetName,
      targetConfig: structuredClone(targetConfig) as JsonObject,
      secretRefs,
      status: "queued",
      url: null,
      error: null,
      createdAt: timestamp,
      startedAt: null,
      finishedAt: null,
      updatedAt: timestamp,
    }
    return this.#repository.createWithAudit({
      deployment,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      ...(input.principalId === undefined ? {} : { principalId: input.principalId }),
      audit: auditRecord("deployment.create", deployment, input, timestamp, {
        runId: input.runId,
        target: input.targetName,
      }),
    })
  }

  async get(scope: string | RequestContext, deploymentId: string): Promise<DeploymentRecord> {
    const deployment =
      typeof scope === "string"
        ? await this.#repository.getForOwner(scope, deploymentId)
        : await this.#repository.getForPrincipal?.(scope.ownerId, scope.principalId, deploymentId)
    if (deployment == null) throw notFound()
    return deployment
  }

  async list(
    scope: string | RequestContext,
    options: { limit: number; before?: string },
  ): Promise<{ readonly items: readonly DeploymentRecord[]; readonly nextCursor: string | null }> {
    const input = {
      ownerId: typeof scope === "string" ? scope : scope.ownerId,
      limit: options.limit,
      ...(options.before === undefined ? {} : { before: options.before }),
    }
    return typeof scope === "string"
      ? this.#repository.listForOwner(input)
      : (this.#repository.listForPrincipal?.({ ...input, principalId: scope.principalId }) ??
          Promise.reject(notFound()))
  }

  async logs(input: {
    ownerId: string
    principalId?: string
    deploymentId: string
    after?: number
    limit?: number
  }): Promise<DeploymentLogPage> {
    const after = input.after ?? 0
    const limit = input.limit ?? 100
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1_000
    ) {
      throw new DeploymentExecutionError(
        "DEPLOYMENT_INPUT_INVALID",
        "Deployment log cursor or limit is invalid.",
      )
    }
    const page =
      input.principalId === undefined
        ? await this.#repository.listLogsForOwner({
            ownerId: input.ownerId,
            deploymentId: input.deploymentId,
            after,
            limit,
          })
        : await this.#repository.listLogsForPrincipal?.({
            ownerId: input.ownerId,
            principalId: input.principalId,
            deploymentId: input.deploymentId,
            after,
            limit,
          })
    if (page == null) throw notFound()
    return page
  }

  /** Claims and executes one queued deployment. Safe under concurrent workers. */
  async execute(
    deploymentId: string,
    context: DeploymentMutationContext,
    signal: AbortSignal = new AbortController().signal,
    options: DeploymentExecutionOptions = {},
  ): Promise<DeploymentRecord> {
    const queued = await this.#repository.getForExecution(deploymentId)
    if (queued === null) throw notFound()
    if (queued.status === "succeeded" || queued.status === "failed") return queued
    if (queued.status === "running") return queued

    const startedAt = this.#now().toISOString()
    const running = await this.#repository.transitionWithAudit({
      deploymentId,
      fromStatus: "queued",
      toStatus: "running",
      at: startedAt,
      audit: auditRecord("deployment.start", queued, context, startedAt, { target: queued.target }),
    })
    if (running === null) {
      const winner = await this.#repository.getForExecution(deploymentId)
      if (winner !== null) return winner
      throw notFound()
    }

    return this.#executeRunning(running, context, signal, options)
  }

  /**
   * Replays a previously claimed deployment after exclusive control-plane
   * restart. Adapters must be idempotent for the stable deployment ID.
   */
  async reconcile(
    deploymentId: string,
    context: DeploymentMutationContext,
    signal: AbortSignal = new AbortController().signal,
    options: DeploymentExecutionOptions = {},
  ): Promise<DeploymentRecord> {
    const deployment = await this.#repository.getForExecution(deploymentId)
    if (deployment === null) throw notFound()
    if (deployment.status === "queued") {
      return this.execute(deploymentId, context, signal, options)
    }
    if (deployment.status === "succeeded" || deployment.status === "failed") {
      return deployment
    }
    return this.#executeRunning(deployment, context, signal, options)
  }

  async #executeRunning(
    running: DeploymentRecord,
    context: DeploymentMutationContext,
    signal: AbortSignal,
    options: DeploymentExecutionOptions,
  ): Promise<DeploymentRecord> {
    const deploymentId = running.id
    let resolvedSecrets: ResolvedSecretMaterial | null = null
    let guard = new DeploymentOutputGuard()
    const activeEmissions = new Set<Promise<void>>()
    let evidenceWriteFailed = false
    let targetSucceeded = false
    try {
      assertExecutionContinues(signal, options)
      const adapter = this.#adapters.get(running.target)
      assertAdapterSecretTargets(adapter.secretEnvNames, running.secretRefs)
      this.#secretResolver.validate(running.secretRefs, {
        ownerId: running.ownerId,
        purpose: "deployment",
      })
      resolvedSecrets = await this.#secretResolver.resolve(running.secretRefs, {
        ownerId: running.ownerId,
        purpose: "deployment",
        resourceType: "deployment",
        resourceId: running.id,
      })
      assertExecutionContinues(signal, options)
      guard = new DeploymentOutputGuard(resolvedSecrets.redactor)
      const source = await this.#sourceResolver.open({
        ownerId: running.ownerId,
        runId: running.runId,
        artifactId: running.artifactId,
      })
      assertExecutionContinues(signal, options)
      assertResolvedSource(running.artifactId, source)
      const deployment = adapter.deploy(
        {
          deploymentId: running.id,
          source,
          target: { name: running.target, config: running.targetConfig },
          secrets: resolvedSecrets.environment,
        },
        {
          signal,
          emit: async (event) => {
            assertExecutionContinues(signal, options)
            const emission = this.#appendAdapterLog(running, guard, event).catch((error) => {
              evidenceWriteFailed = true
              throw error
            })
            activeEmissions.add(emission)
            try {
              await emission
            } finally {
              activeEmissions.delete(emission)
            }
            assertExecutionContinues(signal, options)
          },
        },
      )
      const result = await interruptForShutdown(deployment, signal, options)
      assertExecutionContinues(signal, options)

      const url = validateDeployResult(result, guard)
      targetSucceeded = true

      const finishedAt = this.#now().toISOString()
      const succeeded = await this.#repository.transitionWithAudit({
        deploymentId,
        fromStatus: "running",
        toStatus: "succeeded",
        at: finishedAt,
        url,
        error: null,
        audit: auditRecord("deployment.succeed", running, context, finishedAt, {
          target: running.target,
        }),
      })
      if (succeeded === null) {
        const winner = await this.#repository.getForExecution(deploymentId)
        if (winner !== null && (winner.status === "succeeded" || winner.status === "failed")) {
          return winner
        }
        throw stateConflict()
      }
      return succeeded
    } catch (error) {
      if (signal.aborted && options.preserveRunningOnAbort === true) {
        await Promise.allSettled(activeEmissions)
        throw new DeploymentExecutionInterruptedError()
      }
      if (evidenceWriteFailed || targetSucceeded) {
        await Promise.allSettled(activeEmissions)
        throw new DeploymentExecutionInterruptedError(
          "Deployment target state requires idempotent reconciliation.",
        )
      }
      const failure = guard.failure(error)
      await this.#repository.appendLog({
        deploymentId: running.id,
        level: "error",
        event: "deployment.failed",
        message: failure.message,
        fields: guard.fields({
          code: failure.code,
          retryable: failure.retryable,
        }),
        createdAt: this.#now().toISOString(),
      })
      const finishedAt = this.#now().toISOString()
      const failed = await this.#repository.transitionWithAudit({
        deploymentId,
        fromStatus: "running",
        toStatus: "failed",
        at: finishedAt,
        error: failure,
        audit: auditRecord("deployment.fail", running, context, finishedAt, {
          code: failure.code,
          retryable: failure.retryable,
        }),
      })
      if (failed === null) {
        const winner = await this.#repository.getForExecution(deploymentId)
        if (winner !== null) return winner
        throw notFound()
      }
      return failed
    } finally {
      await resolvedSecrets?.release()
    }
  }

  async #appendAdapterLog(
    deployment: DeploymentRecord,
    guard: DeploymentOutputGuard,
    event: DeploymentAdapterEvent,
  ): Promise<void> {
    await this.#repository.appendLog({
      deploymentId: deployment.id,
      level: event.level,
      event: normalizeEventName(guard.redact(event.event)),
      message: guard.redact(event.message),
      fields: guard.fields(event.fields ?? {}),
      createdAt: this.#now().toISOString(),
    })
  }
}

class DeploymentExecutionInterruptedError extends Error {
  override readonly name = "DeploymentExecutionInterruptedError"
  readonly code = "DEPLOYMENT_RECONCILIATION_REQUIRED"

  constructor(message = "Deployment execution was interrupted for control-plane shutdown.") {
    super(message)
  }
}

function assertExecutionContinues(signal: AbortSignal, options: DeploymentExecutionOptions): void {
  if (signal.aborted && options.preserveRunningOnAbort === true) {
    throw new DeploymentExecutionInterruptedError()
  }
}

function interruptForShutdown<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  options: DeploymentExecutionOptions,
): Promise<T> {
  if (options.preserveRunningOnAbort !== true) return operation

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      complete()
    }
    const onAbort = (): void => {
      finish(() => reject(new DeploymentExecutionInterruptedError()))
    }

    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    )
  })
}

export interface DeploymentDispatcherOptions {
  readonly store: Pick<Store, "listQueuedDeployments" | "listRunningDeployments">
  readonly executor: Pick<DeploymentExecutor, "execute" | "reconcile">
  readonly logger: StructuredLogger
  readonly telemetry?: Telemetry
  readonly concurrency?: number
  readonly pollMs?: number
  readonly shutdownGraceMs?: number
}

/** Small durable queue dispatcher; SQLite deployment rows are the queue. */
export class DeploymentDispatcher implements ManagedComponent {
  readonly name = "deployment-dispatcher"
  readonly #pending = new Set<string>()
  readonly #recovering = new Set<string>()
  readonly #attemptedRecoveries = new Set<string>()
  readonly #active = new Map<string, Promise<void>>()
  readonly #controllers = new Map<string, AbortController>()
  readonly #concurrency: number
  readonly #pollMs: number
  readonly #shutdownGraceMs: number
  #interval: ReturnType<typeof setInterval> | null = null
  #running = false
  #lastFailure: string | null = null

  constructor(private readonly options: DeploymentDispatcherOptions) {
    this.#concurrency = options.concurrency ?? 2
    this.#pollMs = options.pollMs ?? 500
    this.#shutdownGraceMs = options.shutdownGraceMs ?? 10_000
    if (
      !Number.isSafeInteger(this.#concurrency) ||
      this.#concurrency < 1 ||
      !Number.isSafeInteger(this.#pollMs) ||
      this.#pollMs < 10 ||
      !Number.isSafeInteger(this.#shutdownGraceMs) ||
      this.#shutdownGraceMs < 1
    ) {
      throw new TypeError("Deployment dispatcher timing and concurrency must be positive integers")
    }
  }

  async start(): Promise<void> {
    if (this.#running) return
    this.#running = true
    this.#scanRecovering()
    this.#scan()
    this.#interval = setInterval(() => this.#scan(), this.#pollMs)
  }

  async stop(): Promise<void> {
    this.#running = false
    if (this.#interval !== null) clearInterval(this.#interval)
    this.#interval = null
    this.#pending.clear()
    this.#recovering.clear()
    this.#attemptedRecoveries.clear()
    for (const controller of this.#controllers.values()) controller.abort()
    const active = Promise.allSettled([...this.#active.values()])
    const settled = await settlesWithin(active, this.#shutdownGraceMs)
    if (!settled) {
      this.#lastFailure = "DEPLOYMENT_SHUTDOWN_TIMEOUT"
      this.options.logger.warn(
        "deployment.shutdown_timeout",
        "Deployment shutdown grace period elapsed; running records remain recoverable",
        { activeCount: this.#active.size },
      )
    }
    // Adapters are detached at the abort boundary, so this waits only for
    // already-started persistence work. The Store may be closed after return.
    await active
  }

  health(): ComponentHealth {
    if (!this.#running)
      return { status: "unavailable", message: "Deployment dispatcher is stopped" }
    return this.#lastFailure === null
      ? { status: "healthy" }
      : { status: "degraded", message: this.#lastFailure }
  }

  enqueue(deploymentId: string): void {
    this.#pending.add(deploymentId)
    this.#pump()
  }

  /** Waits for currently discoverable work; useful for graceful drains and tests. */
  async drain(): Promise<void> {
    while (this.#pending.size > 0 || this.#active.size > 0) {
      this.#pump()
      if (this.#active.size === 0) return
      await Promise.allSettled(this.#active.values())
    }
  }

  #scan(): void {
    if (!this.#running) return
    try {
      for (const deployment of this.options.store.listQueuedDeployments(this.#concurrency * 2)) {
        this.#pending.add(deployment.id)
      }
      if (this.#lastFailure === "DEPLOYMENT_QUEUE_SCAN_FAILED") this.#lastFailure = null
    } catch {
      this.#lastFailure = "DEPLOYMENT_QUEUE_SCAN_FAILED"
      this.options.logger.error(
        "deployment.queue_scan_failed",
        "Queued deployments could not be scanned",
      )
      return
    }
    this.#pump()
  }

  #scanRecovering(): void {
    if (!this.#running) return
    try {
      for (const deployment of this.options.store.listRunningDeployments(100)) {
        if (
          this.#active.has(deployment.id) ||
          this.#pending.has(deployment.id) ||
          this.#attemptedRecoveries.has(deployment.id)
        )
          continue
        this.#pending.add(deployment.id)
        this.#recovering.add(deployment.id)
      }
      if (this.#lastFailure === "DEPLOYMENT_RECOVERY_SCAN_FAILED") this.#lastFailure = null
    } catch {
      this.#lastFailure = "DEPLOYMENT_RECOVERY_SCAN_FAILED"
      this.options.logger.error(
        "deployment.recovery_scan_failed",
        "Running deployments could not be scanned for recovery",
      )
    }
  }

  #pump(): void {
    if (!this.#running) return
    while (this.#active.size < this.#concurrency) {
      const deploymentId = this.#pending.values().next().value as string | undefined
      if (deploymentId === undefined) break
      this.#pending.delete(deploymentId)
      if (this.#active.has(deploymentId)) continue
      const recovering = this.#recovering.delete(deploymentId)
      if (recovering) this.#attemptedRecoveries.add(deploymentId)
      const controller = new AbortController()
      this.#controllers.set(deploymentId, controller)
      const operation = recovering ? this.options.executor.reconcile : this.options.executor.execute
      const started = performance.now()
      const execute = () =>
        operation.call(
          this.options.executor,
          deploymentId,
          { requestId: `system:${crypto.randomUUID()}` },
          controller.signal,
          { preserveRunningOnAbort: true },
        )
      const execution =
        this.options.telemetry === undefined
          ? execute()
          : this.options.telemetry.span(
              "meanwhile.deployment.execute",
              { "deployment.id": deploymentId },
              async (span) => {
                const deployment = await execute()
                span.setAttributes({
                  "deployment.status": deployment.status,
                  "deploy.target": deployment.target,
                })
                if (deployment.status === "failed") {
                  span.setOutcome(
                    "failed",
                    stableDeploymentTelemetryCode(
                      deployment.error?.code ?? "DEPLOYMENT_EXECUTION_FAILED",
                    ),
                  )
                } else if (deployment.status === "succeeded") span.setOutcome("succeeded")
                else span.setOutcome("interrupted")
                return deployment
              },
            )
      const task = execution
        .then((deployment) => {
          this.#lastFailure = null
          this.options.telemetry?.metrics.increment("meanwhile.deployment.outcomes", 1, {
            "deploy.target": deployment.target,
            outcome: deployment.status,
          })
          this.options.telemetry?.metrics.record(
            "meanwhile.deployment.duration",
            Math.max(0, performance.now() - started),
            { "deploy.target": deployment.target, outcome: deployment.status },
          )
        })
        .catch((error: unknown) => {
          if (error instanceof DeploymentExecutionInterruptedError) {
            this.options.logger.info(
              "deployment.interrupted",
              "Deployment remains running for restart reconciliation",
              { deploymentId },
            )
            return
          }
          this.#lastFailure =
            error instanceof DeploymentExecutionError ? error.code : "DEPLOYMENT_EXECUTION_FAILED"
          this.options.logger.error("deployment.execution_failed", "Deployment execution failed", {
            deploymentId,
            code: this.#lastFailure,
          })
        })
        .finally(() => {
          this.#controllers.delete(deploymentId)
          this.#active.delete(deploymentId)
          this.#scanRecovering()
          this.#pump()
        })
      this.#active.set(deploymentId, task)
    }
  }
}

const stableDeploymentTelemetryCode = (value: string): string =>
  /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : "DEPLOYMENT_EXECUTION_FAILED"

class DeploymentOutputGuard {
  readonly #redactor: SecretRedactor | null

  constructor(redactor: SecretRedactor | null = null) {
    this.#redactor = redactor
  }

  redact(value: string): string {
    return truncate(this.#redactor?.redactString(value) ?? value, 16_384)
  }

  containsSecret(value: unknown): boolean {
    return this.#redactor?.contains(value) ?? false
  }

  fields(value: unknown): Readonly<Record<string, SafeJsonValue>> {
    const sanitized = this.#value(value, 0)
    return isSafeRecord(sanitized) ? sanitized : { value: sanitized }
  }

  failure(error: unknown): DeploymentFailure {
    if (error instanceof DeployAdapterFailure) {
      return {
        code: error.code,
        message: this.redact(error.message),
        retryable: error.retryable,
        details: this.#flatDetails(error.safeDetails),
      }
    }
    if (error instanceof DeploymentExecutionError) {
      return {
        code: error.code,
        message: this.redact(error.message),
        retryable: false,
        details: this.#flatDetails(error.safeDetails),
      }
    }
    return {
      code: "DEPLOYMENT_FAILED",
      message: "Deployment failed unexpectedly.",
      retryable: false,
      details: {},
    }
  }

  #flatDetails(
    value: Readonly<Record<string, string | number | boolean>>,
  ): Readonly<Record<string, string | number | boolean>> {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, item]) => [
          this.redact(key),
          typeof item === "string" ? this.redact(item) : item,
        ]),
    )
  }

  #value(value: unknown, depth: number): SafeJsonValue {
    if (depth > 6) return "[truncated]"
    if (value === null || typeof value === "boolean") return value
    if (typeof value === "string") return this.redact(value)
    if (typeof value === "number") return Number.isFinite(value) ? value : "[non-finite]"
    if (Array.isArray(value)) {
      return value.slice(0, 100).map((item) => this.#value(item, depth + 1))
    }
    if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>).slice(0, 100)
      return Object.fromEntries(
        entries.map(([key, item]) => [this.redact(key), this.#value(item, depth + 1)]),
      )
    }
    return `[${typeof value}]`
  }
}

const MAX_DEPLOYMENT_URL_LENGTH = 2_048
const encodedUrlControlCharacterPattern = /%(?:0[0-9a-f]|1[0-9a-f]|7f|8[0-9a-f]|9[0-9a-f])/iu

function validateDeployResult(result: unknown, guard: DeploymentOutputGuard): string {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw invalidDeployResult()
  }
  const record = result as { url?: unknown; previewUrl?: unknown }
  const url = canonicalDeploymentUrl(record.url, guard)
  const previewUrl = record.previewUrl
  if (previewUrl === undefined) return url
  return canonicalDeploymentUrl(previewUrl, guard)
}

function canonicalDeploymentUrl(value: unknown, guard: DeploymentOutputGuard): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_DEPLOYMENT_URL_LENGTH ||
    containsUrlControlCharacter(value) ||
    encodedUrlControlCharacterPattern.test(value) ||
    guard.containsSecret(value)
  ) {
    throw invalidDeployResult()
  }

  // URL accepts and silently discards some malformed input. Reject userinfo
  // and controls before parsing so the stored value cannot conceal either.
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu.exec(value)?.[1]
  if (authority?.includes("@") === true) throw invalidDeployResult()

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch (error) {
    throw invalidDeployResult(error)
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw invalidDeployResult()
  }

  const canonical = parsed.href
  if (
    canonical.length > MAX_DEPLOYMENT_URL_LENGTH ||
    containsUrlControlCharacter(canonical) ||
    encodedUrlControlCharacterPattern.test(canonical) ||
    guard.containsSecret(canonical)
  ) {
    throw invalidDeployResult()
  }
  return canonical
}

function containsUrlControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 31 || (code >= 127 && code <= 159)) return true
  }
  return false
}

function auditRecord(
  action: DeploymentAuditRecord["action"],
  deployment: Pick<DeploymentRecord, "id" | "ownerId">,
  context: DeploymentMutationContext,
  timestamp: string,
  metadata: Readonly<Record<string, SafeJsonValue>>,
): DeploymentAuditRecord {
  return {
    id: crypto.randomUUID(),
    action,
    ownerId: deployment.ownerId,
    actorApiKeyId: context.actorApiKeyId ?? null,
    resourceType: "deployment",
    resourceId: deployment.id,
    requestId: context.requestId,
    traceId: context.traceId ?? null,
    createdAt: timestamp,
    metadata,
  }
}

function assertResolvedSource(artifactId: string, source: ImmutableDeploymentSource): void {
  if (artifactId !== source.artifactId) {
    throw new DeploymentExecutionError(
      "DEPLOYMENT_SOURCE_UNAVAILABLE",
      "Deployment source no longer matches its immutable reference.",
    )
  }
}

function assertJsonObject(value: Readonly<Record<string, unknown>>): void {
  const seen = new Set<object>()
  const visit = (item: unknown, depth: number): void => {
    if (depth > 12) throw invalidInput("Deployment target configuration is too deep.")
    if (item === null || typeof item === "string" || typeof item === "boolean") return
    if (typeof item === "number" && Number.isFinite(item)) return
    if (Array.isArray(item)) {
      if (seen.has(item)) throw invalidInput("Deployment target configuration is cyclic.")
      seen.add(item)
      for (const child of item) visit(child, depth + 1)
      seen.delete(item)
      return
    }
    if (typeof item === "object") {
      if (seen.has(item)) throw invalidInput("Deployment target configuration is cyclic.")
      seen.add(item)
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) {
        throw invalidInput("Deployment target configuration must contain plain JSON values.")
      }
      for (const child of Object.values(item as Record<string, unknown>)) {
        visit(child, depth + 1)
      }
      seen.delete(item)
      return
    }
    throw invalidInput("Deployment target configuration must contain plain JSON values.")
  }
  visit(value, 0)
}

function assertSecretReferences(references: Readonly<Record<string, string>>): void {
  for (const [name, reference] of Object.entries(references)) {
    if (
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) ||
      reference.length === 0 ||
      reference.length > 2_048
    ) {
      throw invalidInput("Deployment secret reference is invalid.")
    }
  }
}

function assertAdapterSecretTargets(
  allowedTargets: readonly string[],
  references: Readonly<Record<string, string>>,
): void {
  const allowed = new Set(allowedTargets)
  for (const target of Object.keys(references)) {
    if (!allowed.has(target)) {
      throw invalidInput("Deployment target does not accept the requested secret environment.")
    }
  }
}

function assertSourceSelector(source: DeploymentSourceSelector): void {
  const value = source as {
    artifactPath?: unknown
    workspacePath?: unknown
  }
  const hasArtifact = typeof value.artifactPath === "string"
  const hasWorkspace = typeof value.workspacePath === "string"
  if (hasArtifact === hasWorkspace) {
    throw invalidInput("Deployment must select exactly one artifactPath or workspacePath.")
  }
  const selected = hasArtifact ? value.artifactPath : value.workspacePath
  if (typeof selected !== "string" || selected.length === 0) {
    throw invalidInput("Deployment source path must not be empty.")
  }
}

function canonicalSourceSelector(source: DeploymentSourceSelector): DeploymentSourceSelector {
  assertSourceSelector(source)
  const selected = "artifactPath" in source ? source.artifactPath : source.workspacePath
  let logicalPath: string
  try {
    logicalPath = normalizeArtifactPath(selected, true)
  } catch (error) {
    throw invalidInput("Deployment source path is invalid.", error)
  }
  return "artifactPath" in source ? { artifactPath: logicalPath } : { workspacePath: logicalPath }
}

function assertIdempotencyKey(key: string): void {
  if (key.length < 1 || key.length > 255) {
    throw invalidInput("Deployment idempotency key must contain between 1 and 255 characters.")
  }
}

function normalizeEventName(value: string): string {
  return /^[a-z][a-z0-9_.-]{0,127}$/.test(value) ? value : "deployment.adapter.event"
}

function decodeStoredDeploymentLog(chunk: DeploymentLogChunk): DeploymentLogRecord {
  let value: unknown
  try {
    value = JSON.parse(chunk.data)
  } catch (cause) {
    throw new AppError({ code: "INTERNAL", message: "Deployment log evidence is invalid", cause })
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as RawEncodedDeploymentLog
    const level = record.level
    const event = record.event
    const message = record.message
    const fields = record.fields
    if (
      record.version === 1 &&
      isDeploymentLogLevel(level) &&
      typeof event === "string" &&
      typeof message === "string" &&
      isJsonObject(fields)
    ) {
      return {
        deploymentId: chunk.deploymentId,
        sequence: chunk.sequence,
        level,
        event: normalizeEventName(event),
        message,
        fields,
        createdAt: chunk.createdAt,
      }
    }
  }
  throw new AppError({ code: "INTERNAL", message: "Deployment log evidence is invalid" })
}

interface RawEncodedDeploymentLog {
  version?: unknown
  level?: unknown
  event?: unknown
  message?: unknown
  fields?: unknown
}

function isDeploymentLogLevel(value: unknown): value is DeploymentLogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error"
}

function isJsonObject(value: unknown): value is Record<string, SafeJsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return Object.values(value).every(isJsonValue)
}

function isJsonValue(value: unknown): value is SafeJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isJsonObject(value)
}

function isSafeRecord(value: SafeJsonValue): value is Readonly<Record<string, SafeJsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`
}

function settlesWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs)
    void operation.then(() => {
      clearTimeout(timeout)
      resolve(true)
    })
  })
}

function notFound(): DeploymentExecutionError {
  return new DeploymentExecutionError("DEPLOYMENT_NOT_FOUND", "Deployment was not found.")
}

function stateConflict(): DeploymentExecutionError {
  return new DeploymentExecutionError(
    "DEPLOYMENT_STATE_CONFLICT",
    "Deployment state changed concurrently.",
  )
}

function invalidInput(message: string, cause?: unknown): DeploymentExecutionError {
  return new DeploymentExecutionError(
    "DEPLOYMENT_INPUT_INVALID",
    message,
    {},
    cause === undefined ? undefined : { cause },
  )
}

function invalidDeployResult(cause?: unknown): DeploymentExecutionError {
  return new DeploymentExecutionError(
    "DEPLOYMENT_RESULT_INVALID",
    "Deployment target returned an invalid success URL.",
    {},
    cause === undefined ? undefined : { cause },
  )
}

function sourceUnavailable(cause?: unknown): DeploymentExecutionError {
  return new DeploymentExecutionError(
    "DEPLOYMENT_SOURCE_UNAVAILABLE",
    "Deployment source is unavailable.",
    {},
    cause === undefined ? undefined : { cause },
  )
}

function parseDigest(value: string): Sha256Digest {
  try {
    return asSha256Digest(value)
  } catch (error) {
    throw new DeploymentExecutionError(
      "DEPLOYMENT_SOURCE_UNAVAILABLE",
      "Deployment artifact metadata is invalid.",
      {},
      { cause: error },
    )
  }
}
