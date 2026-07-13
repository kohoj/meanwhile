import { describe, expect, test } from "bun:test"
import { sha256 } from "../../src/artifacts/artifact-store"
import {
  type DeployAdapter,
  DeployAdapterError,
  type ImmutableDeploymentSource,
} from "../../src/deployments/deploy-adapter"
import { DeployAdapterRegistry } from "../../src/deployments/registry"
import { EnvironmentSecretResolver } from "../../src/secrets"
import {
  type DeploymentAuditRecord,
  DeploymentDispatcher,
  DeploymentExecutionError,
  DeploymentExecutor,
  type DeploymentLogPage,
  type DeploymentLogRecord,
  type DeploymentRecord,
  type DeploymentRepository,
  type DeploymentRunCatalog,
  type DeploymentSourceReference,
  type DeploymentSourceResolver,
} from "../../src/services/deployment-executor"
import { StructuredLogger } from "../../src/telemetry"

describe("deployment records and audit evidence", () => {
  test("records create, start, ordered logs, and success atomically", async () => {
    const harness = createHarness(successAdapter())
    const created = await harness.executor.create(createInput())

    expect(created.status).toBe("queued")
    expect(harness.repository.audits.map((audit) => audit.action)).toEqual(["deployment.create"])

    const finished = await harness.executor.execute(created.id, {
      requestId: "request-execute",
      traceId: "trace-execute",
    })

    expect(finished.status).toBe("succeeded")
    expect(finished.url).toBe("https://preview.example/deployment_0123456789")
    expect(harness.repository.audits.map((audit) => audit.action)).toEqual([
      "deployment.create",
      "deployment.start",
      "deployment.succeed",
    ])
    expect(harness.repository.logs.map((log) => log.sequence)).toEqual([1])
    expect(JSON.stringify(harness.repository)).not.toContain("resolved-value")
    expect(harness.repository.logs[0]).toMatchObject({
      message: "Publishing with [REDACTED]",
      fields: { nested: { credential: "[REDACTED]" } },
    })
  })

  test("persists a structured redacted failure and failure audit", async () => {
    const harness = createHarness(failingAdapter())
    const created = await harness.executor.create(createInput())
    const failed = await harness.executor.execute(created.id, {
      requestId: "request-execute",
    })

    expect(failed.status).toBe("failed")
    expect(failed.error).toEqual({
      code: "DEPLOYMENT_TARGET_FAILED",
      message: "Target rejected [REDACTED]",
      retryable: true,
      details: { response: "credential=[REDACTED]" },
    })
    expect(harness.repository.audits.at(-1)).toMatchObject({
      action: "deployment.fail",
      metadata: {
        code: "DEPLOYMENT_TARGET_FAILED",
        retryable: true,
      },
    })
    expect(JSON.stringify(harness.repository)).not.toContain("resolved-value")
  })

  test("owner-scopes deployment reads and logs without disclosure", async () => {
    const harness = createHarness(successAdapter())
    const created = await harness.executor.create(createInput())

    await expect(harness.executor.get("owner-b", created.id)).rejects.toMatchObject({
      code: "DEPLOYMENT_NOT_FOUND",
    })
    await expect(
      harness.executor.logs({ ownerId: "owner-b", deploymentId: created.id }),
    ).rejects.toBeInstanceOf(DeploymentExecutionError)
  })

  test("rejects undeclared and reserved deployment secret sources before persistence", async () => {
    const harness = createHarness(successAdapter())
    await expect(
      harness.executor.create({
        ...createInput(),
        secretRefs: { DEPLOY_TOKEN: "env://CLOUDFLARE_BRIDGE_TOKEN" },
      }),
    ).rejects.toMatchObject({ code: "DEPLOYMENT_INPUT_INVALID" })
    await expect(
      harness.executor.create({
        ...createInput(),
        secretRefs: { PLATFORM_TOKEN: "env://DEPLOY_TOKEN" },
      }),
    ).rejects.toMatchObject({ code: "DEPLOYMENT_INPUT_INVALID" })
    expect(harness.repository.records.size).toBe(0)
    expect(harness.repository.audits).toEqual([])
  })

  test("authorizes the run before consulting the target or source", async () => {
    let validated = 0
    let sourceResolutions = 0
    const adapter: DeployAdapter = {
      name: "test-target",
      secretEnvNames: ["DEPLOY_TOKEN"],
      validate(config) {
        validated += 1
        return config
      },
      async deploy() {
        throw new Error("unreachable")
      },
    }
    const source = fixtureSource()
    const harness = createHarness(adapter, {
      runs: { getRun: () => null },
      sourceResolver: {
        async resolve() {
          sourceResolutions += 1
          return {
            artifactId: source.artifactId,
            manifestDigest: source.manifestDigest,
            logicalPath: source.logicalPath,
          }
        },
        async open() {
          return source
        },
      },
    })

    for (const input of [
      { ...createInput(), ownerId: "owner-b" },
      { ...createInput(), runId: "run-missing", targetName: "missing-target" },
    ]) {
      await expect(harness.executor.create(input)).rejects.toMatchObject({
        code: "DEPLOYMENT_NOT_FOUND",
        message: "Deployment was not found.",
      })
    }
    expect(validated).toBe(0)
    expect(sourceResolutions).toBe(0)
    expect(harness.repository.records.size).toBe(0)
  })

  test("keeps an owned run with a missing immutable source distinguishable", async () => {
    const harness = createHarness(successAdapter(), {
      sourceResolver: {
        async resolve() {
          throw new DeploymentExecutionError(
            "DEPLOYMENT_SOURCE_UNAVAILABLE",
            "Deployment source is unavailable.",
          )
        },
        async open() {
          throw new Error("unreachable")
        },
      },
    })

    await expect(harness.executor.create(createInput())).rejects.toMatchObject({
      code: "DEPLOYMENT_SOURCE_UNAVAILABLE",
    })
    expect(harness.repository.records.size).toBe(0)
  })

  test("canonicalizes valid adapter URLs before persistence", async () => {
    const adapter: DeployAdapter = {
      name: "test-target",
      secretEnvNames: ["DEPLOY_TOKEN"],
      validate: (config) => config,
      async deploy() {
        return {
          url: "HTTPS://PREVIEW.EXAMPLE:443/a/../deployment",
          metadata: {},
        }
      },
    }
    const harness = createHarness(adapter)
    const created = await harness.executor.create(createInput())
    const finished = await harness.executor.execute(created.id, { requestId: "execute" })

    expect(finished.status).toBe("succeeded")
    expect(finished.url).toBe("https://preview.example/deployment")
  })

  test.each([
    ["non-HTTP scheme", { url: "ftp://preview.example/output", metadata: {} }],
    ["credentials", { url: "https://user:password@preview.example/output", metadata: {} }],
    ["literal control", { url: "https://preview.example/out\nput", metadata: {} }],
    ["encoded control", { url: "https://preview.example/out%0Aput", metadata: {} }],
    ["oversize URL", { url: `https://preview.example/${"x".repeat(2_100)}`, metadata: {} }],
    ["known secret", { url: "https://preview.example/resolved-value", metadata: {} }],
    [
      "known secret preview",
      {
        url: "https://preview.example/safe",
        previewUrl: "https://preview.example/resolved-value",
        metadata: {},
      },
    ],
    [
      "invalid non-selected URL",
      {
        url: "https://preview.example/resolved-value",
        previewUrl: "https://preview.example/safe",
        metadata: {},
      },
    ],
  ])("fails safely when an adapter returns %s", async (_case, result) => {
    const adapter: DeployAdapter = {
      name: "test-target",
      secretEnvNames: ["DEPLOY_TOKEN"],
      validate: (config) => config,
      async deploy() {
        return result
      },
    }
    const harness = createHarness(adapter)
    const created = await harness.executor.create(createInput())
    const failed = await harness.executor.execute(created.id, { requestId: "execute" })

    expect(failed).toMatchObject({
      status: "failed",
      url: null,
      error: {
        code: "DEPLOYMENT_RESULT_INVALID",
        message: "Deployment target returned an invalid success URL.",
        retryable: false,
      },
    })
    expect(() => JSON.stringify(failed)).not.toThrow()
    expect(JSON.stringify(harness.repository)).not.toContain("resolved-value")
    expect(harness.repository.audits.at(-1)?.action).toBe("deployment.fail")
  })

  test("clears resolved deployment secrets after adapter execution", async () => {
    let retained: Readonly<Record<string, string>> | undefined
    const adapter: DeployAdapter = {
      name: "test-target",
      secretEnvNames: ["DEPLOY_TOKEN"],
      validate: (config) => config,
      async deploy(input) {
        retained = input.secrets
        const secrets = input.secrets as { readonly DEPLOY_TOKEN?: string }
        expect(secrets.DEPLOY_TOKEN).toBe("resolved-value")
        return { url: "https://preview.example/disposed", metadata: {} }
      },
    }
    const harness = createHarness(adapter)
    const created = await harness.executor.create(createInput())
    await harness.executor.execute(created.id, { requestId: "request-execute" })

    expect(retained).toEqual({})
  })

  test("rechecks an adapter's secret contract before resolving persisted references", async () => {
    let calls = 0
    const secretEnvNames = ["DEPLOY_TOKEN"]
    const adapter: DeployAdapter = {
      name: "test-target",
      secretEnvNames,
      validate: (config) => config,
      async deploy() {
        calls += 1
        return { url: "https://preview.example/unreachable", metadata: {} }
      },
    }
    const harness = createHarness(adapter)
    const created = await harness.executor.create(createInput())
    secretEnvNames.length = 0

    const failed = await harness.executor.execute(created.id, { requestId: "execute" })

    expect(failed).toMatchObject({
      status: "failed",
      error: { code: "DEPLOYMENT_INPUT_INVALID" },
    })
    expect(calls).toBe(0)
  })

  test("a concurrent executor cannot run the adapter twice", async () => {
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const adapter: DeployAdapter = {
      name: "test-target",
      secretEnvNames: ["DEPLOY_TOKEN"],
      validate: (config) => config,
      async deploy() {
        calls += 1
        await gate
        return { url: "https://preview.example/once", metadata: {} }
      },
    }
    const harness = createHarness(adapter)
    const created = await harness.executor.create(createInput())
    const first = harness.executor.execute(created.id, { requestId: "request-1" })
    await waitFor(() => calls === 1)
    const second = await harness.executor.execute(created.id, {
      requestId: "request-2",
    })
    expect(second.status).toBe("running")
    release?.()
    expect((await first).status).toBe("succeeded")
    expect(calls).toBe(1)
  })

  test("graceful shutdown aborts work but leaves running status recoverable", async () => {
    let entered: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const adapter: DeployAdapter = {
      name: "test-target",
      secretEnvNames: ["DEPLOY_TOKEN"],
      validate: (config) => config,
      async deploy(_input, context): Promise<never> {
        entered?.()
        return new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () =>
              reject(new DeployAdapterError("DEPLOYMENT_ABORTED", "Deployment was interrupted.")),
            { once: true },
          )
        })
      },
    }
    const harness = createHarness(adapter)
    const created = await harness.executor.create(createInput())
    const dispatcher = new DeploymentDispatcher({
      store: {
        listQueuedDeployments: () =>
          [...harness.repository.records.values()].filter(
            (deployment) => deployment.status === "queued",
          ),
        listRunningDeployments: () => [],
      },
      executor: harness.executor,
      logger: new StructuredLogger({
        serviceName: "meanwhile-test",
        serviceVersion: "0.1.0",
        sink: { write() {} },
      }),
      pollMs: 60_000,
      shutdownGraceMs: 100,
    })

    await dispatcher.start()
    await started
    await dispatcher.stop()

    expect(harness.repository.records.get(created.id)?.status).toBe("running")
    expect(harness.repository.audits.map((audit) => audit.action)).toEqual([
      "deployment.create",
      "deployment.start",
    ])
  })

  test("shutdown seals persistence before a non-cooperative adapter finishes", async () => {
    let entered: (() => void) | undefined
    let release: (() => void) | undefined
    let completed: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const adapterCompleted = new Promise<void>((resolve) => {
      completed = resolve
    })
    const adapter: DeployAdapter = {
      name: "test-target",
      secretEnvNames: ["DEPLOY_TOKEN"],
      validate: (config) => config,
      async deploy(_input, context) {
        entered?.()
        await gate
        try {
          await context.emit({
            level: "info",
            event: "deployment.test.late_output",
            message: "This output arrived after shutdown.",
          })
          return { url: "https://preview.example/late-success", metadata: {} }
        } finally {
          completed?.()
        }
      },
    }
    const harness = createHarness(adapter)
    const created = await harness.executor.create(createInput())
    const dispatcher = new DeploymentDispatcher({
      store: {
        listQueuedDeployments: () =>
          [...harness.repository.records.values()].filter(
            (deployment) => deployment.status === "queued",
          ),
        listRunningDeployments: () => [],
      },
      executor: harness.executor,
      logger: new StructuredLogger({
        serviceName: "meanwhile-test",
        serviceVersion: "0.1.0",
        sink: { write() {} },
      }),
      pollMs: 60_000,
      shutdownGraceMs: 1,
    })

    await dispatcher.start()
    await started
    await dispatcher.stop()
    expect(harness.repository.records.get(created.id)?.status).toBe("running")

    harness.repository.rejectFurtherAccess()
    release?.()
    await adapterCompleted
    await Bun.sleep(0)

    expect(harness.repository.accessesAfterShutdown).toBe(0)
    expect(harness.repository.records.get(created.id)?.status).toBe("running")
    expect(harness.repository.logs).toEqual([])
    expect(harness.repository.audits.map((audit) => audit.action)).toEqual([
      "deployment.create",
      "deployment.start",
    ])
  })
})

