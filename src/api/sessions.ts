import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import { streamSSE } from "hono/streaming"
import { errorEnvelope, normalizeError } from "../errors"
import type { SessionService } from "../services/session-service"
import { parseLastEventId } from "./cursor"
import {
  AgentSessionPageSchema,
  AgentSessionResponseSchema,
  AgentSessionSchema,
  type ApiEnv,
  CreatedPageQuerySchema,
  CreateSessionRequestSchema,
  CreateSessionTurnRequestSchema,
  CursorQuerySchema,
  createApiRouter,
  errorResponses,
  IdempotencyHeaderSchema,
  IdentifierSchema,
  IdParamSchema,
  jsonResponse,
  LogQuerySchema,
  SessionEventPageSchema,
  SessionEventSchema,
  SessionTurnPageSchema,
  SessionTurnResponseSchema,
  SessionTurnSchema,
} from "./schemas"

const createSessionRoute = createRoute({
  method: "post",
  path: "/sessions",
  operationId: "createSession",
  tags: ["Sessions"],
  summary: "Create a durable ACP session",
  request: {
    headers: IdempotencyHeaderSchema,
    body: {
      required: true,
      content: { "application/json": { schema: CreateSessionRequestSchema } },
    },
  },
  responses: {
    200: jsonResponse(AgentSessionResponseSchema, "Existing idempotent session"),
    201: jsonResponse(AgentSessionResponseSchema, "Session created"),
    ...errorResponses,
  },
})

const listSessionsRoute = createRoute({
  method: "get",
  path: "/sessions",
  operationId: "listSessions",
  tags: ["Sessions"],
  summary: "List sessions owned by the caller",
  request: { query: CreatedPageQuerySchema },
  responses: {
    200: jsonResponse(AgentSessionPageSchema, "Owner-scoped sessions"),
    ...errorResponses,
  },
})

const getSessionRoute = createRoute({
  method: "get",
  path: "/sessions/{id}",
  operationId: "getSession",
  tags: ["Sessions"],
  request: { params: IdParamSchema },
  responses: { 200: jsonResponse(AgentSessionResponseSchema, "Session"), ...errorResponses },
})

const createTurnRoute = createRoute({
  method: "post",
  path: "/sessions/{id}/turns",
  operationId: "createSessionTurn",
  tags: ["Sessions"],
  summary: "Submit one prompt turn with an explicit conflict policy",
  request: {
    params: IdParamSchema,
    headers: IdempotencyHeaderSchema,
    body: {
      required: true,
      content: { "application/json": { schema: CreateSessionTurnRequestSchema } },
    },
  },
  responses: {
    200: jsonResponse(SessionTurnResponseSchema, "Existing idempotent turn"),
    201: jsonResponse(SessionTurnResponseSchema, "Turn created"),
    ...errorResponses,
  },
})

const listTurnsRoute = createRoute({
  method: "get",
  path: "/sessions/{id}/turns",
  operationId: "listSessionTurns",
  tags: ["Sessions"],
  request: { params: IdParamSchema, query: CursorQuerySchema },
  responses: { 200: jsonResponse(SessionTurnPageSchema, "Session turns"), ...errorResponses },
})

const getTurnRoute = createRoute({
  method: "get",
  path: "/sessions/{id}/turns/{turnId}",
  operationId: "getSessionTurn",
  tags: ["Sessions"],
  summary: "Get one turn without scanning session history",
  request: {
    params: z.object({ id: IdentifierSchema, turnId: IdentifierSchema }).strict(),
  },
  responses: { 200: jsonResponse(SessionTurnResponseSchema, "Session turn"), ...errorResponses },
})

const sessionCommandRoute = (
  path: "/sessions/{id}/interrupt" | "/sessions/{id}/close",
  operationId: string,
  summary: string,
) =>
  createRoute({
    method: "post",
    path,
    operationId,
    tags: ["Sessions"],
    summary,
    request: { params: IdParamSchema },
    responses: {
      202: jsonResponse(AgentSessionResponseSchema, "Command accepted"),
      ...errorResponses,
    },
  })

const interruptSessionRoute = sessionCommandRoute(
  "/sessions/{id}/interrupt",
  "interruptSession",
  "Interrupt the active turn while preserving the session",
)
const closeSessionRoute = sessionCommandRoute(
  "/sessions/{id}/close",
  "closeSession",
  "Close the ACP session and release its runtime lease",
)

const getSessionEventsRoute = createRoute({
  method: "get",
  path: "/sessions/{id}/events",
  operationId: "listSessionEvents",
  tags: ["Sessions"],
  summary: "Read or follow the durable cross-turn event stream",
  request: {
    params: IdParamSchema,
    query: LogQuerySchema,
    headers: z.object({ "Last-Event-ID": z.string().max(32).optional() }),
  },
  responses: {
    200: {
      description: "A durable event page or resumable SSE stream",
      content: {
        "application/json": { schema: SessionEventPageSchema },
        "text/event-stream": { schema: z.string() },
      },
    },
    ...errorResponses,
  },
})

