import { type RuntimeCredentialBroker, runtimeCredentialBroker } from "../credentials"
import {
  type RuntimeCapabilities,
  type RuntimeProvider,
  RuntimeProviderError,
} from "./runtime-provider"

export interface RuntimeProviderDescriptor {
  readonly name: string
  readonly capabilities: RuntimeCapabilities
}

/** Explicit provider composition without a service locator or DI container. */
export class RuntimeProviderRegistry {
  readonly #providers: ReadonlyMap<string, RuntimeProvider>

  constructor(providers: readonly RuntimeProvider[]) {
    const byName = new Map<string, RuntimeProvider>()
    for (const provider of providers) {
      if (provider.name.length === 0) {
        throw new TypeError("runtime provider name must not be empty")
      }
      if (byName.has(provider.name)) {
        throw new RuntimeProviderError({
          provider: provider.name,
          operation: "resolve",
          code: "DUPLICATE_PROVIDER",
          message: `Runtime provider '${provider.name}' is registered more than once`,
        })
      }
      byName.set(provider.name, provider)
    }
    this.#providers = byName
  }

  get(name: string): RuntimeProvider {
    const provider = this.#providers.get(name)
    if (provider === undefined) {
      throw new RuntimeProviderError({
        provider: name,
        operation: "resolve",
        code: "PROVIDER_NOT_FOUND",
        message: `Runtime provider '${name}' is not configured`,
      })
    }
    return provider
  }

  has(name: string): boolean {
    return this.#providers.has(name)
  }

  credentialBroker(name: string): RuntimeCredentialBroker | null {
    return runtimeCredentialBroker(this.get(name))
  }

  supportsCredentialMediation(name: string): boolean {
    const provider = this.#providers.get(name)
    return provider !== undefined && this.credentialBroker(name) !== null
  }

  list(): RuntimeProviderDescriptor[] {
    return [...this.#providers.values()]
      .map(({ name, capabilities }) => ({ name, capabilities }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }
}