function createHarness(
  adapter: DeployAdapter,
  options: {
    runs?: DeploymentRunCatalog
    sourceResolver?: DeploymentSourceResolver
  } = {},
) {
  const repository = new MemoryDeploymentRepository()
  const source = fixtureSource()
  const reference: DeploymentSourceReference = {
    artifactId: source.artifactId,
    manifestDigest: source.manifestDigest,
    logicalPath: source.logicalPath,
  }
  let tick = 0
  const executor = new DeploymentExecutor({
    repository,
    runs: options.runs ?? {
      getRun: (ownerId, runId) =>
        ownerId === "owner-a" && runId === "run-a" ? { id: runId, ownerId } : null,
    },
    adapters: new DeployAdapterRegistry([adapter]),
    sourceResolver: options.sourceResolver ?? {
      async resolve() {
        return reference
      },
      async open() {
        return source
      },
    },
    secretResolver: new EnvironmentSecretResolver({
      source: {
        get: (name) => (name === "DEPLOY_TOKEN" ? "resolved-value" : undefined),
      },
      allowedSourceNames: ["DEPLOY_TOKEN"],
      allowedOwnerIds: ["owner-a"],
    }),
    id: () => "deployment_0123456789",
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  })
  return { executor, repository }
}

function createInput() {
  return {
    ownerId: "owner-a",
    runId: "run-a",
    source: { artifactPath: "dist" } as const,
    targetName: "test-target",
    targetConfig: {},
    secretRefs: { DEPLOY_TOKEN: "env://DEPLOY_TOKEN" },
    requestId: "request-create",
    traceId: "trace-create",
    actorApiKeyId: "key-a",
  }
}

