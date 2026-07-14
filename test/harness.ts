import type { RequestContext } from "../src/domain"
import { Store } from "../src/persistence/store"
import { EnvironmentSecretResolver } from "../src/secrets"
import { type CreateRunCommand, type RunCommandSink, RunService } from "../src/services/run-service"
import { permissiveTestAgentIntents, testExecutionProvenance } from "./fixtures/agent-intent"

export const OWNER_A = "00000000-0000-4000-8000-00000000000a"
export const OWNER_B = "00000000-0000-4000-8000-00000000000b"

export class DeterministicClock {
  #time: number

  constructor(at = "2026-07-13T00:00:00.000Z") {
    this.#time = Date.parse(at)
  }

  now = (): Date => new Date(this.#time)

  advance(milliseconds = 1): void {
    this.#time += milliseconds
  }
}

export class TestRunCommands implements RunCommandSink {
  readonly enqueued: string[] = []
  readonly cancellationRequests: string[] = []

  constructor(
    private readonly store: Store,
    private readonly clock: DeterministicClock,
  ) {}

  enqueue(runId: string): void {
    this.enqueued.push(runId)
  }

  async cancel(input: { readonly runId: string; readonly context: RequestContext }): Promise<void> {
    this.cancellationRequests.push(input.runId)
    const at = this.clock.now().toISOString()
    this.store.claimRunOutcome({
      kind: "cancel",
      ownerId: input.context.ownerId,
      runId: input.runId,
      at,
      requestAudit: {
        actorApiKeyId: input.context.apiKeyId,
        action: "run.cancel_request",
        requestId: input.context.requestId,
        traceId: input.context.traceId,
        metadata: {},
      },
      resultAudit: {
        actorApiKeyId: input.context.apiKeyId,
        action: "run.cancelled",
        requestId: input.context.requestId,
        traceId: input.context.traceId,
        metadata: {},
      },
      systemLog: { eventType: "run.cancelled", data: "Run cancelled" },
    })
  }
}

export interface RunHarness {
  readonly store: Store
  readonly service: RunService
  readonly commands: TestRunCommands
  readonly clock: DeterministicClock
  readonly contextA: RequestContext
  readonly contextB: RequestContext
  close(): void
}

export const createRunHarness = (): RunHarness => {
  const store = new Store(":memory:")
  const clock = new DeterministicClock()
  const createdAt = clock.now().toISOString()
  store.createOwner({ id: OWNER_A, name: "Owner A", createdAt })
  store.createOwner({ id: OWNER_B, name: "Owner B", createdAt })
  store.createApiKey({
    id: "20000000-0000-4000-8000-00000000000a",
    ownerId: OWNER_A,
    prefix: "mwk_aaaaaaaaaaaa",
    hash: `sha256:${"a".repeat(64)}`,
    name: "Owner A test key",
    createdAt,
  })
  store.createApiKey({
    id: "test-api-key",
    ownerId: OWNER_A,
    prefix: "mwk_testtesttest",
    hash: `sha256:${"c".repeat(64)}`,
    name: "HTTP fixture key",
    createdAt,
  })
  store.createApiKey({
    id: "20000000-0000-4000-8000-00000000000b",
    ownerId: OWNER_B,
    prefix: "mwk_bbbbbbbbbbbb",
    hash: `sha256:${"b".repeat(64)}`,
    name: "Owner B test key",
    createdAt,
  })
  const commands = new TestRunCommands(store, clock)
  let sequence = 0
  const service = new RunService({
    store,
    commands,
    agentIntents: permissiveTestAgentIntents,
    secretReferences: new EnvironmentSecretResolver({
      source: { get: () => undefined },
      allowedSourceNames: ["OPENAI_API_KEY"],
      allowedOwnerIds: [OWNER_A, OWNER_B],
    }),
    providerNames: { has: (name) => name === "local" },
    executionProvenance: testExecutionProvenance,
    defaultProvider: "local",
    clock: clock.now,
    id: () => {
      sequence += 1
      return `10000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`
    },
    followPollMs: 10,
  })
  return {
    store,
    service,
    commands,
    clock,
    contextA: requestContext(OWNER_A, "a"),
    contextB: requestContext(OWNER_B, "b"),
    close: () => store.close(),
  }
}

export const runInput = (overrides: Partial<CreateRunCommand> = {}): CreateRunCommand => ({
  workspace: { type: "repository", url: "https://github.com/example/project.git" },
  agentType: "codex",
  prompt: "Make the tests pass",
  env: { CI: "true" },
  secretRefs: { OPENAI_API_KEY: "env://OPENAI_API_KEY" },
  provider: "local",
  artifactPaths: ["dist"],
  timeoutMs: 60_000,
  ...overrides,
})

const requestContext = (ownerId: string, suffix: string): RequestContext => ({
  ownerId,
  apiKeyId: `20000000-0000-4000-8000-00000000000${suffix}`,
  requestId: `request-${suffix}`,
  traceId: `trace-${suffix}`,
})
