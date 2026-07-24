import type {
  AgentConnection,
  AgentConnectionCapabilities,
  AuditRecord,
  ExternalIdentity,
  ExternalProjectGrant,
  JsonObject,
  Principal,
  Project,
  ProjectAccess,
  ProjectRepositoryBinding,
  ProjectSelection,
  RequestContext,
} from "../domain"
import { AppError } from "../errors"
import type { Store } from "../persistence/store"

export interface AvailableAgentConnection {
  readonly agentType: string
  readonly label: string
  readonly capabilities: AgentConnectionCapabilities
}

export interface ConnectedOnboardingSnapshot {
  readonly principal: Principal
  readonly identities: readonly ExternalIdentity[]
  readonly repositoryGrants: readonly ExternalProjectGrant[]
  readonly repositoryBindings: readonly ProjectRepositoryBinding[]
  readonly agentConnections: readonly AgentConnection[]
  readonly availableAgents: readonly AvailableAgentConnection[]
  readonly projects: readonly {
    readonly project: Project
    readonly access: ProjectAccess["access"]
    readonly source: ProjectAccess["source"]
    readonly selected: boolean
  }[]
}

export interface ImportedProjectRepository {
  readonly project: Project
  readonly binding: ProjectRepositoryBinding
  readonly selection: ProjectSelection
  readonly created: boolean
}

interface ConnectedOnboardingStore
  extends Pick<
    Store,
    | "getPrincipal"
    | "getProjectAccess"
    | "listProjectsForPrincipal"
    | "listExternalIdentities"
    | "listExternalProjectGrants"
    | "getExternalProjectGrant"
    | "listProjectRepositoryBindingsForPrincipal"
    | "bindProjectRepositoryWithAudit"
    | "importProjectRepositoryWithAudit"
    | "listAgentConnections"
    | "createAgentConnectionWithAudit"
    | "revokeAgentConnectionWithAudit"
    | "listProjectSelections"
    | "setProjectSelectionWithAudit"
  > {}

export class ConnectedOnboardingService {
  constructor(
    private readonly store: ConnectedOnboardingStore,
    private readonly availableAgents: () => readonly AvailableAgentConnection[],
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = () => crypto.randomUUID(),
  ) {}

  snapshot(context: RequestContext): ConnectedOnboardingSnapshot {
    const principal = this.#principal(context)
    const at = this.now().toISOString()
    const selections = new Map(
      this.store
        .listProjectSelections(context.ownerId, context.principalId, at)
        .map((selection) => [selection.projectId, selection.hiddenAt === null]),
    )
    return {
      principal,
      identities: this.store.listExternalIdentities(context.ownerId, context.principalId),
      repositoryGrants: this.store.listExternalProjectGrants(
        context.ownerId,
        context.principalId,
        at,
      ),
      repositoryBindings: this.store.listProjectRepositoryBindingsForPrincipal(
        context.ownerId,
        context.principalId,
        at,
      ),
      agentConnections: this.store.listAgentConnections(context.ownerId, context.principalId),
      availableAgents: this.availableAgents(),
      projects: this.store
        .listProjectsForPrincipal(context.ownerId, context.principalId, at)
        .map((project) => {
          const access = this.store.getProjectAccess(
            context.ownerId,
            project.id,
            context.principalId,
            at,
          )
          if (access === null) {
            throw new Error("Project access disappeared during onboarding snapshot")
          }
          return {
            project,
            access: access.access,
            source: access.source,
            selected: selections.get(project.id) ?? false,
          }
        }),
    }
  }

