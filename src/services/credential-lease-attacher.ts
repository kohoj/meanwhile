import {
  CREDENTIAL_LEASE_HANDLE_VERSION,
  type CredentialLease,
  type CredentialLeaseHandle,
  credentialGrants,
  credentialLeaseHandle,
  credentialPolicyDigest,
  runtimeCredentialBroker,
} from "../credentials"
import type { AgentLaunchSnapshot, AuditRecord, JsonObject } from "../domain"
import { AppError } from "../errors"
import type { Store } from "../persistence/store"
import type { RuntimeHandle, RuntimeProvider } from "../providers/runtime-provider"
import { type ResolvedSecretMaterial, SecretRedactor } from "../secrets"

export interface AttachAgentCredentialInput {
  readonly ownerId: string
  readonly resourceType: "run" | "session"
  readonly resourceId: string
  readonly runtimeId: string
  readonly runtime: RuntimeHandle
  readonly provider: RuntimeProvider
  readonly agentSpec: AgentLaunchSnapshot
  readonly secrets: ResolvedSecretMaterial
  readonly at: string
}

/**
 * Materializes one exact agent-phase network/credential boundary before spawn.
 * Returned environment values are revocable placeholders, never credentials.
 */
export async function attachAgentCredentialLease(
  store: Pick<Store, "ensureCredentialLease" | "materializeCredentialLease">,
  input: AttachAgentCredentialInput,
): Promise<ResolvedSecretMaterial> {
  const broker = runtimeCredentialBroker(input.provider)
  if (broker === null) {
    if (Object.keys(input.secrets.environment).length > 0) {
      throw new AppError({
        code: "PROVIDER_CAPABILITY_UNAVAILABLE",
        status: 422,
        message: "Runtime provider cannot keep agent credentials outside the runtime",
        details: { provider: input.provider.name, capability: "credentialMediation" },
      })
    }
    return input.secrets
  }

  const activePolicies = input.agentSpec.credentials.filter(
    ({ environmentVariable }) => input.secrets.environment[environmentVariable] !== undefined,
  )
  const allowedHosts = [
    ...new Set([
      ...input.agentSpec.networkPolicy.allowedHosts,
      ...activePolicies.map(({ host }) => host),
    ]),
  ].sort()
  const policyDigest = credentialPolicyDigest({
    allowedHosts,
    credentials: activePolicies,
  })
  const lease = store.ensureCredentialLease({
    ownerId: input.ownerId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    runtimeId: input.runtimeId,
    runtimeHandle: jsonObject(input.runtime),
    provider: input.provider.name,
    policyDigest,
    at: input.at,
  })
  if (lease === null) {
    throw new AppError({
      code: "INVALID_STATE_TRANSITION",
      status: 409,
      message: "Resource is no longer eligible for a credential lease",
    })
  }
  if (
    lease.status === "revoked" ||
    lease.status === "revoke_pending" ||
    lease.status === "revoking"
  ) {
    throw new AppError({
      code: "INVALID_STATE_TRANSITION",
      status: 409,
      message: "Credential lease is already being revoked",
    })
  }

  const attached = await broker.attach({
    leaseId: lease.id,
    runtime: input.runtime,
    allowedHosts,
    credentials: credentialGrants(activePolicies, input.secrets.environment),
  })
  if (
    attached.handle.kind !== "credential_lease" ||
    attached.handle.version !== CREDENTIAL_LEASE_HANDLE_VERSION ||
    attached.handle.provider !== input.provider.name ||
    typeof attached.handle.opaque !== "string"
  ) {
    throw new AppError({
      code: "PROVIDER_PROTOCOL_ERROR",
      message: "Credential broker returned an invalid handle",
    })
  }
  let normalizedHandle: CredentialLeaseHandle
  try {
    normalizedHandle = credentialLeaseHandle(input.provider.name, attached.handle.opaque)
  } catch (cause) {
    throw new AppError({
      code: "PROVIDER_PROTOCOL_ERROR",
      message: "Credential broker returned an invalid handle",
      cause,
    })
  }
  const materialized = store.materializeCredentialLease({
    leaseId: lease.id,
    handle: jsonObject(normalizedHandle),
    at: input.at,
    audit: attachAudit(lease, input, allowedHosts),
  })
  if (materialized.status !== "active") {
    throw new AppError({
      code: "INVALID_STATE_TRANSITION",
      status: 409,
      message: "Credential lease became ineligible before agent launch",
    })
  }

  const placeholderNames = Object.keys(attached.environment).sort()
  const expectedNames = [
    ...new Set(activePolicies.map(({ environmentVariable }) => environmentVariable)),
  ].sort()
  if (JSON.stringify(placeholderNames) !== JSON.stringify(expectedNames)) {
    throw new AppError({
      code: "PROVIDER_PROTOCOL_ERROR",
      message: "Credential broker returned an inconsistent placeholder environment",
    })
  }
  const sourceValues = new Set(Object.values(input.secrets.environment))
  const placeholders = Object.values(attached.environment)
  if (new Set(placeholders).size !== placeholders.length) {
    throw new AppError({
      code: "PROVIDER_PROTOCOL_ERROR",
      message: "Credential broker returned duplicate placeholders",
    })
  }
  for (const placeholder of placeholders) {
    if (
      typeof placeholder !== "string" ||
      placeholder.length < 16 ||
      placeholder.length > 512 ||
      placeholder.includes("\0") ||
      sourceValues.has(placeholder)
    ) {
      throw new AppError({
        code: "PROVIDER_PROTOCOL_ERROR",
        message: "Credential broker returned an unsafe placeholder",
      })
    }
  }

  const redactor = new SecretRedactor([
    ...Object.values(input.secrets.environment),
    ...Object.values(attached.environment),
  ])
  const environment = { ...attached.environment }
  let released = false
  return {
    environment,
    redactor,
    async release() {
      if (released) return
      released = true
      for (const name of Object.keys(environment)) {
        environment[name] = ""
        delete environment[name]
      }
      redactor.dispose()
      await input.secrets.release()
    },
  }
}

const attachAudit = (
  lease: CredentialLease,
  input: AttachAgentCredentialInput,
  allowedHosts: readonly string[],
): AuditRecord => ({
  id: crypto.randomUUID(),
  ownerId: input.ownerId,
  actorApiKeyId: null,
  action: "credential.attach",
  resourceType: "credential_lease",
  resourceId: lease.id,
  requestId: `executor:${input.resourceId}`,
  traceId: null,
  metadata: {
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    runtimeId: input.runtimeId,
    provider: input.provider.name,
    allowedHosts: [...allowedHosts],
    credentialNames: Object.keys(input.secrets.environment).sort(),
  },
  createdAt: input.at,
})

const jsonObject = (value: object): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject
