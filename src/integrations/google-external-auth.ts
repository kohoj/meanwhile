import { z } from "zod"
import type { ExternalAuthExchangeResult, ExternalAuthProviderAdapter } from "./external-auth"
import { ExternalAuthProviderError } from "./external-auth"

const GoogleTokenSchema = z
  .object({
    id_token: z.string().min(1),
    token_type: z.string().min(1),
  })
  .passthrough()

const JwtHeaderSchema = z
  .object({
    alg: z.literal("RS256"),
    kid: z.string().min(1),
  })
  .passthrough()

const GoogleClaimsSchema = z
  .object({
    iss: z.enum(["https://accounts.google.com", "accounts.google.com"]),
    aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    azp: z.string().min(1).optional(),
    sub: z.string().min(1).max(255),
    exp: z.number().int().positive(),
    iat: z.number().int().positive(),
    nonce: z.string().min(1),
    email: z.string().email().optional(),
    email_verified: z.boolean().optional(),
    name: z.string().min(1).max(255).optional(),
    picture: z.string().url().optional(),
  })
  .passthrough()

const JwkSchema = z
  .object({
    kty: z.literal("RSA"),
    kid: z.string().min(1),
    n: z.string().min(1),
    e: z.string().min(1),
    alg: z.literal("RS256").optional(),
    use: z.literal("sig").optional(),
  })
  .passthrough()

const JwksSchema = z.object({ keys: z.array(JwkSchema).min(1) }).passthrough()

type ExternalFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type GoogleClaims = z.output<typeof GoogleClaimsSchema>

export interface GoogleIdTokenVerifier {
  verify(input: {
    readonly idToken: string
    readonly audience: string
    readonly nonce: string
    readonly signal?: AbortSignal
  }): Promise<GoogleClaims>
}

export interface GoogleExternalAuthOptions {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
  readonly fetch?: ExternalFetch
  readonly authorizationEndpoint?: string
  readonly tokenEndpoint?: string
  readonly verifier?: GoogleIdTokenVerifier
  readonly now?: () => Date
}

export class GoogleExternalAuth implements ExternalAuthProviderAdapter {
  readonly provider = "google" as const
  readonly #clientId: string
  readonly #clientSecret: string
  readonly #redirectUri: string
  readonly #fetch: ExternalFetch
  readonly #authorizationEndpoint: URL
  readonly #tokenEndpoint: URL
  readonly #verifier: GoogleIdTokenVerifier

  constructor(options: GoogleExternalAuthOptions) {
    this.#clientId = required(options.clientId, "Google client ID")
    this.#clientSecret = required(options.clientSecret, "Google client secret")
    this.#redirectUri = exactHttpsOrLoopback(options.redirectUri, "Google callback URL")
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#authorizationEndpoint = new URL(
      options.authorizationEndpoint ?? "https://accounts.google.com/o/oauth2/v2/auth",
    )
    this.#tokenEndpoint = new URL(options.tokenEndpoint ?? "https://oauth2.googleapis.com/token")
    this.#verifier =
      options.verifier ??
      new GoogleJwksIdTokenVerifier({
        fetch: this.#fetch,
        ...(options.now === undefined ? {} : { now: options.now }),
      })
  }

  authorizationUrl(input: {
    readonly state: string
    readonly codeChallenge: string
    readonly nonce: string
  }): URL {
    const url = new URL(this.#authorizationEndpoint)
    url.searchParams.set("client_id", this.#clientId)
    url.searchParams.set("redirect_uri", this.#redirectUri)
    url.searchParams.set("response_type", "code")
    url.searchParams.set("scope", "openid profile email")
    url.searchParams.set("state", input.state)
    url.searchParams.set("nonce", input.nonce)
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
    const response = await this.#request(
      this.#tokenEndpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.#clientId,
          client_secret: this.#clientSecret,
          code: required(input.code, "Google authorization code"),
          code_verifier: required(input.codeVerifier, "Google PKCE verifier"),
          redirect_uri: this.#redirectUri,
          grant_type: "authorization_code",
        }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      "exchange",
    )
    const token = GoogleTokenSchema.safeParse(await response.json().catch(() => null))
    if (!token.success || token.data.token_type.toLowerCase() !== "bearer") {
      throw invalidResponse("exchange")
    }
    const claims = await this.#verifier.verify({
      idToken: token.data.id_token,
      audience: this.#clientId,
      nonce: required(input.nonce, "Google OIDC nonce"),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    return {
      identity: {
        subjectId: claims.sub,
        login: claims.email ?? null,
        displayName: claims.name ?? claims.email ?? null,
        avatarUrl: claims.picture ?? null,
      },
      credential: null,
      repositories: [],
    }
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
        message: "Google authentication is temporarily unavailable",
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
          ? "Google authorization was rejected"
          : "Google authentication is temporarily unavailable",
      })
    }
    return response
  }
}

