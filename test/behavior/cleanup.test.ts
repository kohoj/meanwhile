import { describe, expect, test } from "bun:test"
import type { RunStatus, RuntimeInstance } from "../../src/domain"
import { Store } from "../../src/persistence/store"
import { RuntimeProviderRegistry } from "../../src/providers/registry"
import {
  type CreateRuntimeInput,
  type EventCursor,
  type ExposedEndpoint,
  type ListRuntimeFilesOptions,
  type ProcessEvent,
  type ProcessExit,
  type ProcessHandle,
  type ProcessSignal,
  type ProcessSpec,
  type ProcessState,
  type ProviderHealth,
  type ReadRuntimeFileOptions,
  type RelativePath,
  type RuntimeFile,
  type RuntimeFileInfo,
  type RuntimeHandle,
  type RuntimeProvider,
  RuntimeProviderError,
  type RuntimeState,
} from "../../src/providers/runtime-provider"
import {
  type RuntimeCleanupEvent,
  RuntimeReaper,
  RuntimeReaperLoop,
} from "../../src/services/runtime-reaper"
import { TEST_AGENT_CATALOG_DIGEST, testAgentSpec } from "../fixtures/agent-intent"

const OWNER_ID = "owner-cleanup"
const START = "2026-01-01T00:00:00.000Z"

class DestroyProvider implements RuntimeProvider {
  readonly name = "fake"
  readonly capabilities = {
    isolation: "container",
    processRecovery: true,
    eventReplay: true,
    portExposure: false,
    processSignals: ["SIGINT", "SIGTERM", "SIGKILL"] as const,
  } as const
  readonly destroyed: RuntimeHandle[] = []

  constructor(
    private readonly failCount = 0,
    private readonly failure: () => unknown = () =>
      new RuntimeProviderError({
        provider: "fake",
        operation: "destroy",
        code: "UPSTREAM_BUSY",
        message: "provider details must not persist",
        retryable: true,
      }),
  ) {}

  async destroy(runtime: RuntimeHandle): Promise<void> {
    this.destroyed.push(runtime)
    if (this.destroyed.length <= this.failCount) throw this.failure()
  }

  async create(_input: CreateRuntimeInput): Promise<RuntimeHandle> {
    throw new Error("not used")
  }

  async start(_runtime: RuntimeHandle): Promise<void> {
    throw new Error("not used")
  }

  async inspect(_runtime: RuntimeHandle): Promise<RuntimeState> {
    throw new Error("not used")
  }

  async stop(_runtime: RuntimeHandle): Promise<void> {
    throw new Error("not used")
  }

  async spawn(_runtime: RuntimeHandle, _process: ProcessSpec): Promise<ProcessHandle> {
    throw new Error("not used")
  }

  async inspectProcess(_process: ProcessHandle): Promise<ProcessState> {
    throw new Error("not used")
  }

  async *events(_process: ProcessHandle, _cursor: EventCursor): AsyncIterable<ProcessEvent> {
    const events: ProcessEvent[] = []
    yield* events
  }

  async signal(_process: ProcessHandle, _signal: ProcessSignal): Promise<void> {
    throw new Error("not used")
  }

  async wait(_process: ProcessHandle): Promise<ProcessExit> {
    throw new Error("not used")
  }

  async writeFiles(_runtime: RuntimeHandle, _files: readonly RuntimeFile[]): Promise<void> {
    throw new Error("not used")
  }

  async listFiles(
    _runtime: RuntimeHandle,
    _path: RelativePath,
    _options: ListRuntimeFilesOptions,
  ): Promise<RuntimeFileInfo[]> {
    throw new Error("not used")
  }

  async readFile(
    _runtime: RuntimeHandle,
    _path: RelativePath,
    _options: ReadRuntimeFileOptions,
  ): Promise<Uint8Array> {
    throw new Error("not used")
  }

  async expose(_runtime: RuntimeHandle, _port: number): Promise<ExposedEndpoint> {
    throw new Error("not used")
  }

  async health(): Promise<ProviderHealth> {
    return { status: "healthy", checkedAt: START }
  }
}

