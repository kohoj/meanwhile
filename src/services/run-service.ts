import type { PreparedWorkspaceBundle, UploadedWorkspaceFile } from "../artifacts/workspace-bundle"
import {
  type AgentLaunchSnapshot,
  type Artifact,
  type ExecutionProvenance,
  isSafeRepositoryRevision,
  isTerminalRunStatus,
  type RequestContext,
  type Run,
  type RunEvent,
  type RunLogChunk,
  type WorkspaceSource,
} from "../domain"
import { AppError } from "../errors"
import { hashCanonical } from "../idempotency"
import type { CreateRunInput, Page, Store } from "../persistence/store"
import type { SecretReferenceValidator } from "../secrets"
import type { BriefService } from "./brief-service"

export interface UploadedFilesWorkspaceSource {
  readonly type: "files"
  readonly files: readonly UploadedWorkspaceFile[]
}

export interface WorkspaceInputStore {
  prepare(files: readonly UploadedWorkspaceFile[]): PreparedWorkspaceBundle
  publish(ownerId: string, prepared: PreparedWorkspaceBundle): Promise<void>
  require(ownerId: string, artifactId: string): Promise<void>
}

export interface RunAgentIntentResolver {
  resolveIntent(
    agentType: string,
    environment: Readonly<Record<string, string>>,
    secretReferences: Readonly<Record<string, string>>,
  ): {
    readonly agentSpec: AgentLaunchSnapshot
    readonly agentCatalogDigest: string
  }
}

export interface RunProviderNames {
  has(name: string): boolean
  supportsCredentialMediation(name: string): boolean
}

export interface RunExecutionProvenance {
  capture(input: {
    provider: string
    agentSpec: AgentLaunchSnapshot
    agentCatalogDigest: string
  }): ExecutionProvenance
}

export interface CreateRunCommand {
  readonly projectId?: string
  readonly workspace: WorkspaceSource | UploadedFilesWorkspaceSource
  readonly agentType: string
  readonly prompt: string
  readonly env: Readonly<Record<string, string>>
  readonly secretRefs: Readonly<Record<string, string>>
  readonly provider?: string
  readonly briefIds?: readonly string[]
  readonly artifactPaths: readonly string[]
  readonly timeoutMs: number
}

export interface RunCommandSink {
  /** Wakes the executor after the durable queued record exists. */
  enqueue(runId: string): void
  /** Re-authorizes, durably claims, then acts on cancellation before resolving. */
  cancel(input: { readonly runId: string; readonly context: RequestContext }): Promise<void>
}

export interface RunServiceOptions {
  readonly store: Pick<
    Store,
    | "createRun"
    | "getIdempotentRun"
    | "getRun"
    | "listRuns"
    | "listRunsForPrincipal"
    | "listRunLogs"
    | "listRunEvents"
    | "listArtifacts"
    | "resolveProjectForPrincipal"
    | "getPrincipal"
    | "getRunForPrincipal"
    | "requireRunDelegator"
  >
  readonly commands: RunCommandSink
  readonly workspaceInputs?: WorkspaceInputStore
  readonly agentIntents: RunAgentIntentResolver
  readonly secretReferences: SecretReferenceValidator
  readonly providerNames: RunProviderNames
  readonly executionProvenance: RunExecutionProvenance
  readonly briefs?: Pick<BriefService, "resolve">
  readonly defaultProvider: string
  readonly clock?: () => Date
  readonly id?: () => string
  readonly followPollMs?: number
}

export type RunPage = Page<Run>

export interface RunLogPage {
  readonly items: readonly RunLogChunk[]
  readonly nextCursor: number | null
}

export interface RunEventPage {
  readonly items: readonly RunEvent[]
  readonly nextCursor: number | null
}

export interface CreateRunResult {
  readonly run: Run
  readonly replayed: boolean
}

/** Owner-scoped run use cases. Durable lifecycle transitions remain executor-owned. */
export class RunService {
  readonly #store: RunServiceOptions["store"]
  readonly #commands: RunCommandSink
  readonly #workspaceInputs: WorkspaceInputStore | undefined
  readonly #agentIntents: RunAgentIntentResolver
  readonly #secretReferences: SecretReferenceValidator
  readonly #providerNames: RunProviderNames
  readonly #executionProvenance: RunExecutionProvenance
  readonly #briefs: Pick<BriefService, "resolve"> | undefined
  readonly #defaultProvider: string
  readonly #clock: () => Date
  readonly #id: () => string
  readonly #followPollMs: number
  readonly #idempotencyTails = new Map<string, Promise<void>>()

