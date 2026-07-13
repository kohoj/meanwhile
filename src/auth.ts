const API_KEY_SCHEME = "mwk"
const API_KEY_PREFIX_BYTES = 9
const API_KEY_SECRET_BYTES = 32
const API_KEY_DIGEST_BYTES = 32
const API_KEY_HASH_PREFIX = "sha256:"
const apiKeyPattern = /^mwk_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{43})$/
const storedHashPattern = /^sha256:([0-9a-f]{64})$/

export const LOCAL_BOOTSTRAP_OWNER_ID = "00000000-0000-4000-8000-000000000001"
export const LOCAL_BOOTSTRAP_API_KEY_ID = "00000000-0000-4000-8000-000000000002"

export interface StoredApiKey {
  readonly id: string
  readonly ownerId: string
  readonly prefix: string
  readonly hash: string
  readonly revokedAt?: Date | null
}

export interface ApiKeyLookup {
  findByPrefix(prefix: string): Promise<readonly StoredApiKey[]>
}

export interface IssuedApiKey {
  /** Shown once and never persisted. */
  readonly key: string
  /** Safe lookup/display prefix. */
  readonly prefix: string
  /** Versioned digest suitable for persistence. */
  readonly hash: string
}

export interface AuthenticatedOwner {
  readonly ownerId: string
  readonly apiKeyId: string
  readonly apiKeyPrefix: string
}

export class AuthenticationDataError extends Error {
  readonly code = "AUTHENTICATION_DATA_INVALID"

  constructor(message: string) {
    super(message)
    this.name = "AuthenticationDataError"
  }
}

/** Issues a 256-bit bearer secret with an independent, non-secret lookup prefix. */
export async function issueApiKey(): Promise<IssuedApiKey> {
  const publicPart = randomBase64Url(API_KEY_PREFIX_BYTES)
  const secretPart = randomBase64Url(API_KEY_SECRET_BYTES)
  const prefix = `${API_KEY_SCHEME}_${publicPart}`
  const key = `${prefix}_${secretPart}`

  return {
    key,
    prefix,
    hash: await hashApiKey(key),
  }
}

/**
 * SHA-256 is appropriate here because API keys are uniformly random 256-bit
 * values, unlike human passwords. The versioned representation permits a
 * deliberate future migration.
 */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))
  return `${API_KEY_HASH_PREFIX}${bytesToHex(new Uint8Array(digest))}`
}

export function bearerToken(authorization: string | null | undefined): string | null {
  if (authorization === null || authorization === undefined) return null
  const match = /^Bearer[\t ]+([^\s]+)$/i.exec(authorization.trim())
  return match?.[1] ?? null
}

export function apiKeyPrefix(key: string): string | null {
  const match = apiKeyPattern.exec(key)
  return match ? `${API_KEY_SCHEME}_${match[1]}` : null
}

/**
 * Authenticates without revealing whether a key prefix or owner exists.
 * Candidate digests are all compared before a result is selected.
 */
export async function authenticateBearer(
  authorization: string | null | undefined,
  lookup: ApiKeyLookup,
  _now: Date = new Date(),
): Promise<AuthenticatedOwner | null> {
  const key = bearerToken(authorization)
  if (key === null) return null

  const prefix = apiKeyPrefix(key)
  if (prefix === null) return null

  const candidateHash = parseStoredHash(await hashApiKey(key))
  const records = await lookup.findByPrefix(prefix)
  let authenticated: StoredApiKey | null = null

  for (const record of records) {
    if (record.prefix !== prefix) {
      throw new AuthenticationDataError("API-key lookup returned a record with a different prefix")
    }

    const storedHash = parseStoredHash(record.hash)
    const matches = constantTimeEqual(candidateHash, storedHash)
    const active = record.revokedAt == null

    if (matches && active) {
      if (authenticated !== null) {
        throw new AuthenticationDataError("Multiple active API-key records have the same digest")
      }
      authenticated = record
    }
  }

  return authenticated === null
    ? null
    : {
        ownerId: authenticated.ownerId,
        apiKeyId: authenticated.id,
        apiKeyPrefix: authenticated.prefix,
      }
}

function parseStoredHash(hash: string): Uint8Array {
  const match = storedHashPattern.exec(hash)
  if (!match) {
    throw new AuthenticationDataError("Stored API-key hash is malformed")
  }

  const hexadecimal = match[1]
  if (hexadecimal === undefined) {
    throw new AuthenticationDataError("Stored API-key hash is malformed")
  }
  const bytes = new Uint8Array(API_KEY_DIGEST_BYTES)
  for (let index = 0; index < bytes.byteLength; index += 1) {
    bytes[index] = Number.parseInt(hexadecimal.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.byteLength, right.byteLength)
  let difference = left.byteLength ^ right.byteLength

  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return bytes.toBase64({ alphabet: "base64url", omitPadding: true })
}

function bytesToHex(value: Uint8Array): string {
  let output = ""
  for (const byte of value) output += byte.toString(16).padStart(2, "0")
  return output
}
