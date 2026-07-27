import { Database } from "bun:sqlite"
import { resolve } from "node:path"
import {
  CURRENT_SCHEMA,
  databaseSchemaFingerprint,
  SCHEMA_SQL,
  splitSchemaSql,
} from "../src/persistence/schema"

const PREVIOUS_SCHEMA_FINGERPRINT =
  "cbc6cdc49475a836ac05c63bbfa4505260eec0f3d07218f18002ef643269ddfc"

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
    throw new Error("Database is not the exact supported pre-repository-identity schema")
  }
  const duplicateRepositories = database
    .query<{ owner_id: string; provider: string; repository_id: string; count: number }, []>(`
      SELECT owner_id,provider,repository_id,COUNT(*) AS count
      FROM project_repository_bindings
      GROUP BY owner_id,provider,repository_id
      HAVING COUNT(*) > 1
      ORDER BY owner_id,provider,repository_id
    `)
    .all()
  const reboundProjects = database
    .query<{ owner_id: string; project_id: string; count: number }, []>(`
      SELECT owner_id,project_id,COUNT(*) AS count
      FROM project_repository_bindings
      GROUP BY owner_id,project_id
      HAVING COUNT(*) > 1
      ORDER BY owner_id,project_id
    `)
    .all()
  if (duplicateRepositories.length > 0 || reboundProjects.length > 0) {
    throw new Error(
      `Repository identity migration found ambiguous Project bindings; resolve them before retrying: ${JSON.stringify({ duplicateRepositories, reboundProjects })}`,
    )
  }
  const revokedBindings =
    database
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM project_repository_bindings WHERE revoked_at IS NOT NULL",
      )
      .get()?.count ?? 0
  if (!write) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          database: path,
          from: identity,
          to: CURRENT_SCHEMA,
          bindings: count(database, "project_repository_bindings"),
          bindingsToReactivate: revokedBindings,
        },
        null,
        2,
      ),
    )
    process.exit(0)
  }
  database
    .transaction(() => {
      database.query("UPDATE project_repository_bindings SET revoked_at=NULL").run()
      const statement = splitSchemaSql(SCHEMA_SQL).find((candidate) =>
        candidate.includes("project_repository_bindings_repository_identity_idx"),
      )
      if (statement === undefined) throw new Error("Current repository identity index is missing")
      database.query(statement).run()
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
    JSON.stringify({ mode: "write", database: path, from: identity, to: CURRENT_SCHEMA }, null, 2),
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
