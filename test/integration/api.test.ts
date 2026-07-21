import { expect, test } from "bun:test"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { createDeploymentRoutes, type DeploymentApi } from "../../src/api/deployments"
import { createProviderRoutes, RegistryProviderDiagnostics } from "../../src/api/providers"
import { createRunRoutes } from "../../src/api/runs"
import { createApiRouter } from "../../src/api/schemas"
import type { Artifact, Deployment } from "../../src/domain"
import { AppError, errorEnvelope, normalizeError } from "../../src/errors"
import { RuntimeProviderRegistry } from "../../src/providers/registry"
import { RuntimeProviderError } from "../../src/providers/runtime-provider"
import { DeploymentExecutionError } from "../../src/services/deployment-executor"
import { createRunHarness, OWNER_A, OWNER_B, PRINCIPAL_A, PRINCIPAL_B } from "../harness"

test("run HTTP contract covers create, idempotency, isolation, evidence, and SSE resume", async () => {
  const harness = createRunHarness()
  try {
    const app = testApi(harness.service)
    const creation = {
      workspace: { type: "repository", url: "https://github.com/example/project.git" },
      agentType: "codex",
      prompt: "Ship it",
      env: { CI: "true" },
      secretRefs: {},
      artifactPaths: ["dist"],
      timeoutMs: 60_000,
    }

    const createdResponse = await app.request("/runs", {
      method: "POST",
      headers: requestHeaders(OWNER_A, { "Idempotency-Key": "api-run-1" }),
      body: JSON.stringify(creation),
    })
    expect(createdResponse.status).toBe(201)
    const created = (await createdResponse.json()) as {
      run: {
        id: string
        status: string
        provider: string
        agentSpec: { executable: string; permissionPolicy: object }
        agentCatalogDigest: string
        resolvedRevision: string | null
      }
    }
    expect(created.run.status).toBe("queued")
    expect(created.run.provider).toBe("local")
    expect(created.run.agentSpec).toMatchObject({
      executable: "meanwhile-demo-agent",
      permissionPolicy: {
        mode: "allow-once",
        toolKinds: ["read", "edit", "delete", "move", "search"],
      },
    })
    expect(created.run.agentCatalogDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(created.run.resolvedRevision).toBeNull()

    const replay = await app.request("/runs", {
      method: "POST",
      headers: requestHeaders(OWNER_A, { "Idempotency-Key": "api-run-1" }),
      body: JSON.stringify({ ...creation, provider: "local" }),
    })
    expect(replay.status).toBe(200)
    expect(((await replay.json()) as { run: { id: string } }).run.id).toBe(created.run.id)

    const conflict = await app.request("/runs", {
      method: "POST",
      headers: requestHeaders(OWNER_A, { "Idempotency-Key": "api-run-1" }),
      body: JSON.stringify({ ...creation, prompt: "A different task" }),
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } })

    expect(
      (await app.request(`/runs/${created.run.id}`, { headers: requestHeaders(OWNER_A) })).status,
    ).toBe(200)
    const hidden = await app.request(`/runs/${created.run.id}`, {
      headers: requestHeaders(OWNER_B),
    })
    expect(hidden.status).toBe(404)
    expect(await hidden.json()).toMatchObject({ error: { code: "NOT_FOUND" } })

    const createdAt = harness.clock.now().toISOString()
    harness.store.appendRunLog({
      ownerId: OWNER_A,
      runId: created.run.id,
      sequence: 1,
      stream: "agent",
      eventType: "agent.message",
      data: "done",
      createdAt,
    })
    const artifact: Artifact = {
      id: "c".repeat(64),
      ownerId: OWNER_A,
      runId: created.run.id,
      logicalPath: "dist",
      kind: "directory",
      digest: "b".repeat(64),
      mediaType: "application/vnd.meanwhile.manifest+json",
      byteSize: 64,
      storageKey: "private/storage/key",
      createdAt,
    }
    harness.store.insertArtifact(artifact)

    const logs = await app.request(`/runs/${created.run.id}/logs?after=0&limit=1`, {
      headers: requestHeaders(OWNER_A),
    })
    expect(await logs.json()).toMatchObject({
      items: [{ sequence: 1, data: "done" }],
      nextCursor: 1,
    })

    const artifacts = await app.request(`/runs/${created.run.id}/artifacts`, {
      headers: requestHeaders(OWNER_A),
    })
    const artifactBody = (await artifacts.json()) as { items: Record<string, unknown>[] }
    expect(artifactBody.items).toHaveLength(1)
    expect(artifactBody.items[0]).not.toHaveProperty("storageKey")

    expect(
      (
        await app.request(`/runs/${created.run.id}/cancel`, {
          method: "POST",
          headers: requestHeaders(OWNER_A),
        })
      ).status,
    ).toBe(202)
    const stream = await app.request(`/runs/${created.run.id}/logs?follow=true`, {
      headers: requestHeaders(OWNER_A, { "Last-Event-ID": "0" }),
    })
    expect(stream.headers.get("content-type")).toContain("text/event-stream")
    const eventStream = await stream.text()
    expect(eventStream).toContain("event: ready")
    expect(eventStream).toContain("id: 1")
    expect(eventStream).toContain("event: end")

    const invalidResume = await app.request(`/runs/${created.run.id}/logs?follow=true`, {
      headers: requestHeaders(OWNER_A, { "Last-Event-ID": "not-a-sequence" }),
    })
    expect(invalidResume.status).toBe(400)
    expect(await invalidResume.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } })

    const invalid = await app.request("/runs", {
      method: "POST",
      headers: requestHeaders(OWNER_A),
      body: JSON.stringify({ prompt: "missing required input" }),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({
      error: { code: "INVALID_REQUEST", requestId: "request-test" },
    })

    const spoofedOwner = await app.request("/runs", {
      method: "POST",
      headers: requestHeaders(OWNER_A),
      body: JSON.stringify({ ...creation, ownerId: OWNER_B }),
    })
    expect(spoofedOwner.status).toBe(400)

    const unknownProvider = await app.request("/runs", {
      method: "POST",
      headers: requestHeaders(OWNER_A),
      body: JSON.stringify({ ...creation, provider: "missing" }),
    })
    expect(unknownProvider.status).toBe(400)
    expect(await unknownProvider.json()).toMatchObject({
      error: { code: "INVALID_REQUEST", details: { provider: "missing" } },
    })
    expect(harness.commands.enqueued).toEqual([created.run.id])
    expect((await harness.service.list(OWNER_A, { limit: 100 })).items).toHaveLength(1)

    const specification = await app.request("/openapi.json", { headers: requestHeaders(OWNER_A) })
    expect(specification.status).toBe(200)
    const document = (await specification.json()) as object
    expect(document).toHaveProperty("paths./runs.post.operationId", "createRun")
    expect(document).toHaveProperty("components.schemas.Run")
    expect(document).toHaveProperty("components.schemas.ErrorEnvelope")
  } finally {
    harness.close()
  }
})

