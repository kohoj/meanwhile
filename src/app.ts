import { dirname } from "node:path"
import { OpenAPIHono } from "@hono/zod-openapi"
import type { MiddlewareHandler } from "hono"
import { AgentCatalog } from "./agents/catalog"
import { RunnerSessionController } from "./agents/runner-session"
import { controlRequestBodyLimit } from "./api/body"
import { createDeploymentRoutes } from "./api/deployments"
import { createProviderRoutes, RegistryProviderDiagnostics } from "./api/providers"
import { createRunRoutes } from "./api/runs"
import type { ApiEnv } from "./api/schemas"
import { createSystemRoutes, registerOpenApiDocument } from "./api/system"
import { LocalArtifactStore } from "./artifacts/local-artifact-store"
import { WorkspaceBundleStore } from "./artifacts/workspace-bundle"
import {
  apiKeyPrefix,
  authenticateBearer,
  hashApiKey,
  LOCAL_BOOTSTRAP_API_KEY_ID,
  LOCAL_BOOTSTRAP_OWNER_ID,
} from "./auth"
import type { AppConfig } from "./config"
import { assertLocalProviderPolicy, prepareDataDirectories } from "./config"
import { ControlPlane } from "./control-plane"
import { LocalStaticAdapter } from "./deployments/local-static-adapter"
import { LocalStaticServer } from "./deployments/local-static-server"
import { DeployAdapterRegistry } from "./deployments/registry"
import { AppError, errorEnvelope, normalizeError } from "./errors"
import type { Instrumentation } from "./instrumentation"
import { Store } from "./persistence/store"
import { CloudflareRuntimeProvider } from "./providers/cloudflare-provider"
import { LocalRuntimeProvider } from "./providers/local-provider"
import { RuntimeProviderRegistry } from "./providers/registry"
import { EnvironmentSecretResolver } from "./secrets"
import {
  DeploymentDispatcher,
  DeploymentExecutor,
  StoreDeploymentRepository,
  StoreDeploymentSourceResolver,
} from "./services/deployment-executor"
import { RunExecutor } from "./services/run-executor"
import { RunService } from "./services/run-service"
import { RuntimeReaper, RuntimeReaperLoop } from "./services/runtime-reaper"
import { WorkspacePreparer } from "./services/workspace-preparer"
import { SERVICE_VERSION } from "./version"

export interface MeanwhileApplication {
  readonly app: OpenAPIHono<ApiEnv>
  readonly controlPlane: ControlPlane
  readonly store: Store
  readonly preview: LocalStaticServer
  start(): Promise<void>
  close(): Promise<void>
}

export interface CreateApplicationOptions {
  readonly config: AppConfig
  readonly instrumentation: Instrumentation
}

