import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import type { PresenceService } from "../services/presence-service"
import {
  type ApiEnv,
  createApiRouter,
  errorResponses,
  IdentifierSchema,
  jsonResponse,
  PresenceLeasePageSchema,
  PresenceLeaseResponseSchema,
  PresenceLeaseSchema,
} from "./schemas"

const projectParam = z.object({ projectId: IdentifierSchema }).strict()
const leaseParam = z.object({ projectId: IdentifierSchema, clientId: IdentifierSchema }).strict()

const listRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}/presence",
  operationId: "listProjectPresence",
  tags: ["Project presence"],
  request: { params: projectParam },
  responses: {
    200: jsonResponse(PresenceLeasePageSchema, "Active Project room presence leases"),
    ...errorResponses,
  },
})

const heartbeatRoute = createRoute({
  method: "put",
  path: "/projects/{projectId}/presence/{clientId}",
  operationId: "heartbeatProjectPresence",
  tags: ["Project presence"],
  request: { params: leaseParam },
  responses: {
    200: jsonResponse(PresenceLeaseResponseSchema, "Active Project room presence lease"),
    ...errorResponses,
  },
})

const releaseRoute = createRoute({
  method: "delete",
  path: "/projects/{projectId}/presence/{clientId}",
  operationId: "releaseProjectPresence",
  tags: ["Project presence"],
  request: { params: leaseParam },
  responses: { 204: { description: "Presence lease released" }, ...errorResponses },
})

export const createPresenceRoutes = (service: PresenceService): OpenAPIHono<ApiEnv> => {
  const routes = createApiRouter()
  routes.openapi(listRoute, (context) =>
    context.json(
      PresenceLeasePageSchema.parse({
        items: service.list(context.get("requestContext"), context.req.valid("param").projectId),
      }),
      200,
    ),
  )
  routes.openapi(heartbeatRoute, (context) =>
    context.json(
      {
        lease: PresenceLeaseSchema.parse(
          service.heartbeat(
            context.get("requestContext"),
            context.req.valid("param").projectId,
            context.req.valid("param").clientId,
          ),
        ),
      },
      200,
    ),
  )
  routes.openapi(releaseRoute, (context) => {
    const params = context.req.valid("param")
    service.release(context.get("requestContext"), params.projectId, params.clientId)
    return context.body(null, 204)
  })
  return routes
}
