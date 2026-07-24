const encoder = new TextEncoder()

const SEALED_PREFIX = "mwsv1"
const NONCE_BYTES = 12
const KEY_BYTES = 32
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export type CredentialVaultPurpose = "external_auth_state" | "identity_credential"

export interface CredentialVaultContext {
  readonly purpose: CredentialVaultPurpose
  readonly ownerId: string
  readonly provider: "github" | "google"
  readonly resourceId?: string
}

export interface SealedCredentialVault {
  readonly keyVersion: string
  seal(value: Uint8Array, context: CredentialVaultContext): Promise<string>
  open(sealed: string, context: CredentialVaultContext): Promise<Uint8Array>
}

export class CredentialVaultError extends Error {
  readonly code:
    | "CREDENTIAL_KEY_INVALID"
    | "CREDENTIAL_CONTEXT_INVALID"
    | "CREDENTIAL_PAYLOAD_INVALID"
    | "CREDENTIAL_DECRYPTION_FAILED"

  constructor(code: CredentialVaultError["code"], message: string) {
    super(message)
    this.name = "CredentialVaultError"
    this.code = code
  }
}

/**
 * Small local/self-hosted credential backend. The 256-bit master key stays
 * outside SQLite; the version is persisted in each sealed envelope so an
 * external keyring can implement the same interface later.
 */
export class AesGcmCredentialVault implements SealedCredentialVault {
  readonly keyVersion: string
  readonly #key: CryptoKey

  private constructor(keyVersion: string, key: CryptoKey) {
    this.keyVersion = keyVersion
    this.#key = key
  }

  static async create(input: {
    readonly keyVersion: string
    readonly key: Uint8Array
  }): Promise<AesGcmCredentialVault> {
    if (!versionPattern.test(input.keyVersion)) {
      throw new CredentialVaultError("CREDENTIAL_KEY_INVALID", "Credential key version is invalid")
    }
    if (input.key.byteLength !== KEY_BYTES) {
      throw new CredentialVaultError(
        "CREDENTIAL_KEY_INVALID",
        "Credential master key must contain exactly 32 bytes",
      )
    }
    const copy = Uint8Array.from(input.key)
    try {
      const key = await crypto.subtle.importKey("raw", copy, "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ])
      return new AesGcmCredentialVault(input.keyVersion, key)
    } finally {
      copy.fill(0)
    }
  }

  static async fromBase64Url(input: {
    readonly keyVersion: string
    readonly encodedKey: string
  }): Promise<AesGcmCredentialVault> {
    let key: Uint8Array
    try {
      key = decodeBase64Url(input.encodedKey)
    } catch {
      throw new CredentialVaultError(
        "CREDENTIAL_KEY_INVALID",
        "Credential master key must be base64url encoded",
      )
    }
    try {
      return await AesGcmCredentialVault.create({ keyVersion: input.keyVersion, key })
    } finally {
      key.fill(0)
    }
  }

  async seal(value: Uint8Array, context: CredentialVaultContext): Promise<string> {
    if (value.byteLength === 0) {
      throw new CredentialVaultError(
        "CREDENTIAL_PAYLOAD_INVALID",
        "An empty credential payload cannot be sealed",
      )
    }
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(contextBytes(context)),
        tagLength: 128,
      },
      this.#key,
      toArrayBuffer(value),
    )
    return [
      SEALED_PREFIX,
      this.keyVersion,
      nonce.toBase64({ alphabet: "base64url", omitPadding: true }),
      new Uint8Array(ciphertext).toBase64({ alphabet: "base64url", omitPadding: true }),
    ].join(".")
  }

  async open(sealed: string, context: CredentialVaultContext): Promise<Uint8Array> {
    const parts = sealed.split(".")
    if (
      parts.length !== 4 ||
      parts[0] !== SEALED_PREFIX ||
      parts[1] !== this.keyVersion ||
      !parts[2] ||
      !parts[3]
    ) {
      throw new CredentialVaultError(
        "CREDENTIAL_PAYLOAD_INVALID",
        "Sealed credential envelope is invalid or uses an unavailable key version",
      )
    }
    let nonce: Uint8Array
    let ciphertext: Uint8Array
    try {
      nonce = decodeBase64Url(parts[2])
      ciphertext = decodeBase64Url(parts[3])
    } catch {
      throw new CredentialVaultError(
        "CREDENTIAL_PAYLOAD_INVALID",
        "Sealed credential envelope is not valid base64url",
      )
    }
    if (nonce.byteLength !== NONCE_BYTES || ciphertext.byteLength <= 16) {
      throw new CredentialVaultError(
        "CREDENTIAL_PAYLOAD_INVALID",
        "Sealed credential envelope has invalid lengths",
      )
    }
    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(nonce),
          additionalData: toArrayBuffer(contextBytes(context)),
          tagLength: 128,
        },
        this.#key,
        toArrayBuffer(ciphertext),
      )
      return new Uint8Array(plaintext)
    } catch {
      throw new CredentialVaultError(
        "CREDENTIAL_DECRYPTION_FAILED",
        "Sealed credential could not be authenticated",
      )
    } finally {
      nonce.fill(0)
      ciphertext.fill(0)
    }
  }
}

const decodeBase64Url = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url")
  const decoded = Uint8Array.fromBase64(value, { alphabet: "base64url" })
  if (decoded.toBase64({ alphabet: "base64url", omitPadding: true }) !== value) {
    throw new Error("Non-canonical base64url")
  }
  return decoded
}

const toArrayBuffer = (value: Uint8Array): ArrayBuffer =>
  value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer

const contextBytes = (context: CredentialVaultContext): Uint8Array => {
  if (
    context.ownerId.length === 0 ||
    (context.provider !== "github" && context.provider !== "google") ||
    (context.resourceId !== undefined && context.resourceId.length === 0)
  ) {
    throw new CredentialVaultError(
      "CREDENTIAL_CONTEXT_INVALID",
      "Credential sealing context is invalid",
    )
  }
  return encoder.encode(
    JSON.stringify({
      ownerId: context.ownerId,
      provider: context.provider,
      purpose: context.purpose,
      resourceId: context.resourceId ?? null,
    }),
  )
}
