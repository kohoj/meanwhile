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

const CONNECTED_ONBOARDING_SCHEMA_FINGERPRINT =
  "2efd73c952ba0134f08c63b2baba111245f3a798b6765a30e8b60c7dacb0f53b"
let temporary: string | null = null

afterEach(async () => {
  if (temporary !== null) await rm(temporary, { recursive: true, force: true })
  temporary = null
})

test("the exact Connected Onboarding migration adds empty expiring presence state", async () => {
  temporary = await mkdtemp(join(tmpdir(), "meanwhile-presence-migration-"))
  const path = join(temporary, "meanwhile.sqlite")
  const legacy = new Database(path, { strict: true })
  for (const statement of connectedOnboardingSchemaStatements()) legacy.query(statement).run()
  expect(databaseSchemaFingerprint(legacy)).toBe(CONNECTED_ONBOARDING_SCHEMA_FINGERPRINT)
  legacy
    .query("INSERT INTO schema_identity VALUES (1,?,?,?)")
    .run(CURRENT_SCHEMA.name, CONNECTED_ONBOARDING_SCHEMA_FINGERPRINT, "2026-07-24T00:00:00.000Z")
  legacy.close()

  const migration = Bun.spawn(
    [
      Bun.which("bun") ?? "bun",
      "scripts/migrate-presence-leases.ts",
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
      migrated.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM presence_leases").get()
        ?.count,
    ).toBe(0)
    expect(
      migrated
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM identity_credentials")
        .get()?.count,
    ).toBe(0)
  } finally {
    migrated.close()
  }
})

function connectedOnboardingSchemaStatements(): readonly string[] {
  const presenceObjects = new Set([
    "presence_leases",
    "presence_leases_project_expiry_idx",
    "identity_credentials",
    "identity_credentials_active_identity_idx",
    "principal_invitations",
    "principal_invitations_prefix_idx",
    "principal_invitations_principal_idx",
  ])
  return splitSchemaSql(SCHEMA_SQL).filter((statement) => {
    const match = /^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+([a-z0-9_]+)/i.exec(statement)
    return match === null || !presenceObjects.has(match[1] as string)
  })
}
