import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import type { ConnectedOnboardingService } from "../services/connected-onboarding-service"
import {
  AgentConnectionResponseSchema,
  type ApiEnv,
  BindProjectRepositoryRequestSchema,
  ConnectAgentRequestSchema,
  ConnectedOnboardingResponseSchema,
  createApiRouter,
  errorResponses,
  IdentifierSchema,
  ImportedProjectRepositoryResponseSchema,
  ImportProjectRepositoryRequestSchema,
  jsonResponse,
  ProjectRepositoryBindingResponseSchema,
  ProjectSelectionResponseSchema,
  SetProjectSelectionRequestSchema,
} from "./schemas"

const connectionParam = z.object({ connectionId: IdentifierSchema }).strict()
const projectParam = z.object({ projectId: IdentifierSchema }).strict()

const snapshotRoute = createRoute({
  method: "get",
  path: "/onboarding",
  operationId: "getConnectedOnboarding",
  tags: ["Connected onboarding"],
  responses: {
    200: jsonResponse(ConnectedOnboardingResponseSchema, "Connected onboarding facts"),
    ...errorResponses,
  },
})

const connectAgentRoute = createRoute({
  method: "post",
  path: "/onboarding/agent-connections",
  operationId: "connectOnboardingAgent",
  tags: ["Connected onboarding"],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ConnectAgentRequestSchema } },
    },
  },
  responses: {
    201: jsonResponse(AgentConnectionResponseSchema, "Agent connection authorized"),
    ...errorResponses,
  },
})

const revokeAgentRoute = createRoute({
  method: "delete",
  path: "/onboarding/agent-connections/{connectionId}",
  operationId: "revokeOnboardingAgent",
  tags: ["Connected onboarding"],
  request: { params: connectionParam },
  responses: {
    200: jsonResponse(AgentConnectionResponseSchema, "Agent connection revoked"),
    ...errorResponses,
  },
})

const selectProjectRoute = createRoute({
  method: "put",
  path: "/onboarding/projects/{projectId}/selection",
  operationId: "setOnboardingProjectSelection",
  tags: ["Connected onboarding"],
  request: {
    params: projectParam,
    body: {
      required: true,
      content: { "application/json": { schema: SetProjectSelectionRequestSchema } },
    },
  },
  responses: {
    200: jsonResponse(ProjectSelectionResponseSchema, "Project Lobby selection updated"),
    ...errorResponses,
  },
})

const bindRepositoryRoute = createRoute({
  method: "put",
  path: "/onboarding/projects/{projectId}/repository",
  operationId: "bindOnboardingProjectRepository",
  tags: ["Connected onboarding"],
  request: {
    params: projectParam,
    body: {
      required: true,
      content: { "application/json": { schema: BindProjectRepositoryRequestSchema } },
    },
  },
  responses: {
    200: jsonResponse(ProjectRepositoryBindingResponseSchema, "Project repository binding updated"),
    ...errorResponses,
  },
})

const importRepositoryRoute = createRoute({
  method: "post",
  path: "/onboarding/projects",
  operationId: "importOnboardingProjectRepository",
  tags: ["Connected onboarding"],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ImportProjectRepositoryRequestSchema } },
    },
  },
  responses: {
    200: jsonResponse(ImportedProjectRepositoryResponseSchema, "Repository imported into Lobby"),
    ...errorResponses,
  },
})

export const createConnectedOnboardingRoutes = (
  service: ConnectedOnboardingService,
): OpenAPIHono<ApiEnv> => {
  const routes = createApiRouter()
  routes.openapi(snapshotRoute, (context) =>
    context.json(
      ConnectedOnboardingResponseSchema.parse(service.snapshot(context.get("requestContext"))),
      200,
    ),
  )
  routes.openapi(connectAgentRoute, (context) =>
    context.json(
      AgentConnectionResponseSchema.parse({
        connection: service.connectAgent(
          context.get("requestContext"),
          context.req.valid("json").agentType,
        ),
      }),
      201,
    ),
  )
  routes.openapi(revokeAgentRoute, (context) =>
    context.json(
      AgentConnectionResponseSchema.parse({
        connection: service.revokeAgentConnection(
          context.get("requestContext"),
          context.req.valid("param").connectionId,
        ),
      }),
      200,
    ),
  )
  routes.openapi(selectProjectRoute, (context) =>
    context.json(
      ProjectSelectionResponseSchema.parse({
        selection: service.selectProject(
          context.get("requestContext"),
          context.req.valid("param").projectId,
          context.req.valid("json").selected,
        ),
      }),
      200,
    ),
  )
  routes.openapi(bindRepositoryRoute, (context) =>
    context.json(
      ProjectRepositoryBindingResponseSchema.parse({
        binding: service.bindRepository(
          context.get("requestContext"),
          context.req.valid("param").projectId,
          context.req.valid("json").grantId,
        ),
      }),
      200,
    ),
  )
  routes.openapi(importRepositoryRoute, (context) =>
    context.json(
      ImportedProjectRepositoryResponseSchema.parse(
        service.importRepository(context.get("requestContext"), context.req.valid("json").grantId),
      ),
      200,
    ),
  )
  return routes
}
