import { issueConnectorDeviceSecret } from "../auth"
import type {
  AuditRecord,
  ConnectorDevice,
  ConnectorSource,
  ConversationShareGrant,
  RequestContext,
} from "../domain"
import { AppError } from "../errors"
import type { Store } from "../persistence/store"

type ConnectorDeviceStore = Pick<
  Store,
  | "createConnectorDeviceWithAudit"
  | "adoptConnectorDeviceWithGrantAndAudits"
  | "getConnectorDevice"
  | "listConnectorDevicesForPrincipal"
  | "revokeConnectorDeviceWithAudit"
  | "createConversationShareGrantWithAudit"
  | "listConversationShareGrantsForPrincipal"
  | "listActiveConversationShareGrantsForDevice"
  | "getActiveProjectRepositoryBinding"
  | "requireProjectAccess"
  | "revokeConversationShareGrantWithAudit"
>

export interface CreatedConnectorDevice {
  readonly device: ConnectorDevice
  /** Returned once. Only its digest is persisted. */
  readonly secret: string
}

export interface AdoptedConnectorDevice {
  readonly device: ConnectorDevice
  readonly grant: ConversationShareGrant
}

/** Owns the least-authority credential used by one local transcript companion. */
export class ConnectorDeviceService {
  constructor(
    private readonly store: ConnectorDeviceStore,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = () => crypto.randomUUID(),
  ) {}

