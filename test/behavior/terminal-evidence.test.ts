import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunnerFrame, RunnerTerminalPayload } from "../../runner/protocol"
import { RUNNER_PROTOCOL_VERSION } from "../../runner/protocol"
import {
  type ConsumeRunnerInput,
  type RunnerConsumptionResult,
  RunnerSessionController,
  type StartRunnerInput,
} from "../../src/agents/runner-session"
import { createRunRoutes } from "../../src/api/runs"
import { createApiRouter } from "../../src/api/schemas"
import { LocalArtifactStore } from "../../src/artifacts/local-artifact-store"
import type { JsonObject, RequestContext, Run, RunStatus } from "../../src/domain"
import {
  type ClaimRunOutcomeInput,
  type ClaimRunOutcomeResult,
  type ClaimRunProvisioningInput,
  Store,
} from "../../src/persistence/store"
import { RuntimeProviderRegistry } from "../../src/providers/registry"
import {
  type ProcessEvent,
  type ProcessHandle,
  processHandle,
  type RuntimeHandle,
  type RuntimeProvider,
  RuntimeProviderError,
  relativePath,
} from "../../src/providers/runtime-provider"
import {
  EnvironmentSecretResolver,
  SecretRedactor,
  type SecretReferenceValidator,
  type SecretResolver,
} from "../../src/secrets"
import { RunExecutor } from "../../src/services/run-executor"
import { RunService } from "../../src/services/run-service"
import { WorkspacePreparer } from "../../src/services/workspace-preparer"
import { StructuredLogger, Telemetry } from "../../src/telemetry"
import {
  permissiveTestAgentIntents,
  TEST_AGENT_CATALOG_DIGEST,
  testAgentSpec,
  testExecutionProvenance,
  testExecutionProvenanceFor,
} from "../fixtures/agent-intent"
import { MockRuntimeProvider } from "../fixtures/mock-provider"

const OWNER_ID = "00000000-0000-4000-8000-000000000101"
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000102"
const PROJECT_ID = "00000000-0000-4000-8000-000000000103"
const AGENT_SECRET = "TEST_RUNNER_SECRET"
const encoder = new TextEncoder()

const directories: string[] = []
const executors: RunExecutor[] = []
const stores: Store[] = []

