import { createRoute, type OpenAPIHono } from "@hono/zod-openapi"
import type { ApiKeyService } from "../services/api-key-service"
import {
  type ApiEnv,
  ApiKeyPageSchema,
  ApiKeyResponseSchema,
  CreateApiKeyRequestSchema,
  CreatedApiKeyResponseSchema,
  createApiRouter,
  errorResponses,
  IdParamSchema,
  jsonResponse,
} from "./schemas"

const createApiKeyRoute = createRoute({
  method: "post",
  path: "/api-keys",
  operationId: "createApiKey",
  tags: ["API keys"],
  summary: "Create an owner API key",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateApiKeyRequestSchema } },
    },
  },
  responses: {
    201: jsonResponse(CreatedApiKeyResponseSchema, "API key and one-time plaintext secret"),
    ...errorResponses,
  },
})

const listApiKeysRoute = createRoute({
  method: "get",
  path: "/api-keys",
  operationId: "listApiKeys",
  tags: ["API keys"],
  summary: "List safe API-key metadata",
  responses: { 200: jsonResponse(ApiKeyPageSchema, "Owner API keys"), ...errorResponses },
})

const revokeApiKeyRoute = createRoute({
  method: "delete",
  path: "/api-keys/{id}",
  operationId: "revokeApiKey",
  tags: ["API keys"],
  summary: "Revoke an owner API key",
  request: { params: IdParamSchema },
  responses: { 200: jsonResponse(ApiKeyResponseSchema, "Revoked API key"), ...errorResponses },
})

export const createApiKeyRoutes = (
  service: Pick<ApiKeyService, "create" | "list" | "revoke">,
): OpenAPIHono<ApiEnv> => {
  const routes = createApiRouter()
  routes.openapi(createApiKeyRoute, async (context) => {
    const request = context.get("requestContext")
    const { name, principalId } = context.req.valid("json")
    return context.json(
      CreatedApiKeyResponseSchema.parse(
        await service.create(request, name, principalId ?? request.principalId),
      ),
      201,
    )
  })
  routes.openapi(listApiKeysRoute, (context) => {
    return context.json(
      ApiKeyPageSchema.parse({ items: service.list(context.get("requestContext")) }),
      200,
    )
  })
  routes.openapi(revokeApiKeyRoute, (context) => {
    const request = context.get("requestContext")
    const { id } = context.req.valid("param")
    return context.json(ApiKeyResponseSchema.parse({ key: service.revoke(request, id) }), 200)
  })
  return routes
}