  constructor(options: RunServiceOptions) {
    this.#store = options.store
    this.#commands = options.commands
    this.#workspaceInputs = options.workspaceInputs
    this.#agentIntents = options.agentIntents
    this.#secretReferences = options.secretReferences
    this.#providerNames = options.providerNames
    this.#executionProvenance = options.executionProvenance
    this.#briefs = options.briefs
    this.#defaultProvider = options.defaultProvider
    this.#clock = options.clock ?? (() => new Date())
    this.#id = options.id ?? (() => crypto.randomUUID())
    this.#followPollMs = options.followPollMs ?? 1_000
    if (!Number.isSafeInteger(this.#followPollMs) || this.#followPollMs < 10) {
      throw new TypeError("followPollMs must be an integer of at least 10 milliseconds")
    }
  }

  async create(
    context: RequestContext,
    input: CreateRunCommand,
    idempotencyKey?: string,
  ): Promise<CreateRunResult> {
    const project = this.#store.resolveProjectForPrincipal(
      context.ownerId,
      context.principalId,
      input.projectId,
    )
    const principal = this.#store.getPrincipal(context.ownerId, context.principalId)
    if (principal === null || principal.disabledAt !== null) {
      throw new AppError({
        code: "UNAUTHENTICATED",
        status: 401,
        message: "Authentication required",
      })
    }
    this.#secretReferences.validate(input.secretRefs, {
      ownerId: context.ownerId,
      purpose: "agent",
    })
    if (input.workspace.type === "repository") {
      if (
        input.workspace.revision !== undefined &&
        !isSafeRepositoryRevision(input.workspace.revision)
      ) {
        throw new AppError({
          code: "INVALID_REQUEST",
          message: "Repository revision must be a literal branch, tag, or commit name",
        })
      }
      if (input.workspace.credentialRef !== undefined) {
        if (!input.workspace.url.startsWith("https://")) {
          throw new AppError({
            code: "INVALID_REQUEST",
            message: "Repository credentials are supported only for HTTPS repositories",
          })
        }
        this.#secretReferences.validate(
          {
            MEANWHILE_REPOSITORY_CREDENTIAL: input.workspace.credentialRef,
          },
          {
            ownerId: context.ownerId,
            purpose: "repository",
          },
        )
      }
    }
    const agentIntent = this.#agentIntents.resolveIntent(
      input.agentType,
      input.env,
      input.secretRefs,
    )
    const provider = input.provider ?? this.#defaultProvider
    if (!this.#providerNames.has(provider)) {
      throw new AppError({
        code: "INVALID_REQUEST",
        message: "Runtime provider is not configured",
        details: { provider },
      })
    }
    if (
      Object.keys(input.secretRefs).length > 0 &&
      !this.#providerNames.supportsCredentialMediation(provider)
    ) {
      throw new AppError({
        code: "PROVIDER_CAPABILITY_UNAVAILABLE",
        status: 422,
        message: "Runtime provider cannot keep agent credentials outside the runtime",
        details: { provider, capability: "credentialMediation" },
      })
    }
    const executionProvenance = this.#executionProvenance.capture({
      provider,
      agentSpec: agentIntent.agentSpec,
      agentCatalogDigest: agentIntent.agentCatalogDigest,
    })
    const briefIds = input.briefIds ?? []
    if (briefIds.length > 0 && this.#briefs === undefined) {
      throw new AppError({
        code: "INVALID_REQUEST",
        message: "Reusable briefs are unavailable",
      })
    }
    const contextArtifacts =
      briefIds.length === 0
        ? []
        : await (this.#briefs as Pick<BriefService, "resolve">).resolve(context, briefIds)
    let preparedWorkspace: PreparedWorkspaceBundle | null = null
    let workspace: WorkspaceSource
    if (input.workspace.type === "files") {
      preparedWorkspace = this.#requireWorkspaceInputs().prepare(input.workspace.files)
      workspace = preparedWorkspace.source
    } else {
      workspace = input.workspace
    }
    const { briefIds: _requestedBriefs, ...inputWithoutContext } = input
    const normalizedInput = {
      ...inputWithoutContext,
      projectId: project.id,
      delegatedBy: {
        id: principal.id,
        kind: principal.kind,
        displayName: principal.displayName,
      },
      contextArtifacts,
      provider,
      ...agentIntent,
      executionProvenance,
    }
    const requestHash =
      idempotencyKey === undefined ? undefined : hashCanonical({ ...normalizedInput, workspace })

    const create = async (): Promise<CreateRunResult> => {
      if (idempotencyKey !== undefined && requestHash !== undefined) {
        const existing = this.#store.getIdempotentRun(
          context.ownerId,
          context.principalId,
          idempotencyKey,
          requestHash,
        )
        if (existing !== null) return { run: existing, replayed: true }
      }

      if (preparedWorkspace !== null) {
        await this.#requireWorkspaceInputs().publish(context.ownerId, preparedWorkspace)
      } else if (workspace.type === "bundle") {
        await this.#requireWorkspaceInputs().require(context.ownerId, workspace.artifactId)
      }

      const createdAt = this.#clock().toISOString()
      const createInput: CreateRunInput = {
        id: this.#id(),
        ownerId: context.ownerId,
        projectId: project.id,
        delegatedBy: {
          id: principal.id,
          kind: principal.kind,
          displayName: principal.displayName,
        },
        workspace,
        agentType: input.agentType,
        agentSpec: agentIntent.agentSpec,
        agentCatalogDigest: agentIntent.agentCatalogDigest,
        executionProvenance,
        prompt: input.prompt,
        env: input.env,
        secretRefs: input.secretRefs,
        provider,
        contextArtifacts,
        artifactPaths: input.artifactPaths,
        timeoutMs: input.timeoutMs,
        createdAt,
        ...(idempotencyKey === undefined || requestHash === undefined
          ? {}
          : { idempotencyKey, requestHash }),
        audit: {
          actorApiKeyId: context.apiKeyId,
          requestId: context.requestId,
          traceId: context.traceId,
          metadata: {
            agentType: input.agentType,
            provider,
            contextArtifacts: contextArtifacts.length,
          },
        },
      }
      const result = this.#store.createRun(createInput)
      if (!result.replayed) this.#commands.enqueue(result.run.id)
      return result
    }

    return idempotencyKey === undefined
      ? create()
      : this.#withIdempotencyGate(context.ownerId, context.principalId, idempotencyKey, create)
  }

  #requireWorkspaceInputs(): WorkspaceInputStore {
    if (this.#workspaceInputs === undefined) {
      throw new AppError({
        code: "INVALID_REQUEST",
        message: "Uploaded workspace input is unavailable",
      })
    }
    return this.#workspaceInputs
  }

  async #withIdempotencyGate<Result>(
    ownerId: string,
    principalId: string,
    key: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const scope = JSON.stringify([ownerId, principalId, key])
    const predecessor = this.#idempotencyTails.get(scope) ?? Promise.resolve()
    let release: () => void = () => undefined
    const claim = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = predecessor.then(() => claim)
    this.#idempotencyTails.set(scope, tail)
    await predecessor
    try {
      return await operation()
    } finally {
      release()
      if (this.#idempotencyTails.get(scope) === tail) this.#idempotencyTails.delete(scope)
    }
  }

  async list(
    scope: string | RequestContext,
    options: { limit: number; before?: string },
  ): Promise<RunPage> {
    return typeof scope === "string"
      ? this.#store.listRuns(scope, options)
      : this.#store.listRunsForPrincipal(scope.ownerId, scope.principalId, options)
  }

  async get(scope: string | RequestContext, runId: string): Promise<Run> {
    return this.#requireRunForScope(scope, runId)
  }

  async cancel(context: RequestContext, runId: string): Promise<Run> {
    const run = this.#store.requireRunDelegator(context.ownerId, context.principalId, runId)
    if (run.status === "cancelled") return run
    if (isTerminalRunStatus(run.status)) {
      throw new AppError({
        code: "RUN_TERMINAL",
        message: "The run is already terminal and cannot be cancelled",
        details: { status: run.status },
      })
    }
    await this.#commands.cancel({ runId: run.id, context })
    return this.#requireRun(context.ownerId, runId)
  }

  async logs(
    scope: string | RequestContext,
    runId: string,
    options: { after: number; limit: number },
  ): Promise<RunLogPage> {
    const ownerId = this.#requireRunForScope(scope, runId).ownerId
    const items = this.#store.listRunLogs(ownerId, runId, options.after, options.limit)
    return {
      items,
      nextCursor: items.length === 0 ? null : (items.at(-1)?.sequence ?? null),
    }
  }

  async events(
    scope: string | RequestContext,
    runId: string,
    options: { after: number; limit: number },
  ): Promise<RunEventPage> {
    const ownerId = this.#requireRunForScope(scope, runId).ownerId
    const items = this.#store.listRunEvents(ownerId, runId, options.after, options.limit)
    return {
      items,
      nextCursor: items.length === 0 ? null : (items.at(-1)?.sequence ?? null),
    }
  }

  async artifacts(scope: string | RequestContext, runId: string): Promise<readonly Artifact[]> {
    const ownerId = this.#requireRunForScope(scope, runId).ownerId
    return this.#store.listArtifacts(ownerId, runId)
  }

  /**
   * Follows the same durable sequence used by polling. `null` is a transport
   * heartbeat and carries no product-log identity.
   */
  async *followLogs(
    scope: string | RequestContext,
    runId: string,
    after: number,
    signal: AbortSignal,
  ): AsyncIterable<RunLogChunk | null> {
    const ownerId = this.#requireRunForScope(scope, runId).ownerId
    let cursor = after
    while (!signal.aborted) {
      const run = this.#requireRunForScope(scope, runId)
      const items = this.#store.listRunLogs(ownerId, runId, cursor, 1_000)
      for (const item of items) {
        cursor = item.sequence
        yield item
      }

      if (isTerminalRunStatus(run.status)) {
        // Discard the pre-terminal log snapshot and read the durable tail once
        // more. `end` is therefore emitted only after a post-terminal read;
        // crash atomicity between status and evidence remains the writer's job.
        for (;;) {
          this.#requireRunForScope(scope, runId)
          const tail = this.#store.listRunLogs(ownerId, runId, cursor, 1_000)
          for (const item of tail) {
            cursor = item.sequence
            yield item
          }
          if (tail.length < 1_000) return
        }
      }
      if (items.length === 1_000) continue

      await abortableDelay(this.#followPollMs, signal)
      if (!signal.aborted) yield null
    }
  }

  async *followEvents(
    scope: string | RequestContext,
    runId: string,
    after: number,
    signal: AbortSignal,
  ): AsyncIterable<RunEvent | null> {
    const ownerId = this.#requireRunForScope(scope, runId).ownerId
    let cursor = after
    while (!signal.aborted) {
      const run = this.#requireRunForScope(scope, runId)
      const items = this.#store.listRunEvents(ownerId, runId, cursor, 1_000)
      for (const item of items) {
        cursor = item.sequence
        yield item
      }

      if (isTerminalRunStatus(run.status)) {
        for (;;) {
          this.#requireRunForScope(scope, runId)
          const tail = this.#store.listRunEvents(ownerId, runId, cursor, 1_000)
          for (const item of tail) {
            cursor = item.sequence
            yield item
          }
          if (tail.length < 1_000) return
        }
      }
      if (items.length === 1_000) continue

      await abortableDelay(this.#followPollMs, signal)
      if (!signal.aborted) yield null
    }
  }

  #requireRun(ownerId: string, runId: string): Run {
    const run = this.#store.getRun(ownerId, runId)
    if (run === null) {
      throw new AppError({ code: "NOT_FOUND", message: "Run not found" })
    }
    return run
  }

  #requireRunForScope(scope: string | RequestContext, runId: string): Run {
    if (typeof scope === "string") return this.#requireRun(scope, runId)
    const run = this.#store.getRunForPrincipal(scope.ownerId, scope.principalId, runId)
    if (run === null) throw new AppError({ code: "NOT_FOUND", message: "Run not found" })
    return run
  }
}

const abortableDelay = (milliseconds: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timeout = setTimeout(finish, milliseconds)
    signal.addEventListener("abort", finish, { once: true })
  })
}