afterEach(async () => {
  for (const executor of executors.splice(0).reverse()) await executor.stop().catch(() => undefined)
  for (const store of stores.splice(0).reverse()) store.close()
  for (const directory of directories.splice(0).reverse()) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe("durable runner terminal evidence", () => {
  test("releases control-plane material while the brokered lease survives supervision detach", async () => {
    const provider = new MockRuntimeProvider()
    const ready = deferred()
    const sourceValue = "resource-bound-value"
    const environment: Record<string, string> = { [AGENT_SECRET]: sourceValue }
    const redactor = new SecretRedactor([sourceValue])
    const scopes: Array<Parameters<SecretResolver["resolve"]>[1]> = []
    const runnerEnvironments: Readonly<Record<string, string>>[] = []
    let placeholder = ""
    let releases = 0
    const secrets: SecretResolver = {
      validate() {},
      resolve(_references, scope) {
        scopes.push(scope)
        return {
          environment,
          redactor,
          async release() {
            await Promise.resolve()
            for (const name of Object.keys(environment)) {
              environment[name] = ""
              delete environment[name]
            }
            redactor.dispose()
            releases += 1
          },
        }
      },
    }
    const runner: RunnerSessionController = {
      async start(input) {
        runnerEnvironments.push({ ...input.credentialEnvironment })
        placeholder = input.credentialEnvironment[AGENT_SECRET] ?? ""
        return processHandle(input.provider.name, `${input.runtime.opaque}.${input.processId}`)
      },
      async consume(input) {
        const signal = input.signal
        if (signal === undefined) throw new Error("Run observation signal is required")
        await input.onFrame(
          frame(input.runId, input.runnerSessionId, 1, "session.started", {
            sessionId: "detached-session",
          }),
          "1",
        )
        await input.onCursor("1")
        input.onDiagnostic({ cursor: "2", timestamp: now(), data: `capability=${placeholder}` })
        await input.onCursor("2")
        ready.resolve()
        return new Promise<RunnerConsumptionResult>((_resolve, reject) => {
          const aborted = () => reject(signal.reason)
          if (signal.aborted) aborted()
          else signal.addEventListener("abort", aborted, { once: true })
        })
      },
      async cancel() {},
    }
    const fixture = await createFixture({ provider, runner, secrets, telemetry: true })
    const run = createRun(
      fixture.store,
      { secretRefs: { [AGENT_SECRET]: `env://${AGENT_SECRET}` } },
      provider,
    )

    await fixture.executor.start()
    await bounded(ready.promise)
    await fixture.executor.stop()

    expect(fixture.store.getRun(OWNER_ID, run.id)?.status).toBe("running")
    expect(scopes).toEqual([
      {
        ownerId: OWNER_ID,
        purpose: "agent",
        resourceType: "run",
        resourceId: run.id,
      },
    ])
    expect(releases).toBe(1)
    expect(environment).toEqual({})
    expect(redactor.active).toBeFalse()
    expect(runnerEnvironments).toHaveLength(1)
    expect(runnerEnvironments[0]?.[AGENT_SECRET]).toMatch(/^mwcap_test_/)
    expect(runnerEnvironments[0]?.[AGENT_SECRET]).not.toBe(sourceValue)
    expect(fixture.store.getCredentialLeaseInternal("run", run.id)?.status).toBe("active")
    expect(provider.operations.some(({ operation }) => operation === "credentialAttach")).toBeTrue()
    const durableLogs = JSON.stringify(fixture.store.listRunLogs(OWNER_ID, run.id, 0, 100))
    expect(durableLogs).toContain("capability=[REDACTED]")
    expect(durableLogs).not.toContain(placeholder)
  })

  test("uses control-plane acceptance time instead of a sandbox wall clock", async () => {
    const provider = new MockRuntimeProvider()
    const fixture = await createFixture({
      provider,
      runner: terminalRunner({ outcome: "succeeded", stopReason: "end_turn" }, future()),
    })
    const run = createRun(fixture.store, {}, provider)
    const terminalReached = fixture.store.observe(run.id, "succeeded")
    await fixture.executor.start()
    await bounded(terminalReached)
    expect(
      fixture.store
        .listRunLogs(OWNER_ID, run.id, 0, 100)
        .every(({ createdAt }) => createdAt !== future()),
    ).toBeTrue()
  })

  test("structurally redacts one terminal value before every durable and public representation", async () => {
    const secret = `terminal-"quoted"\\slash\nline-${crypto.randomUUID()}`
    const terminal: RunnerTerminalPayload = {
      outcome: "failed",
      error: {
        code: "RUNNER_INTERNAL_ERROR",
        message: `malicious provider message: ${secret}`,
      },
      agentExit: { exitCode: 23, signal: null },
    }
    const provider = new MockRuntimeProvider()
    const runner = terminalRunner(terminal)
    const fixture = await createFixture({
      provider,
      runner,
      secret,
      workspaceFiles: [{ path: "dist/leak.txt", content: encoder.encode(secret) }],
    })
    const run = createRun(
      fixture.store,
      {
        secretRefs: { [AGENT_SECRET]: `env://${AGENT_SECRET}` },
        artifactPaths: ["dist"],
      },
      provider,
    )
    const terminalReached = fixture.store.observe(run.id, "failed")

    await fixture.executor.start()
    const failed = await bounded(terminalReached)

    expect(failed.error).toEqual({
      code: "RUNNER_INTERNAL_ERROR",
      message: "malicious provider message: [REDACTED]",
      retryable: false,
    })
    expect(failed.exitCode).toBe(23)

    const logs = fixture.store.listRunLogs(OWNER_ID, run.id, 0, 1_000)
    const terminalLog = logs.find((log) => log.eventType === "terminal")
    const session = fixture.store.getRunnerSession(run.id)
    expect(terminalLog).toBeDefined()
    expect(JSON.parse(terminalLog?.data ?? "null")).toEqual(session?.terminalResult)
    expect(session?.terminalResult).toEqual({
      outcome: "failed",
      error: {
        code: "RUNNER_INTERNAL_ERROR",
        message: "malicious provider message: [REDACTED]",
      },
      agentExit: { exitCode: 23, signal: null },
    })
    expect(fixture.store.listArtifacts(OWNER_ID, run.id)).toEqual([])

    const api = runApi(fixture.store, fixture.secrets, fixture.providers)
    const response = await api.request(`/runs/${run.id}`)
    expect(response.status).toBe(200)
    const apiBody = await response.text()
    expect(apiBody).not.toContain(secret)
    expect(apiBody).toContain("malicious provider message: [REDACTED]")

    const rawRows = fixture.store.database
      .query<{ error_json: string | null; terminal_result_json: string | null }, [string]>(`
        SELECT runs.error_json, runner_sessions.terminal_result_json
        FROM runs JOIN runner_sessions ON runner_sessions.run_id = runs.id
        WHERE runs.id = ?
      `)
      .get(run.id)
    const durable = JSON.stringify({
      logs,
      artifacts: fixture.store.listArtifacts(OWNER_ID, run.id),
      audits: fixture.store.listAudit(OWNER_ID),
      rawRows,
    })
    expect(durable).not.toContain(secret)
    expect(
      Buffer.from(fixture.store.database.serialize()).includes(Buffer.from(secret)),
    ).toBeFalse()
    expect(fixture.operationalLogs.join("\n")).not.toContain(secret)
  })

  test("fails closed on terminal evidence without its atomic reservation", async () => {
    const delegate = new MockRuntimeProvider()
    const provider = withRecovery(delegate, false)
    const fixture = await createFixture({ provider, runner: unreachableRunner() })
    const run = createRun(
      fixture.store,
      {
        artifactPaths: ["dist"],
        deadlineAt: future(),
        status: "running",
      },
      provider,
    )
    const runtime = await seedRuntime(fixture.store, delegate, run, { destroy: true })
    const terminal: RunnerTerminalPayload = {
      outcome: "failed",
      error: { code: "AGENT_EXITED", message: "The agent exited" },
      agentExit: { exitCode: 41, signal: null },
    }
    seedTerminal(fixture.store, run, runtime, terminal)
    // This split state cannot be produced by acceptRunnerFrame because its log
    // and reservation commit in one transaction. Recovery fails closed on
    // corrupted persistence instead of inventing state.
    fixture.store.database
      .query("UPDATE runner_sessions SET terminal_result_json = NULL WHERE run_id = ?")
      .run(run.id)
    delegate.operations.length = 0
    const terminalReached = fixture.store.observe(run.id, "failed")

    await fixture.executor.start()
    const failed = await bounded(terminalReached)

    expect(failed.error?.code).toBe("DATABASE_INTEGRITY_FAILED")
    expect(failed.exitCode).toBeNull()
    expect(fixture.store.getRunnerSession(run.id)?.terminalResult).toBeNull()
    expect(fixture.store.listArtifacts(OWNER_ID, run.id)).toEqual([])
    expect(delegate.operations).toEqual([])
  })

  test("recovers accepted terminal evidence and captures artifacts without process recovery", async () => {
    const delegate = new MockRuntimeProvider()
    const provider = withRecovery(delegate, false)
    const fixture = await createFixture({ provider, runner: unreachableRunner() })
    const run = createRun(
      fixture.store,
      {
        artifactPaths: ["dist"],
        deadlineAt: future(),
        status: "running",
      },
      provider,
    )
    const runtime = await seedRuntime(fixture.store, delegate, run, {
      files: [{ path: "dist/index.html", content: encoder.encode("<h1>recovered</h1>") }],
    })
    seedTerminal(fixture.store, run, runtime, { outcome: "succeeded", stopReason: "end_turn" })
    delegate.operations.length = 0
    const terminalReached = Promise.race([
      fixture.store.observe(run.id, "succeeded"),
      fixture.store.observe(run.id, "failed"),
    ])

    await fixture.executor.start()
    const succeeded = await bounded(terminalReached)

    expect(succeeded).toMatchObject({ status: "succeeded", error: null })
    expect(
      fixture.store.listRunStatusEvents(OWNER_ID, run.id).map((event) => event.toStatus),
    ).toEqual(["queued", "provisioning", "running", "succeeded"])
    expect(
      fixture.store.listArtifacts(OWNER_ID, run.id).map((artifact) => artifact.logicalPath),
    ).toEqual(["dist"])
    const operations = delegate.operations.map((operation) => operation.operation)
    expect(operations).toContain("inspect")
    expect(operations).toContain("readFile")
    expect(operations).not.toContain("inspectProcess")
    expect(operations).not.toContain("events")
    expect(operations).not.toContain("wait")
  })

  test("does not reactivate compute to capture artifacts after an accepted deadline", async () => {
    const delegate = new MockRuntimeProvider()
    const provider = withRecovery(delegate, false)
    const fixture = await createFixture({ provider, runner: unreachableRunner() })
    const run = createRun(
      fixture.store,
      {
        artifactPaths: ["dist"],
        deadlineAt: "2000-01-01T00:00:00.000Z",
        status: "running",
      },
      provider,
    )
    const runtime = await seedRuntime(fixture.store, delegate, run, {
      files: [{ path: "dist/index.html", content: encoder.encode("<h1>too late</h1>") }],
    })
    seedTerminal(fixture.store, run, runtime, { outcome: "succeeded", stopReason: "end_turn" })
    delegate.operations.length = 0
    const succeeded = fixture.store.observe(run.id, "succeeded")

    await fixture.executor.start()
    expect((await bounded(succeeded)).status).toBe("succeeded")

    expect(delegate.operations).toEqual([])
    expect(fixture.store.listArtifacts(OWNER_ID, run.id)).toEqual([])
    expect(
      fixture.store
        .listRunLogs(OWNER_ID, run.id, 0, 1_000)
        .find((log) => log.eventType === "artifact.capture_failed")?.data,
    ).toBe(JSON.stringify({ code: "ARTIFACT_CAPTURE_TIMED_OUT" }))
  })

  test("bounds artifact capture by the original run deadline after terminal reservation", async () => {
    const delegate = new MockRuntimeProvider()
    const blocked = withBlockedArtifactRead(delegate)
    const fixture = await createFixture({
      provider: blocked.provider,
      runner: terminalRunner({ outcome: "succeeded", stopReason: "end_turn" }),
      workspaceFiles: [{ path: "dist/index.html", content: encoder.encode("<h1>bounded</h1>") }],
    })
    const run = createRun(
      fixture.store,
      { artifactPaths: ["dist"], timeoutMs: 250 },
      blocked.provider,
    )
    const succeeded = fixture.store.observe(run.id, "succeeded")

    await fixture.executor.start()
    expect((await bounded(succeeded)).status).toBe("succeeded")

    expect(blocked.aborted()).toBeTrue()
    expect(fixture.store.listArtifacts(OWNER_ID, run.id)).toEqual([])
    expect(
      fixture.store
        .listRunLogs(OWNER_ID, run.id, 0, 1_000)
        .find((log) => log.eventType === "artifact.capture_failed")?.data,
    ).toBe(JSON.stringify({ code: "ARTIFACT_CAPTURE_TIMED_OUT" }))
  })

  test("reuses the durable launch budget after a pre-handle spawn interruption", async () => {
    const provider = new MockRuntimeProvider()
    const timeoutBudgets: number[] = []
    const delegate = terminalRunner({ outcome: "succeeded", stopReason: "end_turn" })
    const runner: RunnerSessionController = {
      async start(input) {
        timeoutBudgets.push(input.timeoutMs)
        return delegate.start(input)
      },
      consume: (input) => delegate.consume(input),
      cancel: (provider, process) => delegate.cancel(provider, process),
    }
    const fixture = await createFixture({ provider, runner })
    const run = createRun(fixture.store, { status: "provisioning" }, provider)
    const runtime = await seedRuntime(fixture.store, provider, run, { persistProcess: false })
    const processId = `runner-${run.id}`.slice(0, 128)
    expect(
      fixture.store.ensureRunProcessLaunchIntent({
        runId: run.id,
        ownerId: run.ownerId,
        runtimeId: runtime.runtime.opaque,
        processId,
        timeoutBudgetMs: 55_000,
        createdAt: now(),
      })?.timeoutBudgetMs,
    ).toBe(55_000)
    const succeeded = fixture.store.observe(run.id, "succeeded")

    await fixture.executor.start()
    await bounded(succeeded)

    expect(timeoutBudgets).toEqual([55_000])
    expect(fixture.store.getRun(OWNER_ID, run.id)?.processId).toBe(processId)
    expect(fixture.store.getRuntimeForRun(run.id)?.processHandle).not.toBeNull()
    expect(
      fixture.store
        .listAudit(OWNER_ID, runtime.runtime.opaque)
        .filter((record) => record.action === "runtime.process_start"),
    ).toHaveLength(1)
  })

  test("normalizes a process lost between inspection and replay as RUNTIME_LOST", async () => {
    const delegate = new MockRuntimeProvider()
    const provider = withEventStreamProcessLoss(delegate)
    const fixture = await createFixture({ provider })
    const run = createRun(fixture.store, { status: "running" }, provider)
    const runtime = await seedRuntime(fixture.store, delegate, run)
    fixture.store.setRunRuntime({
      runId: run.id,
      runtimeId: runtime.runtime.opaque,
      processId: runtime.process.opaque,
      at: now(),
    })
    const terminalReached = fixture.store.observe(run.id, "failed")

    await fixture.executor.start()
    const failed = await bounded(terminalReached)

    expect(failed.error).toMatchObject({ code: "RUNTIME_LOST", retryable: false })
  })

  test("lets accepted runner terminal evidence win a concurrent cancellation", async () => {
    const provider = new MockRuntimeProvider()
    const controlled = controlledTerminalRunner({ outcome: "succeeded", stopReason: "end_turn" })
    const fixture = await createFixture({ provider, runner: controlled.controller })
    const run = createRun(fixture.store, {}, provider)
    const succeeded = fixture.store.observe(run.id, "succeeded")

    try {
      await fixture.executor.start()
      await bounded(controlled.ready)
      controlled.allowTerminal()
      await bounded(controlled.terminalAccepted)

      await fixture.executor.cancel({ runId: run.id, context: requestContext() })
      expect(controlled.cancelCalls()).toBe(0)
      controlled.allowCompletion()

      expect((await bounded(succeeded)).status).toBe("succeeded")
      expect(
        fixture.store.listRunStatusEvents(OWNER_ID, run.id).map((event) => event.toStatus),
      ).toEqual(["queued", "provisioning", "running", "succeeded"])
    } finally {
      controlled.allowTerminal()
      controlled.allowCompletion()
    }
  })

  test("keeps a runner terminal arriving after cancellation diagnostic-only", async () => {
    const provider = new MockRuntimeProvider()
    const controlled = controlledTerminalRunner({ outcome: "succeeded", stopReason: "end_turn" })
    const fixture = await createFixture({ provider, runner: controlled.controller })
    const run = createRun(fixture.store, {}, provider)
    const cancelled = fixture.store.observe(run.id, "cancelled")

    try {
      await fixture.executor.start()
      await bounded(controlled.ready)
      await fixture.executor.cancel({ runId: run.id, context: requestContext() })
      expect((await bounded(cancelled)).status).toBe("cancelled")
      expect(controlled.cancelCalls()).toBe(1)

      controlled.allowTerminal()
      await bounded(controlled.terminalAccepted)
      controlled.allowCompletion()
      await Bun.sleep(0)

      expect(fixture.store.getRunnerSession(run.id)?.terminalResult).toBeNull()
      expect(
        fixture.store
          .listRunLogs(OWNER_ID, run.id, 0, 1_000)
          .filter((log) => log.eventType === "terminal.late"),
      ).toHaveLength(1)
      expect(fixture.store.getRun(OWNER_ID, run.id)?.status).toBe("cancelled")
    } finally {
      controlled.allowTerminal()
      controlled.allowCompletion()
    }
  })
})

interface Fixture {
  readonly store: ObservedStore
  readonly executor: RunExecutor
  readonly secrets: SecretReferenceValidator
  readonly providers: RuntimeProviderRegistry
  readonly operationalLogs: string[]
}

async function createFixture(input: {
  provider: RuntimeProvider
  runner?: RunnerSessionController
  secret?: string
  secrets?: SecretResolver
  workspaceFiles?: readonly { path: string; content: Uint8Array }[]
  telemetry?: boolean
}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "meanwhile-terminal-evidence-"))
  directories.push(directory)
  const store = new ObservedStore(join(directory, "meanwhile.sqlite"))
  stores.push(store)
  const createdAt = now()
  store.createOwner({ id: OWNER_ID, name: "Terminal evidence owner", createdAt })
  store.createPrincipal({
    id: PRINCIPAL_ID,
    ownerId: OWNER_ID,
    kind: "person",
    displayName: "Terminal evidence owner",
    ownerRole: "admin",
    createdAt,
  })
  store.createProject({
    id: PROJECT_ID,
    ownerId: OWNER_ID,
    name: "Terminal evidence",
    slug: "terminal-evidence",
    createdAt,
    createdByPrincipalId: PRINCIPAL_ID,
  })
  store.createApiKey({
    id: "terminal-evidence-api-key",
    ownerId: OWNER_ID,
    principalId: PRINCIPAL_ID,
    prefix: "mwk_cccccccccccc",
    hash: `sha256:${"c".repeat(64)}`,
    name: "Terminal evidence test key",
    createdAt,
  })
  const secrets =
    input.secrets ??
    new EnvironmentSecretResolver({
      source: { get: (name) => (name === AGENT_SECRET ? input.secret : undefined) },
      allowedSourceNames: [AGENT_SECRET],
      allowedOwnerIds: [OWNER_ID],
    })
  const providers = new RuntimeProviderRegistry([input.provider])
  const operationalLogs: string[] = []
  const executor = new RunExecutor({
    store,
    providers,
    runner: input.runner ?? new RunnerSessionController(),
    workspace: new WorkspacePreparer({
      read: async () =>
        (input.workspaceFiles ?? []).map((file) => ({
          path: relativePath(file.path),
          content: file.content,
        })),
    }),
    artifactStore: new LocalArtifactStore(join(directory, "artifacts")),
    artifactLimits: { maxFiles: 32, maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000 },
    secrets,
    logger: new StructuredLogger({
      serviceName: "meanwhile-terminal-test",
      serviceVersion: "0.1.0",
      sink: { write: (line) => operationalLogs.push(line) },
    }),
    ...(input.telemetry === true
      ? {
          telemetry: new Telemetry({
            serviceName: "meanwhile-terminal-test",
            serviceVersion: "0.1.0",
            sink: { write: (line) => operationalLogs.push(line) },
          }),
        }
      : {}),
    concurrency: 1,
    pollMs: 60_000,
  })
  executors.push(executor)
  return { store, executor, secrets, providers, operationalLogs }
}

