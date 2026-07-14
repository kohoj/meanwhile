import { Database } from "bun:sqlite"
import { AppError } from "../errors"

export interface SchemaIdentity {
  readonly name: string
  readonly fingerprint: string
}

export const SCHEMA_NAME = "meanwhile-control-plane"

export const SCHEMA_SQL = `
CREATE TABLE schema_identity (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        name TEXT NOT NULL,
        fingerprint TEXT NOT NULL CHECK(
          length(fingerprint) = 64
          AND fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        created_at TEXT NOT NULL
      ) STRICT;

CREATE TABLE owners (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
        prefix TEXT NOT NULL CHECK(
          length(prefix) = 16 AND substr(prefix, 1, 4) = 'mwk_'
          AND substr(prefix, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        hash TEXT NOT NULL UNIQUE CHECK(
          length(hash) = 71 AND substr(hash, 1, 7) = 'sha256:'
          AND substr(hash, 8) NOT GLOB '*[^0-9a-f]*'
        ),
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT,
        UNIQUE(owner_id, id)
      ) STRICT;

CREATE INDEX api_keys_owner_idx ON api_keys(owner_id, created_at);

CREATE INDEX api_keys_prefix_idx ON api_keys(prefix, revoked_at);

CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owners(id),
        workspace_json TEXT NOT NULL CHECK(json_valid(workspace_json)),
        agent_type TEXT NOT NULL,
        agent_spec_json TEXT NOT NULL CHECK(json_valid(agent_spec_json)),
        agent_catalog_digest TEXT NOT NULL CHECK(
          length(agent_catalog_digest) = 64
          AND agent_catalog_digest NOT GLOB '*[^0-9a-f]*'
        ),
        execution_provenance_json TEXT NOT NULL CHECK(json_valid(execution_provenance_json)),
        prompt TEXT NOT NULL,
        env_json TEXT NOT NULL CHECK(json_valid(env_json)),
        secret_refs_json TEXT NOT NULL CHECK(json_valid(secret_refs_json)),
        provider TEXT NOT NULL,
        artifact_paths_json TEXT NOT NULL CHECK(json_valid(artifact_paths_json)),
        timeout_ms INTEGER NOT NULL CHECK(timeout_ms > 0),
        deadline_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('queued','provisioning','running','succeeded','failed','cancelled','timed_out')),
        status_version INTEGER NOT NULL CHECK(status_version >= 1),
        runtime_id TEXT,
        process_id TEXT,
        resolved_revision TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
        exit_code INTEGER,
        UNIQUE(owner_id, id)
      ) STRICT;

CREATE INDEX runs_owner_created_idx ON runs(owner_id, created_at DESC, id);

CREATE INDEX runs_owner_status_idx ON runs(owner_id, status, created_at);

CREATE INDEX runs_status_claim_idx ON runs(status, created_at);

CREATE TABLE run_status_events (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        status_version INTEGER NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, status_version),
        FOREIGN KEY(owner_id, run_id) REFERENCES runs(owner_id, id) ON DELETE CASCADE
      ) STRICT;

CREATE INDEX run_status_events_owner_run_idx ON run_status_events(owner_id, run_id, status_version);

CREATE TABLE run_idempotency_keys (
        owner_id TEXT NOT NULL,
        key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        run_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, key),
        FOREIGN KEY(owner_id, run_id) REFERENCES runs(owner_id, id)
      ) WITHOUT ROWID, STRICT;

CREATE TABLE runtime_instances (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        handle_json TEXT NOT NULL CHECK(json_valid(handle_json)),
        process_handle_json TEXT CHECK(process_handle_json IS NULL OR json_valid(process_handle_json)),
        cleanup_status TEXT NOT NULL CHECK(cleanup_status IN ('pending','running','succeeded','failed')),
        cleanup_attempts INTEGER NOT NULL DEFAULT 0,
        cleanup_last_error_json TEXT CHECK(
          cleanup_last_error_json IS NULL OR json_valid(cleanup_last_error_json)
        ),
        cleanup_next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        destroyed_at TEXT,
        UNIQUE(owner_id, id),
        UNIQUE(owner_id, run_id),
        FOREIGN KEY(owner_id, run_id) REFERENCES runs(owner_id, id)
      ) STRICT;

CREATE INDEX runtime_instances_owner_run_idx ON runtime_instances(owner_id, run_id);

CREATE INDEX runtime_instances_cleanup_idx ON runtime_instances(cleanup_status, cleanup_next_attempt_at, updated_at);

CREATE TABLE runner_sessions (
        run_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        runner_session_id TEXT NOT NULL,
        protocol_version INTEGER NOT NULL,
        provider_cursor TEXT,
        runner_sequence INTEGER NOT NULL DEFAULT 0,
        terminal_result_json TEXT CHECK(
          terminal_result_json IS NULL OR json_valid(terminal_result_json)
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(owner_id, run_id) REFERENCES runs(owner_id, id) ON DELETE CASCADE
      ) WITHOUT ROWID, STRICT;

CREATE INDEX runner_sessions_owner_run_idx ON runner_sessions(owner_id, run_id);

CREATE TABLE run_logs (
        owner_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        stream TEXT NOT NULL CHECK(stream IN ('stdout','stderr','agent','system')),
        event_type TEXT NOT NULL,
        data TEXT NOT NULL,
        runner_session_id TEXT,
        runner_sequence INTEGER,
        provider_cursor TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, sequence),
        UNIQUE(run_id, runner_session_id, runner_sequence),
        FOREIGN KEY(owner_id, run_id) REFERENCES runs(owner_id, id) ON DELETE CASCADE
      ) WITHOUT ROWID, STRICT;

CREATE INDEX run_logs_owner_run_idx ON run_logs(owner_id, run_id, sequence);

CREATE TABLE workspace_bundles (
        owner_id TEXT NOT NULL REFERENCES owners(id),
        id TEXT NOT NULL,
        digest TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
        storage_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, id)
      ) WITHOUT ROWID, STRICT;

CREATE INDEX workspace_bundles_owner_created_idx ON workspace_bundles(owner_id, created_at, id);

CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        logical_path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('file','directory','workspace')),
        digest TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
        storage_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        UNIQUE(owner_id, id),
        UNIQUE(owner_id, run_id, id),
        UNIQUE(owner_id, run_id, logical_path, digest),
        FOREIGN KEY(owner_id, run_id) REFERENCES runs(owner_id, id)
      ) STRICT;

CREATE INDEX artifacts_owner_run_idx ON artifacts(owner_id, run_id, created_at, id);

CREATE TABLE deployments (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        target TEXT NOT NULL,
        target_config_json TEXT NOT NULL CHECK(json_valid(target_config_json)),
        secret_refs_json TEXT NOT NULL CHECK(json_valid(secret_refs_json)),
        status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')),
        url TEXT,
        error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(owner_id, id),
        FOREIGN KEY(owner_id, run_id) REFERENCES runs(owner_id, id),
        FOREIGN KEY(owner_id, run_id, artifact_id) REFERENCES artifacts(owner_id, run_id, id)
      ) STRICT;

CREATE INDEX deployments_owner_created_idx ON deployments(owner_id, created_at DESC, id);

CREATE INDEX deployments_status_idx ON deployments(status, created_at);

CREATE TABLE deployment_idempotency_keys (
        owner_id TEXT NOT NULL,
        key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, key),
        FOREIGN KEY(owner_id, deployment_id) REFERENCES deployments(owner_id, id)
      ) WITHOUT ROWID, STRICT;

CREATE TABLE deployment_logs (
        owner_id TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        stream TEXT NOT NULL CHECK(stream IN ('stdout','stderr','system')),
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(deployment_id, sequence),
        FOREIGN KEY(owner_id, deployment_id) REFERENCES deployments(owner_id, id) ON DELETE CASCADE
      ) WITHOUT ROWID, STRICT;

CREATE INDEX deployment_logs_owner_deployment_idx ON deployment_logs(owner_id, deployment_id, sequence);

CREATE TABLE audit_records (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owners(id),
        actor_api_key_id TEXT,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        trace_id TEXT,
        metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
        created_at TEXT NOT NULL,
        FOREIGN KEY(owner_id, actor_api_key_id) REFERENCES api_keys(owner_id, id)
      ) STRICT;

CREATE INDEX audit_records_owner_created_idx ON audit_records(owner_id, created_at DESC, id);

CREATE INDEX audit_records_owner_resource_idx ON audit_records(owner_id, resource_type, resource_id, created_at);

CREATE TABLE run_events (
        owner_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        version INTEGER NOT NULL CHECK(version = 1),
        type TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('control-plane','runner')),
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, sequence),
        FOREIGN KEY(owner_id, run_id) REFERENCES runs(owner_id, id) ON DELETE CASCADE
      ) WITHOUT ROWID, STRICT;

CREATE INDEX run_events_owner_run_idx ON run_events(owner_id, run_id, sequence);

CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owners(id),
        workspace_json TEXT NOT NULL CHECK(json_valid(workspace_json)),
        agent_type TEXT NOT NULL,
        agent_spec_json TEXT NOT NULL CHECK(json_valid(agent_spec_json)),
        agent_catalog_digest TEXT NOT NULL CHECK(length(agent_catalog_digest) = 64),
        execution_provenance_json TEXT NOT NULL CHECK(json_valid(execution_provenance_json)),
        env_json TEXT NOT NULL CHECK(json_valid(env_json)),
        secret_refs_json TEXT NOT NULL CHECK(json_valid(secret_refs_json)),
        provider TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'queued','provisioning','idle','running','closing','closed','failed','continuity_lost'
        )),
        status_version INTEGER NOT NULL CHECK(status_version >= 1),
        active_turn_id TEXT,
        runtime_id TEXT,
        process_id TEXT,
        agent_session_id TEXT,
        capabilities_json TEXT CHECK(capabilities_json IS NULL OR json_valid(capabilities_json)),
        idle_timeout_ms INTEGER NOT NULL CHECK(idle_timeout_ms >= 1000),
        created_at TEXT NOT NULL,
        started_at TEXT,
        closed_at TEXT,
        updated_at TEXT NOT NULL,
        error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
        UNIQUE(owner_id, id)
      ) STRICT;

CREATE INDEX agent_sessions_owner_created_idx
        ON agent_sessions(owner_id, created_at DESC, id DESC);

CREATE INDEX agent_sessions_status_idx ON agent_sessions(status, updated_at);

CREATE INDEX agent_sessions_status_created_idx
        ON agent_sessions(status, created_at, id);

CREATE TABLE session_idempotency_keys (
        owner_id TEXT NOT NULL,
        key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, key),
        FOREIGN KEY(owner_id, session_id) REFERENCES agent_sessions(owner_id, id)
      ) WITHOUT ROWID, STRICT;

CREATE TABLE session_turns (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        prompt TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL CHECK(timeout_ms >= 1000),
        deadline_at TEXT,
        status TEXT NOT NULL CHECK(status IN (
          'queued','running','succeeded','failed','interrupted','timed_out'
        )),
        status_version INTEGER NOT NULL CHECK(status_version >= 1),
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
        UNIQUE(owner_id, session_id, id),
        UNIQUE(session_id, sequence),
        FOREIGN KEY(owner_id, session_id) REFERENCES agent_sessions(owner_id, id) ON DELETE CASCADE
      ) STRICT;

CREATE INDEX session_turns_owner_session_idx ON session_turns(owner_id, session_id, sequence);

CREATE INDEX session_turns_status_idx ON session_turns(status, created_at);

CREATE TABLE turn_idempotency_keys (
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, session_id, key),
        FOREIGN KEY(owner_id, session_id, turn_id)
          REFERENCES session_turns(owner_id, session_id, id)
      ) WITHOUT ROWID, STRICT;

CREATE TABLE session_runtime_leases (
        session_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        runtime_handle_json TEXT NOT NULL CHECK(json_valid(runtime_handle_json)),
        process_handle_json TEXT CHECK(process_handle_json IS NULL OR json_valid(process_handle_json)),
        provider_cursor TEXT,
        runner_sequence INTEGER NOT NULL DEFAULT 0 CHECK(runner_sequence >= 0),
        command_sequence INTEGER NOT NULL DEFAULT 0 CHECK(command_sequence >= 0),
        cleanup_status TEXT NOT NULL CHECK(cleanup_status IN ('pending','running','succeeded','failed')),
        cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_attempts >= 0),
        cleanup_last_error_json TEXT CHECK(
          cleanup_last_error_json IS NULL OR json_valid(cleanup_last_error_json)
        ),
        cleanup_next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        destroyed_at TEXT,
        FOREIGN KEY(owner_id, session_id) REFERENCES agent_sessions(owner_id, id)
      ) WITHOUT ROWID, STRICT;

CREATE INDEX session_runtime_leases_cleanup_idx
        ON session_runtime_leases(cleanup_status, cleanup_next_attempt_at, updated_at);

CREATE TABLE session_commands (
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('turn.start','turn.interrupt','session.close')),
        turn_id TEXT,
        data_json TEXT NOT NULL CHECK(json_valid(data_json)),
        state TEXT NOT NULL CHECK(state IN ('pending','sent')),
        created_at TEXT NOT NULL,
        sent_at TEXT,
        PRIMARY KEY(session_id, sequence),
        UNIQUE(session_id, id),
        FOREIGN KEY(owner_id, session_id) REFERENCES agent_sessions(owner_id, id) ON DELETE CASCADE
      ) WITHOUT ROWID, STRICT;

CREATE INDEX session_commands_pending_idx ON session_commands(state, created_at);

CREATE TABLE session_events (
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        version INTEGER NOT NULL CHECK(version = 1),
        type TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('control-plane','runner')),
        turn_id TEXT,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        runner_sequence INTEGER,
        provider_cursor TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(session_id, sequence),
        UNIQUE(session_id, runner_sequence),
        FOREIGN KEY(owner_id, session_id) REFERENCES agent_sessions(owner_id, id) ON DELETE CASCADE
      ) WITHOUT ROWID, STRICT;

CREATE INDEX session_events_owner_session_idx ON session_events(owner_id, session_id, sequence);

CREATE TABLE runtime_provisioning_intents (
        runtime_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','creating','materialized','failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        last_error_json TEXT CHECK(last_error_json IS NULL OR json_valid(last_error_json)),
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(owner_id, runtime_id),
        UNIQUE(owner_id, run_id),
        FOREIGN KEY(owner_id, run_id) REFERENCES runs(owner_id, id) ON DELETE CASCADE
      ) STRICT;

CREATE INDEX runtime_provisioning_intents_reconcile_idx
        ON runtime_provisioning_intents(status, next_attempt_at, updated_at);

CREATE TABLE session_runtime_provisioning_intents (
        runtime_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','creating','materialized','failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        last_error_json TEXT CHECK(last_error_json IS NULL OR json_valid(last_error_json)),
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(owner_id, runtime_id),
        UNIQUE(owner_id, session_id),
        FOREIGN KEY(owner_id, session_id)
          REFERENCES agent_sessions(owner_id, id) ON DELETE CASCADE
      ) STRICT;

CREATE INDEX session_runtime_provisioning_intents_reconcile_idx
        ON session_runtime_provisioning_intents(status, next_attempt_at, updated_at);

CREATE TABLE run_process_launch_intents (
        run_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL UNIQUE,
        process_id TEXT NOT NULL,
        timeout_budget_ms INTEGER NOT NULL CHECK(timeout_budget_ms > 0),
        created_at TEXT NOT NULL,
        FOREIGN KEY(owner_id, run_id) REFERENCES runs(owner_id, id) ON DELETE CASCADE,
        FOREIGN KEY(owner_id, runtime_id)
          REFERENCES runtime_instances(owner_id, id) ON DELETE CASCADE
      ) WITHOUT ROWID, STRICT;
`

