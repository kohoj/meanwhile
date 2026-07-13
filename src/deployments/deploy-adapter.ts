import type { ArtifactBlob, Sha256Digest } from "../artifacts/artifact-store"

export type DeploymentLogLevel = "debug" | "info" | "warn" | "error"

export interface DeploymentSourceEntry {
  /** Path relative to the immutable source root. */
  path: string
  mediaType: string
  blob: ArtifactBlob
}

/**
 * A pre-authorized, immutable read capability. The adapter cannot enumerate or
 * fetch anything that the control plane did not resolve into this source.
 */
export interface ImmutableDeploymentSource {
  artifactId: string
  manifestDigest: Sha256Digest
  logicalPath: string
  entries: readonly DeploymentSourceEntry[]
  read(entry: DeploymentSourceEntry): Promise<Uint8Array>
}

export interface DeploymentTarget {
  name: string
  config: Readonly<Record<string, unknown>>
}

export interface DeployInput {
  deploymentId: string
  source: ImmutableDeploymentSource
  target: DeploymentTarget
  /** Resolved just in time and never persisted or emitted. */
  secrets: Readonly<Record<string, string>>
}

export interface DeployContext {
  signal: AbortSignal
  emit(event: DeploymentAdapterEvent): Promise<void>
}

export interface DeploymentAdapterEvent {
  level: DeploymentLogLevel
  event: string
  message: string
  fields?: Readonly<Record<string, unknown>>
}

export interface DeployResult {
  url: string
  previewUrl?: string
  metadata: Readonly<Record<string, string | number | boolean | null>>
}

export interface DeployAdapter {
  readonly name: string
  /** Exact secret environment targets this adapter is trusted to receive. */
  readonly secretEnvNames: readonly string[]
  /** Validates and canonicalizes explicitly non-secret target configuration. */
  validate(config: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>
  /**
   * Idempotent for (deploymentId, source manifest, target). Restart
   * reconciliation may invoke it again after the target already succeeded.
   */
  deploy(input: DeployInput, context: DeployContext): Promise<DeployResult>
}

export type DeployAdapterErrorCode =
  | "DEPLOYMENT_TARGET_INVALID"
  | "DEPLOYMENT_SOURCE_INVALID"
  | "DEPLOYMENT_ABORTED"
  | "DEPLOYMENT_TARGET_FAILED"

export class DeployAdapterError extends Error {
  override readonly name = "DeployAdapterError"

  constructor(
    readonly code: DeployAdapterErrorCode,
    message: string,
    readonly retryable = false,
    readonly safeDetails: Readonly<Record<string, string | number | boolean>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}
