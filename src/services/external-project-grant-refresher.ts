import type {
  AuditRecord,
  ExternalIdentity,
  ExternalProjectGrant,
  IdentityCredential,
  JsonObject,
  RequestContext,
} from "../domain"
import type { SealedCredentialVault } from "../integrations/credential-vault"
import {
  type ExternalAuthCredentialMaterial,
  type ExternalAuthProviderAdapter,
  ExternalAuthProviderError,
} from "../integrations/external-auth"
import {
  openGitHubIdentityCredential,
  sealGitHubIdentityCredential,
} from "../integrations/identity-credential"
import { RepositoryDirectoryError } from "../integrations/repository-directory"
import type { Store } from "../persistence/store"

const REPOSITORY_GRANT_TTL_MS = 10 * 60 * 1_000
const ACCESS_EXPIRY_SKEW_MS = 60 * 1_000
const PROVIDER_RETRY_DELAY_MS = 30 * 1_000

export type GitHubRepositoryConnectionStatus =
  | "not_linked"
  | "connected"
  | "reconnect_required"
  | "unavailable"

export interface GitHubRepositoryConnection {
  readonly provider: "github"
  readonly status: GitHubRepositoryConnectionStatus
  readonly lastVerifiedAt: string | null
}

interface ExternalProjectGrantRefreshStore
  extends Pick<
    Store,
    | "getActiveIdentityCredential"
    | "listExternalIdentities"
    | "refreshExternalProjectGrantsWithAudit"
    | "syncPrincipalGitHubProfileWithAudit"
    | "revokeGitHubAuthorizationWithAudit"
    | "rotateIdentityCredentialWithAudit"
  > {}

interface RefreshFailure {
  readonly retryAt: number
}

/**
 * Keeps provider-derived Project authority current without turning an internal
 * grant TTL into a user-facing OAuth ceremony. The repository directory is a
 * cache of GitHub's current answer; the encrypted identity credential is the
 * durable authorization that can refresh that answer.
 */
export class GitHubExternalProjectGrantRefresher {
  readonly #gates = new Map<string, Promise<void>>()
  readonly #failures = new Map<string, RefreshFailure>()

  constructor(
    private readonly store: ExternalProjectGrantRefreshStore,
    private readonly vault: SealedCredentialVault,
    private readonly provider: ExternalAuthProviderAdapter,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = () => crypto.randomUUID(),
  ) {
    if (
      provider.provider !== "github" ||
      provider.repositories === undefined ||
      provider.refresh === undefined
    ) {
      throw new Error("GitHub grant refresh requires repository and token refresh capabilities")
    }
  }