test("deployment and provider routes preserve owner and adapter boundaries", async () => {
  const deployments = new MemoryDeploymentApi()
  const enqueued: string[] = []
  const app = createApiRouter()
  installTestIdentity(app)
  app.route("/", createDeploymentRoutes(deployments, { enqueue: (id) => enqueued.push(id) }))
  app.route(
    "/",
    createProviderRoutes({
      test: async (provider) => ({
        provider,
        capabilities: {
          isolation: "container",
          processRecovery: true,
          eventReplay: true,
          processInput: true,
          portExposure: true,
          processSignals: ["SIGKILL"],
        },
        health: { status: "healthy", checkedAt: "2026-07-13T00:00:00.000Z" },
      }),
    }),
  )
  installStructuredErrors(app)

  const missingIdempotency = await app.request("/deployments", {
    method: "POST",
    headers: requestHeaders(OWNER_A),
    body: JSON.stringify({
      runId: "10000000-0000-4000-8000-000000000001",
      artifactPath: "dist",
      deployTarget: "local-static",
    }),
  })
  expect(missingIdempotency.status).toBe(400)
  expect(await missingIdempotency.json()).toMatchObject({
    error: { code: "INVALID_REQUEST" },
  })

  const queued = await app.request("/deployments", {
    method: "POST",
    headers: requestHeaders(OWNER_A, { "Idempotency-Key": "deployment-request-a" }),
    body: JSON.stringify({
      runId: "10000000-0000-4000-8000-000000000001",
      artifactPath: "dist",
      deployTarget: "local-static",
      config: { index: "index.html" },
    }),
  })
  expect(queued.status).toBe(202)
  const queuedBody = (await queued.json()) as { deployment: Deployment }
  expect(queuedBody.deployment).toMatchObject({
    ownerId: OWNER_A,
    target: "local-static",
    targetConfig: { index: "index.html" },
    status: "queued",
  })

  const replayed = await app.request("/deployments", {
    method: "POST",
    headers: requestHeaders(OWNER_A, { "Idempotency-Key": "deployment-request-a" }),
    body: JSON.stringify({
      runId: "10000000-0000-4000-8000-000000000001",
      artifactPath: "dist",
      deployTarget: "local-static",
      config: { index: "index.html" },
    }),
  })
  expect(replayed.status).toBe(200)
  expect(await replayed.json()).toEqual(queuedBody)
  expect(enqueued).toEqual([queuedBody.deployment.id])
  expect(deployments.lastCreate).toMatchObject({
    ownerId: OWNER_A,
    idempotencyKey: "deployment-request-a",
    source: { artifactPath: "dist" },
    targetName: "local-static",
    targetConfig: { index: "index.html" },
  })

  const hidden = await app.request(`/deployments/${queuedBody.deployment.id}`, {
    headers: requestHeaders(OWNER_B),
  })
  expect(hidden.status).toBe(404)
  expect(await hidden.json()).toMatchObject({ error: { code: "NOT_FOUND" } })

  const logs = await app.request(`/deployments/${queuedBody.deployment.id}/logs`, {
    headers: requestHeaders(OWNER_A, { "Idempotency-Key": "deployment-request-invalid" }),
  })
  expect(await logs.json()).toMatchObject({ items: [{ sequence: 1, event: "deployment.queued" }] })

  const invalid = await app.request("/deployments", {
    method: "POST",
    headers: requestHeaders(OWNER_A),
    body: JSON.stringify({
      runId: "10000000-0000-4000-8000-000000000001",
      artifactPath: "dist",
      workspacePath: ".",
      deployTarget: "local-static",
    }),
  })
  expect(invalid.status).toBe(400)
  expect(await invalid.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } })

  const provider = await app.request("/providers/test", {
    method: "POST",
    headers: requestHeaders(OWNER_A),
    body: JSON.stringify({ provider: "cloudflare" }),
  })
  expect(await provider.json()).toMatchObject({
    provider: "cloudflare",
    health: { status: "healthy" },
  })
})

