export type ComponentHealth =
  | { readonly status: "healthy" }
  | { readonly status: "degraded" | "unavailable"; readonly message: string }

export interface ManagedComponent {
  readonly name: string
  start(): Promise<void>
  stop(): Promise<void>
  health(): ComponentHealth
}

export type ControlPlaneState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed"

/**
 * Owns process-level component lifecycle. Components own their work; this class
 * only guarantees ordered startup, reverse shutdown, and truthful readiness.
 */
export class ControlPlane {
  private stateValue: ControlPlaneState = "idle"
  private readonly started: ManagedComponent[] = []

  constructor(private readonly components: readonly ManagedComponent[]) {
    const names = new Set<string>()
    for (const component of components) {
      if (names.has(component.name)) throw new TypeError(`Duplicate component: ${component.name}`)
      names.add(component.name)
    }
  }

  get state(): ControlPlaneState {
    return this.stateValue
  }

  async start(): Promise<void> {
    if (this.stateValue !== "idle" && this.stateValue !== "stopped") {
      throw new Error(`Cannot start control plane from ${this.stateValue}`)
    }
    this.stateValue = "starting"
    try {
      for (const component of this.components) {
        await component.start()
        this.started.push(component)
      }
      this.stateValue = "running"
    } catch (error) {
      this.stateValue = "failed"
      await this.stopStarted()
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.stateValue === "stopped" || this.stateValue === "idle") {
      this.stateValue = "stopped"
      return
    }
    if (this.stateValue === "stopping") return
    this.stateValue = "stopping"
    const errors = await this.stopStarted()
    this.stateValue = errors.length === 0 ? "stopped" : "failed"
    if (errors.length > 0) throw new AggregateError(errors, "Control-plane shutdown failed")
  }

  health(): ComponentHealth & { readonly components: Readonly<Record<string, ComponentHealth>> } {
    const components = Object.fromEntries(
      this.components.map((component) => [component.name, component.health()]),
    )
    const unavailable = Object.values(components).find((item) => item.status === "unavailable")
    const degraded = Object.values(components).find((item) => item.status === "degraded")
    const status =
      this.stateValue !== "running"
        ? ({ status: "unavailable", message: `Control plane is ${this.stateValue}` } as const)
        : (unavailable ?? degraded ?? ({ status: "healthy" } as const))
    return { ...status, components }
  }

  private async stopStarted(): Promise<unknown[]> {
    const errors: unknown[] = []
    for (const component of this.started.splice(0).reverse()) {
      try {
        await component.stop()
      } catch (error) {
        errors.push(error)
      }
    }
    return errors
  }
}
