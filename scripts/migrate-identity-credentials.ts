import { Database } from "bun:sqlite"
import { resolve } from "node:path"
import {
  CURRENT_SCHEMA,
  databaseSchemaFingerprint,
  SCHEMA_SQL,
  splitSchemaSql,
} from "../src/persistence/schema"

const PRESENCE_SCHEMA_FINGERPRINT =
  "252a462353f4fb13a98f07307d255accf99e9d6d33b35d92254664e4ece1a16e"

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
    identity.fingerprint !== PRESENCE_SCHEMA_FINGERPRINT ||
    databaseSchemaFingerprint(database) !== PRESENCE_SCHEMA_FINGERPRINT
  ) {
    throw new Error("Database is not the exact supported Presence schema; no changes were made")
  }

  const summary = {
    principals: count(database, "principals"),
    identities: count(database, "external_identities"),
  }
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
      for (const statement of identityCredentialSchemaStatements()) {
        database.query(statement).run()
      }
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

function identityCredentialSchemaStatements(): readonly string[] {
  const ownedObjects = new Set([
    "identity_credentials",
    "identity_credentials_active_identity_idx",
    "principal_invitations",
    "principal_invitations_prefix_idx",
    "principal_invitations_principal_idx",
  ])
  return splitSchemaSql(SCHEMA_SQL).filter((statement) => {
    const match = /^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+([a-z0-9_]+)/i.exec(statement)
    return match !== null && ownedObjects.has(match[1] as string)
  })
}