describe("runtime cleanup", () => {
  test("never destroys compute for a running run", async () => {
    const store = createStore()
    try {
      createRunWithRuntime(store, "run-active", "running")
      const provider = new DestroyProvider()
      const reaper = new RuntimeReaper(store, new RuntimeProviderRegistry([provider]), {
        clock: () => new Date(START),
      })

      expect(await reaper.runOnce()).toEqual({
        recoveredInterrupted: 0,
        eligible: 0,
        claimed: 0,
        skippedClaims: 0,
        succeeded: 0,
        failed: 0,
        exhausted: 0,
        observerFailures: 0,
      })
      expect(provider.destroyed).toHaveLength(0)
      expect(store.getRuntimeForRun("run-active")?.cleanupStatus).toBe("pending")
    } finally {
      store.close()
    }
  })

  test("destroys once, atomically records success and audit evidence, and is idempotent", async () => {
    const store = createStore()
    try {
      const runtime = createRunWithRuntime(store, "run-done", "succeeded")
      const provider = new DestroyProvider()
      const events: RuntimeCleanupEvent[] = []
      const reaper = new RuntimeReaper(store, new RuntimeProviderRegistry([provider]), {
        clock: () => new Date(START),
        createId: deterministicIds(),
        observe: (event) => events.push(event),
      })

      const first = await reaper.runOnce()
      const second = await reaper.runOnce()

      expect(first.succeeded).toBe(1)
      expect(second.eligible).toBe(0)
      expect(provider.destroyed).toEqual([
        { kind: "runtime", version: 1, provider: "fake", opaque: runtime.id },
      ])
      expect(store.getRuntimeForRun("run-done")).toMatchObject({
        cleanupStatus: "succeeded",
        cleanupAttempts: 1,
        cleanupLastError: null,
        cleanupNextAttemptAt: null,
        destroyedAt: START,
      })
      const destroyAudit = store
        .listAudit(OWNER_ID, runtime.id)
        .filter((record) => record.action === "runtime.destroy")
      expect(destroyAudit).toHaveLength(1)
      expect(destroyAudit[0]?.metadata).toEqual({
        provider: "fake",
        runId: "run-done",
        attempt: 1,
        outcome: "succeeded",
      })
      expect(events.map((event) => event.type)).toEqual([
        "runtime.cleanup.started",
        "runtime.cleanup.succeeded",
      ])
    } finally {
      store.close()
    }
  })

  test("persists bounded backoff, safe failures, and terminal exhaustion across reaper restarts", async () => {
    const store = createStore()
    try {
      const runtime = createRunWithRuntime(store, "run-failed", "failed")
      const rawSecret = "raw-provider-secret-body"
      const provider = new DestroyProvider(3, () => new Error(rawSecret))
      let now = Date.parse(START)
      const options = {
        backoffMs: [100, 500],
        clock: () => new Date(now),
        createId: deterministicIds(),
      } as const

      const firstReaper = new RuntimeReaper(store, new RuntimeProviderRegistry([provider]), options)
      const first = await firstReaper.runOnce()
      expect(first).toMatchObject({ failed: 1, exhausted: 0 })
      expect(store.getRuntimeForRun("run-failed")).toMatchObject({
        cleanupStatus: "failed",
        cleanupAttempts: 1,
        cleanupNextAttemptAt: "2026-01-01T00:00:00.100Z",
        cleanupLastError: {
          code: "RUNTIME_CLEANUP_FAILED",
          message: "The runtime could not be destroyed.",
          retryable: true,
        },
      })

      now += 99
      expect((await firstReaper.runOnce()).eligible).toBe(0)
      now += 1

      const restartedReaper = new RuntimeReaper(
        store,
        new RuntimeProviderRegistry([provider]),
        options,
      )
      expect(await restartedReaper.runOnce()).toMatchObject({ failed: 1, exhausted: 0 })
      expect(store.getRuntimeForRun("run-failed")?.cleanupNextAttemptAt).toBe(
        "2026-01-01T00:00:00.600Z",
      )

      now += 500
      expect(await restartedReaper.runOnce()).toMatchObject({ failed: 1, exhausted: 1 })
      const exhausted = store.getRuntimeForRun("run-failed")
      expect(exhausted).toMatchObject({
        cleanupStatus: "failed",
        cleanupAttempts: 3,
        cleanupNextAttemptAt: null,
        cleanupLastError: { retryable: false },
      })
      expect(JSON.stringify(exhausted)).not.toContain(rawSecret)

      const afterAnotherRestart = new RuntimeReaper(
        store,
        new RuntimeProviderRegistry([provider]),
        options,
      )
      expect((await afterAnotherRestart.runOnce()).eligible).toBe(0)
      expect(provider.destroyed).toHaveLength(3)

      const audit = store
        .listAudit(OWNER_ID, runtime.id)
        .filter((record) => record.action === "runtime.destroy")
      expect(audit).toHaveLength(3)
      expect(audit.at(-1)?.metadata).toMatchObject({
        outcome: "failed",
        attempt: 3,
        exhausted: true,
        nextAttemptAt: null,
        errorCode: "RUNTIME_CLEANUP_FAILED",
      })
      expect(JSON.stringify(audit)).not.toContain(rawSecret)
    } finally {
      store.close()
    }
  })

  test("reclaims an interrupted durable cleanup claim after control-plane restart", async () => {
    const store = createStore()
    try {
      const runtime = createRunWithRuntime(store, "run-interrupted", "timed_out")
      expect(store.claimRuntimeCleanup(runtime.id, START)).toBe(true)
      expect(store.getRuntimeForRun("run-interrupted")?.cleanupStatus).toBe("running")

      const provider = new DestroyProvider()
      const reaper = new RuntimeReaper(store, new RuntimeProviderRegistry([provider]), {
        clock: () => new Date(START),
      })
      const result = await reaper.runOnce()

      expect(result).toMatchObject({ recoveredInterrupted: 1, eligible: 1, succeeded: 1 })
      expect(provider.destroyed).toHaveLength(1)
      expect(store.getRuntimeForRun("run-interrupted")).toMatchObject({
        cleanupStatus: "succeeded",
        cleanupAttempts: 2,
        destroyedAt: START,
      })
      expect(reaper.reconcileInterrupted()).toBe(0)
    } finally {
      store.close()
    }
  })

  test("isolates observer failures and reports them without changing cleanup correctness", async () => {
    const store = createStore()
    try {
      createRunWithRuntime(store, "run-observer", "cancelled")
      const provider = new DestroyProvider()
      const reaper = new RuntimeReaper(store, new RuntimeProviderRegistry([provider]), {
        clock: () => new Date(START),
        observe: () => {
          throw new Error("telemetry exporter unavailable")
        },
      })

      expect(await reaper.runOnce()).toMatchObject({ succeeded: 1, observerFailures: 2 })
      expect(store.getRuntimeForRun("run-observer")?.cleanupStatus).toBe("succeeded")
    } finally {
      store.close()
    }
  })
})

