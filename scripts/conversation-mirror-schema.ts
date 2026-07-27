import type { Database } from "bun:sqlite"
import { githubAppSchemaStatements } from "./progressive-onboarding-schema"

const MIRROR_OBJECTS = new Set([
  "connector_devices",
  "connector_devices_principal_idx",
  "conversation_share_grants",
  "conversation_share_grants_active_idx",
  "conversation_mirrors",
  "conversation_mirrors_project_idx",
  "mirror_events",
  "mirror_events_owner_mirror_idx",
  "project_repository_bindings_repository_identity_idx",
])

/** The exact schema immediately before ConversationMirror was introduced. */
export function preConversationMirrorSchemaStatements(): readonly string[] {
  return githubAppSchemaStatements().flatMap((statement) => {
    const name = schemaObjectName(statement)
    if (name !== null && MIRROR_OBJECTS.has(name)) return []
    if (name === "task_relays") return [withoutMirrorReference(statement)]
    if (name === "task_relays_project_task_idx") {
      return [
        "CREATE INDEX task_relays_project_task_idx\n        ON task_relays(owner_id, project_id, run_id, session_id, anchor_sequence, created_at, id)",
      ]
    }
    if (name === "task_annotations") return [withoutMirrorReference(statement)]
    if (name === "task_annotations_project_task_idx") {
      return [
        "CREATE INDEX task_annotations_project_task_idx\n        ON task_annotations(\n          owner_id,project_id,run_id,session_id,\n          anchor_sequence,anchor_start_offset,created_at,id\n        )",
      ]
    }
    return [statement]
  })
}

/**
 * Upgrades an exact pre-Mirror schema inside the caller's transaction. Foreign
 * keys must be disabled by the caller for SQLite table reconstruction.
 */
export function migrateConversationMirrorSchema(database: Database): void {
  for (const statement of statementsNamed(MIRROR_OBJECTS)) database.query(statement).run()

  database.exec(`
    ALTER TABLE task_relay_acknowledgements
      RENAME TO task_relay_acknowledgements_legacy;
    ALTER TABLE task_relays RENAME TO task_relays_legacy;
    ALTER TABLE task_annotation_resolutions
      RENAME TO task_annotation_resolutions_legacy;
    ALTER TABLE task_annotations RENAME TO task_annotations_legacy;
  `)
  for (const table of [
    "task_relays",
    "task_relay_acknowledgements",
    "task_annotations",
    "task_annotation_resolutions",
  ]) {
    database.query(schemaTableStatement(table)).run()
  }

  database.exec(`
    INSERT INTO task_relays(
      id,owner_id,project_id,run_id,session_id,mirror_id,anchor_sequence,
      author_principal_id,author_name,author_kind,
      recipient_principal_id,recipient_name,recipient_kind,body,created_at
    )
    SELECT id,owner_id,project_id,run_id,session_id,NULL,anchor_sequence,
      author_principal_id,author_name,author_kind,
      recipient_principal_id,recipient_name,recipient_kind,body,created_at
    FROM task_relays_legacy;
    INSERT INTO task_relay_acknowledgements
      SELECT * FROM task_relay_acknowledgements_legacy;
    INSERT INTO task_annotations(
      id,owner_id,project_id,run_id,session_id,mirror_id,
      anchor_sequence,anchor_block_id,anchor_start_offset,anchor_end_offset,
      anchor_quote,anchor_prefix,anchor_suffix,anchor_content_digest,
      author_principal_id,author_name,author_kind,body,created_at
    )
    SELECT id,owner_id,project_id,run_id,session_id,NULL,
      anchor_sequence,anchor_block_id,anchor_start_offset,anchor_end_offset,
      anchor_quote,anchor_prefix,anchor_suffix,anchor_content_digest,
      author_principal_id,author_name,author_kind,body,created_at
    FROM task_annotations_legacy;
    INSERT INTO task_annotation_resolutions
      SELECT * FROM task_annotation_resolutions_legacy;
    DROP TABLE task_relay_acknowledgements_legacy;
    DROP TABLE task_relays_legacy;
    DROP TABLE task_annotation_resolutions_legacy;
    DROP TABLE task_annotations_legacy;
  `)
  for (const statement of statementsNamed(
    new Set([
      "task_relays_project_task_idx",
      "task_relays_recipient_idx",
      "task_relay_acknowledgements_principal_idx",
      "task_annotations_project_task_idx",
      "task_annotation_resolutions_resolver_idx",
    ]),
  )) {
    database.query(statement).run()
  }
}

function statementsNamed(names: ReadonlySet<string>): readonly string[] {
  return githubAppSchemaStatements().filter((statement) => {
    const name = schemaObjectName(statement)
    return name !== null && names.has(name)
  })
}

function schemaTableStatement(table: string): string {
  const statement = githubAppSchemaStatements().find(
    (candidate) => schemaObjectName(candidate) === table && /^CREATE\s+TABLE\b/i.test(candidate),
  )
  if (statement === undefined) throw new Error(`Current schema is missing ${table}`)
  return statement
}

function schemaObjectName(statement: string): string | null {
  return /^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+([a-z0-9_]+)/i.exec(statement)?.[1] ?? null
}

function withoutMirrorReference(statement: string): string {
  return statement
    .replace("\n        mirror_id TEXT,", "")
    .replace(
      "CHECK(\n          (run_id IS NOT NULL) + (session_id IS NOT NULL) + (mirror_id IS NOT NULL) = 1\n        )",
      "CHECK((run_id IS NOT NULL) != (session_id IS NOT NULL))",
    )
    .replace(
      "\n        FOREIGN KEY(owner_id, mirror_id)\n          REFERENCES conversation_mirrors(owner_id, id) ON DELETE CASCADE,",
      "",
    )
}
