import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppError } from "../../src/errors"
import { Store, type TransitionRunInput } from "../../src/persistence/store"
import {
  TEST_AGENT_CATALOG_DIGEST,
  testAgentSpec,
  testExecutionProvenanceFor,
} from "../fixtures/agent-intent"

const AT = "2026-07-13T00:00:00.000Z"
const OWNER_A = "owner-a"
const OWNER_B = "owner-b"
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe("SQLite ownership invariants", () => {
  test("rejects every owner/parent mismatch at the relational boundary", () => {
    const store = seededStore()
    try {
      const mismatches = [
        `INSERT INTO run_status_events VALUES ('event-x','owner-b','run-a',NULL,'queued',99,'x','${AT}')`,
        `INSERT INTO idempotency_keys VALUES ('owner-b','key-x','hash-x','run-a','${AT}')`,
        `INSERT INTO runtime_instances(id,owner_id,run_id,provider,handle_json,cleanup_status,created_at,updated_at)
          VALUES ('runtime-x','owner-b','run-a','local','{}','pending','${AT}','${AT}')`,
        `INSERT INTO runner_sessions(run_id,owner_id,runner_session_id,protocol_version,created_at,updated_at)
          VALUES ('run-a','owner-b','session-x',1,'${AT}','${AT}')`,
        `INSERT INTO run_logs(owner_id,run_id,sequence,stream,event_type,data,created_at)
          VALUES ('owner-b','run-a',1,'system','x','x','${AT}')`,
        `INSERT INTO artifacts(id,owner_id,run_id,logical_path,kind,digest,media_type,byte_size,storage_key,created_at)
          VALUES ('artifact-x','owner-b','run-a','x','file','digest-x','text/plain',1,'object-x','${AT}')`,
        `INSERT INTO deployments(id,owner_id,run_id,artifact_id,target,target_config_json,secret_refs_json,status,created_at,updated_at)
          VALUES ('deployment-x','owner-b','run-a','artifact-a','local-static','{}','{}','queued','${AT}','${AT}')`,
        `INSERT INTO deployments(id,owner_id,run_id,artifact_id,target,target_config_json,secret_refs_json,status,created_at,updated_at)
          VALUES ('deployment-y','owner-a','run-a','artifact-b','local-static','{}','{}','queued','${AT}','${AT}')`,
        `INSERT INTO deployment_logs(owner_id,deployment_id,sequence,stream,data,created_at)
          VALUES ('owner-b','deployment-a',1,'system','x','${AT}')`,
        `INSERT INTO audit_records(id,owner_id,actor_api_key_id,action,resource_type,resource_id,request_id,metadata_json,created_at)
          VALUES ('audit-x','owner-b','key-a','x','run','run-b','request-x','{}','${AT}')`,
      ]
      for (const sql of mismatches) {
        expect(() => store.database.exec(sql)).toThrow()
        expect(store.database.query("PRAGMA foreign_key_check").all()).toEqual([])
      }

      store.insertAudit({
        id: "audit-system",
        ownerId: OWNER_A,
        actorApiKeyId: null,
        action: "system.check",
        resourceType: "run",
        resourceId: "run-a",
        requestId: "system",
        traceId: null,
        metadata: {},
        createdAt: AT,
      })
      expect(
        store.listAudit(OWNER_A, "run-a").some((record) => record.id === "audit-system"),
      ).toBeTrue()
    } finally {
      store.close()
    }
  })
})

describe("migration history", () => {
  test("records checksums and rejects drift", async () => {
    const path = await databasePath()
    new Store(path).close()
    const raw = new Database(path)
    const applied = raw
      .query<{ version: number; name: string; sha256: string }, []>(
        "SELECT version, name, sha256 FROM schema_migrations",
      )
      .get()
    expect(applied?.name).toBe("initial_control_plane")
    expect(applied?.sha256).toMatch(/^[0-9a-f]{64}$/)
    raw.query("UPDATE schema_migrations SET sha256 = ? WHERE version = 1").run("f".repeat(64))
    raw.close()

    expectAppError(() => new Store(path), "MIGRATION_DRIFT")
  })

  test("rejects a database with future migration history", async () => {
    const path = await databasePath()
    new Store(path).close()
    const raw = new Database(path)
    raw
      .query(
        "INSERT INTO schema_migrations(version,name,sha256,applied_at) VALUES (5,'future',?,?)",
      )
      .run("a".repeat(64), AT)
    raw.close()
    expectAppError(() => new Store(path), "DATABASE_TOO_NEW")
  })
})

