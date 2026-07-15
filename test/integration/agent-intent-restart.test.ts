import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunnerSpec } from "../../runner/protocol"
import { AgentCatalog } from "../../src/agents/catalog"
import {
  type ConsumeRunnerInput,
  type RunnerConsumptionResult,
  RunnerSessionController,
  type StartRunnerInput,
} from "../../src/agents/runner-session"
import { LocalArtifactStore } from "../../src/artifacts/local-artifact-store"
import { Store } from "../../src/persistence/store"
import { ExecutionProvenanceCatalog } from "../../src/provenance"
import { RuntimeProviderRegistry } from "../../src/providers/registry"
import { relativePath } from "../../src/providers/runtime-provider"
import { EnvironmentSecretResolver } from "../../src/secrets"
import { RunExecutor } from "../../src/services/run-executor"
import { type RunExecutionProvenance, RunService } from "../../src/services/run-service"
import { WorkspacePreparer } from "../../src/services/workspace-preparer"
import { StructuredLogger } from "../../src/telemetry"
import { MockRuntimeProvider } from "../fixtures/mock-provider"

const directories: string[] = []
const OWNER_ID = "agent-intent-owner"
const BUNDLE_ID = "a".repeat(64)

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("immutable agent launch intent", () => {
  test("a recovering run launches its accepted snapshot after the catalog changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meanwhile-agent-intent-"))
    directories.push(directory)
    const databasePath = join(directory, "meanwhile.sqlite")
    const catalogPath = join(directory, "agents.json")
    await writeCatalog(catalogPath, "accepted-agent", false)
    const acceptedCatalog = await AgentCatalog.load(catalogPath)

    const first = new Store(databasePath)
    createIdentity(first)
    const service = runService(first, acceptedCatalog)
    const created = await service.create(context(), command(), "immutable-agent-intent")
    const acceptedDigest = created.run.agentCatalogDigest
    first.close()

    await writeCatalog(catalogPath, "replacement-agent", true)
    const replacementCatalog = await AgentCatalog.load(catalogPath)
    expect(replacementCatalog.digest).not.toBe(acceptedDigest)

    const launched = Promise.withResolvers<RunnerSpec>()
    const second = new Store(databasePath)
    const executor = new RunExecutor({
      store: second,
      providers: new RuntimeProviderRegistry([new MockRuntimeProvider()]),
      runner: new CapturingRunner(launched.resolve),
      workspace: new WorkspacePreparer({ read: async () => [] }),
      artifactStore: new LocalArtifactStore(join(directory, "artifacts")),
      artifactLimits: { maxFiles: 8, maxFileBytes: 1_024, maxTotalBytes: 8_192 },
      secrets: secretResolver(),
      logger: new StructuredLogger({
        serviceName: "agent-intent-test",
        serviceVersion: "test",
        sink: { write() {} },
      }),
      concurrency: 1,
      pollMs: 60_000,
    })

    await executor.start()
    const launchedSpec = await launched.promise
    expect(launchedSpec.agent).toEqual({
      executable: "accepted-agent",
      args: [],
      workingDirectory: "workspace",
    })
    expect(launchedSpec.permissionPolicy).toEqual({
      mode: "allow-once",
      toolKinds: ["read", "edit", "delete", "move", "search"],
    })
    expect(second.getRun(OWNER_ID, created.run.id)?.agentCatalogDigest).toBe(acceptedDigest)
    await executor.stop()
    second.close()
  })

  test("catalog intent participates in idempotency", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meanwhile-agent-idempotency-"))
    directories.push(directory)
    const catalogPath = join(directory, "agents.json")
    const store = new Store(":memory:")
    createIdentity(store)

    await writeCatalog(catalogPath, "first-agent", false)
    await runService(store, await AgentCatalog.load(catalogPath)).create(
      context(),
      command(),
      "same-key",
    )
    await writeCatalog(catalogPath, "second-agent", false)

    await expect(
      runService(store, await AgentCatalog.load(catalogPath)).create(
        context(),
        command(),
        "same-key",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 })
    expect(store.listRuns(OWNER_ID, { limit: 10 }).items).toHaveLength(1)
    store.close()
  })

  test("execution provenance participates in idempotency", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meanwhile-provenance-idempotency-"))
    directories.push(directory)
    const catalogPath = join(directory, "agents.json")
    await writeCatalog(catalogPath, "accepted-agent", false)
    const catalog = await AgentCatalog.load(catalogPath)
    const store = new Store(":memory:")
    createIdentity(store)
    const provider = new MockRuntimeProvider()

    await runService(
      store,
      catalog,
      new ExecutionProvenanceCatalog(new RuntimeProviderRegistry([provider])),
    ).create(context(), command(), "same-provenance-key")
    Object.defineProperty(provider, "provenance", {
      value: { ...provider.provenance, adapterVersion: "replacement-adapter" },
    })

    await expect(
      runService(
        store,
        catalog,
        new ExecutionProvenanceCatalog(new RuntimeProviderRegistry([provider])),
      ).create(context(), command(), "same-provenance-key"),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 })
    expect(store.listRuns(OWNER_ID, { limit: 10 }).items).toHaveLength(1)
    store.close()
  })
})

