import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { preConversationMirrorSchemaStatements } from "../../scripts/conversation-mirror-schema"
import { CURRENT_SCHEMA, databaseSchemaFingerprint } from "../../src/persistence/schema"

const PRE_MIRROR_SCHEMA_FINGERPRINT =
  "9056b0fc858c413261d1c5e84c435fcaa8f9052982bb21bb75490a9e993966fb"
let temporary: string | null = null

afterEach(async () => {
  if (temporary !== null) await rm(temporary, { recursive: true, force: true })
  temporary = null
})

test("the exact pre-Mirror migration preserves Relays and Annotations", async () => {
  temporary = await mkdtemp(join(tmpdir(), "meanwhile-mirror-migration-"))
  const path = join(temporary, "meanwhile.sqlite")
  const legacy = new Database(path, { strict: true })
  for (const statement of preConversationMirrorSchemaStatements()) legacy.query(statement).run()
  expect(databaseSchemaFingerprint(legacy)).toBe(PRE_MIRROR_SCHEMA_FINGERPRINT)
  legacy
    .query("INSERT INTO schema_identity VALUES (1,?,?,?)")
    .run(CURRENT_SCHEMA.name, PRE_MIRROR_SCHEMA_FINGERPRINT, "2026-07-27T00:00:00.000Z")
  insertLegacyCollaborationFixture(legacy)
  legacy.close()

  const migration = Bun.spawn(
    [
      Bun.which("bun") ?? "bun",
      "scripts/migrate-conversation-mirrors.ts",
      `--database=${path}`,
      "--write",
    ],
    { cwd: resolve("."), stdout: "pipe", stderr: "pipe" },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    migration.exited,
    new Response(migration.stdout).text(),
    new Response(migration.stderr).text(),
  ])
  expect(stderr).toBe("")
  expect(exitCode).toBe(0)
  expect(stdout).toContain('"mode": "write"')

  const migrated = new Database(path, { strict: true, readonly: true })
  try {
    expect(databaseSchemaFingerprint(migrated)).toBe(CURRENT_SCHEMA.fingerprint)
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([])
    expect(
      migrated
        .query<{ run_id: string | null; session_id: string | null; mirror_id: string | null }, []>(
          "SELECT run_id,session_id,mirror_id FROM task_relays WHERE id='relay-1'",
        )
        .get(),
    ).toEqual({ run_id: "run-1", session_id: null, mirror_id: null })
    expect(
      migrated
        .query<{ run_id: string | null; session_id: string | null; mirror_id: string | null }, []>(
          "SELECT run_id,session_id,mirror_id FROM task_annotations WHERE id='annotation-1'",
        )
        .get(),
    ).toEqual({ run_id: "run-1", session_id: null, mirror_id: null })
    expect(
      migrated.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM connector_devices").get()
        ?.count,
    ).toBe(0)
  } finally {
    migrated.close()
  }
})

function insertLegacyCollaborationFixture(database: Database): void {
  const createdAt = "2026-07-27T00:00:00.000Z"
  database.query("INSERT INTO owners VALUES (?,?,?)").run("owner-1", "Owner", createdAt)
  database
    .query("INSERT INTO principals VALUES (?,?,?,?,?,?,?)")
    .run("principal-1", "owner-1", "person", "Alice", "admin", createdAt, null)
  database
    .query("INSERT INTO projects VALUES (?,?,?,?,?,?)")
    .run("project-1", "owner-1", "Project", "project", createdAt, null)
  database
    .query("INSERT INTO project_memberships VALUES (?,?,?,?,?,?)")
    .run("owner-1", "project-1", "principal-1", "maintainer", createdAt, null)
  database.exec(`
    INSERT INTO runs VALUES (
      'run-1','owner-1','{}','fixture','{}','${"0".repeat(64)}','{}','Prompt','{}','{}',
      'local','[]','[]',1000,NULL,'queued',1,NULL,NULL,NULL,'${createdAt}',NULL,NULL,
      '${createdAt}',NULL,NULL
    );
    INSERT INTO run_project_bindings VALUES (
      'run-1','owner-1','project-1','principal-1','Alice','person','${createdAt}'
    );
    INSERT INTO task_relays VALUES (
      'relay-1','owner-1','project-1','run-1',NULL,0,
      'principal-1','Alice','person','principal-1','Alice','person','Relay','${createdAt}'
    );
    INSERT INTO task_annotations VALUES (
      'annotation-1','owner-1','project-1','run-1',NULL,0,'message-1',0,4,'Text','','',
      '${"2".repeat(64)}','principal-1','Alice','person','Note','${createdAt}'
    );
  `)
}