function createRun(
  store: Store,
  options: {
    status?: Extract<RunStatus, "provisioning" | "running">
    deadlineAt?: string
    secretRefs?: Readonly<Record<string, string>>
    artifactPaths?: readonly string[]
    timeoutMs?: number
  } = {},
  provider?: RuntimeProvider,
): Run {
  const createdAt = now()
  const agentSpec = testAgentSpec({
    credentials: Object.keys(options.secretRefs ?? {}).map((environmentVariable) => ({
      environmentVariable,
      host: "example.com",
      methods: ["POST"],
    })),
  })
  const run = store.createRun({
    id: crypto.randomUUID(),
    ownerId: OWNER_ID,
    workspace: { type: "bundle", artifactId: "a".repeat(64) },
    agentType: "demo",
    agentSpec,
    agentCatalogDigest: TEST_AGENT_CATALOG_DIGEST,
    executionProvenance: testExecutionProvenanceFor(
      provider ?? "mock",
      agentSpec,
      TEST_AGENT_CATALOG_DIGEST,
    ),
    prompt: "terminal evidence",
    env: {},
    secretRefs: options.secretRefs ?? {},
    provider: "mock",
    artifactPaths: options.artifactPaths ?? [],
    timeoutMs: options.timeoutMs ?? 60_000,
    createdAt,
    audit: { actorApiKeyId: null, requestId: "test", traceId: null, metadata: {} },
  }).run
  if (options.status === undefined) return run

  const provisioning = transition(store, run, "provisioning", options.deadlineAt ?? future())
  return options.status === "running" ? transition(store, provisioning, "running") : provisioning
}

