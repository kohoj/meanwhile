import { normalizedMirrorEventDigest } from "../connectors/external-transcript"
import type {
  AuditRecord,
  ConversationMirror,
  MirrorEvent,
  MirrorEventInput,
  RequestContext,
} from "../domain"
import { AppError } from "../errors"
import type { Store } from "../persistence/store"

type ConversationMirrorStore = Pick<
  Store,
  | "appendMirrorEvents"
  | "getConnectorDevice"
  | "getConversationMirror"
  | "getConversationMirrorForPrincipal"
  | "getActiveConversationShareGrant"
  | "getActiveProjectRepositoryBinding"
  | "listMirrorEvents"
  | "latestMirrorEvent"
  | "requireProjectAccess"
  | "upsertConversationMirrorWithAudit"
>

const SOURCE_CONVERSATION_KEY = /^[a-f0-9]{64}$/

/**
 * Owns Project-visible observation of source-owned conversations. It exposes no
 * lifecycle command because the ConnectorDevice has observation authority only.
 */
export class ConversationMirrorService {
  constructor(
    private readonly store: ConversationMirrorStore,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = () => crypto.randomUUID(),
    private readonly followPollMs = 250,
  ) {}

  upsert(
    context: RequestContext,
    input: {
      readonly projectId: string
      readonly repositoryId: string
      readonly sourceConversationKey: string
      readonly title: string
      readonly status: ConversationMirror["status"]
    },
  ): ConversationMirror {
    const deviceId = this.#requireDeviceContext(context)
    const device = this.store.getConnectorDevice(context.ownerId, deviceId)
    if (
      device === null ||
      device.principalId !== context.principalId ||
      device.revokedAt !== null
    ) {
      throw new AppError({ code: "UNAUTHENTICATED", message: "Connector device is unavailable" })
    }
    const at = this.now().toISOString()
    const access = this.store.requireProjectAccess(
      context.ownerId,
      input.projectId,
      context.principalId,
      at,
      "participate",
    )
    const repository = this.store.getActiveProjectRepositoryBinding(
      context.ownerId,
      input.projectId,
    )
    if (repository === null || repository.repositoryId !== input.repositoryId) {
      throw new AppError({
        code: "PROJECT_REPOSITORY_MISMATCH",
        status: 409,
        message: "Linked conversation does not match the Project GitHub repository",
      })
    }
    if (access.principal.kind !== "person") {
      throw new AppError({
        code: "FORBIDDEN",
        status: 403,
        message: "Only a person can share a local conversation",
      })
    }
    const shareGrant = this.store.getActiveConversationShareGrant(
      context.ownerId,
      device.id,
      input.projectId,
      device.source,
    )
    if (shareGrant === null) {
      throw new AppError({
        code: "FORBIDDEN",
        status: 403,
        message: "This device is not authorized to share into the Project",
      })
    }
    if (!SOURCE_CONVERSATION_KEY.test(input.sourceConversationKey)) {
      throw new AppError({
        code: "INVALID_REQUEST",
        message: "Source conversation identity is invalid",
      })
    }
    const title = input.title.trim()
    if (title.length === 0 || title.length > 500 || hasControlCharacter(title)) {
      throw new AppError({ code: "INVALID_REQUEST", message: "Conversation title is invalid" })
    }
    const mirror: ConversationMirror = {
      id: this.id(),
      ownerId: context.ownerId,
      projectId: input.projectId,
      connectorDeviceId: device.id,
      shareGrantId: shareGrant.id,
      sharedBy: access.principal,
      source: device.source,
      sourceConversationKey: input.sourceConversationKey,
      title,
      status: input.status,
      createdAt: at,
      updatedAt: at,
      endedAt: input.status === "ended" ? at : null,
    }
    return this.store.upsertConversationMirrorWithAudit({
      mirror,
      audit: this.#audit(context, "conversation_mirror.create", mirror.id, at, {
        projectId: mirror.projectId,
        repositoryId: repository.repositoryId,
        source: mirror.source,
        connectorDeviceId: mirror.connectorDeviceId,
      }),
    })
  }

  get(context: RequestContext, mirrorId: string): ConversationMirror {
    const mirror = this.store.getConversationMirrorForPrincipal(
      context.ownerId,
      context.principalId,
      mirrorId,
      this.now().toISOString(),
    )
    if (mirror === null) throw new AppError({ code: "NOT_FOUND", message: "Mirror not found" })
    return mirror
  }

  checkpoint(
    context: RequestContext,
    mirrorId: string,
  ): { readonly sequence: number; readonly sourceCursor: string | null } {
    const deviceId = this.#requireDeviceContext(context)
    const mirror = this.store.getConversationMirror(context.ownerId, mirrorId)
    if (mirror === null || mirror.connectorDeviceId !== deviceId) {
      throw new AppError({ code: "NOT_FOUND", message: "Mirror not found" })
    }
    const device = this.store.getConnectorDevice(context.ownerId, deviceId)
    const grant = this.store.getActiveConversationShareGrant(
      context.ownerId,
      deviceId,
      mirror.projectId,
      mirror.source,
    )
    if (
      device === null ||
      device.revokedAt !== null ||
      grant === null ||
      grant.id !== mirror.shareGrantId
    ) {
      throw new AppError({
        code: "FORBIDDEN",
        status: 403,
        message: "Conversation sharing is revoked",
      })
    }
    this.store.requireProjectAccess(
      context.ownerId,
      mirror.projectId,
      context.principalId,
      this.now().toISOString(),
      "participate",
    )
    const latest = this.store.latestMirrorEvent(context.ownerId, mirrorId)
    return { sequence: latest?.sequence ?? 0, sourceCursor: latest?.sourceCursor ?? null }
  }

  append(
    context: RequestContext,
    mirrorId: string,
    events: readonly MirrorEventInput[],
  ): readonly MirrorEvent[] {
    const deviceId = this.#requireDeviceContext(context)
    const mirror = this.store.getConversationMirror(context.ownerId, mirrorId)
    if (mirror === null || mirror.connectorDeviceId !== deviceId) {
      throw new AppError({ code: "NOT_FOUND", message: "Mirror not found" })
    }
    const device = this.store.getConnectorDevice(context.ownerId, deviceId)
    const grant = this.store.getActiveConversationShareGrant(
      context.ownerId,
      deviceId,
      mirror.projectId,
      mirror.source,
    )
    if (
      device === null ||
      device.revokedAt !== null ||
      grant === null ||
      grant.id !== mirror.shareGrantId
    ) {
      throw new AppError({
        code: "FORBIDDEN",
        status: 403,
        message: "Conversation sharing is revoked",
      })
    }
    this.store.requireProjectAccess(
      context.ownerId,
      mirror.projectId,
      context.principalId,
      this.now().toISOString(),
      "participate",
    )
    if (events.length === 0 || events.length > 100) {
      throw new AppError({ code: "INVALID_REQUEST", message: "Event batch size is invalid" })
    }
    const cursors = new Set<string>()
    const sequences = new Set<number>()
    for (const event of events) {
      if (event.source !== mirror.source) {
        throw new AppError({ code: "INVALID_REQUEST", message: "Mirror source does not match" })
      }
      if (cursors.has(event.sourceCursor)) {
        throw new AppError({
          code: "INVALID_REQUEST",
          message: "Event batch repeats a source cursor",
        })
      }
      cursors.add(event.sourceCursor)
      if (sequences.has(event.sequence)) {
        throw new AppError({ code: "INVALID_REQUEST", message: "Event batch repeats a sequence" })
      }
      sequences.add(event.sequence)
      const computed = normalizedMirrorEventDigest(event)
      if (computed !== event.digest) {
        throw new AppError({ code: "INVALID_REQUEST", message: "Mirror event digest is invalid" })
      }
    }
    return this.store.appendMirrorEvents({
      ownerId: context.ownerId,
      mirrorId,
      connectorDeviceId: deviceId,
      events,
      acceptedAt: this.now().toISOString(),
    })
  }

  events(
    context: RequestContext,
    mirrorId: string,
    after: number,
    limit: number,
  ): readonly MirrorEvent[] {
    this.get(context, mirrorId)
    return this.store.listMirrorEvents(context.ownerId, mirrorId, after, limit)
  }

  async *followEvents(
    context: RequestContext,
    mirrorId: string,
    after: number,
    signal: AbortSignal,
  ): AsyncIterable<MirrorEvent | null> {
    let cursor = after
    while (!signal.aborted) {
      const mirror = this.get(context, mirrorId)
      const items = this.store.listMirrorEvents(context.ownerId, mirrorId, cursor, 1_000)
      for (const item of items) {
        cursor = item.sequence
        yield item
      }
      if (mirror.status === "ended") {
        if (items.length < 1_000) return
        continue
      }
      if (items.length === 1_000) continue
      await abortableDelay(this.followPollMs, signal)
      if (!signal.aborted) yield null
    }
  }

  #requireDeviceContext(context: RequestContext): string {
    if (context.connectorDeviceId === undefined) {
      throw new AppError({
        code: "FORBIDDEN",
        status: 403,
        message: "A ConnectorDevice credential is required",
      })
    }
    return context.connectorDeviceId
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
      actorApiKeyId: null,
      action,
      resourceType: "conversation_mirror",
      resourceId,
      requestId: context.requestId,
      traceId: context.traceId,
      metadata,
      createdAt,
    }
  }
}

const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true
  }
  return false
}

const abortableDelay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(finish, milliseconds)
    function finish() {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    signal.addEventListener("abort", finish, { once: true })
  })
