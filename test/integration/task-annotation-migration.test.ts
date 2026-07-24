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

const TASK_RELAY_SCHEMA_FINGERPRINT =
  "d07927a64104d86d9d3a9b007791aaac451e3fe3ada38bb950a57e7ed029d731"
let temporary: string | null = null

afterEach(async () => {
  if (temporary !== null) await rm(temporary, { recursive: true, force: true })
  temporary = null
})

test("the exact Task Relay migration adds empty Annotation state without rewriting Relays", async () => {
  temporary = await mkdtemp(join(tmpdir(), "meanwhile-annotation-migration-"))
  const path = join(temporary, "meanwhile.sqlite")
  const legacy = new Database(path, { strict: true })
  for (const statement of taskRelaySchemaStatements()) legacy.query(statement).run()
  expect(databaseSchemaFingerprint(legacy)).toBe(TASK_RELAY_SCHEMA_FINGERPRINT)
  legacy
    .query("INSERT INTO schema_identity VALUES (1,?,?,?)")
    .run(CURRENT_SCHEMA.name, TASK_RELAY_SCHEMA_FINGERPRINT, "2026-07-24T00:00:00.000Z")
  legacy.close()

  const migration = Bun.spawn(
    [
      Bun.which("bun") ?? "bun",
      "scripts/migrate-task-annotations.ts",
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
    expect(
      migrated.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM task_relays").get()
        ?.count,
    ).toBe(0)
    expect(
      migrated.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM task_annotations").get()
        ?.count,
    ).toBe(0)
  } finally {
    migrated.close()
  }
})

function taskRelaySchemaStatements(): readonly string[] {
  const annotationObjects = new Set([
    "task_annotations",
    "task_annotations_project_task_idx",
    "task_annotation_resolutions",
    "task_annotation_resolutions_resolver_idx",
    "external_identities",
    "external_identities_principal_idx",
    "identity_credentials",
    "identity_credentials_active_identity_idx",
    "external_project_grants",
    "external_project_grants_principal_idx",
    "project_repository_bindings",
    "project_repository_bindings_active_project_idx",
    "project_repository_bindings_repository_idx",
    "agent_connections",
    "agent_connections_active_agent_idx",
    "agent_connections_principal_idx",
    "project_selections",
    "project_selections_principal_idx",
    "presence_leases",
    "presence_leases_project_expiry_idx",
    "principal_invitations",
    "principal_invitations_prefix_idx",
    "principal_invitations_principal_idx",
  ])
  return splitSchemaSql(SCHEMA_SQL).filter((statement) => {
    const match = /^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+([a-z0-9_]+)/i.exec(statement)
    return match === null || !annotationObjects.has(match[1] as string)
  })
}
