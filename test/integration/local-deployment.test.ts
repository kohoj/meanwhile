import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalArtifactStore } from "../../src/artifacts/local-artifact-store"
import { LocalStaticAdapter } from "../../src/deployments/local-static-adapter"
import { LocalStaticServer } from "../../src/deployments/local-static-server"
import { DeployAdapterRegistry } from "../../src/deployments/registry"
import { Store } from "../../src/persistence/store"
import { EnvironmentSecretResolver } from "../../src/secrets"
import {
  ArtifactCollector,
  artifactMetadata,
  type WorkspaceEntry,
} from "../../src/services/artifact-collector"
import {
  DeploymentDispatcher,
  DeploymentExecutor,
  StoreDeploymentRepository,
  StoreDeploymentSourceResolver,
} from "../../src/services/deployment-executor"
import { StructuredLogger } from "../../src/telemetry"
import {
  TEST_AGENT_CATALOG_DIGEST,
  testAgentSpec,
  testExecutionProvenanceFor,
} from "../fixtures/agent-intent"

const disposals: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
})

describe("durable local deployment", () => {
  test("reconciles a published running deployment after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "meanwhile-local-deploy-"))
    const databasePath = join(root, "meanwhile.sqlite")
    const artifactStore = new LocalArtifactStore(join(root, "artifacts"))
    disposals.push(() => rm(root, { recursive: true, force: true }))

    let store = new Store(databasePath)
    store.createOwner({
      id: "owner-a",
      name: "Owner A",
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    createSucceededRun(store)

    const collector = new ArtifactCollector({
      store: artifactStore,
      limits: { maxFiles: 100, maxFileBytes: 1_000_000, maxTotalBytes: 5_000_000 },
      now: () => new Date("2026-01-01T00:01:00.000Z"),
    })
    const [collected] = await collector.collect({
      ownerId: "owner-a",
      runId: "run-a",
      declaredPaths: ["dist"],
      signal: new AbortController().signal,
      workspace: workspace(
        [
          { path: "dist", type: "directory", size: 0 },
          { path: "dist/index.html", type: "file", size: 17 },
          { path: "dist/app.js", type: "file", size: 28 },
        ],
        {
          "dist/index.html": "<h1>Deployed</h1>",
          "dist/app.js": "document.body.dataset.ok='1'",
        },
      ),
    })
    const artifact = required(collected)
    store.insertArtifact(artifactMetadata(artifact))

    const server = new LocalStaticServer({ root: join(root, "previews") })
    disposals.push(() => server.stop())
    const firstAdapter = new LocalStaticAdapter(server)
    const adapters = new DeployAdapterRegistry([firstAdapter])
    const clock = monotonicClock()
    const firstExecutor = executor(store, artifactStore, adapters, clock)
    const queued = await firstExecutor.create({
      ownerId: "owner-a",
      idempotencyKey: "deployment-request-a",
      runId: "run-a",
      source: { artifactPath: "dist" },
      targetName: "local-static",
      targetConfig: {},
      requestId: "request-create",
    })
    expect(queued.deployment.status).toBe("queued")

    const startedAt = clock().toISOString()
    const running = required(
      store.transitionDeployment({
        deploymentId: queued.deployment.id,
        fromStatus: "queued",
        toStatus: "running",
        at: startedAt,
        audit: {
          id: "audit-deployment-start",
          ownerId: "owner-a",
          actorApiKeyId: null,
          action: "deployment.start",
          resourceType: "deployment",
          resourceId: queued.deployment.id,
          requestId: "request-start-before-crash",
          traceId: null,
          metadata: { target: "local-static" },
          createdAt: startedAt,
        },
      }),
    )
    const immutableSource = await new StoreDeploymentSourceResolver(store, artifactStore).open({
      ownerId: running.ownerId,
      runId: running.runId,
      artifactId: running.artifactId,
    })
    await firstAdapter.deploy(
      {
        deploymentId: running.id,
        source: immutableSource,
        target: { name: running.target, config: running.targetConfig },
        secrets: {},
      },
      { signal: new AbortController().signal, async emit() {} },
    )

    // The publish completed, but the control plane crashed before its success
    // transition. No in-memory source or executor state survives this boundary.
    await server.stop()
    store.close()
    store = new Store(databasePath)
    disposals.push(() => store.close())

    const restartedServer = new LocalStaticServer({ root: join(root, "previews") })
    disposals.push(() => restartedServer.stop())
    const restartedAdapter = new LocalStaticAdapter(restartedServer)
    const restartedAdapters = new DeployAdapterRegistry([restartedAdapter])
    const restartedExecutor = executor(store, artifactStore, restartedAdapters, clock)
    const dispatcher = new DeploymentDispatcher({
      store,
      executor: restartedExecutor,
      logger: new StructuredLogger({
        serviceName: "meanwhile-test",
        serviceVersion: "0.1.0",
        sink: { write() {} },
      }),
      pollMs: 60_000,
      shutdownGraceMs: 100,
    })
    await dispatcher.start()
    await dispatcher.drain()
    await dispatcher.stop()

    const deployed = await restartedExecutor.get("owner-a", queued.deployment.id)

    expect(deployed.status).toBe("succeeded")
    const deploymentUrl = required(deployed.url)
    expect(await (await fetch(deploymentUrl)).text()).toBe("<h1>Deployed</h1>")
    expect(await (await fetch(new URL("app.js", deploymentUrl))).text()).toBe(
      "document.body.dataset.ok='1'",
    )

    const logs = await restartedExecutor.logs({
      ownerId: "owner-a",
      deploymentId: deployed.id,
    })
    expect(logs.items.map((log) => log.event)).toEqual(["deployment.local_static.reused"])
    expect(store.listAudit("owner-a", deployed.id).map((audit) => audit.action)).toEqual([
      "deployment.create",
      "deployment.start",
      "deployment.succeed",
    ])
    await expect(restartedExecutor.get("owner-b", deployed.id)).rejects.toMatchObject({
      code: "DEPLOYMENT_NOT_FOUND",
    })

    await Bun.write(
      join(root, "previews", deployed.id, "public", "index.html"),
      "<h1>Tampered</h1>",
    )
    const sourceAfterTamper = await new StoreDeploymentSourceResolver(store, artifactStore).open({
      ownerId: deployed.ownerId,
      runId: deployed.runId,
      artifactId: deployed.artifactId,
    })
    await expect(
      restartedAdapter.deploy(
        {
          deploymentId: deployed.id,
          source: sourceAfterTamper,
          target: { name: deployed.target, config: deployed.targetConfig },
          secrets: {},
        },
        { signal: new AbortController().signal, async emit() {} },
      ),
    ).rejects.toMatchObject({ code: "DEPLOYMENT_TARGET_FAILED" })
  })
})

function executor(
  store: Store,
  artifacts: LocalArtifactStore,
  adapters: DeployAdapterRegistry,
  now: () => Date,
) {
  return new DeploymentExecutor({
    repository: new StoreDeploymentRepository(store),
    runs: store,
    sourceResolver: new StoreDeploymentSourceResolver(store, artifacts),
    secretResolver: new EnvironmentSecretResolver({ source: { get: () => undefined } }),
    adapters,
    id: () => "deployment_0123456789",
    now,
  })
}

function createSucceededRun(store: Store): void {
  const created = store.createRun({
    id: "run-a",
    ownerId: "owner-a",
    workspace: { type: "repository", url: "https://example.test/repo.git" },
    agentType: "fixture",
    agentSpec: testAgentSpec(),
    agentCatalogDigest: TEST_AGENT_CATALOG_DIGEST,
    executionProvenance: testExecutionProvenanceFor("local"),
    prompt: "Build static output",
    env: {},
    secretRefs: {},
    provider: "local",
    artifactPaths: ["dist"],
    timeoutMs: 60_000,
    createdAt: "2026-01-01T00:00:01.000Z",
    audit: audit("run-create"),
  }).run
  const provisioningAt = "2026-01-01T00:00:02.000Z"
  required(
    store.claimRunProvisioning({
      runId: created.id,
      expectedVersion: created.statusVersion,
      at: provisioningAt,
      deadlineAt: "2026-01-01T00:01:02.000Z",
      audit: { ...audit("run-provision"), action: "run.provision" },
      systemLog: { eventType: "run.provisioning", data: "Provisioning runtime" },
    }),
  )
  const runnerSessionId = `runner-${created.id}`
  store.createRunnerSession({
    runId: created.id,
    ownerId: created.ownerId,
    runnerSessionId,
    protocolVersion: 1,
    createdAt: provisioningAt,
  })
  const runningAt = "2026-01-01T00:00:03.000Z"
  store.acceptRunnerFrame({
    ownerId: created.ownerId,
    runId: created.id,
    runnerSessionId,
    protocolVersion: 1,
    providerCursor: "cursor-1",
    runnerSequence: 1,
    stream: "agent",
    eventType: "session.started",
    data: JSON.stringify({ sessionId: "seed-session" }),
    createdAt: runningAt,
    runningTransition: {
      at: runningAt,
      reason: "agent.session_started",
      audit: { ...audit("run-running"), action: "agent.start" },
      systemLog: { eventType: "run.running", data: "Agent session started" },
    },
  })
  const terminal = { outcome: "succeeded", stopReason: "end_turn" } as const
  const terminalAt = "2026-01-01T00:00:04.000Z"
  store.acceptRunnerFrame({
    ownerId: created.ownerId,
    runId: created.id,
    runnerSessionId,
    protocolVersion: 1,
    providerCursor: "cursor-2",
    runnerSequence: 2,
    stream: "agent",
    eventType: "terminal",
    data: JSON.stringify(terminal),
    terminalResult: terminal,
    createdAt: terminalAt,
  })
  const outcome = store.claimRunOutcome({
    kind: "runner",
    ownerId: created.ownerId,
    runId: created.id,
    status: "succeeded",
    terminalResult: terminal,
    at: terminalAt,
    systemLog: { eventType: "run.succeeded", data: "Run succeeded" },
    resultAudit: { ...audit("run-succeed"), action: "run.succeeded" },
  })
  if (outcome?.outcome !== "claimed") throw new Error("run outcome was not claimed")
}

function audit(requestId: string) {
  return {
    actorApiKeyId: null,
    requestId,
    traceId: null,
    metadata: {},
  }
}

function workspace(entries: readonly WorkspaceEntry[], files: Readonly<Record<string, string>>) {
  return {
    async list() {
      return entries
    },
    async readFile(path: string) {
      const value = files[path]
      if (value === undefined) throw new Error("Missing workspace fixture.")
      return new TextEncoder().encode(value)
    },
  }
}

function monotonicClock(): () => Date {
  let tick = 0
  return () => new Date(Date.UTC(2026, 0, 1, 1, 0, tick++))
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required test value is missing.")
  return value
}
