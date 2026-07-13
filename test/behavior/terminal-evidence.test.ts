import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunnerFrame, RunnerTerminalPayload } from "../../runner/protocol"
import { encodeRunnerFrame, RUNNER_PROTOCOL_VERSION } from "../../runner/protocol"
import {
  type ConsumeRunnerInput,
  type RunnerConsumptionResult,
  RunnerSessionController,
  type StartRunnerInput,
} from "../../src/agents/runner-session"
import { createRunRoutes } from "../../src/api/runs"
import { createApiRouter } from "../../src/api/schemas"
import { LocalArtifactStore } from "../../src/artifacts/local-artifact-store"
import type { JsonObject, Run, RunStatus } from "../../src/domain"
import { Store, type TransitionRunInput } from "../../src/persistence/store"
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
import { EnvironmentSecretResolver } from "../../src/secrets"
import { RunExecutor } from "../../src/services/run-executor"
import { RunService } from "../../src/services/run-service"
import { WorkspacePreparer } from "../../src/services/workspace-preparer"
import { StructuredLogger } from "../../src/telemetry"
import {
  permissiveTestAgentIntents,
  TEST_AGENT_CATALOG_DIGEST,
  testAgentSpec,
} from "../fixtures/agent-intent"
import { MockRuntimeProvider } from "../fixtures/mock-provider"

