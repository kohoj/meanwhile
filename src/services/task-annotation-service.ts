import type { AuditRecord, RequestContext, TaskAnnotation } from "../domain"
import { AppError } from "../errors"
import type { Store } from "../persistence/store"

type AnnotationStore = Pick<
  Store,
  | "requireProjectAccess"
  | "taskBelongsToProject"
  | "taskEventExists"
  | "createTaskAnnotationWithAudit"
  | "getTaskAnnotation"
  | "listTaskAnnotations"
  | "resolveTaskAnnotationWithAudit"
>

/**
 * Owns Project-visible transcript marginalia. An Annotation is immutable source-anchored
 * commentary; resolving it is a separate audited fact. It is never an addressed Relay.
 */
export class TaskAnnotationService {
  constructor(
    private readonly store: AnnotationStore,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = () => crypto.randomUUID(),
  ) {}

  create(
    context: RequestContext,
    projectId: string,
    input: {
      readonly task: TaskAnnotation["task"]
      readonly anchor: TaskAnnotation["anchor"]
      readonly body: string
    },
  ): TaskAnnotation {
    const createdAt = this.now().toISOString()
    const author = this.store.requireProjectAccess(
      context.ownerId,
      projectId,
      context.principalId,
      createdAt,
      "participate",
    )
    if (author.principal.kind !== "person") {
      throw new AppError({
        code: "FORBIDDEN",
        status: 403,
        message: "Only a person can annotate a transcript",
      })
    }
    if (!this.store.taskBelongsToProject(context.ownerId, projectId, input.task)) {
      throw new AppError({ code: "NOT_FOUND", message: "Task not found" })
    }
    if (!this.store.taskEventExists(context.ownerId, input.task, input.anchor.sequence)) {
      throw new AppError({ code: "NOT_FOUND", message: "Transcript anchor not found" })
    }
    validateAnchor(input.anchor)
    const body = input.body.trim()
    if (body.length === 0 || body.length > 2_000) {
      throw new AppError({ code: "INVALID_REQUEST", message: "Annotation body is invalid" })
    }
    const id = this.id()
    return this.store.createTaskAnnotationWithAudit({
      annotation: {
        id,
        ownerId: context.ownerId,
        projectId,
        task: input.task,
        anchor: input.anchor,
        author: author.principal,
        body,
        createdAt,
      },
      audit: this.#audit(context, "task_annotation.create", id, createdAt, {
        projectId,
        taskKind: input.task.kind,
        taskId: input.task.id,
        anchorSequence: input.anchor.sequence,
        anchorBlockId: input.anchor.blockId,
        contentDigest: input.anchor.contentDigest,
      }),
    })
  }

  list(
    context: RequestContext,
    projectId: string,
    task: TaskAnnotation["task"],
  ): readonly TaskAnnotation[] {
    this.store.requireProjectAccess(
      context.ownerId,
      projectId,
      context.principalId,
      this.now().toISOString(),
    )
    if (!this.store.taskBelongsToProject(context.ownerId, projectId, task)) {
      throw new AppError({ code: "NOT_FOUND", message: "Task not found" })
    }
    return this.store.listTaskAnnotations(context.ownerId, projectId, task)
  }

  resolve(context: RequestContext, projectId: string, annotationId: string): TaskAnnotation {
    const resolvedAt = this.now().toISOString()
    const resolver = this.store.requireProjectAccess(
      context.ownerId,
      projectId,
      context.principalId,
      resolvedAt,
      "participate",
    )
    const annotation = this.store.getTaskAnnotation(context.ownerId, projectId, annotationId)
    if (annotation === null) {
      throw new AppError({ code: "NOT_FOUND", message: "Annotation not found" })
    }
    if (annotation.author.id !== context.principalId && resolver.access !== "administer") {
      throw new AppError({
        code: "FORBIDDEN",
        status: 403,
        message: "Only the annotation author or a Project maintainer can resolve it",
      })
    }
    if (annotation.resolvedAt !== null) return annotation
    const resolved = this.store.resolveTaskAnnotationWithAudit({
      ownerId: context.ownerId,
      projectId,
      annotationId,
      resolver: resolver.principal,
      resolvedAt,
      audit: this.#audit(context, "task_annotation.resolve", annotationId, resolvedAt, {
        projectId,
        taskKind: annotation.task.kind,
        taskId: annotation.task.id,
        resolverPrincipalId: resolver.principal.id,
      }),
    })
    if (resolved === null) {
      throw new AppError({ code: "NOT_FOUND", message: "Annotation not found" })
    }
    return resolved
  }

  #audit(
    context: RequestContext,
    action: string,
    resourceId: string,
    createdAt: string,
    metadata: AuditRecord["metadata"],
  ): AuditRecord {
    return {
      id: crypto.randomUUID(),
      ownerId: context.ownerId,
      actorApiKeyId: context.apiKeyId,
      action,
      resourceType: "task_annotation",
      resourceId,
      requestId: context.requestId,
      traceId: context.traceId,
      metadata,
      createdAt,
    }
  }
}

const validateAnchor = (anchor: TaskAnnotation["anchor"]): void => {
  if (
    anchor.endOffset <= anchor.startOffset ||
    anchor.endOffset - anchor.startOffset !== anchor.quote.length ||
    anchor.quote.length === 0 ||
    anchor.quote.length > 4_096 ||
    anchor.prefix.length > 256 ||
    anchor.suffix.length > 256 ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(anchor.blockId) ||
    !/^[a-f0-9]{64}$/.test(anchor.contentDigest)
  ) {
    throw new AppError({ code: "INVALID_REQUEST", message: "Transcript anchor is invalid" })
  }
}
