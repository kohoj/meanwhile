import { Database } from "bun:sqlite"
import { resolve } from "node:path"
import { CURRENT_SCHEMA, databaseSchemaFingerprint } from "../src/persistence/schema"
import { migrateConversationMirrorSchema } from "./conversation-mirror-schema"
import { migrateProgressiveOnboardingSchema } from "./progressive-onboarding-schema"

const PREVIOUS_SCHEMA_FINGERPRINT =
  "9056b0fc858c413261d1c5e84c435fcaa8f9052982bb21bb75490a9e993966fb"

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
    identity.fingerprint !== PREVIOUS_SCHEMA_FINGERPRINT ||
    databaseSchemaFingerprint(database) !== PREVIOUS_SCHEMA_FINGERPRINT
  ) {
    throw new Error("Database is not the exact supported pre-Mirror schema; no changes were made")
  }

  const summary = {
    relays: count(database, "task_relays"),
    annotations: count(database, "task_annotations"),
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
      migrateConversationMirrorSchema(database)
      migrateProgressiveOnboardingSchema(database)
      database
        .query("UPDATE schema_identity SET fingerprint=? WHERE singleton=1")
        .run(CURRENT_SCHEMA.fingerprint)
    })
    .immediate()
  database.exec("PRAGMA foreign_keys=ON")

  const foreignKeyViolations = database
    .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
    .all()
  const migratedFingerprint = databaseSchemaFingerprint(database)
  if (foreignKeyViolations.length > 0 || migratedFingerprint !== CURRENT_SCHEMA.fingerprint) {
    throw new Error(
      `Migration completed but verification failed; restore the pre-migration backup ` +
        `(foreignKeys=${JSON.stringify(foreignKeyViolations)}, ` +
        `fingerprint=${migratedFingerprint}, expected=${CURRENT_SCHEMA.fingerprint})`,
    )
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
