import { createRoute, type OpenAPIHono } from "@hono/zod-openapi"
import type { ConnectorDeviceService } from "../services/connector-device-service"
import {
  AdoptConnectorDeviceRequestSchema,
  AdoptedConnectorDeviceResponseSchema,
  type ApiEnv,
  ConnectorDevicePageSchema,
  ConnectorDeviceResponseSchema,
  ConnectorSetupResponseSchema,
  ConversationShareGrantPageSchema,
  ConversationShareGrantResponseSchema,
  CreateConnectorDeviceRequestSchema,
  CreateConversationShareGrantRequestSchema,
  CreatedConnectorDeviceResponseSchema,
  createApiRouter,
  errorResponses,
  IdParamSchema,
  jsonResponse,
} from "./schemas"

const adoptRouteDefinition = createRoute({
  method: "post",
  path: "/connector-devices/adopt",
  operationId: "adoptConnectorDevice",
  tags: ["Connector Devices"],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: AdoptConnectorDeviceRequestSchema } },
    },
  },
  responses: {
    201: jsonResponse(AdoptedConnectorDeviceResponseSchema, "Adopted device and Project grant"),
    ...errorResponses,
  },
})

const createRouteDefinition = createRoute({
  method: "post",
  path: "/connector-devices",
  operationId: "createConnectorDevice",
  tags: ["Connector Devices"],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateConnectorDeviceRequestSchema } },
    },
  },
  responses: {
    201: jsonResponse(CreatedConnectorDeviceResponseSchema, "Device and one-time secret"),
    ...errorResponses,
  },
})

const listRouteDefinition = createRoute({
  method: "get",
  path: "/connector-devices",
  operationId: "listConnectorDevices",
  tags: ["Connector Devices"],
  responses: {
    200: jsonResponse(ConnectorDevicePageSchema, "Connector devices"),
    ...errorResponses,
  },
})

const revokeRouteDefinition = createRoute({
  method: "delete",
  path: "/connector-devices/{id}",
  operationId: "revokeConnectorDevice",
  tags: ["Connector Devices"],
  request: { params: IdParamSchema },
  responses: {
    200: jsonResponse(ConnectorDeviceResponseSchema, "Revoked device"),
    ...errorResponses,
  },
})

const createGrantRouteDefinition = createRoute({
  method: "post",
  path: "/connector-devices/{id}/grants",
  operationId: "createConversationShareGrant",
  tags: ["Connector Devices"],
  request: {
    params: IdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: CreateConversationShareGrantRequestSchema } },
    },
  },
  responses: {
    201: jsonResponse(ConversationShareGrantResponseSchema, "Conversation share grant"),
    ...errorResponses,
  },
})

const listGrantsRouteDefinition = createRoute({
  method: "get",
  path: "/conversation-share-grants",
  operationId: "listConversationShareGrants",
  tags: ["Connector Devices"],
  responses: {
    200: jsonResponse(ConversationShareGrantPageSchema, "Conversation share grants"),
    ...errorResponses,
  },
})

const revokeGrantRouteDefinition = createRoute({
  method: "delete",
  path: "/conversation-share-grants/{id}",
  operationId: "revokeConversationShareGrant",
  tags: ["Connector Devices"],
  request: { params: IdParamSchema },
  responses: {
    200: jsonResponse(ConversationShareGrantResponseSchema, "Revoked conversation share grant"),
    ...errorResponses,
  },
})

const heartbeatRouteDefinition = createRoute({
  method: "post",
  path: "/connector/v1/heartbeat",
  operationId: "heartbeatConnectorDevice",
  tags: ["Local Connector"],
  security: [{ ConnectorAuth: [] }],
  responses: {
    200: jsonResponse(ConnectorDeviceResponseSchema, "Live connector device"),
    ...errorResponses,
  },
})

const setupRouteDefinition = createRoute({
  method: "get",
  path: "/connector/v1/setup",
  operationId: "getConnectorSetup",
  tags: ["Local Connector"],
  security: [{ ConnectorAuth: [] }],
  responses: {
    200: jsonResponse(ConnectorSetupResponseSchema, "Current device and active Project grants"),
    ...errorResponses,
  },
})

export const createConnectorDeviceRoutes = (
  service: ConnectorDeviceService,
): OpenAPIHono<ApiEnv> => {
  const routes = createApiRouter()
  routes.openapi(adoptRouteDefinition, (context) =>
    context.json(
      AdoptedConnectorDeviceResponseSchema.parse(
        service.adopt(context.get("requestContext"), context.req.valid("json")),
      ),
      201,
    ),
  )
  routes.openapi(createRouteDefinition, async (context) =>
    context.json(
      CreatedConnectorDeviceResponseSchema.parse(
        await service.create(context.get("requestContext"), context.req.valid("json")),
      ),
      201,
    ),
  )
  routes.openapi(listRouteDefinition, (context) =>
    context.json(
      ConnectorDevicePageSchema.parse({ items: service.list(context.get("requestContext")) }),
      200,
    ),
  )
  routes.openapi(revokeRouteDefinition, (context) =>
    context.json(
      ConnectorDeviceResponseSchema.parse({
        device: service.revoke(context.get("requestContext"), context.req.valid("param").id),
      }),
      200,
    ),
  )
  routes.openapi(createGrantRouteDefinition, (context) =>
    context.json(
      ConversationShareGrantResponseSchema.parse({
        grant: service.grantProject(
          context.get("requestContext"),
          context.req.valid("param").id,
          context.req.valid("json").projectId,
        ),
      }),
      201,
    ),
  )
  routes.openapi(listGrantsRouteDefinition, (context) =>
    context.json(
      ConversationShareGrantPageSchema.parse({
        items: service.listGrants(context.get("requestContext")),
      }),
      200,
    ),
  )
  routes.openapi(revokeGrantRouteDefinition, (context) =>
    context.json(
      ConversationShareGrantResponseSchema.parse({
        grant: service.revokeGrant(context.get("requestContext"), context.req.valid("param").id),
      }),
      200,
    ),
  )
  return routes
}

export const createConnectorHeartbeatRoutes = (
  service: ConnectorDeviceService,
): OpenAPIHono<ApiEnv> => {
  const routes = createApiRouter()
  routes.openapi(setupRouteDefinition, (context) =>
    context.json(
      ConnectorSetupResponseSchema.parse(service.setup(context.get("requestContext"))),
      200,
    ),
  )
  routes.openapi(heartbeatRouteDefinition, (context) =>
    context.json(
      ConnectorDeviceResponseSchema.parse({
        device: service.current(context.get("requestContext")),
      }),
      200,
    ),
  )
  return routes
}
