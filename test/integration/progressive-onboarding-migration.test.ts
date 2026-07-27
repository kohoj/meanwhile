import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  GITHUB_APP_SCHEMA_FINGERPRINT,
  githubAppSchemaStatements,
} from "../../scripts/progressive-onboarding-schema"
import { CURRENT_SCHEMA, databaseSchemaFingerprint } from "../../src/persistence/schema"

const timestamp = "2026-07-27T00:00:00.000Z"
let temporary: string | null = null

afterEach(async () => {
  if (temporary !== null) await rm(temporary, { recursive: true, force: true })
  temporary = null
})

test("the exact progressive-onboarding migration preserves OAuth authority without App installation state", async () => {
  temporary = await mkdtemp(join(tmpdir(), "meanwhile-progressive-onboarding-"))
  const path = join(temporary, "meanwhile.sqlite")
  const legacy = new Database(path, { strict: true })
  for (const statement of githubAppSchemaStatements()) legacy.query(statement).run()
  expect(databaseSchemaFingerprint(legacy)).toBe(GITHUB_APP_SCHEMA_FINGERPRINT)
  legacy
    .query("INSERT INTO schema_identity VALUES (1,?,?,?)")
    .run(CURRENT_SCHEMA.name, GITHUB_APP_SCHEMA_FINGERPRINT, timestamp)
  legacy.query("INSERT INTO owners VALUES (?,?,?)").run("owner", "Owner", timestamp)
  legacy
    .query("INSERT INTO principals VALUES (?,?,?,?,?,?,NULL)")
    .run("principal", "owner", "person", "Alice", "admin", timestamp)
  legacy
    .query("INSERT INTO projects VALUES (?,?,?,?,?,NULL)")
    .run("project", "owner", "Northstar", "northstar", timestamp)
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
      timestamp,
      timestamp,
    )
  legacy
    .query("INSERT INTO identity_credentials VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)")
    .run(
      "credential",
      "owner",
      "principal",
      "identity",
      "github",
      "sealed",
      "v1",
      "2026-07-28T00:00:00.000Z",
      "2027-01-01T00:00:00.000Z",
      timestamp,
      timestamp,
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
      timestamp,
      "2026-07-28T00:00:00.000Z",
    )
  legacy
    .query("INSERT INTO project_repository_bindings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)")
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
      timestamp,
    )
  legacy.close()

  const migration = Bun.spawn(
    [
      Bun.which("bun") ?? "bun",
      "scripts/migrate-progressive-onboarding.ts",
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
        .query<{ repository_id: string }, []>(
          "SELECT repository_id FROM external_project_grants WHERE id='grant'",
        )
        .get(),
    ).toEqual({ repository_id: "repository" })
    expect(
      migrated
        .query<{ repository_id: string }, []>(
          "SELECT repository_id FROM project_repository_bindings WHERE id='binding'",
        )
        .get(),
    ).toEqual({ repository_id: "repository" })
  } finally {
    migrated.close()
  }
})