function transition(
  store: Store,
  run: Run,
  status: Extract<RunStatus, "provisioning" | "running">,
  deadlineAt?: string,
): Run {
  const at = now()
  const audit = {
    actorApiKeyId: null,
    action: `test.${status}`,
    requestId: "test",
    traceId: null,
    metadata: {},
  } as const
  if (status === "provisioning") {
    const transitioned = store.claimRunProvisioning({
      runId: run.id,
      expectedVersion: run.statusVersion,
      at,
      deadlineAt: deadlineAt ?? future(),
      audit,
      systemLog: { eventType: "run.provisioning", data: "Provisioning runtime" },
    })
    if (transitioned === null) throw new Error(`Could not seed ${status}`)
    return transitioned
  }
  const runnerSessionId = `runner-${run.id}`
  store.createRunnerSession({
    runId: run.id,
    ownerId: run.ownerId,
    runnerSessionId,
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    createdAt: at,
  })
  const transitioned = store.acceptRunnerFrame({
    ownerId: run.ownerId,
    runId: run.id,
    runnerSessionId,
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    providerCursor: "seed-running",
    runnerSequence: 1,
    stream: "agent",
    eventType: "session.started",
    data: JSON.stringify({ sessionId: "seed-session" }),
    createdAt: at,
    runningTransition: {
      at,
      reason: "agent.session_started",
      audit,
      systemLog: { eventType: "run.running", data: "Agent session started" },
    },
  }).run
  return transitioned
}

