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

const PREVIOUS_SCHEMA_FINGERPRINT =
  "cbc6cdc49475a836ac05c63bbfa4505260eec0f3d07218f18002ef643269ddfc"
let temporary: string | null = null

afterEach(async () => {
  if (temporary !== null) await rm(temporary, { recursive: true, force: true })
  temporary = null
})

test("the exact migration adds owner-scoped one-repository-one-Project identity", async () => {
  temporary = await mkdtemp(join(tmpdir(), "meanwhile-project-repository-identity-"))
  const path = join(temporary, "meanwhile.sqlite")
  const legacy = new Database(path, { strict: true })
  for (const statement of previousSchemaStatements()) legacy.query(statement).run()
  expect(databaseSchemaFingerprint(legacy)).toBe(PREVIOUS_SCHEMA_FINGERPRINT)
  legacy
    .query("INSERT INTO schema_identity VALUES (1,?,?,?)")
    .run(CURRENT_SCHEMA.name, PREVIOUS_SCHEMA_FINGERPRINT, "2026-07-27T00:00:00.000Z")
  legacy
    .query("INSERT INTO owners VALUES (?,?,?)")
    .run("owner", "Owner", "2026-07-27T00:00:00.000Z")
  legacy
    .query("INSERT INTO principals VALUES (?,?,?,?,?,?,NULL)")
    .run("principal", "owner", "person", "Alice", "admin", "2026-07-27T00:00:00.000Z")
  legacy
    .query("INSERT INTO projects VALUES (?,?,?,?,?,NULL)")
    .run("project", "owner", "Northstar", "northstar", "2026-07-27T00:00:00.000Z")
  legacy
    .query("INSERT INTO external_identities VALUES (?,?,?,?,?,?,?,?,?,?,NULL)")
    .run(
      "identity",
      "owner",
      "principal",
      "github",
      "github-alice",
      "alice",
      "Alice",
      null,
      "2026-07-27T00:00:00.000Z",
      "2026-07-27T00:00:00.000Z",
    )
  legacy
    .query("INSERT INTO external_project_grants VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)")
    .run(
      "grant",
      "owner",
      "principal",
      "identity",
      "github",
      "account",
      "Acme",
      "installation",
      "repository",
      "northstar",
      "acme/northstar",
      "https://github.com/acme/northstar",
      1,
      "administer",
      "2026-07-27T00:00:00.000Z",
      "2026-07-28T00:00:00.000Z",
    )
  legacy
    .query("INSERT INTO project_repository_bindings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      "binding",
      "owner",
      "project",
      "grant",
      "github",
      "account",
      "Acme",
      "installation",
      "repository",
      "northstar",
      "acme/northstar",
      "https://github.com/acme/northstar",
      1,
      "principal",
      "2026-07-27T00:00:00.000Z",
      "2026-07-27T01:00:00.000Z",
    )
  legacy.close()

  const migration = Bun.spawn(
    [
      Bun.which("bun") ?? "bun",
      "scripts/migrate-project-repository-identity.ts",
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
    expect(
      migrated
        .query<{ revoked_at: string | null }, []>(
          "SELECT revoked_at FROM project_repository_bindings WHERE id='binding'",
        )
        .get()?.revoked_at,
    ).toBeNull()
    expect(
      migrated
        .query<{ name: string; unique: number }, []>(
          "PRAGMA index_list('project_repository_bindings')",
        )
        .all()
        .some(
          (index) =>
            index.name === "project_repository_bindings_repository_identity_idx" &&
            index.unique === 1,
        ),
    ).toBeTrue()
  } finally {
    migrated.close()
  }
})

function previousSchemaStatements(): readonly string[] {
  return splitSchemaSql(SCHEMA_SQL).filter(
    (statement) => !statement.includes("project_repository_bindings_repository_identity_idx"),
  )
}