describe("bootstrap identity", () => {
  test("creates owner, key, and both audits atomically and never rotates", () => {
    const store = new Store(":memory:")
    const input = bootstrapInput()
    try {
      expect(store.isBootstrapIdentityRequired()).toBeTrue()
      store.database.exec(`
        CREATE TRIGGER reject_bootstrap_audit BEFORE INSERT ON audit_records
        BEGIN SELECT RAISE(ABORT, 'injected bootstrap failure'); END
      `)
      expect(() => store.bootstrapIdentity(input)).toThrow()
      expect(store.isBootstrapIdentityRequired()).toBeTrue()
      store.database.exec("DROP TRIGGER reject_bootstrap_audit")

      expect(store.bootstrapIdentity(input)).toEqual({ created: true })
      expect(store.bootstrapIdentity(input)).toEqual({ created: false })
      expect(
        store
          .listAudit(input.ownerId)
          .map((record) => record.action)
          .sort(),
      ).toEqual(["api_key.create", "owner.create"])
      const before = store.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM audit_records")
        .get()?.count
      expectAppError(
        () => store.bootstrapIdentity({ ...input, apiKeyHash: `sha256:${"b".repeat(64)}` }),
        "BOOTSTRAP_KEY_CONFLICT",
      )
      expect(
        store.database
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM audit_records")
          .get()?.count,
      ).toBe(before)
    } finally {
      store.close()
    }
  })
})