async function seedRuntime(
  store: Store,
  provider: MockRuntimeProvider,
  run: Run,
  options: {
    destroy?: boolean
    persistProcess?: boolean
    files?: readonly { path: string; content: Uint8Array }[]
  } = {},
): Promise<{ runtime: RuntimeHandle; process: ProcessHandle }> {
  const runtime = await provider.create({ runtimeId: `rt-${run.id}` })
  await provider.start(runtime)
  if (options.files !== undefined) {
    await provider.writeFiles(
      runtime,
      options.files.map((file) => ({ path: relativePath(file.path), content: file.content })),
    )
  }
  const process = processHandle(provider.name, `${runtime.opaque}.missing-process`)
  persistRuntime(store, run, runtime, process, options.persistProcess ?? true)
  if (options.destroy === true) await provider.destroy(runtime)
  return { runtime, process }
}

function persistRuntime(
  store: Store,
  run: Run,
  runtime: RuntimeHandle,
  process: ProcessHandle,
  persistProcess = true,
): void {
  const at = now()
  const intent = store.ensureRuntimeProvisioningIntent({
    runId: run.id,
    ownerId: OWNER_ID,
    runtimeId: runtime.opaque,
    provider: runtime.provider,
    at,
  })
  if (intent === null || store.claimRuntimeProvisioning(runtime.opaque, at, "active") === null) {
    throw new Error("test runtime provisioning could not be claimed")
  }
  store.materializeRuntimeProvisioning(
    {
      id: runtime.opaque,
      ownerId: OWNER_ID,
      runId: run.id,
      provider: runtime.provider,
      handle: jsonObject(runtime),
      processHandle: persistProcess ? jsonObject(process) : null,
      cleanupStatus: "pending",
      cleanupAttempts: 0,
      cleanupLastError: null,
      cleanupNextAttemptAt: null,
      createdAt: at,
      updatedAt: at,
      destroyedAt: null,
    },
    {
      id: crypto.randomUUID(),
      ownerId: OWNER_ID,
      actorApiKeyId: null,
      action: "runtime.create",
      resourceType: "runtime",
      resourceId: runtime.opaque,
      requestId: "terminal-evidence-test",
      traceId: null,
      metadata: { runId: run.id, provider: runtime.provider },
      createdAt: at,
    },
  )
  store.setRunRuntime({
    runId: run.id,
    runtimeId: runtime.opaque,
    ...(persistProcess ? { processId: process.opaque } : {}),
    at,
  })
}

