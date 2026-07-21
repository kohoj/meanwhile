import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import type { ProjectService } from "../services/project-service"
import {
  AddProjectMemberRequestSchema,
  type ApiEnv,
  CreatePrincipalRequestSchema,
  CreateProjectRequestSchema,
  createApiRouter,
  errorResponses,
  IdentifierSchema,
  jsonResponse,
  MeResponseSchema,
  PrincipalPageSchema,
  PrincipalResponseSchema,
  PrincipalSchema,
  ProjectMemberPageSchema,
  ProjectMemberResponseSchema,
  ProjectMemberSchema,
  ProjectPageSchema,
  ProjectResponseSchema,
  ProjectSchema,
  ProjectWorkItemSchema,
  ProjectWorkPageSchema,
} from "./schemas"

const ProjectParamSchema = z.object({ projectId: IdentifierSchema }).strict()
const MemberParamSchema = z
  .object({ projectId: IdentifierSchema, principalId: IdentifierSchema })
  .strict()

const meRoute = createRoute({
  method: "get",
  path: "/me",
  operationId: "getCurrentPrincipal",
  tags: ["Projects"],
  responses: {
    200: jsonResponse(MeResponseSchema, "Current Principal and Projects"),
    ...errorResponses,
  },
})

const createPrincipalRoute = createRoute({
  method: "post",
  path: "/principals",
  operationId: "createPrincipal",
  tags: ["Projects"],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreatePrincipalRequestSchema } },
    },
  },
  responses: { 201: jsonResponse(PrincipalResponseSchema, "Principal created"), ...errorResponses },
})

const listPrincipalsRoute = createRoute({
  method: "get",
  path: "/principals",
  operationId: "listPrincipals",
  tags: ["Projects"],
  responses: { 200: jsonResponse(PrincipalPageSchema, "Owner Principals"), ...errorResponses },
})

const createProjectRoute = createRoute({
  method: "post",
  path: "/projects",
  operationId: "createProject",
  tags: ["Projects"],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateProjectRequestSchema } },
    },
  },
  responses: { 201: jsonResponse(ProjectResponseSchema, "Project created"), ...errorResponses },
})

const listProjectsRoute = createRoute({
  method: "get",
  path: "/projects",
  operationId: "listProjects",
  tags: ["Projects"],
  responses: {
    200: jsonResponse(ProjectPageSchema, "Projects visible to the caller"),
    ...errorResponses,
  },
})

const getProjectRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}",
  operationId: "getProject",
  tags: ["Projects"],
  request: { params: ProjectParamSchema },
  responses: { 200: jsonResponse(ProjectResponseSchema, "Project"), ...errorResponses },
})

const listMembersRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}/members",
  operationId: "listProjectMembers",
  tags: ["Projects"],
  request: { params: ProjectParamSchema },
  responses: { 200: jsonResponse(ProjectMemberPageSchema, "Project members"), ...errorResponses },
})

const addMemberRoute = createRoute({
  method: "post",
  path: "/projects/{projectId}/members",
  operationId: "addProjectMember",
  tags: ["Projects"],
  request: {
    params: ProjectParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: AddProjectMemberRequestSchema } },
    },
  },
  responses: {
    201: jsonResponse(ProjectMemberResponseSchema, "Project member added"),
    ...errorResponses,
  },
})

const removeMemberRoute = createRoute({
  method: "delete",
  path: "/projects/{projectId}/members/{principalId}",
  operationId: "removeProjectMember",
  tags: ["Projects"],
  request: { params: MemberParamSchema },
  responses: { 204: { description: "Project member removed" }, ...errorResponses },
})

const listWorkRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}/work",
  operationId: "listProjectWork",
  tags: ["Projects"],
  request: { params: ProjectParamSchema },
  responses: { 200: jsonResponse(ProjectWorkPageSchema, "Project work"), ...errorResponses },
})

export const createProjectRoutes = (service: ProjectService): OpenAPIHono<ApiEnv> => {
  const routes = createApiRouter()
  routes.openapi(meRoute, (context) =>
    context.json(MeResponseSchema.parse(service.me(context.get("requestContext"))), 200),
  )
  routes.openapi(createPrincipalRoute, (context) =>
    context.json(
      {
        principal: PrincipalSchema.parse(
          service.createPrincipal(context.get("requestContext"), context.req.valid("json")),
        ),
      },
      201,
    ),
  )
  routes.openapi(listPrincipalsRoute, (context) =>
    context.json(
      {
        items: service
          .listPrincipals(context.get("requestContext"))
          .map((item) => PrincipalSchema.parse(item)),
      },
      200,
    ),
  )
  routes.openapi(createProjectRoute, (context) =>
    context.json(
      {
        project: ProjectSchema.parse(
          service.createProject(context.get("requestContext"), context.req.valid("json")),
        ),
      },
      201,
    ),
  )
  routes.openapi(listProjectsRoute, (context) =>
    context.json(
      {
        items: service.list(context.get("requestContext")).map((item) => ProjectSchema.parse(item)),
      },
      200,
    ),
  )
  routes.openapi(getProjectRoute, (context) =>
    context.json(
      {
        project: ProjectSchema.parse(
          service.get(context.get("requestContext"), context.req.valid("param").projectId),
        ),
      },
      200,
    ),
  )
  routes.openapi(listMembersRoute, (context) =>
    context.json(
      {
        items: service
          .members(context.get("requestContext"), context.req.valid("param").projectId)
          .map((item) => ProjectMemberSchema.parse(item)),
      },
      200,
    ),
  )
  routes.openapi(addMemberRoute, (context) =>
    context.json(
      {
        member: ProjectMemberSchema.parse(
          service.addMember(
            context.get("requestContext"),
            context.req.valid("param").projectId,
            context.req.valid("json"),
          ),
        ),
      },
      201,
    ),
  )
  routes.openapi(removeMemberRoute, (context) => {
    const params = context.req.valid("param")
    service.removeMember(context.get("requestContext"), params.projectId, params.principalId)
    return context.body(null, 204)
  })
  routes.openapi(listWorkRoute, (context) =>
    context.json(
      {
        items: service
          .work(context.get("requestContext"), context.req.valid("param").projectId)
          .map((item) => ProjectWorkItemSchema.parse(item)),
      },
      200,
    ),
  )
  return routes
}