const OWNER_ID = "00000000-0000-4000-8000-000000000101"
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
    const run = createRun(fixture.store, {
      secretRefs: { [AGENT_SECRET]: `env://${AGENT_SECRET}` },
      artifactPaths: ["dist"],
    })
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

  test("finalizes expired persisted evidence when its runtime is already missing", async () => {
    const delegate = new MockRuntimeProvider()
    const provider = withRecovery(delegate, false)
    const fixture = await createFixture({ provider, runner: unreachableRunner() })
    const run = createRun(fixture.store, {
      artifactPaths: ["dist"],
      deadlineAt: "2000-01-01T00:00:00.000Z",
      status: "running",
    })
    const runtime = await seedRuntime(fixture.store, delegate, run, { destroy: true })
    const terminal: RunnerTerminalPayload = {
      outcome: "failed",
      error: { code: "AGENT_EXITED", message: "The agent exited" },
      agentExit: { exitCode: 41, signal: null },
    }
    seedTerminal(fixture.store, run, runtime, terminal)
    fixture.store.appendRunLogNext({
      ownerId: OWNER_ID,
      runId: run.id,
      stream: "system",
      eventType: "terminal",
      data: JSON.stringify(terminal),
      runnerSessionId: `runner-${run.id}`,
      runnerSequence: 2,
      createdAt: now(),
    })
    // Crash window: the accepted, sanitized log committed before the session
    // terminal update. Recovery must reconstruct the session evidence first.
    fixture.store.database
      .query("UPDATE runner_sessions SET terminal_result_json = NULL WHERE run_id = ?")
      .run(run.id)
    delegate.operations.length = 0
    const terminalReached = fixture.store.observe(run.id, "failed")

    await fixture.executor.start()
    const failed = await bounded(terminalReached)

    expect(failed.error?.code).toBe("AGENT_EXITED")
    expect(failed.error?.code).not.toBe("RUNTIME_LOST")
    expect(failed.exitCode).toBe(41)
    expect(
      fixture.store
        .listRunLogs(OWNER_ID, run.id, 0, 1_000)
        .some((log) => log.eventType === "artifact.capture_unavailable"),
    ).toBeTrue()
    expect(delegate.operations.map((operation) => operation.operation)).toEqual(["inspect"])
  })

  test("recovers session-start evidence and captures artifacts without process recovery", async () => {
    const delegate = new MockRuntimeProvider()
    const provider = withRecovery(delegate, false)
    const fixture = await createFixture({ provider, runner: unreachableRunner() })
    const run = createRun(fixture.store, {
      artifactPaths: ["dist"],
      deadlineAt: "2000-01-01T00:00:00.000Z",
      status: "provisioning",
    })
    const runtime = await seedRuntime(fixture.store, delegate, run, {
      files: [{ path: "dist/index.html", content: encoder.encode("<h1>recovered</h1>") }],
    })
    seedTerminal(
      fixture.store,
      run,
      runtime,
      { outcome: "succeeded", stopReason: "end_turn" },
      true,
    )
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

  test("reconciles an accepted session start before waiting on a still-live process", async () => {
    const provider = new MockRuntimeProvider()
    const fixture = await createFixture({ provider })
    const run = createRun(fixture.store, { status: "provisioning" })
    const runtimeHandle = await provider.create({ runtimeId: `rt-${run.id}` })
    await provider.start(runtimeHandle)
    const process = await provider.spawn(runtimeHandle, {
      processId: `runner-${run.id}`,
      argv: ["meanwhile-runner"],
      cwd: relativePath("."),
    })
    const sessionFrame = frame(run.id, `runner-${run.id}`, 1, "session.started", {
      sessionId: "accepted-before-crash",
    })
    provider.emit(process, "stdout", `${encodeRunnerFrame(sessionFrame)}\n`)
    persistRuntime(fixture.store, run, runtimeHandle, process)
    fixture.store.appendRunLogNext({
      ownerId: OWNER_ID,
      runId: run.id,
      stream: "system",
      eventType: "session.started",
      data: JSON.stringify(sessionFrame.payload),
      runnerSessionId: sessionFrame.runnerSessionId,
      runnerSequence: sessionFrame.sequence,
      createdAt: sessionFrame.timestamp,
    })
    fixture.store.upsertRunnerSession({
      runId: run.id,
      ownerId: OWNER_ID,
      runnerSessionId: sessionFrame.runnerSessionId,
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      providerCursor: "1",
      runnerSequence: 1,
      terminalResult: null,
      createdAt: sessionFrame.timestamp,
      updatedAt: sessionFrame.timestamp,
    })
    const runningReached = fixture.store.observe(run.id, "running")

    await fixture.executor.start()
    const running = await bounded(runningReached)

    expect(running.status).toBe("running")
    expect(fixture.store.listRunStatusEvents(OWNER_ID, run.id).at(-1)?.reason).toBe(
      "agent.session_started",
    )
  })

  test("normalizes a process lost between inspection and replay as RUNTIME_LOST", async () => {
    const delegate = new MockRuntimeProvider()
    const provider = withEventStreamProcessLoss(delegate)
    const fixture = await createFixture({ provider })
    const run = createRun(fixture.store, { status: "running" })
    const runtime = await seedRuntime(fixture.store, delegate, run)
    fixture.store.upsertRunnerSession({
      runId: run.id,
      ownerId: OWNER_ID,
      runnerSessionId: `runner-${run.id}`,
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      providerCursor: null,
      runnerSequence: 0,
      terminalResult: null,
      createdAt: now(),
      updatedAt: now(),
    })
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
})

interface Fixture {
  readonly store: ObservedStore
  readonly executor: RunExecutor
  readonly secrets: EnvironmentSecretResolver
  readonly providers: RuntimeProviderRegistry
  readonly operationalLogs: string[]
}

async function createFixture(input: {
  provider: RuntimeProvider
  runner?: RunnerSessionController
  secret?: string
  workspaceFiles?: readonly { path: string; content: Uint8Array }[]
}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "meanwhile-terminal-evidence-"))
  directories.push(directory)
  const store = new ObservedStore(join(directory, "meanwhile.sqlite"))
  stores.push(store)
  store.createOwner({ id: OWNER_ID, name: "Terminal evidence owner", createdAt: now() })
  const secrets = new EnvironmentSecretResolver({
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
  } = {},
): Run {
  const createdAt = now()
  const run = store.createRun({
    id: crypto.randomUUID(),
    ownerId: OWNER_ID,
    workspace: { type: "bundle", artifactId: "a".repeat(64) },
    agentType: "demo",
    agentSpec: testAgentSpec({
      secretEnvNames: Object.keys(options.secretRefs ?? {}),
    }),
    agentCatalogDigest: TEST_AGENT_CATALOG_DIGEST,
    prompt: "terminal evidence",
    env: {},
    secretRefs: options.secretRefs ?? {},
    provider: "mock",
    artifactPaths: options.artifactPaths ?? [],
    timeoutMs: 60_000,
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
  const transitioned = store.transitionRun({
    runId: run.id,
    expectedStatus: run.status,
    expectedVersion: run.statusVersion,
    toStatus: status,
    reason: `test.${status}`,
    at: now(),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    audit: {
      actorApiKeyId: null,
      action: `test.${status}`,
      requestId: "test",
      traceId: null,
      metadata: {},
    },
  })
  if (transitioned === null) throw new Error(`Could not seed ${status}`)
  return transitioned
}

async function seedRuntime(
  store: Store,
  provider: MockRuntimeProvider,
  run: Run,
  options: {
    destroy?: boolean
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
  persistRuntime(store, run, runtime, process)
  if (options.destroy === true) await provider.destroy(runtime)
  return { runtime, process }
}

function persistRuntime(
  store: Store,
  run: Run,
  runtime: RuntimeHandle,
  process: ProcessHandle,
): void {
  store.setRunRuntime({
    runId: run.id,
    runtimeId: runtime.opaque,
    processId: process.opaque,
    at: now(),
  })
  store.createRuntime({
    id: runtime.opaque,
    ownerId: OWNER_ID,
    runId: run.id,
    provider: runtime.provider,
    handle: jsonObject(runtime),
    processHandle: jsonObject(process),
    cleanupStatus: "pending",
    cleanupAttempts: 0,
    cleanupLastError: null,
    cleanupNextAttemptAt: null,
    createdAt: now(),
    updatedAt: now(),
    destroyedAt: null,
  })
}

function seedTerminal(
  store: Store,
  run: Run,
  handles: { runtime: RuntimeHandle; process: ProcessHandle },
  terminal: RunnerTerminalPayload,
  acceptedSessionStarted = false,
): void {
  const runnerSessionId = `runner-${run.id}`
  if (acceptedSessionStarted) {
    store.appendRunLogNext({
      ownerId: OWNER_ID,
      runId: run.id,
      stream: "system",
      eventType: "session.started",
      data: JSON.stringify({ sessionId: "persisted-session" }),
      runnerSessionId,
      runnerSequence: 1,
      createdAt: now(),
    })
  }
  store.upsertRunnerSession({
    runId: run.id,
    ownerId: OWNER_ID,
    runnerSessionId,
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    providerCursor: "2",
    runnerSequence: 2,
    terminalResult: jsonObject(terminal),
    createdAt: now(),
    updatedAt: now(),
  })
  store.setRunRuntime({
    runId: run.id,
    runtimeId: handles.runtime.opaque,
    processId: handles.process.opaque,
    at: now(),
  })
}

function terminalRunner(terminal: RunnerTerminalPayload): RunnerSessionController {
  return {
    async start(input: StartRunnerInput): Promise<ProcessHandle> {
      return processHandle(input.provider.name, `${input.runtime.opaque}.${input.processId}`)
    },
    async consume(input: ConsumeRunnerInput): Promise<RunnerConsumptionResult> {
      const started = frame(input.runId, input.runnerSessionId, 1, "session.started", {
        sessionId: "malicious-provider-session",
      })
      const terminalFrame = frame(input.runId, input.runnerSessionId, 2, "terminal", terminal)
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
  secrets: EnvironmentSecretResolver,
  providers: RuntimeProviderRegistry,
): ReturnType<typeof createApiRouter> {
  const service = new RunService({
    store,
    commands: { enqueue() {}, async cancel() {} },
    agentIntents: permissiveTestAgentIntents,
    secretReferences: secrets,
    providerNames: providers,
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

  override transitionRun(input: TransitionRunInput): Run | null {
    const run = super.transitionRun(input)
    if (run === null) return null
    const key = `${run.id}:${run.status}`
    const observers = this.#observers.get(key)
    if (observers !== undefined) {
      this.#observers.delete(key)
      for (const resolve of observers) resolve(run)
    }
    return run
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

async function bounded<Value>(promise: Promise<Value>): Promise<Value> {
  return Promise.race([
    promise,
    Bun.sleep(2_000).then(() => {
      throw new Error("Expected state transition did not occur")
    }),
  ])
}
