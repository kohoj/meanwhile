import { createRoute, type OpenAPIHono } from "@hono/zod-openapi"
import type { PrincipalInvitationService } from "../services/principal-invitation-service"
import {
  type ApiEnv,
  CreatedPrincipalInvitationResponseSchema,
  CreatePrincipalInvitationRequestSchema,
  createApiRouter,
  errorResponses,
  IdParamSchema,
  jsonResponse,
  PrincipalInvitationPageSchema,
  PrincipalInvitationResponseSchema,
} from "./schemas"

const createInvitationRoute = createRoute({
  method: "post",
  path: "/principal-invitations",
  operationId: "createPrincipalInvitation",
  tags: ["Principal invitations"],
  summary: "Create a single-use external identity invitation",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreatePrincipalInvitationRequestSchema } },
    },
  },
  responses: {
    201: jsonResponse(
      CreatedPrincipalInvitationResponseSchema,
      "Invitation metadata and one-time plaintext secret",
    ),
    ...errorResponses,
  },
})

const listInvitationsRoute = createRoute({
  method: "get",
  path: "/principal-invitations",
  operationId: "listPrincipalInvitations",
  tags: ["Principal invitations"],
  summary: "List safe invitation metadata",
  responses: {
    200: jsonResponse(PrincipalInvitationPageSchema, "Principal invitations"),
    ...errorResponses,
  },
})

const revokeInvitationRoute = createRoute({
  method: "delete",
  path: "/principal-invitations/{id}",
  operationId: "revokePrincipalInvitation",
  tags: ["Principal invitations"],
  summary: "Revoke an unredeemed invitation",
  request: { params: IdParamSchema },
  responses: {
    200: jsonResponse(PrincipalInvitationResponseSchema, "Revoked invitation"),
    ...errorResponses,
  },
})

export const createPrincipalInvitationRoutes = (
  service: Pick<PrincipalInvitationService, "create" | "list" | "revoke">,
): OpenAPIHono<ApiEnv> => {
  const routes = createApiRouter()
  routes.openapi(createInvitationRoute, async (context) => {
    const body = context.req.valid("json")
    return context.json(
      CreatedPrincipalInvitationResponseSchema.parse(
        await service.create(
          context.get("requestContext"),
          body.principalId,
          body.expiresInSeconds,
        ),
      ),
      201,
    )
  })
  routes.openapi(listInvitationsRoute, (context) =>
    context.json(
      PrincipalInvitationPageSchema.parse({
        items: service.list(context.get("requestContext")),
      }),
      200,
    ),
  )
  routes.openapi(revokeInvitationRoute, (context) =>
    context.json(
      PrincipalInvitationResponseSchema.parse({
        invitation: service.revoke(context.get("requestContext"), context.req.valid("param").id),
      }),
      200,
    ),
  )
  return routes
}