test("unknown provider diagnostics return a structured not-found error", async () => {
  const app = createApiRouter()
  installTestIdentity(app)
  app.route(
    "/",
    createProviderRoutes(new RegistryProviderDiagnostics(new RuntimeProviderRegistry([]))),
  )
  installStructuredErrors(app)

  const response = await app.request("/providers/test", {
    method: "POST",
    headers: requestHeaders(OWNER_A),
    body: JSON.stringify({ provider: "missing" }),
  })
  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({
    error: {
      code: "NOT_FOUND",
      details: {
        provider: "missing",
        operation: "resolve",
        providerCode: "PROVIDER_NOT_FOUND",
      },
    },
  })
})

test("provider diagnostics never expose adapter error messages", async () => {
  const rawMessage = "upstream rejected Bearer provider-secret-token"
  const failure = new RuntimeProviderError({
    provider: "cloudflare",
    operation: "health",
    code: "BRIDGE_UNAVAILABLE",
    message: rawMessage,
    retryable: true,
  })
  const app = createApiRouter()
  installTestIdentity(app)
  app.route(
    "/",
    createProviderRoutes(
      new RegistryProviderDiagnostics({
        get: () => {
          throw failure
        },
      }),
    ),
  )
  installStructuredErrors(app)

  const response = await app.request("/providers/test", {
    method: "POST",
    headers: requestHeaders(OWNER_A),
    body: JSON.stringify({ provider: "cloudflare" }),
  })
  expect(response.status).toBe(503)
  const body = await response.json()
  expect(body).toMatchObject({
    error: {
      code: "PROVIDER_UNAVAILABLE",
      message: "Runtime provider operation failed",
      details: {
        provider: "cloudflare",
        operation: "health",
        providerCode: "BRIDGE_UNAVAILABLE",
      },
    },
  })
  expect(JSON.stringify(body)).not.toContain(rawMessage)
  expect(JSON.stringify(body)).not.toContain("provider-secret-token")

  const normalized = normalizeError(failure)
  expect(normalized.retryable).toBe(true)
  expect(JSON.stringify(normalized)).not.toContain(rawMessage)
  expect(normalized.toStructuredError()).toMatchObject({
    message: "Runtime provider operation failed",
    retryable: true,
  })

  const unsafeCode = normalizeError(
    new RuntimeProviderError({
      provider: "cloudflare",
      operation: "health",
      code: "Bearer provider-code-secret",
      message: rawMessage,
    }),
  )
  expect(unsafeCode.details).toMatchObject({ providerCode: "PROVIDER_ERROR" })
  expect(JSON.stringify(unsafeCode.toStructuredError())).not.toContain("provider-code-secret")

  const runtimeLost = normalizeError(
    new RuntimeProviderError({
      provider: "cloudflare",
      operation: "writeFiles",
      code: "RUNTIME_LOST",
      message: "provider-private placement details",
    }),
  )
  expect(runtimeLost.toStructuredError()).toEqual({
    code: "RUNTIME_LOST",
    message: "Runtime execution state could not be recovered",
    retryable: false,
    details: { provider: "cloudflare", operation: "writeFiles" },
  })
  expect(JSON.stringify(runtimeLost.toStructuredError())).not.toContain("placement")
})