export interface GoogleJwksIdTokenVerifierOptions {
  readonly fetch?: ExternalFetch
  readonly jwksUri?: string
  readonly now?: () => Date
  readonly maxClockSkewSeconds?: number
}

export class GoogleJwksIdTokenVerifier implements GoogleIdTokenVerifier {
  readonly #fetch: ExternalFetch
  readonly #jwksUri: URL
  readonly #now: () => Date
  readonly #maxClockSkewSeconds: number
  #keys = new Map<string, CryptoKey>()
  #keysExpireAt = 0

  constructor(options: GoogleJwksIdTokenVerifierOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#jwksUri = new URL(options.jwksUri ?? "https://www.googleapis.com/oauth2/v3/certs")
    this.#now = options.now ?? (() => new Date())
    this.#maxClockSkewSeconds = options.maxClockSkewSeconds ?? 60
  }

  async verify(input: {
    readonly idToken: string
    readonly audience: string
    readonly nonce: string
    readonly signal?: AbortSignal
  }): Promise<GoogleClaims> {
    const segments = input.idToken.split(".")
    if (segments.length !== 3 || !segments[0] || !segments[1] || !segments[2]) {
      throw invalidResponse("id_token")
    }
    const header = JwtHeaderSchema.safeParse(parseJwtJson(segments[0]))
    const claims = GoogleClaimsSchema.safeParse(parseJwtJson(segments[1]))
    if (!header.success || !claims.success) throw invalidResponse("id_token")
    const key = await this.#key(header.data.kid, input.signal)
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      toArrayBuffer(decodeBase64Url(segments[2])),
      toArrayBuffer(new TextEncoder().encode(`${segments[0]}.${segments[1]}`)),
    )
    if (!verified) throw invalidResponse("id_token_signature")
    const audience = Array.isArray(claims.data.aud) ? claims.data.aud : [claims.data.aud]
    const nowSeconds = Math.floor(this.#now().getTime() / 1_000)
    if (
      !audience.includes(input.audience) ||
      (audience.length > 1 && claims.data.azp !== input.audience) ||
      claims.data.exp <= nowSeconds - this.#maxClockSkewSeconds ||
      claims.data.iat > nowSeconds + this.#maxClockSkewSeconds ||
      claims.data.nonce !== input.nonce
    ) {
      throw invalidResponse("id_token_claims")
    }
    return claims.data
  }

  async #key(kid: string, signal?: AbortSignal): Promise<CryptoKey> {
    if (Date.now() >= this.#keysExpireAt || !this.#keys.has(kid)) {
      await this.#refreshKeys(signal)
    }
    const key = this.#keys.get(kid)
    if (key === undefined) throw invalidResponse("id_token_key")
    return key
  }

  async #refreshKeys(signal?: AbortSignal): Promise<void> {
    let response: Response
    try {
      response = await this.#fetch(this.#jwksUri, signal === undefined ? {} : { signal })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new ExternalAuthProviderError({
        provider: "google",
        operation: "jwks",
        retryable: true,
        message: "Google signing keys are temporarily unavailable",
      })
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new ExternalAuthProviderError({
        provider: "google",
        operation: "jwks",
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
        message: "Google signing keys are temporarily unavailable",
      })
    }
    const body = JwksSchema.safeParse(await response.json().catch(() => null))
    if (!body.success) throw invalidResponse("jwks")
    const next = new Map<string, CryptoKey>()
    for (const jwk of body.data.keys) {
      const key = await crypto.subtle.importKey(
        "jwk",
        {
          kty: jwk.kty,
          kid: jwk.kid,
          n: jwk.n,
          e: jwk.e,
          alg: "RS256",
          ext: true,
        } as JsonWebKey,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as RsaHashedImportParams,
        false,
        ["verify"],
      )
      next.set(jwk.kid, key)
    }
    this.#keys = next
    this.#keysExpireAt = Date.now() + cacheLifetimeMs(response.headers.get("Cache-Control"))
  }
}

const parseJwtJson = (value: string): unknown => {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(value)))
  } catch {
    throw invalidResponse("id_token")
  }
}

const decodeBase64Url = (value: string): Uint8Array => {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url")
    const decoded = Uint8Array.fromBase64(value, { alphabet: "base64url" })
    if (decoded.toBase64({ alphabet: "base64url", omitPadding: true }) !== value) {
      throw new Error("Non-canonical base64url")
    }
    return decoded
  } catch {
    throw invalidResponse("id_token")
  }
}

const cacheLifetimeMs = (cacheControl: string | null): number => {
  const seconds = Number(/(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl ?? "")?.[1] ?? "300")
  return Math.min(Math.max(seconds, 60), 24 * 60 * 60) * 1_000
}

const toArrayBuffer = (value: Uint8Array): ArrayBuffer =>
  value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer

const invalidResponse = (operation: string): ExternalAuthProviderError =>
  new ExternalAuthProviderError({
    provider: "google",
    operation,
    authorizationRejected: operation.startsWith("id_token"),
    message: "Google returned an invalid authentication response",
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