  async refresh(
    context: RequestContext,
    signal?: AbortSignal,
    force = false,
  ): Promise<GitHubRepositoryConnection> {
    const identities = this.store
      .listExternalIdentities(context.ownerId, context.principalId)
      .filter((identity) => identity.provider === "github" && identity.revokedAt === null)
    if (identities.length === 0) {
      return { provider: "github", status: "not_linked", lastVerifiedAt: null }
    }
    const outcomes = await Promise.all(
      identities.map((identity) =>
        this.#withGate(`${identity.ownerId}:${identity.id}`, () => {
          const current = this.store
            .listExternalIdentities(identity.ownerId, identity.principalId)
            .find((candidate) => candidate.id === identity.id && candidate.revokedAt === null)
          return current === undefined
            ? Promise.resolve({
                provider: "github" as const,
                status: "not_linked" as const,
                lastVerifiedAt: null,
              })
            : this.#refreshIdentity(context, current, signal, force)
        }),
      ),
    )
    const status = outcomes.some((outcome) => outcome.status === "unavailable")
      ? "unavailable"
      : outcomes.some((outcome) => outcome.status === "reconnect_required")
        ? "reconnect_required"
        : outcomes.every((outcome) => outcome.status === "not_linked")
          ? "not_linked"
          : "connected"
    const verified =
      outcomes
        .map((outcome) => outcome.lastVerifiedAt)
        .filter((value): value is string => value !== null)
        .sort()
        .at(-1) ?? null
    return { provider: "github", status, lastVerifiedAt: verified }
  }

  async #refreshIdentity(
    context: RequestContext,
    identity: ExternalIdentity,
    signal?: AbortSignal,
    force = false,
  ): Promise<GitHubRepositoryConnection> {
    const now = this.now()
    this.store.syncPrincipalGitHubProfileWithAudit({
      ownerId: identity.ownerId,
      principalId: identity.principalId,
      externalIdentityId: identity.id,
      at: now.toISOString(),
      audit: this.#audit(
        context,
        "principal.github_profile.sync",
        "principal",
        identity.principalId,
        now.toISOString(),
        { provider: "github", externalIdentityId: identity.id },
      ),
    })
    const credential = this.store.getActiveIdentityCredential(identity.ownerId, identity.id)
    if (credential === null) {
      return {
        provider: "github",
        status: "reconnect_required",
        lastVerifiedAt: identity.lastVerifiedAt,
      }
    }
    const verifiedAt = Date.parse(identity.lastVerifiedAt)
    const accessExpiresAt =
      credential.accessExpiresAt === null ? null : Date.parse(credential.accessExpiresAt)
    const accessIsCurrent =
      accessExpiresAt === null || accessExpiresAt > now.getTime() + ACCESS_EXPIRY_SKEW_MS
    if (
      !force &&
      Number.isFinite(verifiedAt) &&
      verifiedAt + REPOSITORY_GRANT_TTL_MS > now.getTime() &&
      accessIsCurrent
    ) {
      this.#failures.delete(identity.id)
      return {
        provider: "github",
        status: "connected",
        lastVerifiedAt: identity.lastVerifiedAt,
      }
    }
    const failed = this.#failures.get(identity.id)
    if (!force && failed !== undefined && failed.retryAt > now.getTime()) {
      return {
        provider: "github",
        status: "unavailable",
        lastVerifiedAt: identity.lastVerifiedAt,
      }
    }

    try {
      const validCredential = accessIsCurrent
        ? credential
        : await this.#refreshCredential(context, identity, credential, now, signal)
      if (validCredential === null) {
        return {
          provider: "github",
          status: "reconnect_required",
          lastVerifiedAt: identity.lastVerifiedAt,
        }
      }
      const opened = await openGitHubIdentityCredential({
        vault: this.vault,
        credential: validCredential,
      })
      const entries = await (
        this.provider.repositories as NonNullable<ExternalAuthProviderAdapter["repositories"]>
      )({
        accessToken: opened.accessToken,
        ...(signal === undefined ? {} : { signal }),
      })
      if (entries.some((entry) => entry.provider !== "github")) {
        throw new ExternalAuthProviderError({
          provider: "github",
          operation: "repositories",
          retryable: true,
          message: "GitHub returned an invalid repository directory",
        })
      }
      const at = now.toISOString()
      const grantExpiresAt = new Date(
        Math.min(
          now.getTime() + REPOSITORY_GRANT_TTL_MS,
          validCredential.accessExpiresAt === null
            ? now.getTime() + REPOSITORY_GRANT_TTL_MS
            : Date.parse(validCredential.accessExpiresAt),
        ),
      ).toISOString()
      const grants = entries.map(
        (entry): ExternalProjectGrant => ({
          id: this.id(),
          ownerId: identity.ownerId,
          principalId: identity.principalId,
          externalIdentityId: identity.id,
          provider: "github",
          accountId: entry.account.id,
          accountName: entry.account.login,
          repositoryId: entry.repository.id,
          repositoryName: entry.repository.name,
          repositoryFullName: entry.repository.fullName,
          repositoryUrl: entry.repository.webUrl,
          private: entry.repository.private,
          access: entry.access,
          observedAt: at,
          expiresAt: grantExpiresAt,
          revokedAt: null,
        }),
      )
      this.store.refreshExternalProjectGrantsWithAudit({
        identity: { ...identity, lastVerifiedAt: at },
        grants,
        at,
        audit: this.#audit(
          context,
          "external_project_grants.refresh",
          "external_identity",
          identity.id,
          at,
          { provider: "github", repositoryCount: grants.length, expiresAt: grantExpiresAt },
        ),
      })
      this.#failures.delete(identity.id)
      return { provider: "github", status: "connected", lastVerifiedAt: at }
    } catch (error) {
      if (authorizationRejected(error)) {
        const at = now.toISOString()
        this.#revoke(context, identity, at, "provider_rejected")
        this.#failures.delete(identity.id)
        return {
          provider: "github",
          status: "reconnect_required",
          lastVerifiedAt: identity.lastVerifiedAt,
        }
      }
      if (!providerUnavailable(error)) throw error
      this.#failures.set(identity.id, { retryAt: now.getTime() + PROVIDER_RETRY_DELAY_MS })
      return {
        provider: "github",
        status: "unavailable",
        lastVerifiedAt: identity.lastVerifiedAt,
      }
    }
  }

  async #refreshCredential(
    context: RequestContext,
    identity: ExternalIdentity,
    credential: IdentityCredential,
    now: Date,
    signal?: AbortSignal,
  ): Promise<IdentityCredential | null> {
    const opened = await openGitHubIdentityCredential({ vault: this.vault, credential })
    const refreshExpiresAt =
      credential.refreshExpiresAt === null ? null : Date.parse(credential.refreshExpiresAt)
    if (
      opened.refreshToken === null ||
      (refreshExpiresAt !== null && refreshExpiresAt <= now.getTime() + ACCESS_EXPIRY_SKEW_MS)
    ) {
      this.#revoke(context, identity, now.toISOString(), "credential_expired")
      return null
    }
    const material = await (
      this.provider.refresh as NonNullable<ExternalAuthProviderAdapter["refresh"]>
    )({
      refreshToken: opened.refreshToken,
      ...(signal === undefined ? {} : { signal }),
    })
    return this.#rotateCredential(context, identity, material, now.toISOString())
  }

  async #rotateCredential(
    context: RequestContext,
    identity: ExternalIdentity,
    material: ExternalAuthCredentialMaterial,
    at: string,
  ): Promise<IdentityCredential> {
    const credential: IdentityCredential = {
      id: this.id(),
      ownerId: identity.ownerId,
      principalId: identity.principalId,
      externalIdentityId: identity.id,
      provider: "github",
      sealedPayload: await sealGitHubIdentityCredential({
        vault: this.vault,
        ownerId: identity.ownerId,
        externalIdentityId: identity.id,
        material,
      }),
      keyVersion: this.vault.keyVersion,
      accessExpiresAt: material.accessExpiresAt,
      refreshExpiresAt: material.refreshExpiresAt,
      createdAt: at,
      updatedAt: at,
      revokedAt: null,
    }
    return this.store.rotateIdentityCredentialWithAudit({
      credential,
      at,
      audit: this.#audit(
        context,
        "identity_credential.refresh",
        "identity_credential",
        credential.id,
        at,
        {
          provider: "github",
          externalIdentityId: identity.id,
          accessExpiresAt: credential.accessExpiresAt,
        },
      ),
    })
  }

  #revoke(context: RequestContext, identity: ExternalIdentity, at: string, reason: string): void {
    this.store.revokeGitHubAuthorizationWithAudit({
      ownerId: identity.ownerId,
      principalId: identity.principalId,
      externalIdentityId: identity.id,
      at,
      audit: this.#audit(
        context,
        "github_authorization.revoke",
        "external_identity",
        identity.id,
        at,
        { provider: "github", reason },
      ),
    })
  }

  #audit(
    context: RequestContext,
    action: string,
    resourceType: AuditRecord["resourceType"],
    resourceId: string,
    createdAt: string,
    metadata: JsonObject,
  ): AuditRecord {
    return {
      id: this.id(),
      ownerId: context.ownerId,
      actorApiKeyId: context.apiKeyId,
      action,
      resourceType,
      resourceId,
      requestId: context.requestId,
      traceId: context.traceId,
      metadata,
      createdAt,
    }
  }

  async #withGate<Result>(scope: string, operation: () => Promise<Result>): Promise<Result> {
    const predecessor = this.#gates.get(scope) ?? Promise.resolve()
    let release: () => void = () => undefined
    const claim = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = predecessor.then(() => claim)
    this.#gates.set(scope, tail)
    await predecessor
    try {
      return await operation()
    } finally {
      release()
      if (this.#gates.get(scope) === tail) this.#gates.delete(scope)
    }
  }
}

const authorizationRejected = (error: unknown): boolean =>
  (error instanceof ExternalAuthProviderError && error.authorizationRejected) ||
  (error instanceof RepositoryDirectoryError && [401, 403].includes(error.status ?? 0))

const providerUnavailable = (error: unknown): boolean =>
  error instanceof ExternalAuthProviderError || error instanceof RepositoryDirectoryError