test("malformed JSON uses the safe invalid-request envelope", async () => {
  const app = createApiRouter()
  installTestIdentity(app)
  app.route(
    "/",
    createProviderRoutes({
      test: async (provider) => ({
        provider,
        capabilities: {
          isolation: "container",
          processRecovery: true,
          eventReplay: true,
          processInput: true,
          portExposure: true,
          processSignals: ["SIGKILL"],
        },
        health: { status: "healthy", checkedAt: "2026-07-13T00:00:00.000Z" },
      }),
    }),
  )
  installStructuredErrors(app)

  const response = await app.request("/providers/test", {
    method: "POST",
    headers: requestHeaders(OWNER_A),
    body: '{"provider":"Bearer malformed-json-secret",',
  })
  expect(response.status).toBe(400)
  const body = (await response.json()) as { error: { code: string; message: string } }
  expect(body.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: "Request body is malformed",
  })
  expect(JSON.stringify(body)).not.toContain("malformed-json-secret")
  expect(JSON.stringify(body)).not.toContain("stack")
})

const testApi = (service: Parameters<typeof createRunRoutes>[0]) => {
  const app = createApiRouter()
  installTestIdentity(app)
  app.route("/", createRunRoutes(service))
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Meanwhile", version: "0.1.0" },
  })
  installStructuredErrors(app)
  return app
}

const installTestIdentity = (app: ReturnType<typeof createApiRouter>): void => {
  app.use("*", async (context, next) => {
    const ownerId = context.req.header("x-test-owner")
    if (ownerId === undefined)
      throw new AppError({ code: "UNAUTHENTICATED", message: "Unauthenticated" })
    context.set("requestContext", {
      ownerId,
      principalId: ownerId === OWNER_A ? PRINCIPAL_A : PRINCIPAL_B,
      ownerRole: "admin",
      apiKeyId: "test-api-key",
      requestId: "request-test",
      traceId: "trace-test",
    })
    await next()
  })
}

const installStructuredErrors = (app: ReturnType<typeof createApiRouter>): void => {
  app.onError((error, context) => {
    const normalized = normalizeError(error)
    const requestId = context.get("requestContext")?.requestId ?? "unavailable"
    return context.json(
      errorEnvelope(normalized, requestId),
      normalized.status as ContentfulStatusCode,
    )
  })
}

const requestHeaders = (
  ownerId: string,
  additional: Readonly<Record<string, string>> = {},
): Record<string, string> => ({
  "Content-Type": "application/json",
  "x-test-owner": ownerId,
  ...additional,
})

class MemoryDeploymentApi implements DeploymentApi {
  readonly records = new Map<string, Deployment>()
  readonly idempotency = new Map<string, Deployment>()
  lastCreate: Parameters<DeploymentApi["create"]>[0] | null = null

  async create(input: Parameters<DeploymentApi["create"]>[0]): ReturnType<DeploymentApi["create"]> {
    this.lastCreate = input
    const identity = `${input.ownerId}\0${input.idempotencyKey}`
    const existing = this.idempotency.get(identity)
    if (existing !== undefined) return { deployment: existing, replayed: true }
    const timestamp = "2026-07-13T00:00:00.000Z"
    const targetConfig: { readonly index?: unknown } = input.targetConfig ?? {}
    const deployment: Deployment = {
      id: "40000000-0000-4000-8000-000000000001",
      ownerId: input.ownerId,
      runId: input.runId,
      artifactId: "c".repeat(64),
      target: input.targetName,
      targetConfig: { index: String(targetConfig.index ?? "index.html") },
      secretRefs: input.secretRefs ?? {},
      status: "queued",
      url: null,
      error: null,
      createdAt: timestamp,
      startedAt: null,
      finishedAt: null,
      updatedAt: timestamp,
    }
    this.records.set(deployment.id, deployment)
    this.idempotency.set(identity, deployment)
    return { deployment, replayed: false }
  }

  async list(
    ownerId: string,
    options: { limit: number; before?: string },
  ): Promise<{ readonly items: readonly Deployment[]; readonly nextCursor: string | null }> {
    return {
      items: [...this.records.values()]
        .filter((deployment) => deployment.ownerId === ownerId)
        .slice(0, options.limit),
      nextCursor: null,
    }
  }

  async get(ownerId: string, deploymentId: string): Promise<Deployment> {
    const deployment = this.records.get(deploymentId)
    if (deployment === undefined || deployment.ownerId !== ownerId) {
      throw new DeploymentExecutionError("DEPLOYMENT_NOT_FOUND", "Deployment not found.")
    }
    return deployment
  }

  async logs(input: Parameters<DeploymentApi["logs"]>[0]) {
    const deployment = await this.get(input.ownerId, input.deploymentId)
    return {
      items: [
        {
          deploymentId: deployment.id,
          sequence: 1,
          level: "info" as const,
          event: "deployment.queued",
          message: "Deployment queued.",
          fields: {},
          createdAt: deployment.createdAt,
        },
      ],
      nextCursor: 1,
    }
  }
}
