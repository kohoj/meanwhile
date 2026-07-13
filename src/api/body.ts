import type { MiddlewareHandler } from "hono"
import { AppError, errorEnvelope } from "../errors"
import type { ApiEnv } from "./schemas"

export const MAX_CONTROL_REQUEST_BODY_BYTES = 16 * 1024 * 1024
export const MAX_TRANSPORT_REQUEST_BODY_BYTES = 17 * 1024 * 1024

/**
 * Enforces the public API limit even when a request has no trustworthy length
 * header. Unknown-length bodies are replayed as a Web stream after bounded
 * admission so downstream validators observe the original bytes exactly once.
 */
export const controlRequestBodyLimit = (): MiddlewareHandler<ApiEnv> =>
  async function controlRequestBodyLimitMiddleware(context, next) {
    const request = context.req.raw
    if (request.body === null) return next()

    const contentLength = request.headers.get("Content-Length")
    const transferEncoding = request.headers.get("Transfer-Encoding")
    if (contentLength !== null && transferEncoding === null) {
      const parsedLength = parseContentLength(contentLength)
      if (parsedLength !== null) {
        if (parsedLength > MAX_CONTROL_REQUEST_BODY_BYTES) return rejectedBody(context)
        return next()
      }
    }

    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let receivedBytes = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        receivedBytes += chunk.value.byteLength
        if (receivedBytes > MAX_CONTROL_REQUEST_BODY_BYTES) {
          await reader.cancel("control-plane body limit exceeded")
          return rejectedBody(context)
        }
        chunks.push(chunk.value)
      }
    } finally {
      reader.releaseLock()
    }

    const replay = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
    context.req.raw = new Request(request, {
      body: replay,
      duplex: "half",
    } as RequestInit & { duplex: "half" })
    return next()
  }

const parseContentLength = (value: string): number | null => {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

const rejectedBody = (context: Parameters<MiddlewareHandler<ApiEnv>>[0]): Response => {
  const error = new AppError({
    code: "INVALID_REQUEST",
    status: 413,
    message: "Request body exceeds the control-plane limit",
    details: { maxBytes: MAX_CONTROL_REQUEST_BODY_BYTES },
  })
  return context.json(errorEnvelope(error, context.get("requestId")), 413)
}
