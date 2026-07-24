import type {
  AgentCredentialHttpMethod,
  AgentCredentialPolicy,
  JsonObject,
  StructuredError,
} from "./domain"
import { hashCanonical } from "./idempotency"
import type { RuntimeHandle, RuntimeProvider } from "./providers/runtime-provider"

export const CREDENTIAL_LEASE_HANDLE_VERSION = 1 as const

export type CredentialLeaseResourceType = "run" | "session"
export type CredentialLeaseStatus =
  | "attaching"
  | "active"
  | "revoke_pending"
  | "revoking"
  | "revoked"
  | "failed"

export interface CredentialLeaseHandle extends JsonObject {
  readonly kind: "credential_lease"
  readonly version: typeof CREDENTIAL_LEASE_HANDLE_VERSION
  readonly provider: string
  readonly opaque: string
}

export interface CredentialLease {
  readonly id: string
  readonly ownerId: string
  readonly resourceType: CredentialLeaseResourceType
  readonly resourceId: string
  readonly runtimeId: string
  readonly runtimeHandle: JsonObject
  readonly provider: string
  readonly policyDigest: string
  readonly handle: JsonObject | null
  readonly status: CredentialLeaseStatus
  readonly attempts: number
  readonly lastError: StructuredError | null
  readonly nextAttemptAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly revokedAt: string | null
}

export interface CredentialGrant {
  readonly environmentVariable: string
  readonly host: string
  readonly methods: readonly AgentCredentialHttpMethod[]
  /** Sensitive control-plane material. Providers must never return or persist it in plaintext. */
  readonly value: string
}

export interface AttachCredentialLeaseInput {
  readonly leaseId: string
  readonly runtime: RuntimeHandle
  readonly allowedHosts: readonly string[]
  readonly credentials: readonly CredentialGrant[]
}

export interface AttachedCredentialLease {
  readonly handle: CredentialLeaseHandle
  /** Opaque capability placeholders safe to expose to the untrusted agent process. */
  readonly environment: Readonly<Record<string, string>>
}

/**
 * A provider-side security boundary, deliberately separate from RuntimeProvider.
 * It owns trusted setup/agent egress mediation and revocable credential leases,
 * not compute.
 */
export interface RuntimeCredentialBroker {
  readonly credentialProvider: string
  attach(input: AttachCredentialLeaseInput): Promise<AttachedCredentialLease>
  revoke(input: {
    readonly leaseId: string
    readonly runtime: RuntimeHandle
    readonly handle: CredentialLeaseHandle | null
  }): Promise<void>
}

export class CredentialBrokerError extends Error {
  readonly provider: string
  readonly operation: "attach" | "revoke"
  readonly code: string
  readonly retryable: boolean

  constructor(input: {
    readonly provider: string
    readonly operation: "attach" | "revoke"
    readonly code: string
    readonly message: string
    readonly retryable?: boolean
    readonly cause?: unknown
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = "CredentialBrokerError"
    this.provider = input.provider
    this.operation = input.operation
    this.code = input.code
    this.retryable = input.retryable ?? false
  }
}

export function runtimeCredentialBroker(provider: RuntimeProvider): RuntimeCredentialBroker | null {
  if (
    !provider.capabilities.networkPolicy ||
    provider.capabilities.credentialMediation === "none"
  ) {
    return null
  }
  const candidate = provider as RuntimeProvider & Partial<RuntimeCredentialBroker>
  return candidate.credentialProvider === provider.name &&
    typeof candidate.attach === "function" &&
    typeof candidate.revoke === "function"
    ? (candidate as RuntimeProvider & RuntimeCredentialBroker)
    : null
}

export function credentialLeaseHandle(provider: string, opaque: string): CredentialLeaseHandle {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(provider)) {
    throw new TypeError("credential lease provider is invalid")
  }
  if (opaque.length === 0 || opaque.length > 512 || opaque.includes("\0")) {
    throw new TypeError("credential lease opaque identity is invalid")
  }
  return Object.freeze({
    kind: "credential_lease",
    version: CREDENTIAL_LEASE_HANDLE_VERSION,
    provider,
    opaque,
  })
}

export function credentialPolicyDigest(input: {
  readonly allowedHosts: readonly string[]
  readonly credentials: readonly AgentCredentialPolicy[]
}): string {
  return hashCanonical({
    allowedHosts: [...input.allowedHosts].sort(),
    credentials: input.credentials
      .map((credential) => ({
        environmentVariable: credential.environmentVariable,
        host: credential.host,
        methods: [...credential.methods].sort(),
      }))
      .sort((left, right) =>
        `${left.environmentVariable}\0${left.host}`.localeCompare(
          `${right.environmentVariable}\0${right.host}`,
        ),
      ),
  })
}

export function credentialGrants(
  policies: readonly AgentCredentialPolicy[],
  environment: Readonly<Record<string, string>>,
): readonly CredentialGrant[] {
  const grants: CredentialGrant[] = []
  for (const policy of policies) {
    const value = environment[policy.environmentVariable]
    if (value === undefined) continue
    grants.push({
      environmentVariable: policy.environmentVariable,
      host: policy.host,
      methods: [...policy.methods],
      value,
    })
  }
  const grantedNames = new Set(grants.map(({ environmentVariable }) => environmentVariable))
  const missing = Object.keys(environment).filter((name) => !grantedNames.has(name))
  if (missing.length > 0) {
    throw new CredentialBrokerError({
      provider: "control-plane",
      operation: "attach",
      code: "CREDENTIAL_POLICY_MISSING",
      message: `Credential policy is missing for ${missing.sort().join(",")}`,
    })
  }
  return grants
}
