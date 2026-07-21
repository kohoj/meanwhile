import { Database } from "bun:sqlite"
import { resolve } from "node:path"
import {
  CURRENT_SCHEMA,
  databaseSchemaFingerprint,
  SCHEMA_SQL,
  splitSchemaSql,
} from "../src/persistence/schema"

const LEGACY_SCHEMA_FINGERPRINT = "a7ee3aed4ff1cd19095d4c1aa2c4da0fdd5b25ab88fbcc4363b0f9255883b911"

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
    identity.fingerprint !== LEGACY_SCHEMA_FINGERPRINT ||
    databaseSchemaFingerprint(database) !== LEGACY_SCHEMA_FINGERPRINT
  ) {
    throw new Error("Database is not the exact supported v0.1.3 schema; no changes were made")
  }

  const counts = {
    owners: count(database, "owners"),
    apiKeys: count(database, "api_keys"),
    runs: count(database, "runs"),
    sessions: count(database, "agent_sessions"),
  }
  if (!write) {
    console.log(
      JSON.stringify(
        { mode: "dry-run", database: path, from: identity, to: CURRENT_SCHEMA, counts },
        null,
        2,
      ),
    )
    process.exit(0)
  }

  database.exec("PRAGMA foreign_keys=OFF")
  database
    .transaction(() => {
      for (const statement of collaborationSchemaStatements()) database.query(statement).run()
      const owners = database
        .query<{ id: string; name: string; created_at: string }, []>(
          "SELECT id,name,created_at FROM owners ORDER BY created_at,id",
        )
        .all()
      for (const owner of owners) {
        const principalId = crypto.randomUUID()
        const projectId = crypto.randomUUID()
        database
          .query(`
            INSERT INTO principals(id,owner_id,kind,display_name,owner_role,created_at)
            VALUES (?,?,'person',?,'admin',?)
          `)
          .run(principalId, owner.id, owner.name, owner.created_at)
        database
          .query(`
            INSERT INTO projects(id,owner_id,name,slug,created_at)
            VALUES (?,?,'Default Project','default',?)
          `)
          .run(projectId, owner.id, owner.created_at)
        database
          .query(`
            INSERT INTO project_memberships(
              owner_id,project_id,principal_id,role,joined_at,removed_at
            ) VALUES (?,?,?,'maintainer',?,NULL)
          `)
          .run(owner.id, projectId, principalId, owner.created_at)
        database
          .query(`
            INSERT INTO api_key_principals(api_key_id,owner_id,principal_id,created_at)
            SELECT id,owner_id,?,created_at FROM api_keys WHERE owner_id=?
          `)
          .run(principalId, owner.id)
        database
          .query(`
            INSERT INTO run_project_bindings(
              run_id,owner_id,project_id,delegated_by_principal_id,
              delegated_by_name,delegated_by_kind,created_at
            ) SELECT id,owner_id,?,?,?,'person',created_at FROM runs WHERE owner_id=?
          `)
          .run(projectId, principalId, owner.name, owner.id)
        database
          .query(`
            INSERT INTO session_project_bindings(
              session_id,owner_id,project_id,delegated_by_principal_id,
              delegated_by_name,delegated_by_kind,created_at
            ) SELECT id,owner_id,?,?,?,'person',created_at
              FROM agent_sessions WHERE owner_id=?
          `)
          .run(projectId, principalId, owner.name, owner.id)
      }

      rebuildIdempotencyTable(database, "run")
      rebuildIdempotencyTable(database, "session")
      rebuildIdempotencyTable(database, "deployment")
      database
        .query("UPDATE schema_identity SET fingerprint=? WHERE singleton=1")
        .run(CURRENT_SCHEMA.fingerprint)
    })
    .immediate()
  database.exec("PRAGMA foreign_keys=ON")

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
      { mode: "write", database: path, from: identity, to: CURRENT_SCHEMA, counts },
      null,
      2,
    ),
  )
} finally {
  database.close()
}

function count(database: Database, table: string): number {
  const row = database.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()
  return row?.count ?? 0
}

function collaborationSchemaStatements(): readonly string[] {
  const ownedObjects = new Set([
    "principals",
    "principals_owner_idx",
    "projects",
    "projects_owner_idx",
    "project_memberships",
    "project_memberships_principal_idx",
    "api_key_principals",
    "api_key_principals_principal_idx",
    "browser_sessions",
    "browser_sessions_prefix_idx",
    "run_project_bindings",
    "run_project_bindings_project_idx",
    "session_project_bindings",
    "session_project_bindings_project_idx",
  ])
  return splitSchemaSql(SCHEMA_SQL).filter((statement) => {
    const match = /^CREATE\s+(?:TABLE|INDEX)\s+([a-z0-9_]+)/i.exec(statement)
    return match !== null && ownedObjects.has(match[1] as string)
  })
}

function rebuildIdempotencyTable(database: Database, kind: "run" | "session" | "deployment"): void {
  const table = `${kind}_idempotency_keys`
  const resourceColumn = `${kind}_id`
  database.query(`ALTER TABLE ${table} RENAME TO ${table}_legacy`).run()
  const statement = splitSchemaSql(SCHEMA_SQL).find((candidate) =>
    new RegExp(`^CREATE\\s+TABLE\\s+${table}\\b`, "i").test(candidate),
  )
  if (statement === undefined) throw new Error(`Current schema is missing ${table}`)
  database.query(statement).run()
  database
    .query(`
      INSERT INTO ${table}(owner_id,principal_id,key,request_hash,${resourceColumn},created_at)
      SELECT legacy.owner_id,principal.id,legacy.key,legacy.request_hash,
        legacy.${resourceColumn},legacy.created_at
      FROM ${table}_legacy legacy
      JOIN principals principal ON principal.owner_id=legacy.owner_id
        AND principal.owner_role='admin'
    `)
    .run()
  database.query(`DROP TABLE ${table}_legacy`).run()
}