function successAdapter(): DeployAdapter {
  return {
    name: "test-target",
    secretEnvNames: ["DEPLOY_TOKEN"],
    validate: (config) => config,
    async deploy(_input, context) {
      await context.emit({
        level: "info",
        event: "deployment.test.publish",
        message: "Publishing with resolved-value",
        fields: { nested: { credential: "resolved-value" } },
      })
      return {
        url: "https://preview.example/deployment_0123456789",
        metadata: { provider: "test" },
      }
    },
  }
}

function failingAdapter(): DeployAdapter {
  return {
    name: "test-target",
    secretEnvNames: ["DEPLOY_TOKEN"],
    validate: (config) => config,
    async deploy() {
      throw new DeployAdapterError(
        "DEPLOYMENT_TARGET_FAILED",
        "Target rejected resolved-value",
        true,
        { response: "credential=resolved-value" },
      )
    },
  }
}

function fixtureSource(): ImmutableDeploymentSource {
  const bytes = new TextEncoder().encode("hello")
  const digest = sha256(bytes)
  const entry = {
    path: "index.html",
    mediaType: "text/html; charset=utf-8",
    blob: { storageKey: `fixture/${digest}`, digest, size: bytes.byteLength },
  }
  return {
    artifactId: digest,
    manifestDigest: digest,
    logicalPath: "dist",
    entries: [entry],
    async read() {
      return bytes
    },
  }
}

