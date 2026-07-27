import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import { streamSSE } from "hono/streaming"
import { errorEnvelope, normalizeError } from "../errors"
import type { ConversationMirrorService } from "../services/conversation-mirror-service"
import { parseLastEventId } from "./cursor"
import {
  type ApiEnv,
  AppendedMirrorEventsResponseSchema,
  AppendMirrorEventsRequestSchema,
  ConversationMirrorResponseSchema,
  createApiRouter,
  errorResponses,
  IdParamSchema,
  jsonResponse,
  LogQuerySchema,
  MirrorCheckpointSchema,
  MirrorEventPageSchema,
  MirrorEventSchema,
  UpsertConversationMirrorRequestSchema,
} from "./schemas"

const upsertMirrorRoute = createRoute({
  method: "post",
  path: "/connector/v1/mirrors",
  operationId: "upsertConversationMirror",
  tags: ["Local Connector"],
  security: [{ ConnectorAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: UpsertConversationMirrorRequestSchema } },
    },
  },
  responses: {
    200: jsonResponse(ConversationMirrorResponseSchema, "Existing linked conversation"),
    201: jsonResponse(ConversationMirrorResponseSchema, "Linked conversation created"),
    ...errorResponses,
  },
})

const appendEventsRoute = createRoute({
  method: "post",
  path: "/connector/v1/mirrors/{id}/events",
  operationId: "appendConversationMirrorEvents",
  tags: ["Local Connector"],
  security: [{ ConnectorAuth: [] }],
  request: {
    params: IdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: AppendMirrorEventsRequestSchema } },
    },
  },
  responses: {
    200: jsonResponse(AppendedMirrorEventsResponseSchema, "Accepted or exactly replayed events"),
    ...errorResponses,
  },
})

const checkpointRoute = createRoute({
  method: "get",
  path: "/connector/v1/mirrors/{id}/checkpoint",
  operationId: "getConversationMirrorCheckpoint",
  tags: ["Local Connector"],
  security: [{ ConnectorAuth: [] }],
  request: { params: IdParamSchema },
  responses: {
    200: jsonResponse(MirrorCheckpointSchema, "Highest contiguous accepted event"),
    ...errorResponses,
  },
})

const getMirrorRoute = createRoute({
  method: "get",
  path: "/mirrors/{id}",
  operationId: "getConversationMirror",
  tags: ["Conversation Mirrors"],
  request: { params: IdParamSchema },
  responses: {
    200: jsonResponse(ConversationMirrorResponseSchema, "Linked conversation"),
    ...errorResponses,
  },
})

const getMirrorEventsRoute = createRoute({
  method: "get",
  path: "/mirrors/{id}/events",
  operationId: "listConversationMirrorEvents",
  tags: ["Conversation Mirrors"],
  request: {
    params: IdParamSchema,
    query: LogQuerySchema,
    headers: z.object({ "Last-Event-ID": z.string().max(32).optional() }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: MirrorEventPageSchema },
        "text/event-stream": { schema: MirrorEventSchema },
      },
      description: "Mirror events or a resumable event stream",
    },
    ...errorResponses,
  },
})

export const createConnectorMirrorRoutes = (
  service: ConversationMirrorService,
): OpenAPIHono<ApiEnv> => {
  const routes = createApiRouter()
  routes.openapi(upsertMirrorRoute, (context) =>
    context.json(
      ConversationMirrorResponseSchema.parse({
        mirror: service.upsert(context.get("requestContext"), context.req.valid("json")),
      }),
      201,
    ),
  )
  routes.openapi(appendEventsRoute, (context) =>
    context.json(
      AppendedMirrorEventsResponseSchema.parse({
        items: service.append(
          context.get("requestContext"),
          context.req.valid("param").id,
          context.req.valid("json").events,
        ),
      }),
      200,
    ),
  )
  routes.openapi(checkpointRoute, (context) =>
    context.json(
      MirrorCheckpointSchema.parse(
        service.checkpoint(context.get("requestContext"), context.req.valid("param").id),
      ),
      200,
    ),
  )
  return routes
}

export const createConversationMirrorRoutes = (
  service: ConversationMirrorService,
): OpenAPIHono<ApiEnv> => {
  const routes = createApiRouter()
  routes.openapi(getMirrorRoute, (context) =>
    context.json(
      ConversationMirrorResponseSchema.parse({
        mirror: service.get(context.get("requestContext"), context.req.valid("param").id),
      }),
      200,
    ),
  )
  routes.openapi(getMirrorEventsRoute, async (context) => {
    const request = context.get("requestContext")
    const { id } = context.req.valid("param")
    const { follow, after, limit } = context.req.valid("query")
    if (!follow) {
      const items = service.events(request, id, after, limit)
      return context.json(
        MirrorEventPageSchema.parse({
          items,
          nextCursor: items.length === limit ? (items.at(-1)?.sequence ?? null) : null,
        }),
        200,
      )
    }
    service.get(request, id)
    const resumeAt = Math.max(after, parseLastEventId(context.req.valid("header")["Last-Event-ID"]))
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
          for await (const item of service.followEvents(
            request,
            id,
            resumeAt,
            cancellation.signal,
          )) {
            if (item === null) {
              await stream.writeSSE({ event: "heartbeat", data: "{}" })
              continue
            }
            await stream.writeSSE({
              event: "event",
              id: String(item.sequence),
              data: JSON.stringify(item),
            })
          }
          await stream.writeSSE({ event: "end", data: "{}" })
        } finally {
          context.req.raw.signal.removeEventListener("abort", abort)
        }
      },
      async (error, stream) => {
        if (stream.aborted) return
        const normalized = normalizeError(error)
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify(errorEnvelope(normalized, request.requestId)),
        })
      },
    )
  })
  return routes
}
