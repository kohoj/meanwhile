import { Database } from "bun:sqlite"
import { resolve } from "node:path"
import {
  CURRENT_SCHEMA,
  databaseSchemaFingerprint,
  SCHEMA_SQL,
  splitSchemaSql,
} from "../src/persistence/schema"

const PROJECT_WATCH_SCHEMA_FINGERPRINT =
  "c2defba13120fe341f211a6d56d6abfe4df5ccf91f499959761951be6c79d4f8"

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
    identity.fingerprint !== PROJECT_WATCH_SCHEMA_FINGERPRINT ||
    databaseSchemaFingerprint(database) !== PROJECT_WATCH_SCHEMA_FINGERPRINT
  ) {
    throw new Error(
      "Database is not the exact supported Project Watch schema; no changes were made",
    )
  }

  const summary = {
    projects: count(database, "projects"),
    runs: count(database, "runs"),
    sessions: count(database, "agent_sessions"),
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
      for (const statement of taskRelaySchemaStatements()) database.query(statement).run()
      database
        .query("UPDATE schema_identity SET fingerprint=? WHERE singleton=1")
        .run(CURRENT_SCHEMA.fingerprint)
    })
    .immediate()

  const foreignKeyFailures = database
    .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
    .all()
  if (
    foreignKeyFailures.length > 0 ||
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

function taskRelaySchemaStatements(): readonly string[] {
  const ownedObjects = new Set([
    "task_relays",
    "task_relays_project_task_idx",
    "task_relays_recipient_idx",
    "task_relay_acknowledgements",
    "task_relay_acknowledgements_principal_idx",
    "task_annotations",
    "task_annotations_project_task_idx",
    "task_annotation_resolutions",
    "task_annotation_resolutions_resolver_idx",
    "external_identities",
    "external_identities_principal_idx",
    "identity_credentials",
    "identity_credentials_active_identity_idx",
    "external_project_grants",
    "external_project_grants_principal_idx",
    "project_repository_bindings",
    "project_repository_bindings_active_project_idx",
    "project_repository_bindings_repository_idx",
    "agent_connections",
    "agent_connections_active_agent_idx",
    "agent_connections_principal_idx",
    "project_selections",
    "project_selections_principal_idx",
    "presence_leases",
    "presence_leases_project_expiry_idx",
    "principal_invitations",
    "principal_invitations_prefix_idx",
    "principal_invitations_principal_idx",
  ])
  return splitSchemaSql(SCHEMA_SQL).filter((statement) => {
    const match = /^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+([a-z0-9_]+)/i.exec(statement)
    return match !== null && ownedObjects.has(match[1] as string)
  })
}