function seedTerminal(
  store: Store,
  run: Run,
  handles: { runtime: RuntimeHandle; process: ProcessHandle },
  terminal: RunnerTerminalPayload,
): void {
  const runnerSessionId = `runner-${run.id}`
  const at = now()
  const session =
    store.getRunnerSession(run.id) ??
    store.createRunnerSession({
      runId: run.id,
      ownerId: OWNER_ID,
      runnerSessionId,
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      createdAt: at,
    })
  const sequence = session.runnerSequence + 1
  store.acceptRunnerFrame({
    ownerId: OWNER_ID,
    runId: run.id,
    runnerSessionId,
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    providerCursor: String(sequence),
    runnerSequence: sequence,
    stream: "agent",
    eventType: "terminal",
    data: JSON.stringify(terminal),
    terminalResult: jsonObject(terminal),
    createdAt: at,
  })
  store.setRunRuntime({
    runId: run.id,
    runtimeId: handles.runtime.opaque,
    processId: handles.process.opaque,
    at,
  })
}

function terminalRunner(
  terminal: RunnerTerminalPayload,
  sourceTimestamp?: string,
): RunnerSessionController {
  return {
    async start(input: StartRunnerInput): Promise<ProcessHandle> {
      return processHandle(input.provider.name, `${input.runtime.opaque}.${input.processId}`)
    },
    async consume(input: ConsumeRunnerInput): Promise<RunnerConsumptionResult> {
      const started = frame(input.runId, input.runnerSessionId, 1, "session.started", {
        sessionId: "malicious-provider-session",
      })
      const terminalFrame = frame(input.runId, input.runnerSessionId, 2, "terminal", terminal)
      if (sourceTimestamp !== undefined) {
        started.timestamp = sourceTimestamp
        terminalFrame.timestamp = sourceTimestamp
      }
      await input.onFrame(started, "1")
      await input.onCursor("1")
      await input.onFrame(terminalFrame, "2")
      await input.onCursor("2")
      return {
        terminal,
        cursor: "2",
        lastSequence: 2,
        exitCode: terminal.agentExit?.exitCode ?? 1,
      }
    },
    async cancel(): Promise<void> {},
  }
}

