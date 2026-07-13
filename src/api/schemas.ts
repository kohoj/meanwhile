import { OpenAPIHono } from "@hono/zod-openapi"
import type { z } from "zod"
import type { RequestContext } from "../domain"
import { AppError, errorEnvelope } from "../errors"
import type { OperationSpan } from "../telemetry"
import { ErrorEnvelopeSchema } from "./contracts"

export * from "./contracts"

export interface ApiEnv {
  Variables: {
    requestId: string
    traceId: string | null
    requestSpan: OperationSpan
    requestContext: RequestContext
  }
}

/** Every API module shares one safe validation failure contract. */
export const createApiRouter = (): OpenAPIHono<ApiEnv> =>
  new OpenAPIHono<ApiEnv>({
    defaultHook: (result, context) => {
      if (result.success) return
      const request = context.get("requestContext")
      const error = new AppError({
        code: "INVALID_REQUEST",
        message: "Request validation failed",
        details: {
          issues: result.error.issues.map((issue) => ({
            code: issue.code,
            path: issue.path.map(String),
            message: issue.message,
          })),
        },
      })
      return context.json(errorEnvelope(error, request.requestId), 400)
    },
  })

export const jsonResponse = <Schema extends z.ZodType>(schema: Schema, description: string) => ({
  content: { "application/json": { schema } },
  description,
})

export const errorResponses = {
  default: jsonResponse(ErrorEnvelopeSchema, "Structured error"),
} as const
