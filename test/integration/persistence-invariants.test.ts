import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppError } from "../../src/errors"
import { CURRENT_SCHEMA, splitSchemaSql } from "../../src/persistence/schema"
import { type ClaimRunOutcomeInput, Store } from "../../src/persistence/store"
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
      createAgentSessionRecord(store, OWNER_A, "session-owner-a")
      const mismatches = [
        `INSERT INTO run_status_events VALUES ('event-x','owner-b','run-a',NULL,'queued',99,'x','${AT}')`,
        `INSERT INTO run_idempotency_keys VALUES ('owner-b','key-x','hash-x','run-a','${AT}')`,
        `INSERT INTO runtime_instances(id,owner_id,run_id,provider,handle_json,cleanup_status,created_at,updated_at)
          VALUES ('runtime-x','owner-b','run-a','local','{}','pending','${AT}','${AT}')`,
        `INSERT INTO runtime_provisioning_intents(runtime_id,owner_id,run_id,provider,status,next_attempt_at,created_at,updated_at)
          VALUES ('runtime-intent-x','owner-b','run-a','local','pending','${AT}','${AT}','${AT}')`,
        `INSERT INTO run_process_launch_intents(run_id,owner_id,runtime_id,process_id,timeout_budget_ms,created_at)
          VALUES ('run-a','owner-b','runtime-x','process-x',1000,'${AT}')`,
        `INSERT INTO session_runtime_provisioning_intents(runtime_id,owner_id,session_id,provider,status,next_attempt_at,created_at,updated_at)
          VALUES ('session-runtime-intent-x','owner-b','session-owner-a','local','pending','${AT}','${AT}','${AT}')`,
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
        `INSERT INTO deployment_idempotency_keys VALUES ('owner-b','key-x','hash-x','deployment-a','${AT}')`,
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

  test("deployment admission is owner-scoped and atomic with its audit", () => {
    const store = seededStore()
    try {
      const retry = store.createDeployment(
        deploymentRecord("deployment-retry", OWNER_A, "run-a", "artifact-a"),
        audit(OWNER_A, "deployment.create", "deployment-retry"),
        { key: "deployment-a", requestHash: "deployment-a-hash" },
      )
      expect(retry).toMatchObject({ replayed: true, deployment: { id: "deployment-a" } })
      expect(store.listDeployments(OWNER_A, { limit: 10 }).items).toHaveLength(1)
      expect(
        store
          .listAudit(OWNER_A, "deployment-a")
          .filter(({ action }) => action === "deployment.create"),
      ).toHaveLength(1)

      expect(() =>
        store.createDeployment(
          deploymentRecord("deployment-conflict", OWNER_A, "run-a", "artifact-a"),
          audit(OWNER_A, "deployment.create", "deployment-conflict"),
          { key: "deployment-a", requestHash: "different-hash" },
        ),
      ).toThrow(AppError)
      expect(store.listDeployments(OWNER_A, { limit: 10 }).items).toHaveLength(1)

      const otherOwner = store.createDeployment(
        deploymentRecord("deployment-b", OWNER_B, "run-b", "artifact-b"),
        audit(OWNER_B, "deployment.create", "deployment-b"),
        { key: "deployment-a", requestHash: "owner-b-hash" },
      )
      expect(otherOwner).toMatchObject({ replayed: false, deployment: { id: "deployment-b" } })
    } finally {
      store.close()
    }
  })
})