function controlledTerminalRunner(terminal: RunnerTerminalPayload): {
  readonly controller: RunnerSessionController
  readonly ready: Promise<void>
  readonly terminalAccepted: Promise<void>
  readonly allowTerminal: () => void
  readonly allowCompletion: () => void
  readonly cancelCalls: () => number
} {
  const ready = deferred()
  const terminalGate = deferred()
  const accepted = deferred()
  const completionGate = deferred()
  let cancellations = 0
  return {
    controller: {
      async start(input: StartRunnerInput): Promise<ProcessHandle> {
        return processHandle(input.provider.name, `${input.runtime.opaque}.${input.processId}`)
      },
      async consume(input: ConsumeRunnerInput): Promise<RunnerConsumptionResult> {
        const started = frame(input.runId, input.runnerSessionId, 1, "session.started", {
          sessionId: "controlled-session",
        })
        await input.onFrame(started, "1")
        await input.onCursor("1")
        ready.resolve()
        await terminalGate.promise
        const terminalFrame = frame(input.runId, input.runnerSessionId, 2, "terminal", terminal)
        await input.onFrame(terminalFrame, "2")
        await input.onCursor("2")
        accepted.resolve()
        await completionGate.promise
        return {
          terminal,
          cursor: "2",
          lastSequence: 2,
          exitCode: terminal.agentExit?.exitCode ?? 0,
        }
      },
      async cancel(): Promise<void> {
        cancellations += 1
      },
    },
    ready: ready.promise,
    terminalAccepted: accepted.promise,
    allowTerminal: terminalGate.resolve,
    allowCompletion: completionGate.resolve,
    cancelCalls: () => cancellations,
  }
}

function unreachableRunner(): RunnerSessionController {
  return {
    async start(): Promise<ProcessHandle> {
      throw new Error("Persisted terminal recovery must not start a runner")
    },
    async consume(): Promise<RunnerConsumptionResult> {
      throw new Error("Persisted terminal recovery must not consume a process")
    },
    async cancel(): Promise<void> {},
  }
}