  async create(
    context: RequestContext,
    input: { readonly displayName: string; readonly source: ConnectorSource },
  ): Promise<CreatedConnectorDevice> {
    const displayName = input.displayName.trim()
    if (displayName.length === 0 || displayName.length > 120) {
      throw new AppError({ code: "INVALID_REQUEST", message: "Device name is invalid" })
    }
    const issued = await issueConnectorDeviceSecret()
    const createdAt = this.now().toISOString()
    const device: ConnectorDevice = {
      id: this.id(),
      ownerId: context.ownerId,
      principalId: context.principalId,
      displayName,
      source: input.source,
      createdAt,
      lastSeenAt: null,
      revokedAt: null,
    }
    return {
      device: this.store.createConnectorDeviceWithAudit({
        device: { ...device, prefix: issued.prefix, hash: issued.hash },
        audit: this.#audit(context, "connector_device.create", device.id, createdAt, {
          source: input.source,
          prefix: issued.prefix,
        }),
      }),
      secret: issued.secret,
    }
  }

  adopt(
    context: RequestContext,
    input: {
      readonly deviceId: string
      readonly displayName: string
      readonly source: ConnectorSource
      readonly credentialPrefix: string
      readonly credentialHash: string
      readonly projectId: string
    },
  ): AdoptedConnectorDevice {
    const displayName = input.displayName.trim()
    if (
      displayName.length === 0 ||
      displayName.length > 120 ||
      !/^mwd_[A-Za-z0-9_-]{12}$/.test(input.credentialPrefix) ||
      !/^sha256:[0-9a-f]{64}$/.test(input.credentialHash)
    ) {
      throw new AppError({ code: "INVALID_REQUEST", message: "Connector verifier is invalid" })
    }
    const at = this.now().toISOString()
    this.store.requireProjectAccess(
      context.ownerId,
      input.projectId,
      context.principalId,
      at,
      "participate",
    )
    if (this.store.getActiveProjectRepositoryBinding(context.ownerId, input.projectId) === null) {
      throw new AppError({ code: "NOT_FOUND", message: "Project not found" })
    }
    const device: ConnectorDevice & { readonly prefix: string; readonly hash: string } = {
      id: input.deviceId,
      ownerId: context.ownerId,
      principalId: context.principalId,
      displayName,
      source: input.source,
      prefix: input.credentialPrefix,
      hash: input.credentialHash,
      createdAt: at,
      lastSeenAt: null,
      revokedAt: null,
    }
    const grant: ConversationShareGrant = {
      id: this.id(),
      ownerId: context.ownerId,
      projectId: input.projectId,
      connectorDeviceId: device.id,
      source: device.source,
      authorizedByPrincipalId: context.principalId,
      createdAt: at,
      revokedAt: null,
    }
    return this.store.adoptConnectorDeviceWithGrantAndAudits({
      device,
      grant,
      deviceAudit: this.#audit(context, "connector_device.adopt", device.id, at, {
        source: device.source,
        prefix: device.prefix,
        projectId: grant.projectId,
      }),
      grantAudit: this.#audit(
        context,
        "conversation_share_grant.create",
        grant.id,
        at,
        {
          projectId: grant.projectId,
          connectorDeviceId: device.id,
          source: device.source,
        },
        "conversation_share_grant",
      ),
    })
  }

  list(context: RequestContext): readonly ConnectorDevice[] {
    return this.store.listConnectorDevicesForPrincipal(context.ownerId, context.principalId)
  }

  current(context: RequestContext): ConnectorDevice {
    const id = context.connectorDeviceId
    if (id === undefined) {
      throw new AppError({ code: "FORBIDDEN", status: 403, message: "Connector device required" })
    }
    const device = this.store.getConnectorDevice(context.ownerId, id)
    if (device === null || device.revokedAt !== null) {
      throw new AppError({ code: "UNAUTHENTICATED", message: "Connector device is unavailable" })
    }
    return device
  }

  setup(context: RequestContext): {
    readonly device: ConnectorDevice
    readonly grants: readonly ConversationShareGrant[]
    readonly repositories: readonly {
      readonly projectId: string
      readonly repositoryId: string
      readonly repositoryFullName: string
      readonly repositoryUrl: string
    }[]
  } {
    const device = this.current(context)
    const grants = this.store.listActiveConversationShareGrantsForDevice(context.ownerId, device.id)
    return {
      device,
      grants,
      repositories: grants.map((grant) => {
        const binding = this.store.getActiveProjectRepositoryBinding(
          context.ownerId,
          grant.projectId,
        )
        if (binding === null) {
          throw new Error("Conversation share grant references an unbound Project")
        }
        return {
          projectId: grant.projectId,
          repositoryId: binding.repositoryId,
          repositoryFullName: binding.repositoryFullName,
          repositoryUrl: binding.repositoryUrl,
        }
      }),
    }
  }

  revoke(context: RequestContext, id: string): ConnectorDevice {
    const existing = this.store.getConnectorDevice(context.ownerId, id)
    if (existing === null || existing.principalId !== context.principalId) {
      throw new AppError({ code: "NOT_FOUND", message: "Connector device not found" })
    }
    const at = this.now().toISOString()
    const revoked = this.store.revokeConnectorDeviceWithAudit({
      ownerId: context.ownerId,
      id,
      principalId: context.principalId,
      at,
      audit: this.#audit(context, "connector_device.revoke", id, at, {}),
    })
    if (revoked === null) {
      throw new AppError({ code: "NOT_FOUND", message: "Connector device not found" })
    }
    return revoked
  }

  grantProject(
    context: RequestContext,
    deviceId: string,
    projectId: string,
  ): ConversationShareGrant {
    const device = this.store.getConnectorDevice(context.ownerId, deviceId)
    if (
      device === null ||
      device.principalId !== context.principalId ||
      device.revokedAt !== null
    ) {
      throw new AppError({ code: "NOT_FOUND", message: "Connector device not found" })
    }
    const at = this.now().toISOString()
    this.store.requireProjectAccess(
      context.ownerId,
      projectId,
      context.principalId,
      at,
      "participate",
    )
    if (this.store.getActiveProjectRepositoryBinding(context.ownerId, projectId) === null) {
      throw new AppError({ code: "NOT_FOUND", message: "Project not found" })
    }
    const grant: ConversationShareGrant = {
      id: this.id(),
      ownerId: context.ownerId,
      projectId,
      connectorDeviceId: deviceId,
      source: device.source,
      authorizedByPrincipalId: context.principalId,
      createdAt: at,
      revokedAt: null,
    }
    return this.store.createConversationShareGrantWithAudit({
      grant,
      audit: this.#audit(
        context,
        "conversation_share_grant.create",
        grant.id,
        at,
        {
          projectId,
          connectorDeviceId: deviceId,
          source: device.source,
        },
        "conversation_share_grant",
      ),
    })
  }

  listGrants(context: RequestContext): readonly ConversationShareGrant[] {
    return this.store.listConversationShareGrantsForPrincipal(context.ownerId, context.principalId)
  }

  revokeGrant(context: RequestContext, grantId: string): ConversationShareGrant {
    const at = this.now().toISOString()
    const grant = this.store.revokeConversationShareGrantWithAudit({
      ownerId: context.ownerId,
      grantId,
      principalId: context.principalId,
      at,
      audit: this.#audit(
        context,
        "conversation_share_grant.revoke",
        grantId,
        at,
        {},
        "conversation_share_grant",
      ),
    })
    if (grant === null) {
      throw new AppError({ code: "NOT_FOUND", message: "Conversation share grant not found" })
    }
    return grant
  }

  #audit(
    context: RequestContext,
    action: string,
    resourceId: string,
    createdAt: string,
    metadata: AuditRecord["metadata"],
    resourceType: "connector_device" | "conversation_share_grant" = "connector_device",
  ): AuditRecord {
    return {
      id: crypto.randomUUID(),
      ownerId: context.ownerId,
      actorApiKeyId: context.apiKeyId,
      action,
      resourceType,
      resourceId,
      requestId: context.requestId,
      traceId: context.traceId,
      metadata,
      createdAt,
    }
  }
}
