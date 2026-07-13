import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import { streamSSE } from "hono/streaming"
import { AppError, errorEnvelope, normalizeError } from "../errors"
import type { RunService } from "../services/run-service"
import {
  type ApiEnv,
  ArtifactPageSchema,
  ArtifactSchema,
  CreateRunRequestSchema,
  createApiRouter,
  errorResponses,
  IdempotencyHeaderSchema,
  IdParamSchema,
  jsonResponse,
  LogQuerySchema,
  RunLogPageSchema,
  RunLogSchema,
  RunPageSchema,
  RunResponseSchema,
  RunSchema,
} from "./schemas"

type RunApi = Pick<
  RunService,
  "create" | "list" | "get" | "cancel" | "logs" | "artifacts" | "followLogs"
>

const createRunRoute = createRoute({
  method: "post",
  path: "/runs",
  operationId: "createRun",
  tags: ["Runs"],
  summary: "Create an agent run",
  request: {
    headers: IdempotencyHeaderSchema,
    body: {
      required: true,
      content: { "application/json": { schema: CreateRunRequestSchema } },
    },
  },
  responses: {
    200: jsonResponse(RunResponseSchema, "Existing idempotent run"),
    201: jsonResponse(RunResponseSchema, "Run created"),
    ...errorResponses,
  },
})

const listRunsRoute = createRoute({
  method: "get",
  path: "/runs",
  operationId: "listRuns",
  tags: ["Runs"],
  summary: "List runs owned by the caller",
  request: {
    query: z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        before: z
          .string()
          .regex(/^[A-Za-z0-9_-]+$/)
          .max(1_024)
          .optional(),
      })
      .strict(),
  },
  responses: { 200: jsonResponse(RunPageSchema, "Owner-scoped run page"), ...errorResponses },
})

const getRunRoute = createRoute({
  method: "get",
  path: "/runs/{id}",
  operationId: "getRun",
  tags: ["Runs"],
  summary: "Get one owned run",
  request: { params: IdParamSchema },
  responses: { 200: jsonResponse(RunResponseSchema, "Run"), ...errorResponses },
})

const cancelRunRoute = createRoute({
  method: "post",
  path: "/runs/{id}/cancel",
  operationId: "cancelRun",
  tags: ["Runs"],
  summary: "Request cancellation",
  request: { params: IdParamSchema },
  responses: { 202: jsonResponse(RunResponseSchema, "Cancellation accepted"), ...errorResponses },
})

const getRunLogsRoute = createRoute({
  method: "get",
  path: "/runs/{id}/logs",
  operationId: "listRunLogs",
  tags: ["Runs"],
  summary: "Read or follow sequenced run logs",
  request: {
    params: IdParamSchema,
    query: LogQuerySchema,
    headers: z.object({
      "Last-Event-ID": z.string().max(32).optional(),
    }),
  },
  responses: {
    200: {
      description: "A durable log page or SSE stream",
      content: {
        "application/json": { schema: RunLogPageSchema },
        "text/event-stream": { schema: z.string() },
      },
    },
    ...errorResponses,
  },
})

const getRunArtifactsRoute = createRoute({
  method: "get",
  path: "/runs/{id}/artifacts",
  operationId: "listRunArtifacts",
  tags: ["Runs"],
  summary: "List immutable run artifacts",
  request: { params: IdParamSchema },
  responses: { 200: jsonResponse(ArtifactPageSchema, "Artifact metadata"), ...errorResponses },
})

export const createRunRoutes = (service: RunApi): OpenAPIHono<ApiEnv> => {
  const routes = createApiRouter()

  routes.openapi(createRunRoute, async (context) => {
    const request = context.get("requestContext")
    const input = context.req.valid("json")
    const idempotencyKey = context.req.valid("header")["idempotency-key"]
    const workspace =
      input.workspace.type === "bundle"
        ? input.workspace
        : input.workspace.type === "files"
          ? {
              type: "files" as const,
              files: input.workspace.files.map((file) => ({
                path: file.path,
                content: Uint8Array.fromBase64(file.contentBase64),
                ...(file.mode === undefined ? {} : { mode: file.mode }),
              })),
            }
          : {
              type: input.workspace.type,
              url: input.workspace.url,
              ...(input.workspace.revision === undefined
                ? {}
                : { revision: input.workspace.revision }),
              ...(input.workspace.credentialRef === undefined
                ? {}
                : { credentialRef: input.workspace.credentialRef }),
            }
    const { provider, ...runInput } = input
    const result = await service.create(
      request,
      { ...runInput, workspace, ...(provider === undefined ? {} : { provider }) },
      idempotencyKey,
    )
    const response = { run: RunSchema.parse(result.run) }
    return result.replayed ? context.json(response, 200) : context.json(response, 201)
  })

  routes.openapi(listRunsRoute, async (context) => {
    const { ownerId } = context.get("requestContext")
    const query = context.req.valid("query")
    const page = await service.list(ownerId, {
      limit: query.limit,
      ...(query.before === undefined ? {} : { before: query.before }),
    })
    return context.json(
      { items: page.items.map((run) => RunSchema.parse(run)), nextCursor: page.nextCursor },
      200,
    )
  })

  routes.openapi(getRunRoute, async (context) => {
    const { ownerId } = context.get("requestContext")
    const { id } = context.req.valid("param")
    return context.json({ run: RunSchema.parse(await service.get(ownerId, id)) }, 200)
  })

  routes.openapi(cancelRunRoute, async (context) => {
    const request = context.get("requestContext")
    const { id } = context.req.valid("param")
    return context.json({ run: RunSchema.parse(await service.cancel(request, id)) }, 202)
  })

  routes.openapi(getRunLogsRoute, async (context) => {
    const request = context.get("requestContext")
    const { ownerId } = request
    const { id } = context.req.valid("param")
    const { follow, after, limit } = context.req.valid("query")
    if (!follow) {
      const page = await service.logs(ownerId, id, { after, limit })
      return context.json(
        { items: page.items.map((item) => RunLogSchema.parse(item)), nextCursor: page.nextCursor },
        200,
      )
    }

    await service.get(ownerId, id)
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
          for await (const item of service.followLogs(ownerId, id, resumeAt, cancellation.signal)) {
            if (item === null) {
              await stream.writeSSE({ event: "heartbeat", data: "{}" })
              continue
            }
            await stream.writeSSE({
              event: "log",
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

  routes.openapi(getRunArtifactsRoute, async (context) => {
    const { ownerId } = context.get("requestContext")
    const { id } = context.req.valid("param")
    const artifacts = await service.artifacts(ownerId, id)
    return context.json({ items: artifacts.map((artifact) => ArtifactSchema.parse(artifact)) }, 200)
  })

  return routes
}

const parseLastEventId = (value: string | undefined): number => {
  if (value === undefined || value.length === 0) return 0
  if (!/^\d+$/.test(value)) {
    throw new AppError({ code: "INVALID_REQUEST", message: "Last-Event-ID must be an integer" })
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AppError({ code: "INVALID_REQUEST", message: "Last-Event-ID is out of range" })
  }
  return parsed
}
