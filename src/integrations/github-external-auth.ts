import { z } from "zod"
import type {
  ExternalAuthCredentialMaterial,
  ExternalAuthExchangeResult,
  ExternalAuthProviderAdapter,
} from "./external-auth"
import { ExternalAuthProviderError } from "./external-auth"
import { GitHubProjectDirectory } from "./github-project-directory"
import type { RepositoryProjectDirectory } from "./repository-directory"

const GitHubTokenSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().min(1),
    expires_in: z.number().int().positive(),
    refresh_token: z.string().min(1),
    refresh_token_expires_in: z.number().int().positive(),
  })
  .passthrough()

const GitHubProfileSchema = z
  .object({
    id: z.union([z.number().int().nonnegative(), z.string().min(1)]),
    login: z.string().min(1),
    name: z.string().min(1).nullable().optional(),
    avatar_url: z.string().url().nullable().optional(),
  })
  .passthrough()

type ExternalFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface GitHubExternalAuthOptions {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
  readonly fetch?: ExternalFetch
  readonly authorizationOrigin?: string
  readonly apiOrigin?: string
  readonly directory?: RepositoryProjectDirectory
  readonly now?: () => Date
}

export class GitHubExternalAuth implements ExternalAuthProviderAdapter {
  readonly provider = "github" as const
  readonly #clientId: string
  readonly #clientSecret: string
  readonly #redirectUri: string
  readonly #fetch: ExternalFetch
  readonly #authorizationOrigin: URL
  readonly #apiOrigin: URL
  readonly #directory: RepositoryProjectDirectory
  readonly #now: () => Date

  constructor(options: GitHubExternalAuthOptions) {
    this.#clientId = required(options.clientId, "GitHub client ID")
    this.#clientSecret = required(options.clientSecret, "GitHub client secret")
    this.#redirectUri = exactHttpsOrLoopback(options.redirectUri, "GitHub callback URL")
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#authorizationOrigin = new URL(options.authorizationOrigin ?? "https://github.com/")
    this.#apiOrigin = new URL(options.apiOrigin ?? "https://api.github.com/")
    this.#directory =
      options.directory ??
      new GitHubProjectDirectory({ fetch: this.#fetch, apiOrigin: this.#apiOrigin.href })
    this.#now = options.now ?? (() => new Date())
  }

  authorizationUrl(input: {
    readonly state: string
    readonly codeChallenge: string
    readonly nonce: string
  }): URL {
    const url = new URL("login/oauth/authorize", this.#authorizationOrigin)
    url.searchParams.set("client_id", this.#clientId)
    url.searchParams.set("redirect_uri", this.#redirectUri)
    url.searchParams.set("state", input.state)
    url.searchParams.set("code_challenge", input.codeChallenge)
    url.searchParams.set("code_challenge_method", "S256")
    url.searchParams.set("prompt", "select_account")
    return url
  }

  async exchange(input: {
    readonly code: string
    readonly codeVerifier: string
    readonly nonce: string
    readonly signal?: AbortSignal
  }): Promise<ExternalAuthExchangeResult> {
    const credential = await this.#token(
      {
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        code: required(input.code, "GitHub authorization code"),
        redirect_uri: this.#redirectUri,
        code_verifier: required(input.codeVerifier, "GitHub PKCE verifier"),
      },
      "exchange",
      input.signal,
    )
    const profile = await this.#profile(credential.accessToken, input.signal)
    const repositories = await this.#directory.list(
      { bearerToken: credential.accessToken },
      input.signal === undefined ? {} : { signal: input.signal },
    )
    return {
      identity: {
        subjectId: String(profile.id),
        login: profile.login,
        displayName: profile.name ?? profile.login,
        avatarUrl: profile.avatar_url ?? null,
      },
      credential,
      repositories,
    }
  }

  async refresh(input: {
    readonly refreshToken: string
    readonly signal?: AbortSignal
  }): Promise<ExternalAuthCredentialMaterial> {
    return this.#token(
      {
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        grant_type: "refresh_token",
        refresh_token: required(input.refreshToken, "GitHub refresh token"),
      },
      "refresh",
      input.signal,
    )
  }

  async repositories(input: {
    readonly accessToken: string
    readonly signal?: AbortSignal
  }): Promise<Awaited<ReturnType<RepositoryProjectDirectory["list"]>>> {
    return this.#directory.list(
      { bearerToken: required(input.accessToken, "GitHub access token") },
      input.signal === undefined ? {} : { signal: input.signal },
    )
  }

  async #token(
    fields: Readonly<Record<string, string>>,
    operation: string,
    signal?: AbortSignal,
  ): Promise<ExternalAuthCredentialMaterial> {
    const response = await this.#request(
      new URL("login/oauth/access_token", this.#authorizationOrigin),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(fields),
        ...(signal === undefined ? {} : { signal }),
      },
      operation,
    )
    const parsed = GitHubTokenSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer") {
      throw invalidResponse(operation)
    }
    const now = this.#now().getTime()
    return {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      accessExpiresAt: new Date(now + parsed.data.expires_in * 1_000).toISOString(),
      refreshExpiresAt: new Date(now + parsed.data.refresh_token_expires_in * 1_000).toISOString(),
    }
  }

  async #profile(
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<z.output<typeof GitHubProfileSchema>> {
    const response = await this.#request(
      new URL("user", this.#apiOrigin),
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${accessToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        ...(signal === undefined ? {} : { signal }),
      },
      "profile",
    )
    const profile = GitHubProfileSchema.safeParse(await response.json().catch(() => null))
    if (!profile.success) throw invalidResponse("profile")
    return profile.data
  }

  async #request(url: URL, init: RequestInit, operation: string): Promise<Response> {
    let response: Response
    try {
      response = await this.#fetch(url, init)
    } catch (error) {
      if (init.signal?.aborted) throw error
      throw new ExternalAuthProviderError({
        provider: this.provider,
        operation,
        retryable: true,
        message: "GitHub authentication is temporarily unavailable",
      })
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new ExternalAuthProviderError({
        provider: this.provider,
        operation,
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
        authorizationRejected: [400, 401, 403].includes(response.status),
        message: [400, 401, 403].includes(response.status)
          ? "GitHub authorization was rejected"
          : "GitHub authentication is temporarily unavailable",
      })
    }
    return response
  }
}

const invalidResponse = (operation: string): ExternalAuthProviderError =>
  new ExternalAuthProviderError({
    provider: "github",
    operation,
    retryable: true,
    message: "GitHub returned an invalid authentication response",
  })

const required = (value: string, name: string): string => {
  if (value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}

const exactHttpsOrLoopback = (value: string, name: string): string => {
  const url = new URL(value)
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(`${name} must be an exact HTTPS or loopback callback URL`)
  }
  return url.href
}