class CapturingRunner extends RunnerSessionController {
  constructor(private readonly capture: (spec: RunnerSpec) => void) {
    super()
  }

  override async start(input: StartRunnerInput) {
    this.capture(input.spec)
    return input.provider.spawn(input.runtime, {
      processId: input.processId,
      argv: ["meanwhile-runner"],
      cwd: relativePath("."),
      env: input.credentialEnvironment,
      timeoutMs: input.timeoutMs,
    })
  }

  override async consume(input: ConsumeRunnerInput): Promise<RunnerConsumptionResult> {
    return new Promise<RunnerConsumptionResult>((_resolve, reject) => {
      const fail = () => reject(input.signal?.reason ?? new Error("observation stopped"))
      if (input.signal?.aborted === true) fail()
      else input.signal?.addEventListener("abort", fail, { once: true })
    })
  }
}

function runService(
  store: Store,
  catalog: AgentCatalog,
  executionProvenance: RunExecutionProvenance = new ExecutionProvenanceCatalog(
    new RuntimeProviderRegistry([new MockRuntimeProvider()]),
  ),
): RunService {
  return new RunService({
    store,
    commands: { enqueue() {}, async cancel() {} },
    workspaceInputs: {
      prepare() {
        throw new Error("Inline upload preparation is outside this fixture")
      },
      async publish() {
        throw new Error("Inline upload publication is outside this fixture")
      },
      async require(ownerId, artifactId) {
        if (ownerId !== OWNER_ID || artifactId !== BUNDLE_ID) {
          throw new Error("Workspace bundle is outside this fixture owner scope")
        }
      },
    },
    agentIntents: catalog,
    secretReferences: secretResolver(),
    providerNames: {
      has: (name) => name === "mock",
      supportsCredentialMediation: () => false,
    },
    executionProvenance,
    defaultProvider: "mock",
  })
}

function secretResolver(): EnvironmentSecretResolver {
  return new EnvironmentSecretResolver({ source: { get: () => undefined } })
}

function command() {
  return {
    workspace: { type: "bundle" as const, artifactId: BUNDLE_ID },
    agentType: "fixture",
    prompt: "Use the accepted launch intent",
    env: {},
    secretRefs: {},
    provider: "mock",
    artifactPaths: [],
    timeoutMs: 60_000,
  }
}

function context() {
  return {
    ownerId: OWNER_ID,
    apiKeyId: "agent-intent-api-key",
    requestId: crypto.randomUUID(),
    traceId: null,
  }
}

function createIdentity(store: Store): void {
  store.createOwner({ id: OWNER_ID, name: "Agent intent owner", createdAt: now() })
  store.createApiKey({
    id: "agent-intent-api-key",
    ownerId: OWNER_ID,
    prefix: "mwk_abcdefghijkl",
    hash: `sha256:${"a".repeat(64)}`,
    name: "Agent intent test",
    createdAt: now(),
  })
}

async function writeCatalog(path: string, executable: string, terminal: boolean): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      agents: {
        fixture: {
          transport: "stdio",
          executable,
          args: [],
          workingDirectory: "workspace",
          capabilities: { filesystem: true, terminal },
          envNames: [],
          networkPolicy: { allowedHosts: [] },
          credentials: [],
        },
      },
    }),
  )
}

function now(): string {
  return "2026-07-13T00:00:00.000Z"
}