export const SCHEMA_FINGERPRINT = buildSchemaFingerprint()

export const CURRENT_SCHEMA: SchemaIdentity = Object.freeze({
  name: SCHEMA_NAME,
  fingerprint: SCHEMA_FINGERPRINT,
})

export function databaseSchemaFingerprint(database: Database): string {
  const objects = database
    .query<{ type: string; name: string; table_name: string; sql: string }, []>(`
      SELECT type, name, tbl_name AS table_name, sql
      FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `)
    .all()
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(objects)).digest("hex")
}

function buildSchemaFingerprint(): string {
  const database = new Database(":memory:", { strict: true })
  try {
    for (const statement of splitSchemaSql(SCHEMA_SQL)) database.query(statement).run()
    return databaseSchemaFingerprint(database)
  } finally {
    database.close()
  }
}

export function splitSchemaSql(sql: string): readonly string[] {
  const statements: string[] = []
  let start = 0
  let quote: "'" | '"' | "`" | "]" | null = null
  let lineComment = false
  let blockComment = false
  let hasSql = false

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]
    const next = sql[index + 1]
    if (lineComment) {
      if (character === "\n") lineComment = false
      continue
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote !== null) {
      const closing = quote === "]" ? "]" : quote
      if (character === closing) {
        if (quote !== "]" && next === closing) index += 1
        else quote = null
      }
      continue
    }
    if (character === "-" && next === "-") {
      lineComment = true
      index += 1
      continue
    }
    if (character === "/" && next === "*") {
      blockComment = true
      index += 1
      continue
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character
      hasSql = true
      continue
    }
    if (character === "[") {
      quote = "]"
      hasSql = true
      continue
    }
    if (character === ";") {
      if (hasSql) statements.push(sql.slice(start, index).trim())
      start = index + 1
      hasSql = false
      continue
    }
    if (!/\s/.test(character ?? "")) hasSql = true
  }

  if (quote !== null || blockComment) {
    throw new AppError({
      code: "SCHEMA_DEFINITION_INVALID",
      message: "Schema SQL contains an unterminated token",
    })
  }
  if (hasSql) statements.push(sql.slice(start).trim())
  if (statements.length === 0) {
    throw new AppError({ code: "SCHEMA_DEFINITION_INVALID", message: "Schema SQL is empty" })
  }
  for (const statement of statements) {
    if (/^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(withoutLeadingComments(statement))) {
      throw new AppError({
        code: "SCHEMA_DEFINITION_INVALID",
        message: "Schema triggers are not supported by the statement executor",
      })
    }
  }
  return statements
}

function withoutLeadingComments(statement: string): string {
  const remaining = statement.trimStart()
  if (remaining.startsWith("--")) {
    const end = remaining.indexOf("\n")
    return end === -1 ? "" : withoutLeadingComments(remaining.slice(end + 1))
  }
  if (remaining.startsWith("/*")) {
    const end = remaining.indexOf("*/", 2)
    return end === -1 ? remaining : withoutLeadingComments(remaining.slice(end + 2))
  }
  return remaining
}
