import { dirname } from "node:path"
import { OpenAPIHono } from "@hono/zod-openapi"
import type { MiddlewareHandler } from "hono"
import { AgentCatalog } from "./agents/catalog"
import { RunnerSessionController } from "./agents/runner-session"
import { SessionRunnerController } from "./agents/session-runner"
import { createApiKeyRoutes } from "./api/api-keys"
import { createArtifactRoutes } from "./api/artifacts"
import { createAuditRoutes } from "./api/audit"
import { controlRequestBodyLimit } from "./api/body"
import { createBriefRoutes } from "./api/briefs"
import { createBrowserSessionRoutes } from "./api/browser-sessions"
import { createDeploymentRoutes } from "./api/deployments"
import { createProjectRoutes } from "./api/projects"
import { createProviderRoutes, RegistryProviderDiagnostics } from "./api/providers"
import { createRunRoutes } from "./api/runs"
import type { ApiEnv } from "./api/schemas"
import { createSessionRoutes } from "./api/sessions"
import { createSystemRoutes, registerOpenApiDocument } from "./api/system"
import { LocalArtifactStore } from "./artifacts/local-artifact-store"
import { WORKSPACE_BUNDLE_LIMITS, WorkspaceBundleStore } from "./artifacts/workspace-bundle"
import {
  apiKeyPrefix,
  authenticateBearer,
  authenticateBrowserSession,
  hashApiKey,
  LOCAL_BOOTSTRAP_API_KEY_ID,
  LOCAL_BOOTSTRAP_OWNER_ID,
} from "./auth"
import type { AppConfig } from "./config"
import { assertLocalProviderPolicy, prepareDataDirectories } from "./config"
import { ControlPlane } from "./control-plane"
import { runtimeCredentialBroker } from "./credentials"
import { DataRootLease } from "./data-root"
import { LocalStaticAdapter } from "./deployments/local-static-adapter"
import { LocalStaticServer } from "./deployments/local-static-server"
import { DeployAdapterRegistry } from "./deployments/registry"
import { AppError, errorEnvelope, normalizeError } from "./errors"
import type { Instrumentation } from "./instrumentation"
import { Store } from "./persistence/store"
import { ExecutionProvenanceCatalog, sha256File } from "./provenance"
import { CloudflareRuntimeProvider } from "./providers/cloudflare-provider"
import { LocalRuntimeProvider } from "./providers/local-provider"
import { RuntimeProviderRegistry } from "./providers/registry"
import { ensureDefaultRunnerBuilt } from "./runner-bootstrap"
import { EnvironmentSecretResolver } from "./secrets"
import { ApiKeyService } from "./services/api-key-service"
import { ArtifactService } from "./services/artifact-service"
import { AuditService } from "./services/audit-service"
import { BriefService } from "./services/brief-service"
import { BrowserSessionService } from "./services/browser-session-service"
import { CredentialLeaseReaper } from "./services/credential-lease-reaper"
import {
  DeploymentDispatcher,
  DeploymentExecutor,
  StoreDeploymentRepository,
  StoreDeploymentSourceResolver,
} from "./services/deployment-executor"
import { ExecutionContext } from "./services/execution-context"
import { ProjectService } from "./services/project-service"
import { RunExecutor } from "./services/run-executor"
import { RunService } from "./services/run-service"
import { RuntimeReaper, RuntimeReaperLoop } from "./services/runtime-reaper"
import { SessionExecutor } from "./services/session-executor"
import { SessionService } from "./services/session-service"
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
  await ensureDefaultRunnerBuilt(config.runnerPath)
  const localRunnerDigest = await sha256File(config.runnerPath)
  const providers = [
    new LocalRuntimeProvider({
      rootDirectory: config.runtimeDir,
      runnerExecutable: config.runnerPath,
      baseEnvironment: {
        PATH: `${dirname(config.runnerPath)}:${Bun.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"}`,
      },
      runnerDigest: localRunnerDigest,
    }),
    ...(config.cloudflare === undefined
      ? []
      : [
          new CloudflareRuntimeProvider({
            bridgeUrl: config.cloudflare.bridgeUrl,
            bridgeToken: config.cloudflare.token,
            ...(config.cloudflare.runtimeImageReference === undefined
              ? {}
              : { runtimeImageReference: config.cloudflare.runtimeImageReference }),
            ...(config.cloudflare.runtimeImageDigest === undefined
              ? {}
              : { runtimeImageDigest: config.cloudflare.runtimeImageDigest }),
            ...(config.cloudflare.runnerDigest === undefined
              ? {}
              : { runnerDigest: config.cloudflare.runnerDigest }),
          }),
        ]),
  ]
  const providerRegistry = new RuntimeProviderRegistry(providers)
  const executionProvenance = new ExecutionProvenanceCatalog(providerRegistry)
  const providerAdmission = {
    has: (name: string) =>
      providerRegistry
        .list()
        .some(
          (provider) =>
            provider.name === name &&
            (provider.capabilities.isolation !== "none" || config.localProvider.enabled),
        ),
    supportsCredentialMediation: (name: string) =>
      providerRegistry.has(name) && runtimeCredentialBroker(providerRegistry.get(name)) !== null,
  }
  if (!providerAdmission.has(config.defaultProvider)) {
    throw new Error(`Default runtime provider '${config.defaultProvider}' is not configured`)
  }

  await prepareDataDirectories(config)
  const dataRootLease = await DataRootLease.acquire(config.dataDir, "control-plane")
  let openedStore: Store | undefined
  try {
    const store = new Store(config.databasePath)
    openedStore = store
    await bootstrapLocalIdentity(store, config.apiKey)
    const catalog = await AgentCatalog.load(config.agentCatalogPath)
    const artifacts = new LocalArtifactStore(config.artifactDir)
    const artifactService = new ArtifactService(store, artifacts)
    const executionContext = new ExecutionContext(artifactService, store)
    const briefService = new BriefService({ store, executionContext })
    const auditService = new AuditService(store)
    const apiKeyService = new ApiKeyService(store)
    const browserSessionService = new BrowserSessionService(store)
    const projectService = new ProjectService(store)
    const workspaceBundles = new WorkspaceBundleStore(store, artifacts, WORKSPACE_BUNDLE_LIMITS)
    const workspacePreparer = new WorkspacePreparer(workspaceBundles)
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
      workspace: workspacePreparer,
      artifactStore: artifacts,
      artifactLimits: {
        maxFiles: 1_000,
        maxFileBytes: 64 * 1024 * 1024,
        maxTotalBytes: 256 * 1024 * 1024,
      },
      secrets,
      executionContext,
      logger: instrumentation.telemetry.logger,
      telemetry: instrumentation.telemetry,
      concurrency: config.runConcurrency,
    })
    const runService = new RunService({
      store,
      commands: runExecutor,
      workspaceInputs: workspaceBundles,
      agentIntents: catalog,
      secretReferences: secrets,
      providerNames: providerAdmission,
      executionProvenance,
      briefs: briefService,
      defaultProvider: config.defaultProvider,
    })
    const sessionExecutor = new SessionExecutor({
      store,
      providers: providerRegistry,
      runner: new SessionRunnerController(),
      workspace: workspacePreparer,
      executionContext,
      secrets,
      logger: instrumentation.telemetry.logger,
      telemetry: instrumentation.telemetry,
      concurrency: config.sessionConcurrency,
    })
    const sessionService = new SessionService({
      store,
      commands: sessionExecutor,
      workspaceInputs: workspaceBundles,
      agentIntents: catalog,
      secretReferences: secrets,
      providerNames: providerAdmission,
      providerCapabilities: {
        supportsProcessInput: (name) => {
          const provider = providerRegistry.get(name)
          return provider.capabilities.processInput && provider.send !== undefined
        },
        supportsCredentialMediation: (name) =>
          runtimeCredentialBroker(providerRegistry.get(name)) !== null,
      },
      executionProvenance,
      briefs: briefService,
      defaultProvider: config.defaultProvider,
    })
    const reaper = new RuntimeReaper(store, providerRegistry, {
      telemetry: instrumentation.telemetry,
      observe: (event) => {
        const provisioning = event.type.startsWith("runtime.provisioning.")
        const status = event.type.split(".").at(-1) ?? "unknown"
        instrumentation.telemetry.logger
          .child({
            ownerId: event.ownerId,
            runId: event.runId,
            runtimeId: event.runtimeId,
          })
          .info(
            event.type,
            provisioning
              ? "Runtime provisioning reconciliation changed"
              : "Runtime cleanup state changed",
            {
              provider: event.provider,
              attempt: event.attempt,
              status,
              ...(event.type === "runtime.cleanup.failed" ||
              event.type === "runtime.provisioning.reconcile_failed"
                ? { errorCode: event.errorCode, exhausted: event.exhausted }
                : {}),
            },
          )
        instrumentation.telemetry.metrics.increment(
          provisioning
            ? "meanwhile.runtime.provisioning_reconciliation.events"
            : "meanwhile.cleanup.events",
          1,
          {
            provider: event.provider,
            status,
          },
        )
        if ("durationMs" in event) {
          instrumentation.telemetry.metrics.record(
            provisioning
              ? "meanwhile.runtime.provisioning_reconciliation.duration"
              : "meanwhile.cleanup.duration",
            event.durationMs,
            { provider: event.provider, status },
          )
        }
      },
    })
    const controlPlane = new ControlPlane([
      new CredentialLeaseReaper(store, providerRegistry),
      new RuntimeReaperLoop(reaper),
      runExecutor,
      sessionExecutor,
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
      // Protected control-plane representations may contain prompts, metadata,
      // or one-time key material. Routes can opt into a stricter explicit
      // policy (artifact bytes do), but authenticated JSON is never cacheable.
      context.header("Cache-Control", "private, no-store")
      const authorization = context.req.header("Authorization")
      const apiKeyIdentity = await authenticateBearer(authorization, store)
      const browserIdentity =
        apiKeyIdentity === null ? await authenticateBrowserSession(authorization, store) : null
      if (apiKeyIdentity === null && browserIdentity === null) {
        const error = new AppError({ code: "UNAUTHENTICATED", message: "Authentication required" })
        return context.json(errorEnvelope(error, context.get("requestId")), 401)
      }
      if (
        browserIdentity !== null &&
        !["GET", "HEAD"].includes(context.req.method) &&
        !(context.req.method === "DELETE" && context.req.path === "/browser-sessions/current")
      ) {
        const error = new AppError({
          code: "FORBIDDEN",
          status: 403,
          message: "Browser sessions are read-only",
        })
        return context.json(errorEnvelope(error, context.get("requestId")), 403)
      }
      const now = new Date().toISOString()
      if (apiKeyIdentity !== null) store.touchApiKey(apiKeyIdentity.apiKeyId, now)
      else
        store.touchBrowserSession(
          (browserIdentity as NonNullable<typeof browserIdentity>).browserSessionId,
          now,
        )
      const identity = apiKeyIdentity ?? (browserIdentity as NonNullable<typeof browserIdentity>)
      context.get("requestSpan").setAttributes({ "owner.id": identity.ownerId })
      context.set("requestContext", {
        requestId: context.get("requestId"),
        traceId: context.get("traceId"),
        ownerId: identity.ownerId,
        principalId: identity.principalId,
        ownerRole: identity.ownerRole,
        apiKeyId: apiKeyIdentity?.apiKeyId ?? null,
        ...(browserIdentity === null ? {} : { browserSessionId: browserIdentity.browserSessionId }),
      })
      await next()
    }
    const controlApi = new OpenAPIHono<ApiEnv>()
    controlApi.use("*", authenticate)
    controlApi.route("/", createRunRoutes(runService))
    controlApi.route("/", createSessionRoutes(sessionService))
    controlApi.route("/", createProjectRoutes(projectService))
    controlApi.route("/", createBrowserSessionRoutes(browserSessionService))
    controlApi.route("/", createArtifactRoutes(artifactService))
    controlApi.route("/", createBriefRoutes(briefService))
    controlApi.route("/", createAuditRoutes(auditService))
    controlApi.route("/", createApiKeyRoutes(apiKeyService))
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
        "meanwhile.session.queue.depth",
        "meanwhile.session.active",
        "meanwhile.session.runtime.active",
        "meanwhile.session.cleanup.backlog",
        "meanwhile.deployment.running",
      ],
      () => {
        const state = store.countOperationalState()
        return {
          "meanwhile.run.queue.depth": state.queuedRuns,
          "meanwhile.run.active": state.activeRuns,
          "meanwhile.runtime.active": state.activeRuntimes,
          "meanwhile.cleanup.backlog": state.cleanupBacklog,
          "meanwhile.session.queue.depth": state.queuedSessions,
          "meanwhile.session.active": state.activeSessions,
          "meanwhile.session.runtime.active": state.activeSessionRuntimes,
          "meanwhile.session.cleanup.backlog": state.sessionCleanupBacklog,
          "meanwhile.deployment.running": state.runningDeployments,
        }
      },
    )

    let closed = false
    const application: MeanwhileApplication = {
      app,
      controlPlane,
      store,
      preview,
      async start() {
        const resumePreview = store.listLocalDeploymentRoots().length > 0
        if (resumePreview) preview.start()
        try {
          await controlPlane.start()
        } catch (error) {
          if (resumePreview) await preview.stop()
          throw error
        }
      },
      async close() {
        if (closed) return
        closed = true
        const failures: unknown[] = []
        await controlPlane.stop().catch((error: unknown) => failures.push(error))
        await preview.stop().catch((error: unknown) => failures.push(error))
        await instrumentation.shutdown().catch((error: unknown) => failures.push(error))
        try {
          removeOperationalStateMetrics()
        } catch (error) {
          failures.push(error)
        }
        try {
          store.close()
        } catch (error) {
          failures.push(error)
        }
        await dataRootLease.release().catch((error: unknown) => failures.push(error))
        if (failures.length > 0) throw new AggregateError(failures, "Meanwhile shutdown failed")
      },
    }
    return application
  } catch (cause) {
    const failures: unknown[] = []
    try {
      openedStore?.close()
    } catch (error) {
      failures.push(error)
    }
    await dataRootLease.release().catch((error: unknown) => failures.push(error))
    if (failures.length > 0) {
      throw new AggregateError([cause, ...failures], "Meanwhile application setup failed")
    }
    throw cause
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
