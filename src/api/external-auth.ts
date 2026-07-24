import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import type { ExternalIdentityProvider } from "../domain"
import type { ExternalAuthService } from "../services/external-auth-service"
import {
  type ApiEnv,
  BrowserSessionSchema,
  createApiRouter,
  createPublicApiRouter,
  ExternalIdentitySchema,
  ExternalProjectGrantSchema,
  errorResponses,
  jsonResponse,
} from "./schemas"

const providerSchema = z.enum(["github", "google"])
const providerParam = z.object({ provider: providerSchema }).strict()
const providerSummarySchema = z
  .object({ provider: providerSchema, label: z.string().min(1).max(80) })
  .strict()
const providersResponseSchema = z
  .object({
    providers: z.array(providerSummarySchema).readonly(),
    registration: z.enum(["closed", "open"]),
  })
  .strict()
const startResponseSchema = z.object({ authorizationUrl: z.string().url().max(16_384) }).strict()
const startInvitationRequestSchema = z
  .object({ secret: z.string().regex(/^mwi_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/) })
  .strict()
const callbackRequestSchema = z
  .object({
    state: z.string().min(1).max(32_768),
    code: z.string().min(1).max(4_096).nullable(),
    error: z.string().min(1).max(255).nullable(),
  })
  .strict()
const callbackResponseSchema = z
  .object({
    identity: ExternalIdentitySchema,
    repositoryGrants: z.array(ExternalProjectGrantSchema).readonly(),
    session: BrowserSessionSchema,
    secret: z.string().regex(/^mws_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/),
    intent: z.enum(["login", "link", "invite"]),
  })
  .strict()

const providersRoute = createRoute({
  method: "get",
  path: "/external-auth/providers",
  operationId: "listExternalAuthProviders",
  tags: ["External authentication"],
  responses: {
    200: jsonResponse(providersResponseSchema, "Configured external identity providers"),
    ...errorResponses,
  },
})

const startLoginRoute = createRoute({
  method: "post",
  path: "/external-auth/{provider}/login",
  operationId: "startExternalLogin",
  tags: ["External authentication"],
  request: { params: providerParam },
  responses: {
    200: jsonResponse(startResponseSchema, "Provider authorization URL"),
    ...errorResponses,
  },
})

const callbackRoute = createRoute({
  method: "post",
  path: "/external-auth/{provider}/callback",
  operationId: "completeExternalAuthentication",
  tags: ["External authentication"],
  request: {
    params: providerParam,
    body: {
      required: true,
      content: { "application/json": { schema: callbackRequestSchema } },
    },
  },
  responses: {
    201: jsonResponse(callbackResponseSchema, "Authenticated browser session"),
    ...errorResponses,
  },
})

const startInvitationRoute = createRoute({
  method: "post",
  path: "/external-auth/{provider}/invite",
  operationId: "startExternalInvitation",
  tags: ["External authentication"],
  request: {
    params: providerParam,
    body: {
      required: true,
      content: { "application/json": { schema: startInvitationRequestSchema } },
    },
  },
  responses: {
    200: jsonResponse(startResponseSchema, "Provider authorization URL for invitation redemption"),
    ...errorResponses,
  },
})

const invitationCallbackRoute = createRoute({
  method: "post",
  path: "/external-auth/{provider}/invite-callback",
  operationId: "completeExternalInvitation",
  tags: ["External authentication"],
  request: {
    params: providerParam,
    body: {
      required: true,
      content: { "application/json": { schema: callbackRequestSchema } },
    },
  },
  responses: {
    201: jsonResponse(callbackResponseSchema, "Redeemed invitation and browser session"),
    ...errorResponses,
  },
})

const linkCallbackRoute = createRoute({
  method: "post",
  path: "/external-auth/{provider}/link-callback",
  operationId: "completeExternalIdentityLink",
  tags: ["External authentication"],
  request: {
    params: providerParam,
    body: {
      required: true,
      content: { "application/json": { schema: callbackRequestSchema } },
    },
  },
  responses: {
    201: jsonResponse(callbackResponseSchema, "Linked identity and authenticated browser session"),
    ...errorResponses,
  },
})

