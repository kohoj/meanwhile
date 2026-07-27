import { z } from "zod"
import type { IdentityCredential } from "../domain"
import type { SealedCredentialVault } from "./credential-vault"
import type { ExternalAuthCredentialMaterial } from "./external-auth"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
const githubCredentialV1Schema = z
  .object({
    version: z.literal(1),
    accessToken: z.string().min(1).max(8_192),
    refreshToken: z.string().min(1).max(8_192),
  })
  .strict()

const githubCredentialSchema = z.union([
  githubCredentialV1Schema,
  z
    .object({
      version: z.literal(2),
      accessToken: z.string().min(1).max(8_192),
      refreshToken: z.string().min(1).max(8_192).nullable(),
    })
    .strict(),
])

export interface OpenGitHubIdentityCredential {
  readonly accessToken: string
  readonly refreshToken: string | null
}

export async function sealGitHubIdentityCredential(input: {
  readonly vault: SealedCredentialVault
  readonly ownerId: string
  readonly externalIdentityId: string
  readonly material: ExternalAuthCredentialMaterial
}): Promise<string> {
  const value = encoder.encode(
    JSON.stringify({
      version: 2,
      accessToken: input.material.accessToken,
      refreshToken: input.material.refreshToken,
    }),
  )
  try {
    return await input.vault.seal(value, {
      purpose: "identity_credential",
      ownerId: input.ownerId,
      provider: "github",
      resourceId: input.externalIdentityId,
    })
  } finally {
    value.fill(0)
  }
}

export async function openGitHubIdentityCredential(input: {
  readonly vault: SealedCredentialVault
  readonly credential: IdentityCredential
}): Promise<OpenGitHubIdentityCredential> {
  const plaintext = await input.vault.open(input.credential.sealedPayload, {
    purpose: "identity_credential",
    ownerId: input.credential.ownerId,
    provider: "github",
    resourceId: input.credential.externalIdentityId,
  })
  try {
    const parsed = githubCredentialSchema.parse(JSON.parse(decoder.decode(plaintext)))
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
    }
  } finally {
    plaintext.fill(0)
  }
}
