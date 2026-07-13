import type { DeployAdapter } from "./deploy-adapter"

export class DeployAdapterRegistry {
  readonly #adapters: ReadonlyMap<string, DeployAdapter>

  constructor(adapters: readonly DeployAdapter[]) {
    const entries = new Map<string, DeployAdapter>()
    for (const adapter of adapters) {
      if (!isRegistryName(adapter.name)) {
        throw new DeployRegistryError(
          "DEPLOYMENT_TARGET_INVALID",
          `Invalid deployment adapter name: ${adapter.name}`,
        )
      }
      if (entries.has(adapter.name)) {
        throw new DeployRegistryError(
          "DEPLOYMENT_TARGET_DUPLICATE",
          `Deployment adapter is registered more than once: ${adapter.name}`,
        )
      }
      if (
        new Set(adapter.secretEnvNames).size !== adapter.secretEnvNames.length ||
        adapter.secretEnvNames.some((name) => !/^[A-Z][A-Z0-9_]{0,127}$/.test(name))
      ) {
        throw new DeployRegistryError(
          "DEPLOYMENT_TARGET_INVALID",
          `Deployment adapter ${adapter.name} has an invalid secret environment contract`,
        )
      }
      entries.set(adapter.name, adapter)
    }
    this.#adapters = entries
  }

  get(name: string): DeployAdapter {
    const adapter = this.#adapters.get(name)
    if (adapter === undefined) {
      throw new DeployRegistryError(
        "DEPLOYMENT_TARGET_NOT_FOUND",
        "Deployment target is not configured.",
      )
    }
    return adapter
  }

  names(): readonly string[] {
    return [...this.#adapters.keys()].sort()
  }
}

export type DeployRegistryErrorCode =
  | "DEPLOYMENT_TARGET_INVALID"
  | "DEPLOYMENT_TARGET_DUPLICATE"
  | "DEPLOYMENT_TARGET_NOT_FOUND"

export class DeployRegistryError extends Error {
  override readonly name = "DeployRegistryError"

  constructor(
    readonly code: DeployRegistryErrorCode,
    message: string,
  ) {
    super(message)
  }
}

function isRegistryName(value: string): boolean {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)
}