const startLinkRoute = createRoute({
  method: "post",
  path: "/external-auth/{provider}/link",
  operationId: "startExternalIdentityLink",
  tags: ["External authentication"],
  request: { params: providerParam },
  responses: {
    200: jsonResponse(startResponseSchema, "Provider authorization URL for identity linking"),
    ...errorResponses,
  },
})

export const createPublicExternalAuthRoutes = (
  service: ExternalAuthService,
): OpenAPIHono<ApiEnv> => {
  const routes = createPublicApiRouter()
  routes.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store")
    await next()
  })
  routes.openapi(providersRoute, (context) =>
    context.json(
      providersResponseSchema.parse({
        providers: service.providers(),
        registration: service.registrationPolicy(),
      }),
      200,
    ),
  )
  routes.openapi(startLoginRoute, async (context) =>
    context.json(
      startResponseSchema.parse(
        await service.startLogin(context.req.valid("param").provider as ExternalIdentityProvider),
      ),
      200,
    ),
  )
  routes.openapi(startInvitationRoute, async (context) => {
    const provider = context.req.valid("param").provider as ExternalIdentityProvider
    return context.json(
      startResponseSchema.parse(
        await service.startInvitation(provider, context.req.valid("json").secret),
      ),
      200,
    )
  })
  routes.openapi(callbackRoute, async (context) => {
    const provider = context.req.valid("param").provider as ExternalIdentityProvider
    const body = context.req.valid("json")
    const completed = await service.callback({
      provider,
      expectedIntent: "login",
      state: body.state,
      code: body.code,
      providerError: body.error,
      request: {
        requestId: context.get("requestId"),
        traceId: context.get("traceId"),
      },
      signal: context.req.raw.signal,
    })
    return context.json(
      callbackResponseSchema.parse({
        identity: completed.identity,
        repositoryGrants: completed.grants,
        session: completed.session,
        secret: completed.secret,
        intent: completed.intent,
      }),
      201,
    )
  })
  routes.openapi(invitationCallbackRoute, async (context) => {
    const provider = context.req.valid("param").provider as ExternalIdentityProvider
    const body = context.req.valid("json")
    const completed = await service.callback({
      provider,
      expectedIntent: "invite",
      state: body.state,
      code: body.code,
      providerError: body.error,
      request: {
        requestId: context.get("requestId"),
        traceId: context.get("traceId"),
      },
      signal: context.req.raw.signal,
    })
    return context.json(
      callbackResponseSchema.parse({
        identity: completed.identity,
        repositoryGrants: completed.grants,
        session: completed.session,
        secret: completed.secret,
        intent: completed.intent,
      }),
      201,
    )
  })
  return routes
}

export const createProtectedExternalAuthRoutes = (
  service: ExternalAuthService,
): OpenAPIHono<ApiEnv> => {
  const routes = createApiRouter()
  routes.openapi(startLinkRoute, async (context) =>
    context.json(
      startResponseSchema.parse(
        await service.startLink(
          context.req.valid("param").provider as ExternalIdentityProvider,
          context.get("requestContext"),
        ),
      ),
      200,
    ),
  )
  routes.openapi(linkCallbackRoute, async (context) => {
    const provider = context.req.valid("param").provider as ExternalIdentityProvider
    const body = context.req.valid("json")
    const completed = await service.callback({
      provider,
      expectedIntent: "link",
      context: context.get("requestContext"),
      state: body.state,
      code: body.code,
      providerError: body.error,
      request: {
        requestId: context.get("requestId"),
        traceId: context.get("traceId"),
      },
      signal: context.req.raw.signal,
    })
    return context.json(
      callbackResponseSchema.parse({
        identity: completed.identity,
        repositoryGrants: completed.grants,
        session: completed.session,
        secret: completed.secret,
        intent: completed.intent,
      }),
      201,
    )
  })
  return routes
}
