import type { Brief, ExecutionContextArtifact, RequestContext } from "../domain"
import { AppError } from "../errors"
import { hashCanonical } from "../idempotency"
import type { Page, Store } from "../persistence/store"
import { sameWorkspaceBasis } from "../workspace-basis"
import type { ExecutionContext } from "./execution-context"

export interface CreateBriefCommand {
  readonly title: string
  readonly artifactId: string
  readonly path?: string
}

export interface BriefServiceOptions {
  readonly store: Pick<
    Store,
    | "createBrief"
    | "getBrief"
    | "listBriefs"
    | "getBriefForPrincipal"
    | "listBriefsForPrincipal"
    | "getArtifactForPrincipal"
  >
  readonly executionContext: Pick<ExecutionContext, "resolve">
  readonly clock?: () => Date
}

/**
 * Curates immutable artifact evidence without copying or reinterpreting it.
 * Briefs are a discovery layer; artifact bytes remain the only source of truth.
 */
export class BriefService {
  readonly #store: BriefServiceOptions["store"]
  readonly #executionContext: BriefServiceOptions["executionContext"]
  readonly #clock: () => Date

  constructor(options: BriefServiceOptions) {
    this.#store = options.store
    this.#executionContext = options.executionContext
    this.#clock = options.clock ?? (() => new Date())
  }

  async create(
    context: RequestContext,
    input: CreateBriefCommand,
  ): Promise<{ readonly brief: Brief; readonly replayed: boolean }> {
    if (
      this.#store.getArtifactForPrincipal(
        context.ownerId,
        context.principalId,
        input.artifactId,
      ) === null
    ) {
      throw notFound()
    }
    const [source] = await this.#executionContext.resolve(context.ownerId, [
      {
        artifactId: input.artifactId,
        ...(input.path === undefined ? {} : { path: input.path }),
      },
    ])
    if (source === undefined || source.sourceWorkspace === null) {
      throw new Error("Brief source resolution returned incomplete evidence")
    }

    const brief: Brief = {
      id: hashCanonical({
        version: 1,
        ownerId: context.ownerId,
        artifactId: source.artifactId,
        path: source.path,
        digest: source.digest,
      }),
      ownerId: context.ownerId,
      title: input.title,
      artifactId: source.artifactId,
      sourceRunId: source.sourceRunId,
      sourceWorkspace: source.sourceWorkspace,
      path: source.path,
      digest: source.digest,
      mediaType: source.mediaType,
      byteSize: source.byteSize,
      createdAt: this.#clock().toISOString(),
    }
    return this.#store.createBrief(brief, {
      id: crypto.randomUUID(),
      ownerId: context.ownerId,
      actorApiKeyId: context.apiKeyId,
      action: "brief.create",
      resourceType: "brief",
      resourceId: brief.id,
      requestId: context.requestId,
      traceId: context.traceId,
      metadata: {
        artifactId: brief.artifactId,
        sourceRunId: brief.sourceRunId,
        path: brief.path,
        digest: brief.digest,
      },
      createdAt: brief.createdAt,
    })
  }

  get(scope: string | RequestContext, briefId: string): Brief {
    const brief =
      typeof scope === "string"
        ? this.#store.getBrief(scope, briefId)
        : this.#store.getBriefForPrincipal(scope.ownerId, scope.principalId, briefId)
    if (brief === null) throw notFound()
    return brief
  }

  list(scope: string | RequestContext, options: { limit: number; before?: string }): Page<Brief> {
    return typeof scope === "string"
      ? this.#store.listBriefs(scope, options)
      : this.#store.listBriefsForPrincipal(scope.ownerId, scope.principalId, options)
  }

  /** Resolves public brief identities into the exact evidence frozen on a Run. */
  async resolve(
    scope: string | RequestContext,
    briefIds: readonly string[],
  ): Promise<readonly ExecutionContextArtifact[]> {
    const ownerId = typeof scope === "string" ? scope : scope.ownerId
    const briefs = briefIds.map((briefId) => this.get(scope, briefId))
    const observed = await this.#executionContext.resolve(
      ownerId,
      briefs.map((brief) => ({ artifactId: brief.artifactId, path: brief.path })),
    )
    for (const [index, source] of observed.entries()) {
      const brief = briefs[index]
      if (
        brief === undefined ||
        source.artifactId !== brief.artifactId ||
        source.sourceRunId !== brief.sourceRunId ||
        source.sourceWorkspace === null ||
        !sameWorkspaceBasis(source.sourceWorkspace, brief.sourceWorkspace) ||
        source.path !== brief.path ||
        source.digest !== brief.digest ||
        source.mediaType !== brief.mediaType ||
        source.byteSize !== brief.byteSize
      ) {
        throw new AppError({
          code: "ARTIFACT_UNAVAILABLE",
          status: 500,
          message: "Brief source no longer matches its immutable artifact evidence",
          details: { briefId: brief?.id ?? briefIds[index] ?? "unknown" },
        })
      }
    }
    return observed
  }
}

const notFound = (): AppError => new AppError({ code: "NOT_FOUND", message: "Brief not found" })