describe("durable runner evidence", () => {
  test("accepts exact replay, rejects conflicting sequence, and atomically starts the run", () => {
    const store = seededStore()
    try {
      const provisioning = transition(store, "run-a", "queued", "provisioning")
      store.upsertRunnerSession({
        runId: "run-a",
        ownerId: OWNER_A,
        runnerSessionId: "session-a",
        protocolVersion: 1,
        providerCursor: null,
        runnerSequence: 0,
        terminalResult: null,
        createdAt: AT,
        updatedAt: AT,
      })
      const started = frameInput(1, "runner.started", '{"timeoutBudgetMs":60000}')
      expect(store.acceptRunnerFrame(started).accepted).toBeTrue()
      expect(store.acceptRunnerFrame(started).accepted).toBeFalse()
      expectAppError(
        () => store.acceptRunnerFrame({ ...started, data: '{"timeoutBudgetMs":30000}' }),
        "RUNNER_EVIDENCE_CONFLICT",
      )
      expectAppError(
        () => store.acceptRunnerFrame(frameInput(3, "agent.started", "{}")),
        "RUNNER_EVIDENCE_CONFLICT",
      )

      const accepted = store.acceptRunnerFrame({
        ...frameInput(2, "session.started", "{}"),
        runningTransition: {
          at: AT,
          reason: "agent.session_started",
          audit: {
            actorApiKeyId: null,
            action: "agent.start",
            requestId: "system:start",
            traceId: null,
            metadata: {},
          },
          systemLog: { eventType: "run.running", data: "Agent session started" },
        },
      })
      expect(accepted.run.status).toBe("running")
      expect(accepted.run.statusVersion).toBe(provisioning.statusVersion + 1)
      expect(store.listRunLogs(OWNER_A, "run-a", 0, 10).map((log) => log.eventType)).toEqual([
        "runner.started",
        "session.started",
        "run.running",
      ])
      expect(store.listRunStatusEvents(OWNER_A, "run-a").map((event) => event.toStatus)).toEqual([
        "queued",
        "provisioning",
        "running",
      ])
      expect(
        store.listAudit(OWNER_A, "run-a").filter((record) => record.action === "agent.start"),
      ).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  test("rolls back terminal state when its final log cannot commit", () => {
    const store = seededStore()
    try {
      const provisioning = transition(store, "run-a", "queued", "provisioning")
      const running = transition(store, "run-a", "provisioning", "running", provisioning)
      store.database.exec(`
        CREATE TRIGGER reject_final_log BEFORE INSERT ON run_logs
        WHEN NEW.event_type = 'run.succeeded'
        BEGIN SELECT RAISE(ABORT, 'injected final-log failure'); END
      `)
      const input = terminalTransition(running)
      expect(() => store.transitionRun(input)).toThrow()
      expect(store.getRun(OWNER_A, "run-a")?.status).toBe("running")
      expect(
        store.listRunStatusEvents(OWNER_A, "run-a").some((event) => event.toStatus === "succeeded"),
      ).toBeFalse()
      store.database.exec("DROP TRIGGER reject_final_log")

      expect(store.transitionRun(input)?.status).toBe("succeeded")
      expect(store.listRunLogs(OWNER_A, "run-a", 0, 10).at(-1)?.eventType).toBe("run.succeeded")
    } finally {
      store.close()
    }
  })
})

function seededStore(): Store {
  const store = new Store(":memory:")
  for (const owner of [OWNER_A, OWNER_B]) {
    store.createOwner({ id: owner, name: owner, createdAt: AT })
  }
  store.createApiKey({
    id: "key-a",
    ownerId: OWNER_A,
    prefix: "mwk_aaaaaaaaaaaa",
    hash: `sha256:${"a".repeat(64)}`,
    name: "A",
    createdAt: AT,
  })
  store.createApiKey({
    id: "key-b",
    ownerId: OWNER_B,
    prefix: "mwk_bbbbbbbbbbbb",
    hash: `sha256:${"b".repeat(64)}`,
    name: "B",
    createdAt: AT,
  })
  createRun(store, OWNER_A, "run-a")
  createRun(store, OWNER_B, "run-b")
  store.insertArtifact({
    id: "artifact-a",
    ownerId: OWNER_A,
    runId: "run-a",
    logicalPath: "dist",
    kind: "file",
    digest: "digest-a",
    mediaType: "text/plain",
    byteSize: 1,
    storageKey: "object-a",
    createdAt: AT,
  })
  store.insertArtifact({
    id: "artifact-b",
    ownerId: OWNER_B,
    runId: "run-b",
    logicalPath: "dist",
    kind: "file",
    digest: "digest-b",
    mediaType: "text/plain",
    byteSize: 1,
    storageKey: "object-b",
    createdAt: AT,
  })
  store.createDeployment(
    {
      id: "deployment-a",
      ownerId: OWNER_A,
      runId: "run-a",
      artifactId: "artifact-a",
      target: "local-static",
      targetConfig: {},
      secretRefs: {},
      status: "queued",
      url: null,
      error: null,
      createdAt: AT,
      startedAt: null,
      finishedAt: null,
      updatedAt: AT,
    },
    audit(OWNER_A, "deployment.create", "deployment-a"),
  )
  return store
}

function createRun(store: Store, ownerId: string, id: string): void {
  store.createRun({
    id,
    ownerId,
    workspace: { type: "repository", url: "https://example.test/repo.git" },
    agentType: "demo",
    agentSpec: testAgentSpec(),
    agentCatalogDigest: TEST_AGENT_CATALOG_DIGEST,
    executionProvenance: testExecutionProvenanceFor("local"),
    prompt: "test",
    env: {},
    secretRefs: {},
    provider: "local",
    artifactPaths: [],
    timeoutMs: 60_000,
    createdAt: AT,
    audit: { actorApiKeyId: null, requestId: `create:${id}`, traceId: null, metadata: {} },
  })
}

function transition(
  store: Store,
  runId: string,
  from: "queued" | "provisioning",
  to: "provisioning" | "running",
  known?: ReturnType<Store["getRunInternal"]>,
) {
  const current = known ?? store.getRunInternal(runId)
  if (current === null) throw new Error("missing run")
  const result = store.transitionRun({
    runId,
    expectedStatus: from,
    expectedVersion: current.statusVersion,
    toStatus: to,
    reason: `run.${to}`,
    at: AT,
    audit: {
      actorApiKeyId: null,
      action: `run.${to}`,
      requestId: `system:${to}`,
      traceId: null,
      metadata: {},
    },
  })
  if (result === null) throw new Error("transition failed")
  return result
}

function frameInput(sequence: number, eventType: string, data: string) {
  return {
    ownerId: OWNER_A,
    runId: "run-a",
    runnerSessionId: "session-a",
    protocolVersion: 1,
    providerCursor: `cursor-${sequence}`,
    runnerSequence: sequence,
    stream: "system" as const,
    eventType,
    data,
    createdAt: AT,
  }
}

function terminalTransition(
  run: NonNullable<ReturnType<Store["getRunInternal"]>>,
): TransitionRunInput {
  return {
    runId: run.id,
    expectedStatus: "running",
    expectedVersion: run.statusVersion,
    toStatus: "succeeded",
    reason: "run.succeeded",
    at: AT,
    systemLog: { eventType: "run.succeeded", data: "Run succeeded" },
    audit: {
      actorApiKeyId: null,
      action: "run.succeeded",
      requestId: "system:success",
      traceId: null,
      metadata: {},
    },
  }
}

function audit(ownerId: string, action: string, resourceId: string) {
  return {
    id: crypto.randomUUID(),
    ownerId,
    actorApiKeyId: null,
    action,
    resourceType: "deployment" as const,
    resourceId,
    requestId: "system",
    traceId: null,
    metadata: {},
    createdAt: AT,
  }
}

function bootstrapInput() {
  return {
    ownerId: "bootstrap-owner",
    ownerName: "Bootstrap",
    apiKeyId: "bootstrap-key",
    apiKeyPrefix: "mwk_abcdefghijkl",
    apiKeyHash: `sha256:${"a".repeat(64)}`,
    apiKeyName: "Bootstrap key",
    createdAt: AT,
  }
}

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "meanwhile-migrations-"))
  directories.push(directory)
  return join(directory, "control-plane.sqlite")
}

function expectAppError(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error(`Expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe(code)
  }
}