class MemoryDeploymentRepository implements DeploymentRepository {
  readonly records = new Map<string, DeploymentRecord>()
  readonly audits: DeploymentAuditRecord[] = []
  readonly logs: DeploymentLogRecord[] = []
  accessesAfterShutdown = 0
  #acceptingAccess = true

  rejectFurtherAccess(): void {
    this.#acceptingAccess = false
  }

  #assertAccessible(): void {
    if (this.#acceptingAccess) return
    this.accessesAfterShutdown += 1
    throw new Error("Deployment repository was accessed after dispatcher shutdown")
  }

  async createWithAudit(input: {
    deployment: DeploymentRecord
    audit: DeploymentAuditRecord
  }): Promise<DeploymentRecord> {
    this.#assertAccessible()
    if (this.records.has(input.deployment.id)) throw new Error("duplicate fixture id")
    this.records.set(input.deployment.id, input.deployment)
    this.audits.push(input.audit)
    return input.deployment
  }

  async getForOwner(ownerId: string, deploymentId: string) {
    this.#assertAccessible()
    const record = this.records.get(deploymentId)
    return record?.ownerId === ownerId ? record : null
  }

  async getForExecution(deploymentId: string) {
    this.#assertAccessible()
    return this.records.get(deploymentId) ?? null
  }

