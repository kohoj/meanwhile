import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  CURRENT_SCHEMA,
  databaseSchemaFingerprint,
  SCHEMA_SQL,
  splitSchemaSql,
} from "../../src/persistence/schema"

const LEGACY_SCHEMA_FINGERPRINT = "a7ee3aed4ff1cd19095d4c1aa2c4da0fdd5b25ab88fbcc4363b0f9255883b911"
const timestamp = "2026-07-18T00:00:00.000Z"
const ownerId = "10000000-0000-4000-8000-000000000001"
const apiKeyId = "10000000-0000-4000-8000-000000000002"
const runId = "10000000-0000-4000-8000-000000000003"
const sessionId = "10000000-0000-4000-8000-000000000004"

let temporary: string | null = null

afterEach(async () => {
  if (temporary !== null) await rm(temporary, { recursive: true, force: true })
  temporary = null
})

test("the exact v0.1.3 migration preserves identity, work, and idempotency", async () => {
  temporary = await mkdtemp(join(tmpdir(), "meanwhile-project-migration-"))
  const path = join(temporary, "meanwhile.sqlite")
  const legacy = new Database(path, { strict: true })
  for (const statement of legacySchemaStatements()) legacy.query(statement).run()
  expect(databaseSchemaFingerprint(legacy)).toBe(LEGACY_SCHEMA_FINGERPRINT)
  seedLegacyData(legacy)
  legacy.close()

  const migration = Bun.spawn(
    [
      Bun.which("bun") ?? "bun",
      "scripts/migrate-project-collaboration.ts",
      `--database=${path}`,
      "--write",
    ],
    { cwd: resolve("."), stdout: "pipe", stderr: "pipe" },
  )
  const [exitCode, stderr] = await Promise.all([
    migration.exited,
    new Response(migration.stderr).text(),
  ])
  expect(stderr).toBe("")
  expect(exitCode).toBe(0)

  const migrated = new Database(path, { strict: true, readonly: true })
  try {
    expect(databaseSchemaFingerprint(migrated)).toBe(CURRENT_SCHEMA.fingerprint)
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([])
    const principal = migrated
      .query<{ id: string; display_name: string; owner_role: string }, [string]>(
        "SELECT id,display_name,owner_role FROM principals WHERE owner_id=?",
      )
      .get(ownerId)
    expect(principal).toMatchObject({ display_name: "Acme", owner_role: "admin" })
    expect(
      migrated
        .query<{ name: string; slug: string }, [string]>(
          "SELECT name,slug FROM projects WHERE owner_id=?",
        )
        .get(ownerId),
    ).toEqual({ name: "Default Project", slug: "default" })
    expect(
      migrated
        .query<{ principal_id: string }, [string]>(
          "SELECT principal_id FROM api_key_principals WHERE api_key_id=?",
        )
        .get(apiKeyId)?.principal_id,
    ).toBe(principal?.id)
    for (const [table, resourceColumn, resourceId] of [
      ["run_project_bindings", "run_id", runId],
      ["session_project_bindings", "session_id", sessionId],
    ] as const) {
      expect(
        migrated
          .query<{ delegated_by_principal_id: string }, [string]>(
            `SELECT delegated_by_principal_id FROM ${table} WHERE ${resourceColumn}=?`,
          )
          .get(resourceId)?.delegated_by_principal_id,
      ).toBe(principal?.id)
    }
    for (const table of ["run_idempotency_keys", "session_idempotency_keys"] as const) {
      expect(
        migrated.query<{ principal_id: string }, []>(`SELECT principal_id FROM ${table}`).get()
          ?.principal_id,
      ).toBe(principal?.id)
    }
  } finally {
    migrated.close()
  }
})

function legacySchemaStatements(): readonly string[] {
  const collaborationObjects = new Set([
    "principals",
    "principals_owner_idx",
    "projects",
    "projects_owner_idx",
    "project_memberships",
    "project_memberships_principal_idx",
    "api_key_principals",
    "api_key_principals_principal_idx",
    "browser_sessions",
    "browser_sessions_prefix_idx",
    "run_project_bindings",
    "run_project_bindings_project_idx",
    "session_project_bindings",
    "session_project_bindings_project_idx",
  ])
  return splitSchemaSql(SCHEMA_SQL)
    .filter((statement) => {
      const match = /^CREATE\s+(?:TABLE|INDEX)\s+([a-z0-9_]+)/i.exec(statement)
      return match === null || !collaborationObjects.has(match[1] as string)
    })
    .map((statement) =>
      statement
        .replace("\n        principal_id TEXT NOT NULL,", "")
        .replace("PRIMARY KEY(owner_id, principal_id, key)", "PRIMARY KEY(owner_id, key)")
        .replace(
          "\n        FOREIGN KEY(owner_id, principal_id) REFERENCES principals(owner_id, id),",
          "",
        ),
    )
}

function seedLegacyData(database: Database): void {
  database
    .query("INSERT INTO schema_identity VALUES (1,?,?,?)")
    .run(CURRENT_SCHEMA.name, LEGACY_SCHEMA_FINGERPRINT, timestamp)
  database.query("INSERT INTO owners VALUES (?,?,?)").run(ownerId, "Acme", timestamp)
  database
    .query("INSERT INTO api_keys VALUES (?,?,?,?,?,?,?,?)")
    .run(
      apiKeyId,
      ownerId,
      "mwk_abcdefghijkl",
      `sha256:${"a".repeat(64)}`,
      "bootstrap",
      timestamp,
      null,
      null,
    )
  database
    .query(`
      INSERT INTO runs VALUES (
        ?,?, '{}','demo','{}',?,'{}','legacy task','{}','{}','local','[]','[]',
        60000,NULL,'queued',1,NULL,NULL,NULL,?,NULL,NULL,?,NULL,NULL
      )
    `)
    .run(runId, ownerId, "b".repeat(64), timestamp, timestamp)
  database
    .query(`
      INSERT INTO agent_sessions VALUES (
        ?,?,'{}','demo','{}',?,'{}','{}','{}','local','queued',1,
        NULL,NULL,NULL,NULL,NULL,NULL,1800000,?,NULL,NULL,?,NULL
      )
    `)
    .run(sessionId, ownerId, "c".repeat(64), timestamp, timestamp)
  database
    .query("INSERT INTO run_idempotency_keys VALUES (?,?,?,?,?)")
    .run(ownerId, "legacy-run", "d".repeat(64), runId, timestamp)
  database
    .query("INSERT INTO session_idempotency_keys VALUES (?,?,?,?,?)")
    .run(ownerId, "legacy-session", "e".repeat(64), sessionId, timestamp)
}
