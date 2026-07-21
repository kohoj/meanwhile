import { issueApiKey } from "../auth"
import type { ApiKey, RequestContext } from "../domain"
import { AppError } from "../errors"
import type { Store } from "../persistence/store"

export interface CreatedApiKey {
  readonly key: ApiKey
  /** Returned once. Only its digest is persisted. */
  readonly secret: string
}

/** Complete hashed-key lifecycle; plaintext exists only in the create result. */
export class ApiKeyService {
  constructor(
    private readonly store: Pick<
      Store,
      | "createApiKeyWithAudit"
      | "listApiKeysForPrincipal"
      | "getApiKey"
      | "getPrincipal"
      | "revokeApiKeyWithAudit"
    >,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = () => crypto.randomUUID(),
  ) {}

  async create(
    request: RequestContext,
    name: string,
    principalId = request.principalId,
  ): Promise<CreatedApiKey> {
    if (principalId !== request.principalId && request.ownerRole !== "admin") {
      throw new AppError({ code: "NOT_FOUND", message: "Principal not found" })
    }
    const principal = this.store.getPrincipal(request.ownerId, principalId)
    if (principal === null || principal.disabledAt !== null) {
      throw new AppError({ code: "NOT_FOUND", message: "Principal not found" })
    }
    const issued = await issueApiKey()
    const createdAt = this.now().toISOString()
    const id = this.id()
    const key = this.store.createApiKeyWithAudit({
      key: {
        id,
        ownerId: request.ownerId,
        principalId,
        prefix: issued.prefix,
        hash: issued.hash,
        name: name.trim(),
        createdAt,
        lastUsedAt: null,
        revokedAt: null,
      },
      audit: {
        id: crypto.randomUUID(),
        ownerId: request.ownerId,
        actorApiKeyId: request.apiKeyId,
        action: "api_key.create",
        resourceType: "api_key",
        resourceId: id,
        requestId: request.requestId,
        traceId: request.traceId,
        metadata: { prefix: issued.prefix, principalId },
        createdAt,
      },
    })
    return { key, secret: issued.key }
  }

  list(request: RequestContext): readonly ApiKey[] {
    return this.store.listApiKeysForPrincipal(request.ownerId, request.principalId)
  }

  revoke(request: RequestContext, id: string): ApiKey {
    const existing = this.store.getApiKey(request.ownerId, id)
    if (
      existing === null ||
      (existing.principalId !== request.principalId && request.ownerRole !== "admin")
    ) {
      throw new AppError({ code: "NOT_FOUND", message: "API key not found" })
    }
    const at = this.now().toISOString()
    const key = this.store.revokeApiKeyWithAudit({
      ownerId: request.ownerId,
      id,
      at,
      audit: {
        id: crypto.randomUUID(),
        ownerId: request.ownerId,
        actorApiKeyId: request.apiKeyId,
        action: "api_key.revoke",
        resourceType: "api_key",
        resourceId: id,
        requestId: request.requestId,
        traceId: request.traceId,
        metadata: {},
        createdAt: at,
      },
    })
    if (key === null) throw new AppError({ code: "NOT_FOUND", message: "API key not found" })
    return key
  }
}