export const createApplication = async (
  options: CreateApplicationOptions,
): Promise<MeanwhileApplication> => {
  const { config, instrumentation } = options
  assertLocalProviderPolicy(config)
  const providers = [
    new LocalRuntimeProvider({
      rootDirectory: config.runtimeDir,
      runnerExecutable: config.runnerPath,
      baseEnvironment: {
        PATH: `${dirname(config.runnerPath)}:${Bun.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"}`,
      },
    }),
    ...(config.cloudflare === undefined
      ? []
      : [
          new CloudflareRuntimeProvider({
            bridgeUrl: config.cloudflare.bridgeUrl,
            bridgeToken: config.cloudflare.token,
          }),
        ]),
  ]
  const providerRegistry = new RuntimeProviderRegistry(providers)
  const providerAdmission = {
    has: (name: string) =>
      providerRegistry
        .list()
        .some(
          (provider) =>
            provider.name === name &&
            (provider.capabilities.isolation !== "none" || config.localProvider.enabled),
        ),
  }
  if (!providerAdmission.has(config.defaultProvider)) {
    throw new Error(`Default runtime provider '${config.defaultProvider}' is not configured`)
  }

  await prepareDataDirectories(config)
  const store = new Store(config.databasePath)
  try {
    await bootstrapLocalIdentity(store, config.apiKey)
  } catch (error) {
    store.close()
    throw error
  }
  const catalog = await AgentCatalog.load(config.agentCatalogPath)
  const artifacts = new LocalArtifactStore(config.artifactDir)
  const workspaceBundles = new WorkspaceBundleStore(store, artifacts, {
    maxFiles: 256,
    maxFileBytes: 4 * 1024 * 1024,
    maxTotalBytes: 8 * 1024 * 1024,
  })
  const secrets = new EnvironmentSecretResolver({
    allowedSourceNames: config.secretSourceCatalog,
    allowedOwnerIds: [LOCAL_BOOTSTRAP_OWNER_ID],
  })

  const preview = new LocalStaticServer({
    root: config.deploymentDir,
    hostname: config.previewHost,
    port: config.previewPort,
    ...(config.previewPublicUrl === undefined ? {} : { publicOrigin: config.previewPublicUrl }),
  })
  const deployRegistry = new DeployAdapterRegistry([new LocalStaticAdapter(preview)])
  const deploymentExecutor = new DeploymentExecutor({
    repository: new StoreDeploymentRepository(store),
    runs: store,
    sourceResolver: new StoreDeploymentSourceResolver(store, artifacts),
    secretResolver: secrets,
    adapters: deployRegistry,
  })
  const deploymentDispatcher = new DeploymentDispatcher({
    store,
    executor: deploymentExecutor,
    logger: instrumentation.telemetry.logger,
    telemetry: instrumentation.telemetry,
  })

  const runExecutor = new RunExecutor({
    store,
    providers: providerRegistry,
    runner: new RunnerSessionController(),
    workspace: new WorkspacePreparer(workspaceBundles),
    artifactStore: artifacts,
    artifactLimits: {
      maxFiles: 1_000,
      maxFileBytes: 64 * 1024 * 1024,
      maxTotalBytes: 256 * 1024 * 1024,
    },
    secrets,
    logger: instrumentation.telemetry.logger,
    telemetry: instrumentation.telemetry,
  })
  const runService = new RunService({
    store,
    commands: runExecutor,
    workspaceInputs: workspaceBundles,
    agentIntents: catalog,
    secretReferences: secrets,
    providerNames: providerAdmission,
    defaultProvider: config.defaultProvider,
  })
  const reaper = new RuntimeReaper(store, providerRegistry, {
    telemetry: instrumentation.telemetry,
    observe: (event) => {
      instrumentation.telemetry.logger
        .child({
          ownerId: event.ownerId,
          runId: event.runId,
          runtimeId: event.runtimeId,
        })
        .info(event.type, "Runtime cleanup state changed", {
          provider: event.provider,
          attempt: event.attempt,
          status: event.type.split(".").at(-1) ?? "unknown",
          ...(event.type === "runtime.cleanup.failed"
            ? { errorCode: event.errorCode, exhausted: event.exhausted }
            : {}),
        })
      instrumentation.telemetry.metrics.increment("meanwhile.cleanup.events", 1, {
        provider: event.provider,
        status: event.type.split(".").at(-1) ?? "unknown",
      })
      if ("durationMs" in event) {
        instrumentation.telemetry.metrics.record("meanwhile.cleanup.duration", event.durationMs, {
          provider: event.provider,
          status: event.type.split(".").at(-1) ?? "unknown",
        })
      }
    },
  })
  const controlPlane = new ControlPlane([
    new RuntimeReaperLoop(reaper),
    runExecutor,
    deploymentDispatcher,
  ])

  const app = new OpenAPIHono<ApiEnv>()
  app.openAPIRegistry.registerComponent("securitySchemes", "BearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "Meanwhile API key",
  })
  app.use("*", async (context, next) => {
    const requestId = safeRequestId(context.req.header("X-Request-ID"))
    context.set("requestId", requestId)
    return instrumentation.telemetry.span(
      "meanwhile.http.request",
      { "request.id": requestId, "http.request.method": context.req.method },
      async (span) => {
        context.set("requestSpan", span)
        context.set("traceId", span.traceId)
        try {
          await next()
          const status = context.res.status
          span.setAttributes({
            "http.route": matchedRoute(context.req.matchedRoutes),
            "http.response.status_code": status,
          })
          if (status >= 500) span.setOutcome("failed", "HTTP_SERVER_ERROR")
          else if (status >= 400) span.setOutcome("rejected")
          else span.setOutcome("succeeded")
        } finally {
          context.header("X-Request-ID", requestId)
        }
      },
    )
  })
  app.use("*", controlRequestBodyLimit())

  app.route(
    "/",
    createSystemRoutes({
      version: SERVICE_VERSION,
      controlPlane,
      telemetryHealth: instrumentation.health,
    }),
  )
  registerOpenApiDocument(app, { version: SERVICE_VERSION })

  const authenticate: MiddlewareHandler<ApiEnv> = async (context, next) => {
    const owner = await authenticateBearer(context.req.header("Authorization"), store)
    if (owner === null) {
      const error = new AppError({ code: "UNAUTHENTICATED", message: "Authentication required" })
      return context.json(errorEnvelope(error, context.get("requestId")), 401)
    }
    store.touchApiKey(owner.apiKeyId, new Date().toISOString())
    context.get("requestSpan").setAttributes({ "owner.id": owner.ownerId })
    context.set("requestContext", {
      requestId: context.get("requestId"),
      traceId: context.get("traceId"),
      ownerId: owner.ownerId,
      apiKeyId: owner.apiKeyId,
    })
    await next()
  }
  const controlApi = new OpenAPIHono<ApiEnv>()
  controlApi.use("*", authenticate)
  controlApi.route("/", createRunRoutes(runService))
  controlApi.route("/", createDeploymentRoutes(deploymentExecutor, deploymentDispatcher))
  controlApi.route("/", createProviderRoutes(new RegistryProviderDiagnostics(providerRegistry)))
  app.route("/", controlApi)
  app.notFound((context) => {
    const error = new AppError({ code: "NOT_FOUND", message: "Route not found" })
    return context.json(errorEnvelope(error, context.get("requestId")), 404)
  })
  app.onError((error, context) => {
    const normalized = normalizeError(error)
    const requestId = context.get("requestId")
    const traceId = context.get("traceId")
    const requestContext = context.get("requestContext")
    context.header("X-Request-ID", requestId)
    instrumentation.telemetry.logger
      .child({
        requestId,
        ...(traceId === null ? {} : { traceId }),
        ...(requestContext === undefined ? {} : { ownerId: requestContext.ownerId }),
      })
      .error("http.request_failed", "HTTP request failed", {
        code: normalized.code,
        status: normalized.status,
      })
    return context.json(errorEnvelope(normalized, requestId), normalized.status as 400)
  })

  const removeOperationalStateMetrics = instrumentation.telemetry.metrics.observeBatch(
    [
      "meanwhile.run.queue.depth",
      "meanwhile.run.active",
      "meanwhile.runtime.active",
      "meanwhile.cleanup.backlog",
      "meanwhile.deployment.running",
    ],
    () => {
      const state = store.countOperationalState()
      return {
        "meanwhile.run.queue.depth": state.queuedRuns,
        "meanwhile.run.active": state.activeRuns,
        "meanwhile.runtime.active": state.activeRuntimes,
        "meanwhile.cleanup.backlog": state.cleanupBacklog,
        "meanwhile.deployment.running": state.runningDeployments,
      }
    },
  )

  let closed = false
  return {
    app,
    controlPlane,
    store,
    preview,
    start: () => controlPlane.start(),
    async close() {
      if (closed) return
      closed = true
      const failures: unknown[] = []
      await controlPlane.stop().catch((error: unknown) => failures.push(error))
      await preview.stop().catch((error: unknown) => failures.push(error))
      await instrumentation.shutdown().catch((error: unknown) => failures.push(error))
      removeOperationalStateMetrics()
      store.close()
      if (failures.length > 0) throw new AggregateError(failures, "Meanwhile shutdown failed")
    },
  }
}

const bootstrapLocalIdentity = async (store: Store, key: string | undefined): Promise<void> => {
  if (key === undefined) {
    if (store.isBootstrapIdentityRequired()) {
      throw new AppError({
        code: "BOOTSTRAP_KEY_REQUIRED",
        message: "MEANWHILE_API_KEY is required to initialize an empty database",
      })
    }
    return
  }
  const prefix = apiKeyPrefix(key)
  if (prefix === null) throw new Error("MEANWHILE_API_KEY is not a valid Meanwhile API key")
  const createdAt = new Date().toISOString()
  store.bootstrapIdentity({
    ownerId: LOCAL_BOOTSTRAP_OWNER_ID,
    ownerName: "Local owner",
    apiKeyId: LOCAL_BOOTSTRAP_API_KEY_ID,
    apiKeyPrefix: prefix,
    apiKeyHash: await hashApiKey(key),
    apiKeyName: "Local bootstrap key",
    createdAt,
  })
}

const safeRequestId = (candidate: string | undefined): string =>
  candidate !== undefined && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : crypto.randomUUID()

const matchedRoute = (routes: readonly { readonly path: string }[]): string =>
  routes.findLast(({ path }) => path !== "*")?.path ?? "unmatched"
