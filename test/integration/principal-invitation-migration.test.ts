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

const IDENTITY_CREDENTIAL_SCHEMA_FINGERPRINT =
  "3b505e0f61a2ae2e7f142c6b5f237566b3c66a5ec9c36b5c6eff3e75cc55d686"
let temporary: string | null = null

afterEach(async () => {
  if (temporary !== null) await rm(temporary, { recursive: true, force: true })
  temporary = null
})

test("the exact Identity Credential migration adds empty Principal invitation state", async () => {
  temporary = await mkdtemp(join(tmpdir(), "meanwhile-principal-invitation-migration-"))
  const path = join(temporary, "meanwhile.sqlite")
  const legacy = new Database(path, { strict: true })
  for (const statement of identityCredentialSchemaStatements()) legacy.query(statement).run()
  expect(databaseSchemaFingerprint(legacy)).toBe(IDENTITY_CREDENTIAL_SCHEMA_FINGERPRINT)
  legacy
    .query("INSERT INTO schema_identity VALUES (1,?,?,?)")
    .run(CURRENT_SCHEMA.name, IDENTITY_CREDENTIAL_SCHEMA_FINGERPRINT, "2026-07-24T00:00:00.000Z")
  legacy.close()

  const migration = Bun.spawn(
    [
      Bun.which("bun") ?? "bun",
      "scripts/migrate-principal-invitations.ts",
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
      migrated
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM principal_invitations")
        .get()?.count,
    ).toBe(0)
  } finally {
    migrated.close()
  }
})

function identityCredentialSchemaStatements(): readonly string[] {
  const invitationObjects = new Set([
    "principal_invitations",
    "principal_invitations_prefix_idx",
    "principal_invitations_principal_idx",
  ])
  return splitSchemaSql(SCHEMA_SQL).filter((statement) => {
    const match = /^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+([a-z0-9_]+)/i.exec(statement)
    return match === null || !invitationObjects.has(match[1] as string)
  })
}