describe("runtime cleanup loop", () => {
  test("stop waits for the active cleanup tick and prevents another tick", async () => {
    let finishTick: (() => void) | undefined
    const tickStarted = Promise.withResolvers<void>()
    let calls = 0
    const loop = new RuntimeReaperLoop(
      {
        runOnce: async () => {
          calls += 1
          tickStarted.resolve()
          await new Promise<void>((resolve) => {
            finishTick = resolve
          })
          return emptyReaperReport()
        },
      },
      100,
    )

    const starting = loop.start()
    await tickStarted.promise

    let stopped = false
    const stopping = loop.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()

    expect(stopped).toBe(false)
    expect(calls).toBe(1)

    finishTick?.()
    await Promise.all([starting, stopping])
    await Promise.resolve()

    expect(stopped).toBe(true)
    expect(calls).toBe(1)
    expect(loop.health()).toEqual({
      status: "unavailable",
      message: "Runtime reaper is stopped",
    })
  })
})

function emptyReaperReport() {
  return {
    recoveredInterrupted: 0,
    eligible: 0,
    claimed: 0,
    skippedClaims: 0,
    succeeded: 0,
    failed: 0,
    exhausted: 0,
    observerFailures: 0,
  } as const
}

function createStore(): Store {
  const store = new Store(":memory:")
  store.createOwner({ id: OWNER_ID, name: "Cleanup owner", createdAt: START })
  return store
}

function createRunWithRuntime(
  store: Store,
  runId: string,
  status: Extract<RunStatus, "running" | "succeeded" | "failed" | "cancelled" | "timed_out">,
): RuntimeInstance {
  store.createRun({
    id: runId,
    ownerId: OWNER_ID,
    workspace: { type: "repository", url: "https://example.invalid/repository.git" },
    agentType: "fixture",
    agentSpec: testAgentSpec(),
    agentCatalogDigest: TEST_AGENT_CATALOG_DIGEST,
    prompt: "test cleanup",
    env: {},
    secretRefs: {},
    provider: "fake",
    artifactPaths: [],
    timeoutMs: 60_000,
    createdAt: START,
    audit: auditInput(),
  })
  transition(store, runId, "queued", "provisioning")
  transition(store, runId, "provisioning", "running")
  if (status !== "running") transition(store, runId, "running", status)

  const runtime: RuntimeInstance = {
    id: `runtime-${runId}`,
    ownerId: OWNER_ID,
    runId,
    provider: "fake",
    handle: { kind: "runtime", version: 1, provider: "fake", opaque: `runtime-${runId}` },
    processHandle: null,
    cleanupStatus: "pending",
    cleanupAttempts: 0,
    cleanupLastError: null,
    cleanupNextAttemptAt: START,
    createdAt: START,
    updatedAt: START,
    destroyedAt: null,
  }
  store.createRuntime(runtime)
  return runtime
}

function transition(store: Store, runId: string, fromStatus: RunStatus, toStatus: RunStatus): void {
  const current = store.getRunInternal(runId)
  if (current === null) throw new Error("test run is missing")
  const transitioned = store.transitionRun({
    runId,
    expectedStatus: fromStatus,
    expectedVersion: current.statusVersion,
    toStatus,
    reason: `test.${toStatus}`,
    at: START,
    audit: { ...auditInput(), action: `run.${toStatus}` },
  })
  if (transitioned === null) throw new Error(`test transition to ${toStatus} was not claimed`)
}

function auditInput() {
  return {
    actorApiKeyId: null,
    requestId: "request-cleanup-test",
    traceId: null,
    metadata: {},
  } as const
}

function deterministicIds(): () => string {
  let next = 0
  return () => `cleanup-id-${++next}`
}
