import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import type { ControlPlane } from "../control-plane"
import type { TelemetryHealth } from "../telemetry"
import { type ApiEnv, createApiRouter, jsonResponse } from "./schemas"

const ComponentHealthSchema = z.union([
  z.object({ status: z.literal("healthy") }).strict(),
  z
    .object({
      status: z.enum(["degraded", "unavailable"]),
      message: z.string(),
    })
    .strict(),
])

const HealthSchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal("meanwhile"),
    version: z.string(),
  })
  .openapi("Health")

const ReadinessSchema = z
  .object({
    status: z.enum(["ready", "not_ready"]),
    control: z.object({
      status: z.enum(["healthy", "degraded", "unavailable"]),
      message: z.string().optional(),
      components: z.record(z.string(), ComponentHealthSchema),
    }),
    telemetry: z.object({
      state: z.enum(["disabled", "initializing", "healthy", "degraded"]),
      exporter: z.enum(["disabled", "initializing", "healthy", "degraded"]),
      lastExportAt: z.string().optional(),
      lastFailureAt: z.string().optional(),
      lastFailureCode: z.string().optional(),
      localLogFailures: z.number().int().nonnegative(),
      localLogHealthy: z.boolean(),
      exporters: z.record(
        z.string(),
        z
          .object({
            state: z.enum(["initializing", "healthy", "degraded"]),
            lastExportAt: z.string().optional(),
            lastFailureAt: z.string().optional(),
            lastFailureCode: z.string().optional(),
          })
          .strict(),
      ),
    }),
  })
  .openapi("Readiness")

const healthRoute = createRoute({
  method: "get",
  path: "/healthz",
  operationId: "getHealth",
  tags: ["System"],
  summary: "Check process liveness",
  security: [],
  responses: { 200: jsonResponse(HealthSchema, "Process is alive") },
})

const readinessRoute = createRoute({
  method: "get",
  path: "/readyz",
  operationId: "getReadiness",
  tags: ["System"],
  summary: "Check control-plane readiness",
  security: [],
  responses: {
    200: jsonResponse(ReadinessSchema, "Control plane is ready"),
    503: jsonResponse(ReadinessSchema, "Control plane is not ready"),
  },
})

export const createSystemRoutes = (input: {
  readonly version: string
  readonly controlPlane: Pick<ControlPlane, "health">
  readonly telemetryHealth: Pick<TelemetryHealth, "snapshot">
}): OpenAPIHono<ApiEnv> => {
  const routes = createApiRouter()
  routes.openapi(healthRoute, (context) =>
    context.json({ status: "ok", service: "meanwhile", version: input.version }, 200),
  )
  routes.openapi(readinessRoute, (context) => {
    const control = input.controlPlane.health()
    const telemetry = input.telemetryHealth.snapshot()
    const payload = {
      status: control.status === "unavailable" ? ("not_ready" as const) : ("ready" as const),
      control,
      telemetry,
    }
    return control.status === "unavailable"
      ? context.json(payload, 503)
      : context.json(payload, 200)
  })
  return routes
}

const OpenApiDocumentSchema = z
  .object({
    openapi: z.literal("3.1.0"),
    info: z.object({ title: z.string(), version: z.string() }).passthrough(),
    paths: z.record(z.string(), z.unknown()),
  })
  .passthrough()

const openApiDocumentRoute = createRoute({
  method: "get",
  path: "/openapi.json",
  operationId: "getOpenApiDocument",
  tags: ["System"],
  summary: "Read the OpenAPI contract",
  security: [],
  responses: { 200: jsonResponse(OpenApiDocumentSchema, "OpenAPI 3.1 document") },
})

export const registerOpenApiDocument = (
  app: OpenAPIHono<ApiEnv>,
  input: { readonly version: string },
): void => {
  app.openapi(openApiDocumentRoute, (context) => {
    const document = OpenApiDocumentSchema.parse(
      app.getOpenAPI31Document({
        openapi: "3.1.0",
        info: {
          title: "Meanwhile API",
          version: input.version,
          description: "Run any ACP coding agent in an isolated runtime.",
        },
        security: [{ BearerAuth: [] }],
      }),
    )
    return context.json(document, 200)
  })
}