  async transitionWithAudit(input: {
    deploymentId: string
    fromStatus: DeploymentRecord["status"]
    toStatus: DeploymentRecord["status"]
    at: string
    url?: string | null
    error?: DeploymentRecord["error"]
    audit: DeploymentAuditRecord
  }) {
    this.#assertAccessible()
    const current = this.records.get(input.deploymentId)
    if (current === undefined || current.status !== input.fromStatus) return null
    const terminal = input.toStatus === "succeeded" || input.toStatus === "failed"
    const next: DeploymentRecord = {
      ...current,
      status: input.toStatus,
      url: input.url === undefined ? current.url : input.url,
      error: input.error === undefined ? null : input.error,
      startedAt: input.toStatus === "running" ? (current.startedAt ?? input.at) : current.startedAt,
      finishedAt: terminal ? input.at : current.finishedAt,
      updatedAt: input.at,
    }
    this.records.set(next.id, next)
    this.audits.push(input.audit)
    return next
  }

  async appendLog(input: Omit<DeploymentLogRecord, "sequence">) {
    this.#assertAccessible()
    const log = { ...input, sequence: this.logs.length + 1 }
    this.logs.push(log)
    return log
  }

  async listLogsForOwner(input: {
    ownerId: string
    deploymentId: string
    after: number
    limit: number
  }): Promise<DeploymentLogPage | null> {
    this.#assertAccessible()
    const deployment = await this.getForOwner(input.ownerId, input.deploymentId)
    if (deployment === null) return null
    const items = this.logs
      .filter((log) => log.deploymentId === input.deploymentId && log.sequence > input.after)
      .slice(0, input.limit)
    return {
      items,
      nextCursor: items.length === input.limit ? (items.at(-1)?.sequence ?? null) : null,
    }
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return
    await Bun.sleep(0)
  }
  throw new Error("Timed out waiting for test condition.")
}
