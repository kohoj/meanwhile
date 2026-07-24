import { authenticatePrincipalInvitation, issueBrowserSession } from "../auth"
import type {
  AuditRecord,
  BrowserSession,
  ExternalIdentity,
  ExternalIdentityProvider,
  ExternalProjectGrant,
  IdentityCredential,
  JsonObject,
  Principal,
  RequestContext,
} from "../domain"
import { AppError } from "../errors"
import type { SealedCredentialVault } from "../integrations/credential-vault"
import {
  createPkce,
  type ExternalAuthIntent,
  type ExternalAuthProviderAdapter,
  ExternalAuthProviderError,
  type ExternalAuthStateCodec,
} from "../integrations/external-auth"
import { sealGitHubIdentityCredential } from "../integrations/identity-credential"
import type {
  CompletedExternalAuthentication,
  CompleteExternalAuthenticationInput,
  Store,
} from "../persistence/store"

const AUTH_TRANSACTION_TTL_MS = 5 * 60 * 1_000
const AUTH_TRANSACTION_CLOCK_SKEW_MS = 60 * 1_000
const REPOSITORY_GRANT_TTL_MS = 10 * 60 * 1_000
const BROWSER_SESSION_TTL_MS = 12 * 60 * 60 * 1_000

export interface ConfiguredExternalAuthProvider {
  readonly adapter: ExternalAuthProviderAdapter
  readonly redirectUri: string
  readonly label: string
}

export type ExternalRegistrationPolicy = "closed" | "open"

export interface ExternalAuthRequestFacts {
  readonly requestId: string
  readonly traceId: string | null
}

interface ExternalAuthStore
  extends Pick<
    Store,
    | "completeExternalAuthentication"
    | "findPrincipalInvitationsByPrefix"
    | "getExternalIdentityBySubject"
    | "getPrincipal"
  > {}

export class ExternalAuthService {
  readonly #providers: ReadonlyMap<ExternalIdentityProvider, ConfiguredExternalAuthProvider>

