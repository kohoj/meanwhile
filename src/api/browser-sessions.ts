import { createRoute, type OpenAPIHono } from "@hono/zod-openapi"
import type { BrowserSessionService } from "../services/browser-session-service"
import {
  type ApiEnv,
  BrowserSessionResponseSchema,
  CreatedBrowserSessionResponseSchema,
  createApiRouter,
  errorResponses,
  jsonResponse,
} from "./schemas"

const createRouteDefinition = createRoute({
  method: "post",
  path: "/browser-sessions",
  operationId: "createBrowserSession",
  tags: ["Browser sessions"],
  responses: {
    201: jsonResponse(
      CreatedBrowserSessionResponseSchema,
      "Opaque browser session and one-time secret",
    ),
    ...errorResponses,
  },
})

const revokeRouteDefinition = createRoute({
  method: "delete",
  path: "/browser-sessions/current",
  operationId: "revokeCurrentBrowserSession",
  tags: ["Browser sessions"],
  responses: {
    200: jsonResponse(BrowserSessionResponseSchema, "Revoked browser session"),
    ...errorResponses,
  },
})

export const createBrowserSessionRoutes = (service: BrowserSessionService): OpenAPIHono<ApiEnv> => {
  const routes = createApiRouter()
  routes.openapi(createRouteDefinition, async (context) =>
    context.json(
      CreatedBrowserSessionResponseSchema.parse(
        await service.create(context.get("requestContext")),
      ),
      201,
    ),
  )
  routes.openapi(revokeRouteDefinition, (context) =>
    context.json(
      BrowserSessionResponseSchema.parse({
        session: service.revokeCurrent(context.get("requestContext")),
      }),
      200,
    ),
  )
  return routes
}