export const createSessionRoutes = (service: SessionService): OpenAPIHono<ApiEnv> => {
  const routes = createApiRouter()

  routes.openapi(createSessionRoute, async (context) => {
    const request = context.get("requestContext")
    const input = context.req.valid("json")
    const workspace =
      input.workspace.type === "files"
        ? {
            type: "files" as const,
            files: input.workspace.files.map((file) => ({
              path: file.path,
              content: Uint8Array.fromBase64(file.contentBase64),
              ...(file.mode === undefined ? {} : { mode: file.mode }),
            })),
          }
        : input.workspace.type === "bundle"
          ? input.workspace
          : {
              type: "repository" as const,
              url: input.workspace.url,
              ...(input.workspace.revision === undefined
                ? {}
                : { revision: input.workspace.revision }),
              ...(input.workspace.credentialRef === undefined
                ? {}
                : { credentialRef: input.workspace.credentialRef }),
            }
    const { provider, ...sessionInput } = input
    const result = await service.create(
      request,
      { ...sessionInput, workspace, ...(provider === undefined ? {} : { provider }) },
      context.req.valid("header")["idempotency-key"],
    )
    const response = { session: AgentSessionSchema.parse(result.session) }
    return result.replayed ? context.json(response, 200) : context.json(response, 201)
  })

  routes.openapi(listSessionsRoute, (context) => {
    const { ownerId } = context.get("requestContext")
    const query = context.req.valid("query")
    const page = service.list(ownerId, {
      limit: query.limit,
      ...(query.before === undefined ? {} : { before: query.before }),
    })
    return context.json(
      {
        items: page.items.map((item) => AgentSessionSchema.parse(item)),
        nextCursor: page.nextCursor,
      },
      200,
    )
  })

  routes.openapi(getSessionRoute, (context) => {
    const { ownerId } = context.get("requestContext")
    return context.json(
      { session: AgentSessionSchema.parse(service.get(ownerId, context.req.valid("param").id)) },
      200,
    )
  })

  routes.openapi(createTurnRoute, (context) => {
    const request = context.get("requestContext")
    const result = service.send(
      request,
      context.req.valid("param").id,
      context.req.valid("json"),
      context.req.valid("header")["idempotency-key"],
    )
    const response = { turn: SessionTurnSchema.parse(result.turn) }
    return result.replayed ? context.json(response, 200) : context.json(response, 201)
  })

  routes.openapi(listTurnsRoute, (context) => {
    const { ownerId } = context.get("requestContext")
    const id = context.req.valid("param").id
    const query = context.req.valid("query")
    const page = service.turns(ownerId, id, query)
    return context.json(
      {
        items: page.items.map((turn) => SessionTurnSchema.parse(turn)),
        nextCursor: page.nextCursor,
      },
      200,
    )
  })

  routes.openapi(getTurnRoute, (context) => {
    const { ownerId } = context.get("requestContext")
    const { id, turnId } = context.req.valid("param")
    return context.json(
      { turn: SessionTurnSchema.parse(service.getTurn(ownerId, id, turnId)) },
      200,
    )
  })

  routes.openapi(interruptSessionRoute, (context) => {
    const request = context.get("requestContext")
    return context.json(
      {
        session: AgentSessionSchema.parse(
          service.interrupt(request, context.req.valid("param").id),
        ),
      },
      202,
    )
  })

  routes.openapi(closeSessionRoute, (context) => {
    const request = context.get("requestContext")
    return context.json(
      { session: AgentSessionSchema.parse(service.close(request, context.req.valid("param").id)) },
      202,
    )
  })

  routes.openapi(getSessionEventsRoute, async (context) => {
    const request = context.get("requestContext")
    const { ownerId } = request
    const id = context.req.valid("param").id
    const { follow, after, limit } = context.req.valid("query")
    if (!follow) {
      const page = service.events(ownerId, id, { after, limit })
      return context.json(
        {
          items: page.items.map((item) => SessionEventSchema.parse(item)),
          nextCursor: page.nextCursor,
        },
        200,
      )
    }
    const resumeAt = Math.max(after, parseLastEventId(context.req.valid("header")["Last-Event-ID"]))
    service.get(ownerId, id)
    return streamSSE(
      context,
      async (stream) => {
        const cancellation = new AbortController()
        const abort = () => cancellation.abort()
        stream.onAbort(abort)
        context.req.raw.signal.addEventListener("abort", abort, { once: true })
        if (context.req.raw.signal.aborted) abort()
        try {
          await stream.writeSSE({ event: "ready", data: "{}", retry: 1_000 })
          for await (const event of service.followEvents(
            ownerId,
            id,
            resumeAt,
            cancellation.signal,
          )) {
            if (event === null) await stream.writeSSE({ event: "heartbeat", data: "{}" })
            else
              await stream.writeSSE({
                event: "event",
                id: String(event.sequence),
                data: JSON.stringify(event),
              })
          }
          await stream.writeSSE({ event: "end", data: "{}" })
        } finally {
          context.req.raw.signal.removeEventListener("abort", abort)
        }
      },
      async (error, stream) => {
        if (!stream.aborted) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify(errorEnvelope(normalizeError(error), request.requestId)),
          })
        }
      },
    )
  })

  return routes
}