describe("current schema", () => {
  test("splits the schema definition without losing quoted semicolons", () => {
    const raw = new Database(":memory:")
    try {
      const statements = splitSchemaSql(`
        -- statement boundary; remains a comment
        CREATE TABLE sample(value TEXT NOT NULL) STRICT;
        /* a block comment containing ; */
        INSERT INTO sample(value) VALUES ('left;right'), ('escaped '' quote; value');
      `)
      expect(statements).toHaveLength(2)
      for (const statement of statements) raw.query(statement).run()
      expect(
        raw.query<{ value: string }, []>("SELECT value FROM sample ORDER BY rowid").all(),
      ).toEqual([{ value: "left;right" }, { value: "escaped ' quote; value" }])
      expectAppError(() => splitSchemaSql("/* comment only */"), "SCHEMA_DEFINITION_INVALID")
      expectAppError(
        () => splitSchemaSql("CREATE TABLE broken(value TEXT DEFAULT 'unterminated)"),
        "SCHEMA_DEFINITION_INVALID",
      )
      expectAppError(
        () =>
          splitSchemaSql(
            "-- no compound statements\nCREATE TRIGGER forbidden AFTER INSERT ON sample BEGIN SELECT 1; END",
          ),
        "SCHEMA_DEFINITION_INVALID",
      )
    } finally {
      raw.close()
    }
  })

  test("records one exact schema identity and rejects drift", async () => {
    const path = await databasePath()
    new Store(path).close()
    const raw = new Database(path)
    const identity = raw
      .query<{ name: string; fingerprint: string }, []>(
        "SELECT name, fingerprint FROM schema_identity",
      )
      .get()
    expect(identity).toEqual(CURRENT_SCHEMA)
    raw.query("UPDATE schema_identity SET fingerprint = ?").run("f".repeat(64))
    raw.close()

    expectAppError(() => new Store(path), "DATABASE_SCHEMA_MISMATCH")

    const structurallyDrifted = new Database(path)
    structurallyDrifted
      .query("UPDATE schema_identity SET fingerprint = ?")
      .run(CURRENT_SCHEMA.fingerprint)
    structurallyDrifted.exec("CREATE TABLE unexpected_state(value TEXT NOT NULL) STRICT")
    structurallyDrifted.close()
    expectAppError(() => new Store(path), "DATABASE_SCHEMA_MISMATCH")
  })

  test("rejects every nonempty foreign or partial database without modifying it", async () => {
    const path = await databasePath()
    let raw = new Database(path)
    try {
      raw.exec("CREATE TABLE foreign_state(value TEXT NOT NULL) STRICT")

      raw.close()
      expectAppError(() => new Store(path), "DATABASE_SCHEMA_MISMATCH")
      raw = new Database(path)
      expect(
        raw
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE name='owners'",
          )
          .get()?.count,
      ).toBe(0)
    } finally {
      raw.close()
    }
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
      store.touchApiKey(input.apiKeyId, "2026-07-13T00:01:00.000Z")
      store.touchApiKey(input.apiKeyId, "2026-07-13T00:01:30.000Z")
      expect(store.listApiKeys(input.ownerId)[0]?.lastUsedAt).toBe("2026-07-13T00:01:00.000Z")
      store.touchApiKey(input.apiKeyId, "2026-07-13T00:02:00.000Z")
      expect(store.listApiKeys(input.ownerId)[0]?.lastUsedAt).toBe("2026-07-13T00:02:00.000Z")
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
  test("rolls back the provisioning claim when its evidence cannot commit", () => {
    const store = seededStore()
    try {
      const queued = store.getRunInternal("run-a")
      if (queued === null) throw new Error("missing run")
      store.database.exec(`
        CREATE TRIGGER reject_provisioning_log BEFORE INSERT ON run_logs
        WHEN NEW.event_type = 'run.provisioning'
        BEGIN SELECT RAISE(ABORT, 'injected provisioning-log failure'); END
      `)
      const claim = () =>
        store.claimRunProvisioning({
          runId: queued.id,
          expectedVersion: queued.statusVersion,
          at: AT,
          deadlineAt: "2099-01-01T00:00:00.000Z",
          audit: {
            actorApiKeyId: null,
            action: "run.provision",
            requestId: "system:provision",
            traceId: null,
            metadata: {},
          },
          systemLog: { eventType: "run.provisioning", data: "Provisioning runtime" },
        })

      expect(claim).toThrow()
      expect(store.getRun(OWNER_A, queued.id)?.status).toBe("queued")
      expect(store.listRunStatusEvents(OWNER_A, queued.id).map((event) => event.toStatus)).toEqual([
        "queued",
      ])
      expect(store.listRunLogs(OWNER_A, queued.id, 0, 10)).toEqual([])
      expect(
        store.listAudit(OWNER_A, queued.id).some((record) => record.action === "run.provision"),
      ).toBeFalse()

      store.database.exec("DROP TRIGGER reject_provisioning_log")
      expect(claim()?.status).toBe("provisioning")
    } finally {
      store.close()
    }
  })

  test("accepts exact replay, rejects conflicting sequence, and atomically starts the run", () => {
    const store = seededStore()
    try {
      const provisioning = transition(store, "run-a", "queued", "provisioning")
      store.createRunnerSession({
        runId: "run-a",
        ownerId: OWNER_A,
        runnerSessionId: "session-a",
        protocolVersion: 1,
        createdAt: AT,
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
        "run.provisioning",
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
      const input = terminalOutcome(store, running)
      expect(() => store.claimRunOutcome(input)).toThrow()
      expect(store.getRun(OWNER_A, "run-a")?.status).toBe("running")
      expect(
        store.listRunStatusEvents(OWNER_A, "run-a").some((event) => event.toStatus === "succeeded"),
      ).toBeFalse()
      store.database.exec("DROP TRIGGER reject_final_log")

      expect(store.claimRunOutcome(input)?.run.status).toBe("succeeded")
      expect(store.listRunLogs(OWNER_A, "run-a", 0, 10).at(-1)?.eventType).toBe("run.succeeded")
    } finally {
      store.close()
    }
  })

  test("rolls back the entire outcome when cleanup scheduling cannot commit", () => {
    const store = seededStore()
    try {
      const provisioning = transition(store, "run-a", "queued", "provisioning")
      transition(store, "run-a", "provisioning", "running", provisioning)
      const runtime = {
        id: "runtime-a",
        ownerId: OWNER_A,
        runId: "run-a",
        provider: "local",
        handle: { kind: "runtime", version: 1, provider: "local", opaque: "runtime-a" },
        processHandle: null,
        cleanupStatus: "pending",
        cleanupAttempts: 0,
        cleanupLastError: null,
        cleanupNextAttemptAt: null,
        createdAt: AT,
        updatedAt: AT,
        destroyedAt: null,
      } as const
      expect(
        store.ensureRuntimeProvisioningIntent({
          runId: "run-a",
          ownerId: OWNER_A,
          runtimeId: runtime.id,
          provider: runtime.provider,
          at: AT,
        }),
      ).not.toBeNull()
      expect(store.claimRuntimeProvisioning(runtime.id, AT, "active")).not.toBeNull()
      store.materializeRuntimeProvisioning(runtime, {
        id: crypto.randomUUID(),
        ownerId: OWNER_A,
        actorApiKeyId: null,
        action: "runtime.create",
        resourceType: "runtime",
        resourceId: runtime.id,
        requestId: "system:runtime-create",
        traceId: null,
        metadata: { runId: "run-a", provider: "local" },
        createdAt: AT,
      })
      const beforeEvents = store.listRunEvents(OWNER_A, "run-a", 0, 100).length
      const beforeAudits = store.listAudit(OWNER_A, "run-a").length
      const beforeLogs = store.listRunLogs(OWNER_A, "run-a", 0, 100).length
      store.database.exec(`
        CREATE TRIGGER reject_cleanup_schedule
        BEFORE UPDATE OF cleanup_next_attempt_at ON runtime_instances
        WHEN NEW.id = 'runtime-a' AND NEW.cleanup_next_attempt_at IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'injected cleanup scheduling failure'); END
      `)

      const claim = () =>
        store.claimRunOutcome({
          kind: "control_plane_failure",
          ownerId: OWNER_A,
          runId: "run-a",
          status: "failed",
          at: AT,
          error: { code: "INTERNAL", message: "Execution failed", retryable: false },
          resultAudit: {
            actorApiKeyId: null,
            action: "run.failed",
            requestId: "system:failed",
            traceId: null,
            metadata: {},
          },
          systemLog: { eventType: "run.failed", data: "Run failed" },
        })

      expect(claim).toThrow()
      expect(store.getRun(OWNER_A, "run-a")?.status).toBe("running")
      expect(store.getRuntimeForRun("run-a")?.cleanupNextAttemptAt).toBeNull()
      expect(store.listRunEvents(OWNER_A, "run-a", 0, 100)).toHaveLength(beforeEvents)
      expect(store.listAudit(OWNER_A, "run-a")).toHaveLength(beforeAudits)
      expect(store.listRunLogs(OWNER_A, "run-a", 0, 100)).toHaveLength(beforeLogs)

      store.database.exec("DROP TRIGGER reject_cleanup_schedule")
      expect(claim()?.outcome).toBe("claimed")
      expect(store.getRun(OWNER_A, "run-a")?.status).toBe("failed")
      expect(store.getRuntimeForRun("run-a")?.cleanupNextAttemptAt).toBe(AT)
    } finally {
      store.close()
    }
  })

  test("materializes process handle, public identity, and audit atomically", () => {
    const store = seededStore()
    try {
      transition(store, "run-a", "queued", "provisioning")
      const runtime = {
        id: "runtime-process-a",
        ownerId: OWNER_A,
        runId: "run-a",
        provider: "local",
        handle: { kind: "runtime", version: 1, provider: "local", opaque: "runtime-process-a" },
        processHandle: null,
        cleanupStatus: "pending",
        cleanupAttempts: 0,
        cleanupLastError: null,
        cleanupNextAttemptAt: null,
        createdAt: AT,
        updatedAt: AT,
        destroyedAt: null,
      } as const
      store.ensureRuntimeProvisioningIntent({
        runId: runtime.runId,
        ownerId: runtime.ownerId,
        runtimeId: runtime.id,
        provider: runtime.provider,
        at: AT,
      })
      store.claimRuntimeProvisioning(runtime.id, AT, "active")
      store.materializeRuntimeProvisioning(runtime, {
        id: crypto.randomUUID(),
        ownerId: OWNER_A,
        actorApiKeyId: null,
        action: "runtime.create",
        resourceType: "runtime",
        resourceId: runtime.id,
        requestId: "system:runtime-create",
        traceId: null,
        metadata: {},
        createdAt: AT,
      })
      const launch = store.ensureRunProcessLaunchIntent({
        runId: runtime.runId,
        ownerId: runtime.ownerId,
        runtimeId: runtime.id,
        processId: "runner-run-a",
        timeoutBudgetMs: 50_000,
        createdAt: AT,
      })
      expect(launch?.timeoutBudgetMs).toBe(50_000)
      expect(
        store.ensureRunProcessLaunchIntent({
          runId: runtime.runId,
          ownerId: runtime.ownerId,
          runtimeId: runtime.id,
          processId: "runner-run-a",
          timeoutBudgetMs: 1,
          createdAt: "2099-01-01T00:00:00.000Z",
        })?.timeoutBudgetMs,
      ).toBe(50_000)
      store.database.exec(`
        CREATE TRIGGER reject_process_audit BEFORE INSERT ON audit_records
        WHEN NEW.action = 'runtime.process_start'
        BEGIN SELECT RAISE(ABORT, 'injected process audit failure'); END
      `)
      const materialize = () =>
        store.materializeRunProcessLaunch({
          runId: runtime.runId,
          ownerId: runtime.ownerId,
          runtimeId: runtime.id,
          processId: "runner-run-a",
          processHandle: {
            kind: "process",
            version: 1,
            provider: "local",
            opaque: "runtime-process-a.runner-run-a",
          },
          at: AT,
          audit: {
            id: crypto.randomUUID(),
            ownerId: OWNER_A,
            actorApiKeyId: null,
            action: "runtime.process_start",
            resourceType: "runtime",
            resourceId: runtime.id,
            requestId: "system:process-start",
            traceId: null,
            metadata: {},
            createdAt: AT,
          },
        })

      expect(materialize).toThrow()
      expect(store.getRuntimeForRun(runtime.runId)?.processHandle).toBeNull()
      expect(store.getRun(OWNER_A, runtime.runId)?.processId).toBeNull()

      store.database.exec("DROP TRIGGER reject_process_audit")
      expect(materialize()).toBeTrue()
      expect(store.getRuntimeForRun(runtime.runId)?.processHandle).not.toBeNull()
      expect(store.getRun(OWNER_A, runtime.runId)?.processId).toBe("runner-run-a")
      expect(materialize()).toBeFalse()
      expect(
        store
          .listAudit(OWNER_A, runtime.id)
          .filter((record) => record.action === "runtime.process_start"),
      ).toHaveLength(1)
    } finally {
      store.close()
    }
  })
})

describe("durable session runtime ownership", () => {
  test("recovers provisioning and cleanup claims without losing a terminal session", () => {
    const store = seededStore()
    try {
      store.createAgentSession({
        id: "session-a",
        ownerId: OWNER_A,
        workspace: { type: "repository", url: "https://example.test/repo.git" },
        agentType: "demo",
        agentSpec: testAgentSpec(),
        agentCatalogDigest: TEST_AGENT_CATALOG_DIGEST,
        executionProvenance: testExecutionProvenanceFor("local"),
        env: {},
        secretRefs: {},
        provider: "local",
        idleTimeoutMs: 60_000,
        createdAt: AT,
        audit: {
          actorApiKeyId: null,
          requestId: "session:create",
          traceId: null,
          metadata: {},
        },
      })
      expect(store.claimAgentSessionProvisioning("session-a", AT)?.status).toBe("provisioning")
      const runtimeId = "session-session-a"
      expect(
        store.ensureSessionRuntimeProvisioningIntent({
          sessionId: "session-a",
          ownerId: OWNER_A,
          provider: "local",
          runtimeId,
          at: AT,
        })?.status,
      ).toBe("pending")
      expect(store.claimSessionRuntimeProvisioning("session-a", AT, "active")?.status).toBe(
        "creating",
      )

      store.failAgentSession(
        "session-a",
        { code: "INTERNAL", message: "Executor interrupted", retryable: false },
        AT,
      )
      expect(store.recoverInterruptedSessionRuntimeProvisioning(AT)).toBe(1)
      expect(store.listSessionRuntimeProvisioningCleanupCandidates(AT)).toEqual(["session-a"])
      expect(store.claimSessionRuntimeProvisioning("session-a", AT, "terminal")?.attempts).toBe(2)

      const lease = store.materializeSessionRuntimeProvisioning({
        sessionId: "session-a",
        ownerId: OWNER_A,
        provider: "local",
        runtimeId,
        runtimeHandle: { kind: "runtime", version: 1, provider: "local", opaque: runtimeId },
        at: AT,
      })
      expect(lease).toMatchObject({ cleanupStatus: "pending", cleanupNextAttemptAt: AT })
      expect(store.getSessionRuntimeProvisioningIntent("session-a")?.status).toBe("materialized")

      expect(store.claimSessionRuntimeCleanup("session-a", AT)?.cleanupStatus).toBe("running")
      expect(store.recoverInterruptedSessionRuntimeCleanups(AT)).toBe(1)
      expect(store.claimSessionRuntimeCleanup("session-a", AT)?.cleanupAttempts).toBe(2)
      store.finishSessionRuntimeCleanup("session-a", null, AT)
      expect(store.getSessionRuntimeLease("session-a")).toMatchObject({
        cleanupStatus: "succeeded",
        destroyedAt: AT,
      })
      expect(store.getAgentSessionInternal("session-a")?.status).toBe("failed")
    } finally {
      store.close()
    }
  })

  test("materializes session process identity and audit in one exact transaction", () => {
    const store = seededStore()
    try {
      createAgentSessionRecord(store, OWNER_A, "session-process")
      store.claimAgentSessionProvisioning("session-process", AT)
      const runtimeId = "session-session-process"
      store.ensureSessionRuntimeProvisioningIntent({
        sessionId: "session-process",
        ownerId: OWNER_A,
        provider: "local",
        runtimeId,
        at: AT,
      })
      store.claimSessionRuntimeProvisioning("session-process", AT, "active")
      store.materializeSessionRuntimeProvisioning({
        sessionId: "session-process",
        ownerId: OWNER_A,
        provider: "local",
        runtimeId,
        runtimeHandle: { kind: "runtime", version: 1, provider: "local", opaque: runtimeId },
        at: AT,
      })
      store.database.exec(`
        CREATE TRIGGER reject_session_process_audit BEFORE INSERT ON audit_records
        WHEN NEW.action = 'agent.start'
        BEGIN SELECT RAISE(ABORT, 'injected session process audit failure'); END
      `)
      const materialize = () =>
        store.materializeSessionProcessLaunch({
          sessionId: "session-process",
          ownerId: OWNER_A,
          processId: "session-runner-session-process",
          processHandle: {
            kind: "process",
            version: 1,
            provider: "local",
            opaque: `${runtimeId}.session-runner-session-process`,
          },
          at: AT,
        })

      expect(materialize).toThrow()
      expect(store.getSessionRuntimeLease("session-process")?.processHandle).toBeNull()
      expect(store.getAgentSessionInternal("session-process")?.processId).toBeNull()

      store.database.exec("DROP TRIGGER reject_session_process_audit")
      expect(materialize()).toBeTrue()
      expect(store.getSessionRuntimeLease("session-process")?.processHandle).not.toBeNull()
      expect(store.getAgentSessionInternal("session-process")?.processId).toBe(
        "session-runner-session-process",
      )
      expect(materialize()).toBeFalse()
      expect(
        store
          .listAudit(OWNER_A, "session-process")
          .filter((record) => record.action === "agent.start"),
      ).toHaveLength(1)
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
    { key: "deployment-a", requestHash: "deployment-a-hash" },
  )
  return store
}

function deploymentRecord(id: string, ownerId: string, runId: string, artifactId: string) {
  return {
    id,
    ownerId,
    runId,
    artifactId,
    target: "local-static",
    targetConfig: {},
    secretRefs: {},
    status: "queued" as const,
    url: null,
    error: null,
    createdAt: AT,
    startedAt: null,
    finishedAt: null,
    updatedAt: AT,
  }
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

function createAgentSessionRecord(store: Store, ownerId: string, id: string): void {
  store.createAgentSession({
    id,
    ownerId,
    workspace: { type: "repository", url: "https://example.test/repo.git" },
    agentType: "demo",
    agentSpec: testAgentSpec(),
    agentCatalogDigest: TEST_AGENT_CATALOG_DIGEST,
    executionProvenance: testExecutionProvenanceFor("local"),
    env: {},
    secretRefs: {},
    provider: "local",
    idleTimeoutMs: 60_000,
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
  if (current.status !== from) throw new Error(`expected ${from}, received ${current.status}`)
  const audit = {
    actorApiKeyId: null,
    action: `run.${to}`,
    requestId: `system:${to}`,
    traceId: null,
    metadata: {},
  } as const
  if (to === "provisioning") {
    const result = store.claimRunProvisioning({
      runId,
      expectedVersion: current.statusVersion,
      at: AT,
      deadlineAt: "2099-01-01T00:00:00.000Z",
      audit,
      systemLog: { eventType: "run.provisioning", data: "Provisioning runtime" },
    })
    if (result === null) throw new Error("provisioning claim failed")
    return result
  }
  store.createRunnerSession({
    runId,
    ownerId: current.ownerId,
    runnerSessionId: "session-a",
    protocolVersion: 1,
    createdAt: AT,
  })
  return store.acceptRunnerFrame({
    ...frameInput(1, "session.started", "{}"),
    runningTransition: {
      at: AT,
      reason: "agent.session_started",
      audit,
      systemLog: { eventType: "run.running", data: "Agent session started" },
    },
  }).run
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

function terminalOutcome(
  store: Store,
  run: NonNullable<ReturnType<Store["getRunInternal"]>>,
): ClaimRunOutcomeInput {
  const terminalResult = { outcome: "succeeded", stopReason: "end_turn" } as const
  const data = JSON.stringify(terminalResult)
  store.acceptRunnerFrame({
    ...frameInput(2, "terminal", data),
    terminalResult,
  })
  return {
    kind: "runner",
    ownerId: run.ownerId,
    runId: run.id,
    status: "succeeded",
    terminalResult,
    at: AT,
    systemLog: { eventType: "run.succeeded", data: "Run succeeded" },
    resultAudit: {
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
  const directory = await mkdtemp(join(tmpdir(), "meanwhile-schema-"))
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
