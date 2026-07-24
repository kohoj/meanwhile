import type { PresenceLease, RequestContext } from "../domain"
import type { Store } from "../persistence/store"

export const PRESENCE_LEASE_TTL_MS = 45_000

export class PresenceService {
  constructor(
    private readonly store: Pick<
      Store,
      | "requireProjectAccess"
      | "heartbeatPresenceLease"
      | "listActivePresenceLeases"
      | "releasePresenceLease"
    >,
    private readonly now: () => Date = () => new Date(),
  ) {}

  heartbeat(context: RequestContext, projectId: string, clientId: string): PresenceLease {
    const now = this.now()
    this.store.requireProjectAccess(
      context.ownerId,
      projectId,
      context.principalId,
      now.toISOString(),
    )
    return this.store.heartbeatPresenceLease({
      ownerId: context.ownerId,
      projectId,
      principalId: context.principalId,
      clientId,
      now: now.toISOString(),
      expiresAt: new Date(now.getTime() + PRESENCE_LEASE_TTL_MS).toISOString(),
    })
  }

  list(context: RequestContext, projectId: string): readonly PresenceLease[] {
    const now = this.now().toISOString()
    this.store.requireProjectAccess(context.ownerId, projectId, context.principalId, now)
    return this.store.listActivePresenceLeases(context.ownerId, projectId, now)
  }

  release(context: RequestContext, projectId: string, clientId: string): void {
    this.store.requireProjectAccess(
      context.ownerId,
      projectId,
      context.principalId,
      this.now().toISOString(),
    )
    this.store.releasePresenceLease({
      ownerId: context.ownerId,
      projectId,
      principalId: context.principalId,
      clientId,
    })
  }
}
