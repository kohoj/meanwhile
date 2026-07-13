import { createRoute, type OpenAPIHono } from "@hono/zod-openapi"
import { DeployRegistryError } from "../deployments/registry"
import type { Deployment } from "../domain"
import { AppError } from "../errors"
import { DeploymentExecutionError } from "../services/deployment-executor"
import {
  type ApiEnv,
  CreateDeploymentRequestSchema,
  CursorQuerySchema,
  createApiRouter,
  DeploymentLogPageSchema,
  DeploymentResponseSchema,
  errorResponses,
  IdParamSchema,
  jsonResponse,
} from "./schemas"

interface CreateDeploymentCommand {
  readonly ownerId: string
  readonly runId: string
  readonly source:
    | { readonly artifactPath: string; readonly workspacePath?: never }
    | { readonly artifactPath?: never; readonly workspacePath: string }
  readonly targetName: string
  readonly targetConfig?: Readonly<Record<string, unknown>>
  readonly secretRefs?: Readonly<Record<string, string>>
  readonly requestId: string
  readonly traceId?: string
  readonly actorApiKeyId?: string
}

interface DeploymentLogPage {
  readonly items: readonly {
    readonly deploymentId: string
    readonly sequence: number
    readonly level: "debug" | "info" | "warn" | "error"
    readonly event: string
    readonly message: string
    readonly fields: Readonly<Record<string, unknown>>
    readonly createdAt: string
  }[]
  readonly nextCursor: number | null
}

export interface DeploymentApi {
  create(input: CreateDeploymentCommand): Promise<Deployment>
  get(ownerId: string, deploymentId: string): Promise<Deployment>
  logs(input: {
    ownerId: string
    deploymentId: string
    after?: number
    limit?: number
  }): Promise<DeploymentLogPage>
}

export interface DeploymentCommandSink {
  enqueue(deploymentId: string): void
}

const createDeploymentRoute = createRoute({
  method: "post",
  path: "/deployments",
  operationId: "createDeployment",
  tags: ["Deployments"],
  summary: "Deploy immutable output from a run",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateDeploymentRequestSchema } },
    },
  },
  responses: {
    202: jsonResponse(DeploymentResponseSchema, "Deployment queued"),
    ...errorResponses,
  },
})

const getDeploymentRoute = createRoute({
  method: "get",
  path: "/deployments/{id}",
  operationId: "getDeployment",
  tags: ["Deployments"],
  summary: "Get one owned deployment",
  request: { params: IdParamSchema },
  responses: {
    200: jsonResponse(DeploymentResponseSchema, "Deployment"),
    ...errorResponses,
  },
})

const getDeploymentLogsRoute = createRoute({
  method: "get",
  path: "/deployments/{id}/logs",
  operationId: "listDeploymentLogs",
  tags: ["Deployments"],
  summary: "Read sequenced deployment logs",
  request: { params: IdParamSchema, query: CursorQuerySchema },
  responses: {
    200: jsonResponse(DeploymentLogPageSchema, "Deployment log page"),
    ...errorResponses,
  },
})

export const createDeploymentRoutes = (
  service: DeploymentApi,
  commands: DeploymentCommandSink,
): OpenAPIHono<ApiEnv> => {
  const routes = createApiRouter()

  routes.openapi(createDeploymentRoute, async (context) => {
    const request = context.get("requestContext")
    const input = context.req.valid("json")
    const source = sourceSelector(input)
    const deployment = await mapDeploymentErrors(() =>
      service.create({
        ownerId: request.ownerId,
        runId: input.runId,
        source,
        targetName: input.deployTarget,
        targetConfig: input.config,
        secretRefs: input.secretRefs,
        requestId: request.requestId,
        ...(request.traceId === null ? {} : { traceId: request.traceId }),
        actorApiKeyId: request.apiKeyId,
      }),
    )
    commands.enqueue(deployment.id)
    return context.json(DeploymentResponseSchema.parse({ deployment }), 202)
  })

  routes.openapi(getDeploymentRoute, async (context) => {
    const { ownerId } = context.get("requestContext")
    const { id } = context.req.valid("param")
    const deployment = await mapDeploymentErrors(() => service.get(ownerId, id))
    return context.json(DeploymentResponseSchema.parse({ deployment }), 200)
  })

  routes.openapi(getDeploymentLogsRoute, async (context) => {
    const { ownerId } = context.get("requestContext")
    const { id } = context.req.valid("param")
    const query = context.req.valid("query")
    const page = await mapDeploymentErrors(() =>
      service.logs({ ownerId, deploymentId: id, ...query }),
    )
    return context.json(
      DeploymentLogPageSchema.parse({ items: page.items, nextCursor: page.nextCursor }),
      200,
    )
  })

  return routes
}

const sourceSelector = (
  input:
    | { readonly artifactPath: string; readonly workspacePath?: never }
    | { readonly artifactPath?: never; readonly workspacePath: string },
): CreateDeploymentCommand["source"] =>
  "artifactPath" in input
    ? { artifactPath: input.artifactPath }
    : { workspacePath: input.workspacePath }

const mapDeploymentErrors = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof AppError) throw error
    if (error instanceof DeploymentExecutionError) {
      const mapping = {
        DEPLOYMENT_NOT_FOUND: { code: "NOT_FOUND", status: 404 },
        DEPLOYMENT_SOURCE_UNAVAILABLE: { code: "DEPLOYMENT_SOURCE_UNAVAILABLE", status: 422 },
        DEPLOYMENT_STATE_CONFLICT: { code: "INVALID_STATE_TRANSITION", status: 409 },
        DEPLOYMENT_INPUT_INVALID: { code: "INVALID_REQUEST", status: 400 },
        DEPLOYMENT_RESULT_INVALID: { code: "DEPLOYMENT_RESULT_INVALID", status: 502 },
      } as const
      const normalized = mapping[error.code]
      throw new AppError({
        code: normalized.code,
        status: normalized.status,
        message: error.message,
        details: { ...error.safeDetails },
        cause: error,
      })
    }
    if (error instanceof DeployRegistryError) {
      throw new AppError({
        code: "INVALID_REQUEST",
        status: 400,
        message: error.message,
        details: { registryCode: error.code },
        cause: error,
      })
    }
    throw error
  }
}