  connectAgent(context: RequestContext, agentType: string): AgentConnection {
    this.#principal(context)
    const available = this.availableAgents().find((candidate) => candidate.agentType === agentType)
    if (available === undefined) {
      throw new AppError({ code: "INVALID_REQUEST", message: "Agent is not available" })
    }
    const at = this.now().toISOString()
    const connection: AgentConnection = {
      id: this.id(),
      ownerId: context.ownerId,
      principalId: context.principalId,
      agentType: available.agentType,
      label: available.label,
      capabilities: available.capabilities,
      createdAt: at,
      lastVerifiedAt: at,
      revokedAt: null,
    }
    return this.store.createAgentConnectionWithAudit({
      connection,
      audit: this.#audit(
        context,
        "agent_connection.authorize",
        "agent_connection",
        connection.id,
        at,
        {
          agentType: connection.agentType,
        },
      ),
    })
  }

  revokeAgentConnection(context: RequestContext, connectionId: string): AgentConnection {
    const at = this.now().toISOString()
    const connection = this.store.revokeAgentConnectionWithAudit({
      ownerId: context.ownerId,
      principalId: context.principalId,
      id: connectionId,
      at,
      audit: this.#audit(
        context,
        "agent_connection.revoke",
        "agent_connection",
        connectionId,
        at,
        {},
      ),
    })
    if (connection === null) {
      throw new AppError({ code: "NOT_FOUND", message: "Agent connection not found" })
    }
    return connection
  }

  selectProject(context: RequestContext, projectId: string, selected: boolean): ProjectSelection {
    const at = this.now().toISOString()
    if (this.store.getProjectAccess(context.ownerId, projectId, context.principalId, at) === null) {
      throw new AppError({ code: "NOT_FOUND", message: "Project not found" })
    }
    const selection: ProjectSelection = {
      ownerId: context.ownerId,
      principalId: context.principalId,
      projectId,
      selectedAt: at,
      hiddenAt: selected ? null : at,
    }
    return this.store.setProjectSelectionWithAudit({
      selection,
      audit: this.#audit(
        context,
        selected ? "project_selection.show" : "project_selection.hide",
        "project_selection",
        `${context.principalId}:${projectId}`,
        at,
        { projectId, selected },
      ),
    })
  }

  bindRepository(
    context: RequestContext,
    projectId: string,
    grantId: string,
  ): ProjectRepositoryBinding {
    const at = this.now().toISOString()
    const access = this.store.getProjectAccess(context.ownerId, projectId, context.principalId, at)
    if (access?.access !== "administer") {
      throw new AppError({ code: "NOT_FOUND", message: "Project not found" })
    }
    const grant = this.store.getExternalProjectGrant(
      context.ownerId,
      context.principalId,
      grantId,
      at,
    )
    if (grant === null || grant.access !== "administer") {
      throw new AppError({ code: "NOT_FOUND", message: "Repository grant not found" })
    }
    const binding: ProjectRepositoryBinding = {
      id: this.id(),
      projectId,
      ownerId: context.ownerId,
      grantId: grant.id,
      provider: grant.provider,
      accountId: grant.accountId,
      accountName: grant.accountName,
      installationId: grant.installationId,
      repositoryId: grant.repositoryId,
      repositoryName: grant.repositoryName,
      repositoryFullName: grant.repositoryFullName,
      repositoryUrl: grant.repositoryUrl,
      private: grant.private,
      boundByPrincipalId: context.principalId,
      createdAt: at,
      revokedAt: null,
    }
    return this.store.bindProjectRepositoryWithAudit({
      binding,
      audit: this.#audit(
        context,
        "project_repository_binding.bind",
        "project_repository_binding",
        binding.id,
        at,
        {
          projectId,
          provider: binding.provider,
          repositoryId: binding.repositoryId,
        },
      ),
    })
  }

  importRepository(context: RequestContext, grantId: string): ImportedProjectRepository {
    this.#principal(context)
    const at = this.now().toISOString()
    const grant = this.store.getExternalProjectGrant(
      context.ownerId,
      context.principalId,
      grantId,
      at,
    )
    if (grant === null || grant.access !== "administer") {
      throw new AppError({ code: "NOT_FOUND", message: "Repository grant not found" })
    }
    const projectId = this.id()
    const bindingId = this.id()
    const projectName = grant.repositoryName.trim().slice(0, 120)
    const project: Project = {
      id: projectId,
      ownerId: context.ownerId,
      name: projectName,
      slug: importedProjectSlug(grant.repositoryFullName, projectId),
      createdAt: at,
      archivedAt: null,
    }
    return this.store.importProjectRepositoryWithAudit({
      ownerId: context.ownerId,
      principalId: context.principalId,
      grantId,
      at,
      project,
      bindingId,
      audits: {
        project: this.#audit(context, "project.import", "project", projectId, at, {
          authority: "github",
          provider: grant.provider,
          repositoryId: grant.repositoryId,
        }),
        binding: this.#audit(
          context,
          "project_repository_binding.bind",
          "project_repository_binding",
          bindingId,
          at,
          {
            projectId,
            provider: grant.provider,
            repositoryId: grant.repositoryId,
          },
        ),
        selection: this.#audit(
          context,
          "project_selection.show",
          "project_selection",
          `${context.principalId}:${projectId}`,
          at,
          { projectId, selected: true, imported: true },
        ),
      },
    })
  }

  #principal(context: RequestContext): Principal {
    const principal = this.store.getPrincipal(context.ownerId, context.principalId)
    if (principal === null || principal.disabledAt !== null) {
      throw new AppError({
        code: "UNAUTHENTICATED",
        status: 401,
        message: "Authentication required",
      })
    }
    return principal
  }

  #audit(
    context: RequestContext,
    action: string,
    resourceType: AuditRecord["resourceType"],
    resourceId: string,
    createdAt: string,
    metadata: JsonObject,
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

const importedProjectSlug = (repositoryFullName: string, projectId: string): string => {
  const base = repositoryFullName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 71)
    .replace(/-+$/g, "")
  return `${base || "project"}-${projectId.slice(0, 8).toLowerCase()}`
}
