import { Database } from "bun:sqlite"
import { resolve } from "node:path"
import {
  CURRENT_SCHEMA,
  databaseSchemaFingerprint,
  SCHEMA_SQL,
  splitSchemaSql,
} from "../src/persistence/schema"

const IDENTITY_CREDENTIAL_SCHEMA_FINGERPRINT =
  "3b505e0f61a2ae2e7f142c6b5f237566b3c66a5ec9c36b5c6eff3e75cc55d686"

const arguments_ = process.argv.slice(2)
const databaseArgument = arguments_.find((value) => value.startsWith("--database="))?.slice(11)
const write = arguments_.includes("--write")
if (databaseArgument === undefined || databaseArgument.length === 0) {
  throw new Error("Expected --database=/absolute/path/to/meanwhile.sqlite")
}

const path = resolve(databaseArgument)
const database = new Database(path, { strict: true })

try {
  database.exec("PRAGMA busy_timeout=5000")
  const identity = database
    .query<{ name: string; fingerprint: string }, []>(
      "SELECT name,fingerprint FROM schema_identity WHERE singleton=1",
    )
    .get()
  if (
    identity?.name !== CURRENT_SCHEMA.name ||
    identity.fingerprint !== IDENTITY_CREDENTIAL_SCHEMA_FINGERPRINT ||
    databaseSchemaFingerprint(database) !== IDENTITY_CREDENTIAL_SCHEMA_FINGERPRINT
  ) {
    throw new Error(
      "Database is not the exact supported Identity Credential schema; no changes were made",
    )
  }

  const summary = { principals: count(database, "principals") }
  if (!write) {
    console.log(
      JSON.stringify(
        { mode: "dry-run", database: path, from: identity, to: CURRENT_SCHEMA, summary },
        null,
        2,
      ),
    )
    process.exit(0)
  }

  database
    .transaction(() => {
      for (const statement of principalInvitationSchemaStatements()) database.query(statement).run()
      database
        .query("UPDATE schema_identity SET fingerprint=? WHERE singleton=1")
        .run(CURRENT_SCHEMA.fingerprint)
    })
    .immediate()

  if (
    database.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all().length > 0 ||
    databaseSchemaFingerprint(database) !== CURRENT_SCHEMA.fingerprint
  ) {
    throw new Error("Migration completed but verification failed; restore the pre-migration backup")
  }
  console.log(
    JSON.stringify(
      { mode: "write", database: path, from: identity, to: CURRENT_SCHEMA, summary },
      null,
      2,
    ),
  )
} finally {
  database.close()
}

function count(database: Database, table: string): number {
  return (
    database.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ??
    0
  )
}

function principalInvitationSchemaStatements(): readonly string[] {
  const ownedObjects = new Set([
    "principal_invitations",
    "principal_invitations_prefix_idx",
    "principal_invitations_principal_idx",
  ])
  return splitSchemaSql(SCHEMA_SQL).filter((statement) => {
    const match = /^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+([a-z0-9_]+)/i.exec(statement)
    return match !== null && ownedObjects.has(match[1] as string)
  })
}
