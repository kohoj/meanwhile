import { createRoute, type OpenAPIHono, type z } from "@hono/zod-openapi"
import { AppError, ProviderError } from "../errors"
import type { RuntimeProviderRegistry } from "../providers/registry"
import { RuntimeProviderError } from "../providers/runtime-provider"
import {
  type ApiEnv,
  createApiRouter,
  errorResponses,
  jsonResponse,
  ProviderDiagnosticsSchema,
  ProviderTestRequestSchema,
} from "./schemas"

const testProviderRoute = createRoute({
  method: "post",
  path: "/providers/test",
  operationId: "testProvider",
  tags: ["Providers"],
  summary: "Check a configured runtime provider",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ProviderTestRequestSchema } },
    },
  },
  responses: {
    200: jsonResponse(ProviderDiagnosticsSchema, "Provider capabilities and health"),
    ...errorResponses,
  },
})

export interface ProviderDiagnostics {
  test(name: string): Promise<z.infer<typeof ProviderDiagnosticsSchema>>
}

export class RegistryProviderDiagnostics implements ProviderDiagnostics {
  constructor(private readonly providers: Pick<RuntimeProviderRegistry, "get">) {}

  async test(name: string): Promise<z.infer<typeof ProviderDiagnosticsSchema>> {
    try {
      const provider = this.providers.get(name)
      return {
        provider: provider.name,
        capabilities: provider.capabilities,
        health: await provider.health(),
      }
    } catch (error) {
      if (error instanceof RuntimeProviderError) {
        if (error.code === "PROVIDER_NOT_FOUND") {
          throw new AppError({
            code: "NOT_FOUND",
            message: "Runtime provider is not configured",
            details: {
              provider: error.provider,
              operation: error.operation,
              providerCode: error.code,
            },
            cause: error,
          })
        }
        throw new ProviderError({
          provider: error.provider,
          operation: error.operation,
          providerCode: error.code,
          retryable: error.retryable,
        })
      }
      throw error
    }
  }
}

export const createProviderRoutes = (service: ProviderDiagnostics): OpenAPIHono<ApiEnv> => {
  const routes = createApiRouter()
  routes.openapi(testProviderRoute, async (context) => {
    const { provider } = context.req.valid("json")
    return context.json(await service.test(provider), 200)
  })
  return routes
}
