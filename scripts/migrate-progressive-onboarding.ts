import { Database } from "bun:sqlite"
import { resolve } from "node:path"
import { CURRENT_SCHEMA, databaseSchemaFingerprint } from "../src/persistence/schema"
import {
  GITHUB_APP_SCHEMA_FINGERPRINT,
  migrateProgressiveOnboardingSchema,
} from "./progressive-onboarding-schema"

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
    identity.fingerprint !== GITHUB_APP_SCHEMA_FINGERPRINT ||
    databaseSchemaFingerprint(database) !== GITHUB_APP_SCHEMA_FINGERPRINT
  ) {
    throw new Error(
      "Database is not the exact supported GitHub App onboarding schema; no changes were made",
    )
  }

  const summary = {
    identityCredentials: count(database, "identity_credentials"),
    repositoryGrants: count(database, "external_project_grants"),
    repositoryBindings: count(database, "project_repository_bindings"),
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

  database.exec("PRAGMA foreign_keys=OFF")
  database
    .transaction(() => {
      migrateProgressiveOnboardingSchema(database)
      database
        .query("UPDATE schema_identity SET fingerprint=? WHERE singleton=1")
        .run(CURRENT_SCHEMA.fingerprint)
    })
    .immediate()
  database.exec("PRAGMA foreign_keys=ON")

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
