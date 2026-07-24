import type { AuditRecord, ExternalProjectGrant, JsonObject } from "../domain"
import { AppError } from "../errors"
import type { SealedCredentialVault } from "../integrations/credential-vault"
import type { ExternalAuthProviderAdapter } from "../integrations/external-auth"
import { ExternalAuthProviderError } from "../integrations/external-auth"
import { openGitHubIdentityCredential } from "../integrations/identity-credential"
import { RepositoryDirectoryError } from "../integrations/repository-directory"
import type { Store } from "../persistence/store"
import { type ResolvedSecretMaterial, SecretRedactor } from "../secrets"

const REPOSITORY_GRANT_TTL_MS = 10 * 60 * 1_000
const ACCESS_EXPIRY_SKEW_MS = 60 * 1_000

export interface RepositoryCredentialResolutionInput {
  readonly ownerId: string
  readonly principalId: string
  readonly projectId: string
  readonly repositoryUrl: string
  readonly resourceType: "run" | "session"
  readonly resourceId: string
  readonly signal?: AbortSignal
}

export interface RepositoryCredentialResolver {
  resolve(input: RepositoryCredentialResolutionInput): Promise<ResolvedSecretMaterial | null>
}

interface RepositoryCredentialStore
  extends Pick<
    Store,
    | "getProjectRepositoryCheckoutAuthority"
    | "revokeExternalProjectGrantWithAudit"
    | "upsertExternalProjectGrantWithAudit"
  > {}

/**
 * Revalidates a Project's exact GitHub binding at checkout time and exposes the
 * user-access token only to the short-lived git preparation process. The agent
 * runtime never receives it.
 */
export class GitHubRepositoryCredentialResolver implements RepositoryCredentialResolver {
  readonly #gates = new Map<string, Promise<void>>()

  constructor(
    private readonly store: RepositoryCredentialStore,
    private readonly vault: SealedCredentialVault,
    private readonly provider: ExternalAuthProviderAdapter,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = () => crypto.randomUUID(),
  ) {
    if (provider.provider !== "github" || provider.repositories === undefined) {
      throw new Error("GitHub repository credential resolver requires directory revalidation")
    }
  }

  async resolve(
    input: RepositoryCredentialResolutionInput,
  ): Promise<ResolvedSecretMaterial | null> {
    return this.#withGate(`${input.ownerId}:${input.projectId}`, () => this.#resolve(input))
  }

  async #resolve(
    input: RepositoryCredentialResolutionInput,
  ): Promise<ResolvedSecretMaterial | null> {
    const at = this.now()
    const authority = this.store.getProjectRepositoryCheckoutAuthority(
      input.ownerId,
      input.principalId,
      input.projectId,
      input.repositoryUrl,
      at.toISOString(),
    )
    if (authority === null) return null
    if (Date.parse(authority.credential.accessExpiresAt) <= at.getTime() + ACCESS_EXPIRY_SKEW_MS) {
      throw new AppError({
        code: "REPOSITORY_AUTHORIZATION_EXPIRED",
        status: 409,
        message: "GitHub authorization expired; link GitHub again before delegating work",
      })
    }
    const opened = await openGitHubIdentityCredential({
      vault: this.vault,
      credential: authority.credential,
    })
    let entries: Awaited<ReturnType<NonNullable<ExternalAuthProviderAdapter["repositories"]>>>
    try {
      entries = await (
        this.provider.repositories as NonNullable<ExternalAuthProviderAdapter["repositories"]>
      )({
        accessToken: opened.accessToken,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    } catch (error) {
      if (authorizationRejected(error)) {
        this.#revoke(input, authority.grant.id, at.toISOString(), "provider_rejected")
        throw new AppError({
          code: "REPOSITORY_AUTHORIZATION_REVOKED",
          status: 409,
          message: "GitHub repository authorization was revoked",
          cause: error,
        })
      }
      throw new AppError({
        code: "EXTERNAL_AUTH_PROVIDER_UNAVAILABLE",
        status: 503,
        retryable: true,
        message: "GitHub repository authorization is temporarily unavailable",
        cause: error,
      })
    }
    const entry = entries.find(
      (candidate) =>
        candidate.provider === "github" &&
        candidate.installationId === authority.binding.installationId &&
        candidate.repository.id === authority.binding.repositoryId,
    )
    if (entry === undefined) {
      this.#revoke(input, authority.grant.id, at.toISOString(), "repository_missing")
      throw new AppError({
        code: "REPOSITORY_AUTHORIZATION_REVOKED",
        status: 409,
        message: "GitHub repository authorization was revoked",
      })
    }
    const grant: ExternalProjectGrant = {
      ...authority.grant,
      accountId: entry.account.id,
      accountName: entry.account.login,
      installationId: entry.installationId,
      repositoryId: entry.repository.id,
      repositoryName: entry.repository.name,
      repositoryFullName: entry.repository.fullName,
      repositoryUrl: entry.repository.webUrl,
      private: entry.repository.private,
      access: entry.access,
      observedAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + REPOSITORY_GRANT_TTL_MS).toISOString(),
      revokedAt: null,
    }
    this.store.upsertExternalProjectGrantWithAudit({
      grant,
      audit: this.#audit(
        input,
        "external_project_grant.revalidate",
        "external_project_grant",
        grant.id,
        at.toISOString(),
        {
          repositoryId: grant.repositoryId,
          installationId: grant.installationId,
          access: grant.access,
          expiresAt: grant.expiresAt,
        },
      ),
    })

    const gitAuthorization = githubGitAuthorization(opened.accessToken)
    const environment: Record<string, string> = {
      MEANWHILE_REPOSITORY_CREDENTIAL: gitAuthorization,
    }
    const values = [
      opened.accessToken,
      opened.refreshToken,
      gitAuthorization,
      gitAuthorization.slice("Basic ".length),
    ]
    const redactor = new SecretRedactor(values)
    let released = false
    return {
      environment,
      redactor,
      release() {
        if (released) return
        released = true
        environment["MEANWHILE_REPOSITORY_CREDENTIAL"] = ""
        delete environment["MEANWHILE_REPOSITORY_CREDENTIAL"]
        values.fill("")
        redactor.dispose()
      },
    }
  }

  #revoke(
    input: RepositoryCredentialResolutionInput,
    grantId: string,
    at: string,
    reason: string,
  ): void {
    this.store.revokeExternalProjectGrantWithAudit({
      ownerId: input.ownerId,
      grantId,
      at,
      audit: this.#audit(
        input,
        "external_project_grant.revoke",
        "external_project_grant",
        grantId,
        at,
        { grantId, reason },
      ),
    })
  }

  #audit(
    input: RepositoryCredentialResolutionInput,
    action: string,
    resourceType: AuditRecord["resourceType"],
    resourceId: string,
    createdAt: string,
    metadata: JsonObject,
  ): AuditRecord {
    return {
      id: this.id(),
      ownerId: input.ownerId,
      actorApiKeyId: null,
      action,
      resourceType,
      resourceId,
      requestId: `repository-checkout:${input.resourceId}`,
      traceId: null,
      metadata: {
        ...metadata,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
      },
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
  (error instanceof RepositoryDirectoryError && [401, 403, 404].includes(error.status ?? 0))

const githubGitAuthorization = (accessToken: string): string => {
  const bytes = new TextEncoder().encode(`x-access-token:${accessToken}`)
  try {
    return `Basic ${bytes.toBase64()}`
  } finally {
    bytes.fill(0)
  }
}