function withRecovery(provider: MockRuntimeProvider, enabled: boolean): RuntimeProvider {
  const capabilities = Object.freeze({
    ...provider.capabilities,
    processRecovery: enabled,
    eventReplay: enabled,
  })
  return new Proxy(provider, {
    get(target, property) {
      if (property === "capabilities") return capabilities
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as RuntimeProvider
}

function withBlockedArtifactRead(provider: MockRuntimeProvider): {
  readonly provider: RuntimeProvider
  readonly aborted: () => boolean
} {
  let aborted = false
  return {
    provider: new Proxy(provider, {
      get(target, property) {
        if (property === "readFile") {
          return async (
            _runtime: RuntimeHandle,
            _path: ReturnType<typeof relativePath>,
            _options: { readonly maxBytes: number },
            signal?: AbortSignal,
          ): Promise<Uint8Array> => {
            if (signal === undefined) throw new Error("Artifact read requires an abort signal")
            if (signal.aborted) {
              aborted = true
              throw signal.reason
            }
            return new Promise<Uint8Array>((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true
                  reject(signal.reason)
                },
                { once: true },
              )
            })
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    }) as RuntimeProvider,
    aborted: () => aborted,
  }
}

function withEventStreamProcessLoss(provider: MockRuntimeProvider): RuntimeProvider {
  return new Proxy(provider, {
    get(target, property) {
      if (property === "inspectProcess") {
        return async () => ({ status: "running" as const, observedAt: now() })
      }
      if (property === "events") {
        return async function* () {
          yield await Promise.reject<ProcessEvent>(
            new RuntimeProviderError({
              provider: provider.name,
              operation: "events",
              code: "PROCESS_NOT_FOUND",
              message: "The process disappeared before replay",
            }),
          )
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as RuntimeProvider
}

function runApi(
  store: Store,
  secrets: SecretReferenceValidator,
  providers: RuntimeProviderRegistry,
): ReturnType<typeof createApiRouter> {
  const service = new RunService({
    store,
    commands: { enqueue() {}, async cancel() {} },
    agentIntents: permissiveTestAgentIntents,
    secretReferences: secrets,
    providerNames: providers,
    executionProvenance: testExecutionProvenance,
    defaultProvider: "mock",
  })
  const api = createApiRouter()
  api.use("*", async (context, next) => {
    context.set("requestId", "terminal-evidence-test")
    context.set("traceId", null)
    context.set("requestContext", {
      requestId: "terminal-evidence-test",
      traceId: null,
      ownerId: OWNER_ID,
      principalId: PRINCIPAL_ID,
      ownerRole: "admin",
      apiKeyId: "terminal-evidence-api-key",
    })
    await next()
  })
  api.route("/", createRunRoutes(service))
  return api
}

function frame<Type extends RunnerFrame["type"]>(
  runId: string,
  runnerSessionId: string,
  sequence: number,
  type: Type,
  payload: Extract<RunnerFrame, { type: Type }>["payload"],
): Extract<RunnerFrame, { type: Type }> {
  return {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    runId,
    runnerSessionId,
    sequence,
    timestamp: now(),
    type,
    payload,
  } as Extract<RunnerFrame, { type: Type }>
}

class ObservedStore extends Store {
  readonly #observers = new Map<string, Set<(run: Run) => void>>()

  observe(runId: string, status: RunStatus): Promise<Run> {
    const current = this.getRunInternal(runId)
    if (current?.status === status) return Promise.resolve(current)
    const key = `${runId}:${status}`
    return new Promise((resolve) => {
      const observers = this.#observers.get(key) ?? new Set<(run: Run) => void>()
      observers.add(resolve)
      this.#observers.set(key, observers)
    })
  }

  override claimRunProvisioning(input: ClaimRunProvisioningInput): Run | null {
    const run = super.claimRunProvisioning(input)
    if (run !== null) this.#notify(run)
    return run
  }

  override claimRunOutcome(input: ClaimRunOutcomeInput): ClaimRunOutcomeResult | null {
    const result = super.claimRunOutcome(input)
    if (result?.outcome === "claimed") this.#notify(result.run)
    return result
  }

  #notify(run: Run): void {
    const key = `${run.id}:${run.status}`
    const observers = this.#observers.get(key)
    if (observers !== undefined) {
      this.#observers.delete(key)
      for (const resolve of observers) resolve(run)
    }
  }
}

function jsonObject(value: object): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

function now(): string {
  return new Date().toISOString()
}

function future(): string {
  return "2099-01-01T00:00:00.000Z"
}

function requestContext(): RequestContext {
  return {
    ownerId: OWNER_ID,
    principalId: PRINCIPAL_ID,
    ownerRole: "admin",
    apiKeyId: "terminal-evidence-api-key",
    requestId: crypto.randomUUID(),
    traceId: null,
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: () => resolvePromise?.(),
  }
}

async function bounded<Value>(promise: Promise<Value>): Promise<Value> {
  return Promise.race([
    promise,
    Bun.sleep(2_000).then(() => {
      throw new Error("Expected state transition did not occur")
    }),
  ])
}
