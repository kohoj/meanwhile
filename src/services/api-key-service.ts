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
      "createApiKeyWithAudit" | "listApiKeys" | "revokeApiKeyWithAudit"
    >,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = () => crypto.randomUUID(),
  ) {}

  async create(request: RequestContext, name: string): Promise<CreatedApiKey> {
    const issued = await issueApiKey()
    const createdAt = this.now().toISOString()
    const id = this.id()
    const key = this.store.createApiKeyWithAudit({
      key: {
        id,
        ownerId: request.ownerId,
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
        metadata: { prefix: issued.prefix },
        createdAt,
      },
    })
    return { key, secret: issued.key }
  }

  list(ownerId: string): readonly ApiKey[] {
    return this.store.listApiKeys(ownerId)
  }

  revoke(request: RequestContext, id: string): ApiKey {
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
