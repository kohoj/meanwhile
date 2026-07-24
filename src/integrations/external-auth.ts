import { z } from "zod"
import type { ExternalIdentityProvider } from "../domain"
import type { RepositoryDirectoryEntry } from "./repository-directory"

export type ExternalAuthIntent = "login" | "link" | "invite"

export interface ExternalAuthIdentityProfile {
  readonly subjectId: string
  readonly login: string | null
  readonly displayName: string | null
  readonly avatarUrl: string | null
}

export interface ExternalAuthCredentialMaterial {
  readonly accessToken: string
  readonly refreshToken: string | null
  readonly accessExpiresAt: string
  readonly refreshExpiresAt: string | null
}

export interface ExternalAuthExchangeResult {
  readonly identity: ExternalAuthIdentityProfile
  readonly credential: ExternalAuthCredentialMaterial | null
  readonly repositories: readonly RepositoryDirectoryEntry[]
}

export interface ExternalAuthProviderAdapter {
  readonly provider: ExternalIdentityProvider
  authorizationUrl(input: {
    readonly state: string
    readonly codeChallenge: string
    readonly nonce: string
  }): URL
  exchange(input: {
    readonly code: string
    readonly codeVerifier: string
    readonly nonce: string
    readonly signal?: AbortSignal
  }): Promise<ExternalAuthExchangeResult>
  refresh?(input: {
    readonly refreshToken: string
    readonly signal?: AbortSignal
  }): Promise<ExternalAuthCredentialMaterial>
  repositories?(input: {
    readonly accessToken: string
    readonly signal?: AbortSignal
  }): Promise<readonly RepositoryDirectoryEntry[]>
}

export class ExternalAuthProviderError extends Error {
  readonly provider: ExternalIdentityProvider
  readonly operation: string
  readonly status: number | null
  readonly retryable: boolean
  readonly authorizationRejected: boolean

  constructor(input: {
    readonly provider: ExternalIdentityProvider
    readonly operation: string
    readonly message: string
    readonly status?: number
    readonly retryable?: boolean
    readonly authorizationRejected?: boolean
  }) {
    super(input.message)
    this.name = "ExternalAuthProviderError"
    this.provider = input.provider
    this.operation = input.operation
    this.status = input.status ?? null
    this.retryable = input.retryable ?? false
    this.authorizationRejected = input.authorizationRejected ?? false
  }
}

const statePayloadV1Schema = z
  .object({
    version: z.literal(1),
    provider: z.enum(["github", "google"]),
    ownerId: z.string().uuid(),
    intent: z.enum(["login", "link"]),
    principalId: z.string().uuid().nullable(),
    redirectUri: z.string().url().max(2_048),
    codeVerifier: z.string().min(43).max(128),
    nonce: z.string().min(32).max(128),
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()

const statePayloadV2Schema = z
  .object({
    version: z.literal(2),
    provider: z.enum(["github", "google"]),
    ownerId: z.string().uuid(),
    intent: z.enum(["login", "link", "invite"]),
    principalId: z.string().uuid().nullable(),
    invitationId: z.string().uuid().nullable(),
    redirectUri: z.string().url().max(2_048),
    codeVerifier: z.string().min(43).max(128),
    nonce: z.string().min(32).max(128),
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((state, context) => {
    const valid =
      (state.intent === "login" && state.principalId === null && state.invitationId === null) ||
      (state.intent === "link" && state.principalId !== null && state.invitationId === null) ||
      (state.intent === "invite" && state.principalId !== null && state.invitationId !== null)
    if (!valid) {
      context.addIssue({
        code: "custom",
        message: "External authentication state authority is invalid",
      })
    }
  })

const statePayloadSchema = z.union([statePayloadV1Schema, statePayloadV2Schema])

export type ExternalAuthState = z.output<typeof statePayloadSchema>

export interface ExternalAuthStateCodec {
  seal(state: ExternalAuthState): Promise<string>
  open(provider: ExternalIdentityProvider, value: string): Promise<ExternalAuthState>
}

export const parseExternalAuthState = (value: unknown): ExternalAuthState =>
  statePayloadSchema.parse(value)

export const createPkce = async (): Promise<{
  readonly codeVerifier: string
  readonly codeChallenge: string
  readonly nonce: string
}> => {
  const codeVerifier = randomBase64Url(32)
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier))
  return {
    codeVerifier,
    codeChallenge: new Uint8Array(digest).toBase64({
      alphabet: "base64url",
      omitPadding: true,
    }),
    nonce: randomBase64Url(32),
  }
}

const randomBase64Url = (byteLength: number): string =>
  crypto
    .getRandomValues(new Uint8Array(byteLength))
    .toBase64({ alphabet: "base64url", omitPadding: true })