  constructor(
    private readonly ownerId: string,
    providers: readonly ConfiguredExternalAuthProvider[],
    private readonly state: ExternalAuthStateCodec,
    private readonly vault: SealedCredentialVault,
    private readonly store: ExternalAuthStore,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = () => crypto.randomUUID(),
    private readonly registration: ExternalRegistrationPolicy = "closed",
  ) {
    this.#providers = new Map(
      providers.map((provider) => [provider.adapter.provider, provider] as const),
    )
    if (this.#providers.size !== providers.length) {
      throw new Error("External auth providers must be unique")
    }
  }

  providers(): readonly { readonly provider: ExternalIdentityProvider; readonly label: string }[] {
    return [...this.#providers.values()]
      .map(({ adapter, label }) => ({ provider: adapter.provider, label }))
      .sort((left, right) => left.provider.localeCompare(right.provider))
  }

  registrationPolicy(): ExternalRegistrationPolicy {
    return this.registration
  }

  async startLogin(
    provider: ExternalIdentityProvider,
  ): Promise<{ readonly authorizationUrl: string }> {
    return this.#start(provider, "login", null, null)
  }

  async startLink(
    provider: ExternalIdentityProvider,
    context: RequestContext,
  ): Promise<{ readonly authorizationUrl: string }> {
    if (context.ownerId !== this.ownerId) {
      throw new AppError({ code: "NOT_FOUND", message: "Authentication provider not found" })
    }
    const principal = this.store.getPrincipal(context.ownerId, context.principalId)
    if (principal === null || principal.disabledAt !== null) {
      throw new AppError({
        code: "UNAUTHENTICATED",
        status: 401,
        message: "Authentication required",
      })
    }
    return this.#start(provider, "link", principal.id, null)
  }

  async startInvitation(
    provider: ExternalIdentityProvider,
    secret: string,
  ): Promise<{ readonly authorizationUrl: string }> {
    const invitation = await authenticatePrincipalInvitation(secret, this.store, this.now())
    if (invitation === null || invitation.ownerId !== this.ownerId) {
      throw new AppError({
        code: "PRINCIPAL_INVITATION_INVALID",
        status: 401,
        message: "Invitation is invalid or expired",
      })
    }
    return this.#start(provider, "invite", invitation.principalId, invitation.id)
  }

  async callback(input: {
    readonly provider: ExternalIdentityProvider
    readonly expectedIntent: ExternalAuthIntent
    readonly context?: RequestContext
    readonly state: string
    readonly code: string | null
    readonly providerError: string | null
    readonly request: ExternalAuthRequestFacts
    readonly signal?: AbortSignal
  }): Promise<
    CompletedExternalAuthentication & {
      readonly secret: string
      readonly intent: ExternalAuthIntent
    }
  > {
    const configured = this.#provider(input.provider)
    if (input.providerError !== null || input.code === null || input.code.length === 0) {
      throw new AppError({
        code: "EXTERNAL_AUTH_REJECTED",
        status: 401,
        message: "External authorization was rejected",
      })
    }
    const transaction = await this.state.open(input.provider, input.state).catch(() => {
      throw new AppError({
        code: "EXTERNAL_AUTH_TRANSACTION_INVALID",
        status: 400,
        message: "Authentication transaction is invalid or expired",
      })
    })
    const now = this.now()
    const nowMs = now.getTime()
    const issuedAt = Date.parse(transaction.issuedAt)
    const expiresAt = Date.parse(transaction.expiresAt)
    if (
      transaction.ownerId !== this.ownerId ||
      transaction.provider !== input.provider ||
      transaction.intent !== input.expectedIntent ||
      transaction.redirectUri !== configured.redirectUri ||
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      issuedAt > nowMs + AUTH_TRANSACTION_CLOCK_SKEW_MS ||
      expiresAt <= nowMs ||
      expiresAt - issuedAt > AUTH_TRANSACTION_TTL_MS
    ) {
      throw new AppError({
        code: "EXTERNAL_AUTH_TRANSACTION_INVALID",
        status: 400,
        message: "Authentication transaction is invalid or expired",
      })
    }
    if (
      transaction.intent === "link" &&
      (input.context === undefined ||
        input.context.ownerId !== transaction.ownerId ||
        input.context.principalId !== transaction.principalId)
    ) {
      throw new AppError({
        code: "EXTERNAL_AUTH_TRANSACTION_INVALID",
        status: 400,
        message: "Authentication transaction is invalid or expired",
      })
    }

    let exchanged: Awaited<ReturnType<ExternalAuthProviderAdapter["exchange"]>>
    try {
      exchanged = await configured.adapter.exchange({
        code: input.code,
        codeVerifier: transaction.codeVerifier,
        nonce: transaction.nonce,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    } catch (error) {
      throw normalizeProviderFailure(error)
    }

    const existing = this.store.getExternalIdentityBySubject(
      this.ownerId,
      input.provider,
      exchanged.identity.subjectId,
    )
    const at = now.toISOString()
    const registration =
      transaction.intent === "login"
        ? this.#loginPrincipal(existing, exchanged.identity, at)
        : { principalId: this.#linkPrincipal(transaction.principalId, existing), principal: null }
    const principalId = registration.principalId
    const invitationId = transaction.version === 2 ? transaction.invitationId : null
    const principal = registration.principal ?? this.store.getPrincipal(this.ownerId, principalId)
    if (principal === null || principal.disabledAt !== null) {
      throw new AppError({
        code: "EXTERNAL_IDENTITY_NOT_LINKED",
        status: 403,
        message: "This identity has not been invited to this Meanwhile installation",
      })
    }
    const identity: ExternalIdentity = {
      id: existing?.id ?? this.id(),
      ownerId: this.ownerId,
      principalId,
      provider: input.provider,
      subjectId: exchanged.identity.subjectId,
      login: exchanged.identity.login,
      displayName: exchanged.identity.displayName,
      avatarUrl: exchanged.identity.avatarUrl,
      createdAt: existing?.createdAt ?? at,
      lastVerifiedAt: at,
      revokedAt: null,
    }
    const credential = await this.#credential(identity, exchanged.credential, at)
    const grantExpiresAt = new Date(
      Math.min(
        nowMs + REPOSITORY_GRANT_TTL_MS,
        exchanged.credential === null
          ? nowMs + REPOSITORY_GRANT_TTL_MS
          : Date.parse(exchanged.credential.accessExpiresAt),
      ),
    ).toISOString()
    const grants = exchanged.repositories.map((entry): ExternalProjectGrant => {
      if (input.provider !== "github" || entry.provider !== "github") {
        throw new AppError({
          code: "EXTERNAL_AUTH_RESPONSE_INVALID",
          status: 502,
          message: "External authorization returned an invalid repository directory",
        })
      }
      return {
        id: this.id(),
        ownerId: this.ownerId,
        principalId,
        externalIdentityId: identity.id,
        provider: "github",
        accountId: entry.account.id,
        accountName: entry.account.login,
        installationId: entry.installationId,
        repositoryId: entry.repository.id,
        repositoryName: entry.repository.name,
        repositoryFullName: entry.repository.fullName,
        repositoryUrl: entry.repository.webUrl,
        private: entry.repository.private,
        access: entry.access,
        observedAt: at,
        expiresAt: grantExpiresAt,
        revokedAt: null,
      }
    })
    const issued = await issueBrowserSession()
    const session: BrowserSession & { readonly prefix: string; readonly hash: string } = {
      id: this.id(),
      ownerId: this.ownerId,
      principalId,
      prefix: issued.prefix,
      hash: issued.hash,
      createdAt: at,
      expiresAt: new Date(nowMs + BROWSER_SESSION_TTL_MS).toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    }
    const completion: CompleteExternalAuthenticationInput = {
      principal: registration.principal,
      identity,
      credential,
      grants,
      session,
      invitationId,
      at,
      audits: {
        principal:
          registration.principal === null
            ? null
            : this.#audit(
                input.request,
                "principal.external_register",
                "principal",
                registration.principal.id,
                at,
                { provider: input.provider },
              ),
        identity: this.#audit(
          input.request,
          existing === null ? "external_identity.link" : "external_identity.verify",
          "external_identity",
          identity.id,
          at,
          { provider: input.provider, intent: transaction.intent, principalId },
        ),
        credential:
          credential === null
            ? null
            : this.#audit(
                input.request,
                "identity_credential.rotate",
                "identity_credential",
                credential.id,
                at,
                {
                  provider: input.provider,
                  externalIdentityId: identity.id,
                  keyVersion: credential.keyVersion,
                  accessExpiresAt: credential.accessExpiresAt,
                },
              ),
        grants: grants.map((grant) =>
          this.#audit(
            input.request,
            "external_project_grant.observe",
            "external_project_grant",
            grant.id,
            at,
            {
              provider: grant.provider,
              repositoryId: grant.repositoryId,
              access: grant.access,
              expiresAt: grant.expiresAt,
            },
          ),
        ),
        session: this.#audit(
          input.request,
          "browser_session.create",
          "browser_session",
          session.id,
          at,
          { principalId, provider: input.provider, expiresAt: session.expiresAt },
        ),
        invitation:
          invitationId === null
            ? null
            : this.#audit(
                input.request,
                "principal_invitation.redeem",
                "principal_invitation",
                invitationId,
                at,
                { principalId, provider: input.provider },
              ),
      },
    }
    return {
      ...this.store.completeExternalAuthentication(completion),
      secret: issued.secret,
      intent: transaction.intent,
    }
  }

  async #start(
    provider: ExternalIdentityProvider,
    intent: ExternalAuthIntent,
    principalId: string | null,
    invitationId: string | null,
  ): Promise<{ readonly authorizationUrl: string }> {
    const configured = this.#provider(provider)
    const pkce = await createPkce()
    const issuedAt = this.now()
    const state = await this.state.seal({
      version: 2,
      provider,
      ownerId: this.ownerId,
      intent,
      principalId,
      invitationId,
      redirectUri: configured.redirectUri,
      codeVerifier: pkce.codeVerifier,
      nonce: pkce.nonce,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + AUTH_TRANSACTION_TTL_MS).toISOString(),
    })
    return {
      authorizationUrl: configured.adapter.authorizationUrl({
        state,
        codeChallenge: pkce.codeChallenge,
        nonce: pkce.nonce,
      }).href,
    }
  }

  #provider(provider: ExternalIdentityProvider): ConfiguredExternalAuthProvider {
    const configured = this.#providers.get(provider)
    if (configured === undefined) {
      throw new AppError({ code: "NOT_FOUND", message: "Authentication provider not found" })
    }
    return configured
  }

  #loginPrincipal(
    existing: ExternalIdentity | null,
    profile: {
      readonly login: string | null
      readonly displayName: string | null
    },
    at: string,
  ): { readonly principalId: string; readonly principal: Principal | null } {
    if (existing === null || existing.revokedAt !== null) {
      if (this.registration === "open" && existing === null) {
        const principalId = this.id()
        const displayName = externalDisplayName(profile)
        return {
          principalId,
          principal: {
            id: principalId,
            ownerId: this.ownerId,
            kind: "person",
            displayName,
            ownerRole: "member",
            createdAt: at,
            disabledAt: null,
          },
        }
      }
      throw new AppError({
        code: "EXTERNAL_IDENTITY_NOT_LINKED",
        status: 403,
        message: "This identity has not been invited to this Meanwhile installation",
      })
    }
    return { principalId: existing.principalId, principal: null }
  }

  #linkPrincipal(principalId: string | null, existing: ExternalIdentity | null): string {
    if (principalId === null) {
      throw new AppError({
        code: "EXTERNAL_AUTH_TRANSACTION_INVALID",
        status: 400,
        message: "Authentication transaction is invalid or expired",
      })
    }
    if (existing !== null && existing.principalId !== principalId) {
      throw new AppError({
        code: "EXTERNAL_IDENTITY_CONFLICT",
        status: 409,
        message: "External identity is already linked",
      })
    }
    return principalId
  }

  async #credential(
    identity: ExternalIdentity,
    material: Awaited<ReturnType<ExternalAuthProviderAdapter["exchange"]>>["credential"],
    at: string,
  ): Promise<IdentityCredential | null> {
    if (identity.provider === "google") {
      if (material !== null) {
        throw new AppError({
          code: "EXTERNAL_AUTH_RESPONSE_INVALID",
          status: 502,
          message: "External authorization returned unexpected credential material",
        })
      }
      return null
    }
    if (material === null || material.refreshToken === null) {
      throw new AppError({
        code: "EXTERNAL_AUTH_RESPONSE_INVALID",
        status: 502,
        message: "External authorization returned incomplete credential material",
      })
    }
    const sealedPayload = await sealGitHubIdentityCredential({
      vault: this.vault,
      ownerId: identity.ownerId,
      externalIdentityId: identity.id,
      material,
    })
    return {
      id: this.id(),
      ownerId: identity.ownerId,
      principalId: identity.principalId,
      externalIdentityId: identity.id,
      provider: "github",
      sealedPayload,
      keyVersion: this.vault.keyVersion,
      accessExpiresAt: material.accessExpiresAt,
      refreshExpiresAt: material.refreshExpiresAt,
      createdAt: at,
      updatedAt: at,
      revokedAt: null,
    }
  }

  #audit(
    request: ExternalAuthRequestFacts,
    action: string,
    resourceType: AuditRecord["resourceType"],
    resourceId: string,
    createdAt: string,
    metadata: JsonObject,
  ): AuditRecord {
    return {
      id: this.id(),
      ownerId: this.ownerId,
      actorApiKeyId: null,
      action,
      resourceType,
      resourceId,
      requestId: request.requestId,
      traceId: request.traceId,
      metadata,
      createdAt,
    }
  }
}

const externalDisplayName = (profile: {
  readonly login: string | null
  readonly displayName: string | null
}): string => {
  const candidate = (profile.displayName ?? profile.login ?? "Member").trim().replace(/\s+/g, " ")
  return candidate.slice(0, 120) || "Member"
}

const normalizeProviderFailure = (error: unknown): AppError => {
  if (!(error instanceof ExternalAuthProviderError)) {
    return new AppError({
      code: "EXTERNAL_AUTH_PROVIDER_UNAVAILABLE",
      status: 503,
      retryable: true,
      message: "External authentication is temporarily unavailable",
      cause: error,
    })
  }
  return new AppError({
    code: error.authorizationRejected
      ? "EXTERNAL_AUTH_REJECTED"
      : "EXTERNAL_AUTH_PROVIDER_UNAVAILABLE",
    status: error.authorizationRejected ? 401 : 503,
    retryable: error.retryable,
    message: error.authorizationRejected
      ? "External authorization was rejected"
      : "External authentication is temporarily unavailable",
    details: { provider: error.provider, operation: error.operation },
    cause: error,
  })
}
