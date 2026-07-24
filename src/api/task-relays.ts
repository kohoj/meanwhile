import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import type { TaskRelayService } from "../services/task-relay-service"
import {
  type ApiEnv,
  CreateTaskRelayRequestSchema,
  createApiRouter,
  errorResponses,
  IdentifierSchema,
  jsonResponse,
  TaskRelayPageSchema,
  TaskRelayResponseSchema,
  TaskRelaySchema,
} from "./schemas"

const ProjectParamSchema = z.object({ projectId: IdentifierSchema }).strict()
const RelayParamSchema = z
  .object({ projectId: IdentifierSchema, relayId: IdentifierSchema })
  .strict()
const TaskRelayQuerySchema = z
  .object({ taskKind: z.enum(["run", "session"]), taskId: IdentifierSchema })
  .strict()
const RecentRelayQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(20).default(3) })
  .strict()

const createRelayRoute = createRoute({
  method: "post",
  path: "/projects/{projectId}/relays",
  operationId: "createTaskRelay",
  tags: ["Task Relays"],
  request: {
    params: ProjectParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: CreateTaskRelayRequestSchema } },
    },
  },
  responses: { 201: jsonResponse(TaskRelayResponseSchema, "Relay created"), ...errorResponses },
})

const listRelaysRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}/relays",
  operationId: "listTaskRelays",
  tags: ["Task Relays"],
  request: { params: ProjectParamSchema, query: TaskRelayQuerySchema },
  responses: { 200: jsonResponse(TaskRelayPageSchema, "Task Relays"), ...errorResponses },
})

const relayInboxRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}/relay-inbox",
  operationId: "listPendingTaskRelays",
  tags: ["Task Relays"],
  request: { params: ProjectParamSchema },
  responses: { 200: jsonResponse(TaskRelayPageSchema, "Pending Relays"), ...errorResponses },
})

const recentRelaysRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}/recent-relays",
  operationId: "listRecentProjectTaskRelays",
  tags: ["Task Relays"],
  request: { params: ProjectParamSchema, query: RecentRelayQuerySchema },
  responses: { 200: jsonResponse(TaskRelayPageSchema, "Recent Project Relays"), ...errorResponses },
})

const acknowledgeRelayRoute = createRoute({
  method: "post",
  path: "/projects/{projectId}/relays/{relayId}/acknowledge",
  operationId: "acknowledgeTaskRelay",
  tags: ["Task Relays"],
  request: { params: RelayParamSchema },
  responses: {
    200: jsonResponse(TaskRelayResponseSchema, "Relay acknowledged"),
    ...errorResponses,
  },
})

export const createTaskRelayRoutes = (service: TaskRelayService): OpenAPIHono<ApiEnv> => {
  const routes = createApiRouter()
  routes.openapi(createRelayRoute, (context) =>
    context.json(
      {
        relay: TaskRelaySchema.parse(
          service.create(
            context.get("requestContext"),
            context.req.valid("param").projectId,
            context.req.valid("json"),
          ),
        ),
      },
      201,
    ),
  )
  routes.openapi(listRelaysRoute, (context) => {
    const params = context.req.valid("param")
    const query = context.req.valid("query")
    return context.json(
      {
        items: service
          .list(context.get("requestContext"), params.projectId, {
            kind: query.taskKind,
            id: query.taskId,
          })
          .map((relay) => TaskRelaySchema.parse(relay)),
      },
      200,
    )
  })
  routes.openapi(relayInboxRoute, (context) =>
    context.json(
      {
        items: service
          .inbox(context.get("requestContext"), context.req.valid("param").projectId)
          .map((relay) => TaskRelaySchema.parse(relay)),
      },
      200,
    ),
  )
  routes.openapi(recentRelaysRoute, (context) =>
    context.json(
      {
        items: service
          .recent(
            context.get("requestContext"),
            context.req.valid("param").projectId,
            context.req.valid("query").limit,
          )
          .map((relay) => TaskRelaySchema.parse(relay)),
      },
      200,
    ),
  )
  routes.openapi(acknowledgeRelayRoute, (context) => {
    const params = context.req.valid("param")
    return context.json(
      {
        relay: TaskRelaySchema.parse(
          service.acknowledge(context.get("requestContext"), params.projectId, params.relayId),
        ),
      },
      200,
    )
  })
  return routes
}
