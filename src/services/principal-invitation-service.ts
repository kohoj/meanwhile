import { issuePrincipalInvitation } from "../auth"
import type { PrincipalInvitation, RequestContext } from "../domain"
import { AppError } from "../errors"
import type { Store } from "../persistence/store"

const MIN_INVITATION_TTL_SECONDS = 5 * 60
const MAX_INVITATION_TTL_SECONDS = 30 * 24 * 60 * 60
const DEFAULT_INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60

export interface CreatedPrincipalInvitation {
  readonly invitation: PrincipalInvitation
  /** Returned exactly once. Only its digest is persisted. */
  readonly secret: string
}

/** Owns the complete lifecycle of single-use Principal invitations. */
export class PrincipalInvitationService {
  constructor(
    private readonly store: Pick<
      Store,
      | "createPrincipalInvitationWithAudit"
      | "getPrincipal"
      | "getPrincipalInvitation"
      | "listPrincipalInvitations"
      | "revokePrincipalInvitationWithAudit"
    >,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = () => crypto.randomUUID(),
  ) {}

  async create(
    request: RequestContext,
    principalId: string,
    expiresInSeconds = DEFAULT_INVITATION_TTL_SECONDS,
  ): Promise<CreatedPrincipalInvitation> {
    this.#requireOwnerAdmin(request)
    if (
      !Number.isInteger(expiresInSeconds) ||
      expiresInSeconds < MIN_INVITATION_TTL_SECONDS ||
      expiresInSeconds > MAX_INVITATION_TTL_SECONDS
    ) {
      throw new AppError({ code: "INVALID_REQUEST", message: "Invitation expiry is invalid" })
    }
    const principal = this.store.getPrincipal(request.ownerId, principalId)
    if (principal === null || principal.disabledAt !== null || principal.kind !== "person") {
      throw new AppError({ code: "NOT_FOUND", message: "Principal not found" })
    }
    const issued = await issuePrincipalInvitation()
    const createdAt = this.now()
    const invitation: PrincipalInvitation & { readonly hash: string } = {
      id: this.id(),
      ownerId: request.ownerId,
      principalId,
      prefix: issued.prefix,
      hash: issued.hash,
      createdByPrincipalId: request.principalId,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + expiresInSeconds * 1_000).toISOString(),
      redeemedAt: null,
      revokedAt: null,
    }
    return {
      invitation: this.store.createPrincipalInvitationWithAudit({
        invitation,
        audit: {
          id: crypto.randomUUID(),
          ownerId: request.ownerId,
          actorApiKeyId: request.apiKeyId,
          action: "principal_invitation.create",
          resourceType: "principal_invitation",
          resourceId: invitation.id,
          requestId: request.requestId,
          traceId: request.traceId,
          metadata: {
            principalId,
            prefix: invitation.prefix,
            expiresAt: invitation.expiresAt,
          },
          createdAt: invitation.createdAt,
        },
      }),
      secret: issued.secret,
    }
  }

  list(request: RequestContext): readonly PrincipalInvitation[] {
    this.#requireOwnerAdmin(request)
    return this.store.listPrincipalInvitations(request.ownerId)
  }

  revoke(request: RequestContext, id: string): PrincipalInvitation {
    this.#requireOwnerAdmin(request)
    const existing = this.store.getPrincipalInvitation(request.ownerId, id)
    if (existing === null) {
      throw new AppError({ code: "NOT_FOUND", message: "Invitation not found" })
    }
    const at = this.now().toISOString()
    const invitation = this.store.revokePrincipalInvitationWithAudit({
      ownerId: request.ownerId,
      id,
      at,
      audit: {
        id: crypto.randomUUID(),
        ownerId: request.ownerId,
        actorApiKeyId: request.apiKeyId,
        action: "principal_invitation.revoke",
        resourceType: "principal_invitation",
        resourceId: id,
        requestId: request.requestId,
        traceId: request.traceId,
        metadata: {},
        createdAt: at,
      },
    })
    if (invitation === null) {
      throw new AppError({ code: "NOT_FOUND", message: "Invitation not found" })
    }
    return invitation
  }

  #requireOwnerAdmin(request: RequestContext): void {
    if (request.ownerRole !== "admin") {
      throw new AppError({ code: "NOT_FOUND", message: "Resource not found" })
    }
  }
}
