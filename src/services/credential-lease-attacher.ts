import {
  CREDENTIAL_LEASE_HANDLE_VERSION,
  type CredentialLease,
  type CredentialLeaseHandle,
  credentialGrants,
  credentialLeaseHandle,
  credentialPolicyDigest,
  type RuntimeCredentialBroker,
} from "../credentials"
import type { AgentLaunchSnapshot, AuditRecord, JsonObject, WorkspaceSource } from "../domain"
import { AppError } from "../errors"
import type { Store } from "../persistence/store"
import type { RuntimeHandle } from "../providers/runtime-provider"
import { type ResolvedSecretMaterial, SecretRedactor } from "../secrets"

export interface AttachAgentCredentialInput {
  readonly ownerId: string
  readonly resourceType: "run" | "session"
  readonly resourceId: string
  readonly runtimeId: string
  readonly runtime: RuntimeHandle
  readonly providerName: string
  readonly credentialBroker: RuntimeCredentialBroker | null
  readonly agentSpec: AgentLaunchSnapshot
  readonly workspace: WorkspaceSource
  readonly secrets: ResolvedSecretMaterial
  readonly at: string
}

/**
 * Materializes one exact runtime network/credential boundary before trusted
 * workspace setup and agent spawn. Repository setup contributes only its
 * validated HTTPS hostname; returned environment values remain revocable
 * placeholders, never credentials.
 */
export async function attachAgentCredentialLease(
  store: Pick<Store, "ensureCredentialLease" | "materializeCredentialLease">,
  input: AttachAgentCredentialInput,
): Promise<ResolvedSecretMaterial> {
  const broker = input.credentialBroker
  if (broker === null) {
    if (Object.keys(input.secrets.environment).length > 0) {
      throw new AppError({
        code: "PROVIDER_CAPABILITY_UNAVAILABLE",
        status: 422,
        message: "Runtime provider cannot keep agent credentials outside the runtime",
        details: { provider: input.providerName, capability: "credentialMediation" },
      })
    }
    return input.secrets
  }

  const activePolicies = input.agentSpec.credentials.filter(
    ({ environmentVariable }) => input.secrets.environment[environmentVariable] !== undefined,
  )
  const allowedHosts = [
    ...new Set([
      ...workspaceAllowedHosts(input.workspace),
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
    provider: input.providerName,
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
    attached.handle.provider !== input.providerName ||
    typeof attached.handle.opaque !== "string"
  ) {
    throw new AppError({
      code: "PROVIDER_PROTOCOL_ERROR",
      message: "Credential broker returned an invalid handle",
    })
  }
  let normalizedHandle: CredentialLeaseHandle
  try {
    normalizedHandle = credentialLeaseHandle(input.providerName, attached.handle.opaque)
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

function workspaceAllowedHosts(workspace: WorkspaceSource): readonly string[] {
  if (workspace.type === "bundle") return []
  let repository: URL
  try {
    repository = new URL(workspace.url)
  } catch (cause) {
    throw new AppError({
      code: "INVALID_REQUEST",
      message: "Repository workspace URL is invalid",
      cause,
    })
  }
  if (
    repository.protocol !== "https:" ||
    repository.username !== "" ||
    repository.password !== "" ||
    repository.hostname === ""
  ) {
    throw new AppError({
      code: "INVALID_REQUEST",
      message: "Repository workspace must use an HTTPS host without embedded credentials",
    })
  }
  return [repository.hostname.toLowerCase()]
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
    provider: input.providerName,
    allowedHosts: [...allowedHosts],
    credentialNames: Object.keys(input.secrets.environment).sort(),
  },
  createdAt: input.at,
})

const jsonObject = (value: object): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject
