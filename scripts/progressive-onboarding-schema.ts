import type { Database } from "bun:sqlite"
import { SCHEMA_SQL, splitSchemaSql } from "../src/persistence/schema"

export const GITHUB_APP_SCHEMA_FINGERPRINT =
  "14458dde5db0183cd1785aea3c03fb18d9415237c9337bd95a5f5bf33e8fbdb6"

/** The exact schema immediately before progressive GitHub OAuth onboarding. */
export function githubAppSchemaStatements(): readonly string[] {
  const accountName = "account_name TEXT NOT NULL CHECK(length(account_name) BETWEEN 1 AND 255),"
  const schema = SCHEMA_SQL.replace(
    "access_expires_at TEXT,",
    "access_expires_at TEXT NOT NULL,",
  ).replaceAll(
    `${accountName}\n        repository_id`,
    `${accountName}\n        installation_id TEXT NOT NULL CHECK(length(installation_id) BETWEEN 1 AND 255),\n        repository_id`,
  )
  return splitSchemaSql(schema)
}

/**
 * Rebuilds the three GitHub App-shaped tables into the provider-neutral OAuth
 * shape. The caller owns one transaction with foreign keys disabled.
 */
export function migrateProgressiveOnboardingSchema(database: Database): void {
  for (const index of [
    "project_repository_bindings_repository_idx",
    "project_repository_bindings_repository_identity_idx",
    "project_repository_bindings_active_project_idx",
    "external_project_grants_principal_idx",
    "identity_credentials_active_identity_idx",
  ]) {
    database.query(`DROP INDEX ${index}`).run()
  }
  database
    .query("ALTER TABLE project_repository_bindings RENAME TO project_repository_bindings_legacy")
    .run()
  database
    .query("ALTER TABLE external_project_grants RENAME TO external_project_grants_legacy")
    .run()
  database.query("ALTER TABLE identity_credentials RENAME TO identity_credentials_legacy").run()

  for (const statement of progressiveSchemaStatements()) database.query(statement).run()

  database
    .query(`
      INSERT INTO identity_credentials(
        id,owner_id,principal_id,external_identity_id,provider,sealed_payload,key_version,
        access_expires_at,refresh_expires_at,created_at,updated_at,revoked_at
      )
      SELECT id,owner_id,principal_id,external_identity_id,provider,sealed_payload,key_version,
        access_expires_at,refresh_expires_at,created_at,updated_at,revoked_at
      FROM identity_credentials_legacy
    `)
    .run()
  database
    .query(`
      INSERT INTO external_project_grants(
        id,owner_id,principal_id,external_identity_id,provider,account_id,account_name,
        repository_id,repository_name,repository_full_name,repository_url,private,access,
        observed_at,expires_at,revoked_at
      )
      SELECT id,owner_id,principal_id,external_identity_id,provider,account_id,account_name,
        repository_id,repository_name,repository_full_name,repository_url,private,access,
        observed_at,expires_at,revoked_at
      FROM external_project_grants_legacy
    `)
    .run()
  database
    .query(`
      INSERT INTO project_repository_bindings(
        id,owner_id,project_id,grant_id,provider,account_id,account_name,repository_id,
        repository_name,repository_full_name,repository_url,private,bound_by_principal_id,
        created_at,revoked_at
      )
      SELECT id,owner_id,project_id,grant_id,provider,account_id,account_name,repository_id,
        repository_name,repository_full_name,repository_url,private,bound_by_principal_id,
        created_at,revoked_at
      FROM project_repository_bindings_legacy
    `)
    .run()

  database.query("DROP TABLE project_repository_bindings_legacy").run()
  database.query("DROP TABLE external_project_grants_legacy").run()
  database.query("DROP TABLE identity_credentials_legacy").run()
}

function progressiveSchemaStatements(): readonly string[] {
  const ownedObjects = new Set([
    "identity_credentials",
    "identity_credentials_active_identity_idx",
    "external_project_grants",
    "external_project_grants_principal_idx",
    "project_repository_bindings",
    "project_repository_bindings_active_project_idx",
    "project_repository_bindings_repository_identity_idx",
    "project_repository_bindings_repository_idx",
  ])
  return splitSchemaSql(SCHEMA_SQL).filter((statement) => {
    const match = /^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+([a-z0-9_]+)/i.exec(statement)
    return match !== null && ownedObjects.has(match[1] as string)
  })
}
