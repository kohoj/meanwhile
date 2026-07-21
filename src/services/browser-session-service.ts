import { issueBrowserSession } from "../auth"
import type { BrowserSession, RequestContext } from "../domain"
import { AppError } from "../errors"
import type { Store } from "../persistence/store"

const DEFAULT_BROWSER_SESSION_TTL_MS = 12 * 60 * 60 * 1_000

export class BrowserSessionService {
  constructor(
    private readonly store: Pick<
      Store,
      "createBrowserSessionWithAudit" | "revokeBrowserSessionWithAudit"
    >,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = () => crypto.randomUUID(),
  ) {}

  async create(context: RequestContext): Promise<{
    readonly session: BrowserSession
    readonly secret: string
  }> {
    if (context.apiKeyId === null) {
      throw new AppError({
        code: "INVALID_REQUEST",
        status: 409,
        message: "A browser session must be created from an API key",
      })
    }
    const issued = await issueBrowserSession()
    const createdAt = this.now()
    const id = this.id()
    const session = this.store.createBrowserSessionWithAudit({
      session: {
        id,
        ownerId: context.ownerId,
        principalId: context.principalId,
        prefix: issued.prefix,
        hash: issued.hash,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + DEFAULT_BROWSER_SESSION_TTL_MS).toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      },
      audit: {
        id: crypto.randomUUID(),
        ownerId: context.ownerId,
        actorApiKeyId: context.apiKeyId,
        action: "browser_session.create",
        resourceType: "browser_session",
        resourceId: id,
        requestId: context.requestId,
        traceId: context.traceId,
        metadata: {
          principalId: context.principalId,
          expiresAt: new Date(createdAt.getTime() + DEFAULT_BROWSER_SESSION_TTL_MS).toISOString(),
        },
        createdAt: createdAt.toISOString(),
      },
    })
    return { session, secret: issued.secret }
  }

  revokeCurrent(context: RequestContext): BrowserSession {
    if (context.browserSessionId === undefined) {
      throw new AppError({ code: "NOT_FOUND", message: "Browser session not found" })
    }
    const at = this.now().toISOString()
    const session = this.store.revokeBrowserSessionWithAudit({
      ownerId: context.ownerId,
      id: context.browserSessionId,
      at,
      audit: {
        id: crypto.randomUUID(),
        ownerId: context.ownerId,
        actorApiKeyId: null,
        action: "browser_session.revoke",
        resourceType: "browser_session",
        resourceId: context.browserSessionId,
        requestId: context.requestId,
        traceId: context.traceId,
        metadata: { principalId: context.principalId },
        createdAt: at,
      },
    })
    if (session === null) {
      throw new AppError({ code: "NOT_FOUND", message: "Browser session not found" })
    }
    return session
  }
}
