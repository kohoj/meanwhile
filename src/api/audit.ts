import { createRoute, type OpenAPIHono } from "@hono/zod-openapi"
import type { AuditService } from "../services/audit-service"
import {
  type ApiEnv,
  AuditPageSchema,
  AuditQuerySchema,
  createApiRouter,
  errorResponses,
  jsonResponse,
} from "./schemas"

const listAuditRoute = createRoute({
  method: "get",
  path: "/audit",
  operationId: "listAuditRecords",
  tags: ["Audit"],
  summary: "List append-only owner mutation evidence",
  request: { query: AuditQuerySchema },
  responses: {
    200: jsonResponse(AuditPageSchema, "Owner-scoped audit page"),
    ...errorResponses,
  },
})

export const createAuditRoutes = (service: Pick<AuditService, "list">): OpenAPIHono<ApiEnv> => {
  const routes = createApiRouter()
  routes.openapi(listAuditRoute, (context) => {
    const request = context.get("requestContext")
    const query = context.req.valid("query")
    return context.json(
      AuditPageSchema.parse(
        service.list(request, {
          limit: query.limit,
          ...(query.before === undefined ? {} : { before: query.before }),
          ...(query.resourceType === undefined ? {} : { resourceType: query.resourceType }),
          ...(query.resourceId === undefined ? {} : { resourceId: query.resourceId }),
          ...(query.action === undefined ? {} : { action: query.action }),
        }),
      ),
      200,
    )
  })
  return routes
}
