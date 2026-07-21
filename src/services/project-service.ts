import type {
  Principal,
  PrincipalKind,
  Project,
  ProjectMember,
  ProjectRole,
  ProjectWorkItem,
  RequestContext,
} from "../domain"
import { AppError } from "../errors"
import type { Store } from "../persistence/store"

const PROJECT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export class ProjectService {
  constructor(
    private readonly store: Pick<
      Store,
      | "createPrincipalWithAudit"
      | "getPrincipal"
      | "listPrincipals"
      | "createProjectWithAudit"
      | "getProject"
      | "listProjectsForPrincipal"
      | "getProjectMember"
      | "listProjectMembers"
      | "addProjectMemberWithAudit"
      | "removeProjectMemberWithAudit"
      | "listProjectWork"
    >,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = () => crypto.randomUUID(),
  ) {}

  me(context: RequestContext): {
    readonly principal: Principal
    readonly projects: readonly Project[]
  } {
    const principal = this.store.getPrincipal(context.ownerId, context.principalId)
    if (principal === null || principal.disabledAt !== null) {
      throw new AppError({
        code: "UNAUTHENTICATED",
        status: 401,
        message: "Authentication required",
      })
    }
    return {
      principal,
      projects: this.store.listProjectsForPrincipal(context.ownerId, context.principalId),
    }
  }

  createPrincipal(
    context: RequestContext,
    input: { readonly kind: PrincipalKind; readonly displayName: string },
  ): Principal {
    this.#requireOwnerAdmin(context)
    const displayName = input.displayName.trim()
    if (displayName.length === 0 || displayName.length > 120) {
      throw new AppError({ code: "INVALID_REQUEST", message: "Display name is invalid" })
    }
    const id = this.id()
    const createdAt = this.now().toISOString()
    return this.store.createPrincipalWithAudit({
      principal: {
        id,
        ownerId: context.ownerId,
        kind: input.kind,
        displayName,
        ownerRole: "member",
        createdAt,
        disabledAt: null,
      },
      audit: this.#audit(context, "principal.create", "principal", id, createdAt, {
        kind: input.kind,
      }),
    })
  }

  listPrincipals(context: RequestContext): readonly Principal[] {
    this.#requireOwnerAdmin(context)
    return this.store.listPrincipals(context.ownerId)
  }

  createProject(
    context: RequestContext,
    input: { readonly name: string; readonly slug: string },
  ): Project {
    this.#requireOwnerAdmin(context)
    const name = input.name.trim()
    const slug = input.slug.trim().toLowerCase()
    if (name.length === 0 || name.length > 120 || !PROJECT_SLUG.test(slug) || slug.length > 80) {
      throw new AppError({ code: "INVALID_REQUEST", message: "Project name or slug is invalid" })
    }
    const id = this.id()
    const createdAt = this.now().toISOString()
    return this.store.createProjectWithAudit({
      project: {
        id,
        ownerId: context.ownerId,
        name,
        slug,
        createdAt,
        archivedAt: null,
      },
      createdByPrincipalId: context.principalId,
      audit: this.#audit(context, "project.create", "project", id, createdAt, { slug }),
    })
  }

  list(context: RequestContext): readonly Project[] {
    return this.store.listProjectsForPrincipal(context.ownerId, context.principalId)
  }

  get(context: RequestContext, projectId: string): Project {
    this.#requireMembership(context, projectId)
    const project = this.store.getProject(context.ownerId, projectId)
    if (project === null || project.archivedAt !== null) {
      throw new AppError({ code: "NOT_FOUND", message: "Project not found" })
    }
    return project
  }

  members(context: RequestContext, projectId: string): readonly ProjectMember[] {
    this.#requireMembership(context, projectId)
    return this.store.listProjectMembers(context.ownerId, projectId)
  }

  addMember(
    context: RequestContext,
    projectId: string,
    input: { readonly principalId: string; readonly role: ProjectRole },
  ): ProjectMember {
    this.#requireMaintainer(context, projectId)
    if (input.principalId === context.principalId) {
      throw new AppError({
        code: "INVALID_REQUEST",
        status: 409,
        message: "A maintainer cannot change their own active role",
      })
    }
    const principal = this.store.getPrincipal(context.ownerId, input.principalId)
    if (principal === null || principal.disabledAt !== null) {
      throw new AppError({ code: "NOT_FOUND", message: "Principal not found" })
    }
    const joinedAt = this.now().toISOString()
    return this.store.addProjectMemberWithAudit({
      ownerId: context.ownerId,
      projectId,
      principalId: input.principalId,
      role: input.role,
      joinedAt,
      audit: this.#audit(
        context,
        "project_member.add",
        "project_membership",
        `${projectId}:${input.principalId}`,
        joinedAt,
        { projectId, principalId: input.principalId, role: input.role },
      ),
    })
  }

  removeMember(context: RequestContext, projectId: string, principalId: string): void {
    this.#requireMaintainer(context, projectId)
    if (principalId === context.principalId) {
      throw new AppError({
        code: "INVALID_REQUEST",
        status: 409,
        message: "A maintainer cannot remove their own active membership",
      })
    }
    const removedAt = this.now().toISOString()
    if (
      !this.store.removeProjectMemberWithAudit({
        ownerId: context.ownerId,
        projectId,
        principalId,
        removedAt,
        audit: this.#audit(
          context,
          "project_member.remove",
          "project_membership",
          `${projectId}:${principalId}`,
          removedAt,
          { projectId, principalId },
        ),
      })
    ) {
      throw new AppError({ code: "NOT_FOUND", message: "Project member not found" })
    }
  }

  work(context: RequestContext, projectId: string): readonly ProjectWorkItem[] {
    return this.store.listProjectWork(context.ownerId, context.principalId, projectId)
  }

  #requireOwnerAdmin(context: RequestContext): void {
    if (context.ownerRole !== "admin") {
      throw new AppError({ code: "NOT_FOUND", message: "Resource not found" })
    }
  }

  #requireMembership(context: RequestContext, projectId: string): ProjectMember {
    const membership = this.store.getProjectMember(context.ownerId, projectId, context.principalId)
    if (membership === null) throw new AppError({ code: "NOT_FOUND", message: "Project not found" })
    return membership
  }

  #requireMaintainer(context: RequestContext, projectId: string): void {
    const membership = this.#requireMembership(context, projectId)
    if (membership.role !== "maintainer") {
      throw new AppError({ code: "NOT_FOUND", message: "Project not found" })
    }
  }

  #audit(
    context: RequestContext,
    action: string,
    resourceType: "principal" | "project" | "project_membership",
    resourceId: string,
    createdAt: string,
    metadata: Record<string, string>,
  ) {
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
