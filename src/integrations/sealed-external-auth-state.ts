import type { ExternalIdentityProvider } from "../domain"
import type { SealedCredentialVault } from "./credential-vault"
import {
  type ExternalAuthState,
  type ExternalAuthStateCodec,
  parseExternalAuthState,
} from "./external-auth"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export class SealedExternalAuthStateCodec implements ExternalAuthStateCodec {
  constructor(
    private readonly ownerId: string,
    private readonly vault: SealedCredentialVault,
  ) {}

  async seal(state: ExternalAuthState): Promise<string> {
    if (state.ownerId !== this.ownerId) throw new Error("External auth owner does not match")
    return this.vault.seal(encoder.encode(JSON.stringify(state)), {
      purpose: "external_auth_state",
      ownerId: this.ownerId,
      provider: state.provider,
    })
  }

  async open(provider: ExternalIdentityProvider, value: string): Promise<ExternalAuthState> {
    const plaintext = await this.vault.open(value, {
      purpose: "external_auth_state",
      ownerId: this.ownerId,
      provider,
    })
    try {
      const state = parseExternalAuthState(JSON.parse(decoder.decode(plaintext)))
      if (state.ownerId !== this.ownerId || state.provider !== provider) {
        throw new Error("External auth state context does not match")
      }
      return state
    } finally {
      plaintext.fill(0)
    }
  }
}
