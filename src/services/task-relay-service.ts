import type { AuditRecord, RequestContext, TaskRelay } from "../domain"
import { AppError } from "../errors"
import type { Store } from "../persistence/store"

type RelayStore = Pick<
  Store,
  | "requireProjectAccess"
  | "getProjectAccess"
  | "getPrincipal"
  | "taskBelongsToProject"
  | "taskEventExists"
  | "createTaskRelayWithAudit"
  | "listTaskRelays"
  | "listPendingTaskRelays"
  | "listRecentProjectTaskRelays"
  | "acknowledgeTaskRelayWithAudit"
>

/**
 * Owns the narrow human-to-human handoff contract. A Relay is immutable, Project-visible,
 * addressed to one active person, and anchored to durable task evidence.
 */
export class TaskRelayService {
  constructor(
    private readonly store: RelayStore,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = () => crypto.randomUUID(),
  ) {}

  create(
    context: RequestContext,
    projectId: string,
    input: {
      readonly task: TaskRelay["task"]
      readonly anchorSequence: number
      readonly recipientPrincipalId: string
      readonly body: string
    },
  ): TaskRelay {
    const createdAt = this.now().toISOString()
    const author = this.store.requireProjectAccess(
      context.ownerId,
      projectId,
      context.principalId,
      createdAt,
      "participate",
    )
    const recipient = this.store.getProjectAccess(
      context.ownerId,
      projectId,
      input.recipientPrincipalId,
      createdAt,
    )
    const recipientPrincipal = this.store.getPrincipal(context.ownerId, input.recipientPrincipalId)
    if (
      author.principal.kind !== "person" ||
      recipient?.principal.kind !== "person" ||
      recipient.access === "watch" ||
      recipientPrincipal === null ||
      recipientPrincipal.disabledAt !== null
    ) {
      throw new AppError({ code: "NOT_FOUND", message: "Project member not found" })
    }
    if (recipient.principal.id === author.principal.id) {
      throw new AppError({
        code: "INVALID_REQUEST",
        status: 409,
        message: "A Relay must be addressed to another Project member",
      })
    }
    if (!this.store.taskBelongsToProject(context.ownerId, projectId, input.task)) {
      throw new AppError({ code: "NOT_FOUND", message: "Task not found" })
    }
    if (!this.store.taskEventExists(context.ownerId, input.task, input.anchorSequence)) {
      throw new AppError({ code: "NOT_FOUND", message: "Transcript anchor not found" })
    }
    const body = input.body.trim()
    if (body.length === 0 || body.length > 2_000) {
      throw new AppError({ code: "INVALID_REQUEST", message: "Relay body is invalid" })
    }
    const id = this.id()
    return this.store.createTaskRelayWithAudit({
      relay: {
        id,
        ownerId: context.ownerId,
        projectId,
        task: input.task,
        anchorSequence: input.anchorSequence,
        author: author.principal,
        recipient: recipient.principal,
        body,
        createdAt,
      },
      audit: this.#audit(context, "task_relay.create", id, createdAt, {
        projectId,
        taskKind: input.task.kind,
        taskId: input.task.id,
        anchorSequence: input.anchorSequence,
        recipientPrincipalId: recipient.principal.id,
      }),
    })
  }

  list(context: RequestContext, projectId: string, task: TaskRelay["task"]): readonly TaskRelay[] {
    this.store.requireProjectAccess(
      context.ownerId,
      projectId,
      context.principalId,
      this.now().toISOString(),
    )
    if (!this.store.taskBelongsToProject(context.ownerId, projectId, task)) {
      throw new AppError({ code: "NOT_FOUND", message: "Task not found" })
    }
    return this.store.listTaskRelays(context.ownerId, projectId, task)
  }

  inbox(context: RequestContext, projectId: string): readonly TaskRelay[] {
    this.store.requireProjectAccess(
      context.ownerId,
      projectId,
      context.principalId,
      this.now().toISOString(),
      "participate",
    )
    return this.store.listPendingTaskRelays(context.ownerId, projectId, context.principalId)
  }

  recent(context: RequestContext, projectId: string, limit: number): readonly TaskRelay[] {
    this.store.requireProjectAccess(
      context.ownerId,
      projectId,
      context.principalId,
      this.now().toISOString(),
    )
    return this.store.listRecentProjectTaskRelays(context.ownerId, projectId, limit)
  }

  acknowledge(context: RequestContext, projectId: string, relayId: string): TaskRelay {
    const acknowledgedAt = this.now().toISOString()
    this.store.requireProjectAccess(
      context.ownerId,
      projectId,
      context.principalId,
      acknowledgedAt,
      "participate",
    )
    const relay = this.store.acknowledgeTaskRelayWithAudit({
      ownerId: context.ownerId,
      projectId,
      relayId,
      principalId: context.principalId,
      acknowledgedAt,
      audit: this.#audit(context, "task_relay.acknowledge", relayId, acknowledgedAt, {
        projectId,
        principalId: context.principalId,
      }),
    })
    if (relay === null) throw new AppError({ code: "NOT_FOUND", message: "Relay not found" })
    return relay
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
      resourceType: "task_relay",
      resourceId,
      requestId: context.requestId,
      traceId: context.traceId,
      metadata,
      createdAt,
    }
  }
}
