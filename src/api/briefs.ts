import { createRoute, type OpenAPIHono } from "@hono/zod-openapi"
import type { BriefService } from "../services/brief-service"
import {
  type ApiEnv,
  ArtifactIdParamSchema,
  BriefPageSchema,
  BriefResponseSchema,
  CreateBriefRequestSchema,
  CreatedPageQuerySchema,
  createApiRouter,
  errorResponses,
  jsonResponse,
} from "./schemas"

type BriefApi = Pick<BriefService, "create" | "get" | "list">

const createBriefRoute = createRoute({
  method: "post",
  path: "/briefs",
  operationId: "createBrief",
  tags: ["Briefs"],
  summary: "Promote immutable artifact evidence into a reusable brief",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateBriefRequestSchema } },
    },
  },
  responses: {
    200: jsonResponse(BriefResponseSchema, "Existing brief for this artifact entry"),
    201: jsonResponse(BriefResponseSchema, "Brief created"),
    ...errorResponses,
  },
})

const listBriefsRoute = createRoute({
  method: "get",
  path: "/briefs",
  operationId: "listBriefs",
  tags: ["Briefs"],
  summary: "List reusable owner-curated briefs",
  request: { query: CreatedPageQuerySchema },
  responses: { 200: jsonResponse(BriefPageSchema, "Owner-scoped brief page"), ...errorResponses },
})

const getBriefRoute = createRoute({
  method: "get",
  path: "/briefs/{id}",
  operationId: "getBrief",
  tags: ["Briefs"],
  summary: "Get one reusable brief",
  request: { params: ArtifactIdParamSchema },
  responses: { 200: jsonResponse(BriefResponseSchema, "Brief"), ...errorResponses },
})

export const createBriefRoutes = (service: BriefApi): OpenAPIHono<ApiEnv> => {
  const routes = createApiRouter()

  routes.openapi(createBriefRoute, async (context) => {
    const input = context.req.valid("json")
    const result = await service.create(context.get("requestContext"), {
      title: input.title,
      artifactId: input.artifactId,
      ...(input.path === undefined ? {} : { path: input.path }),
    })
    return context.json(
      BriefResponseSchema.parse({ brief: result.brief }),
      result.replayed ? 200 : 201,
    )
  })

  routes.openapi(listBriefsRoute, (context) => {
    const { ownerId } = context.get("requestContext")
    const query = context.req.valid("query")
    return context.json(
      BriefPageSchema.parse(
        service.list(ownerId, {
          limit: query.limit,
          ...(query.before === undefined ? {} : { before: query.before }),
        }),
      ),
      200,
    )
  })

  routes.openapi(getBriefRoute, (context) => {
    const { ownerId } = context.get("requestContext")
    const { id } = context.req.valid("param")
    return context.json(BriefResponseSchema.parse({ brief: service.get(ownerId, id) }), 200)
  })

  return routes
}
