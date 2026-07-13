export interface Migration {
  readonly version: number
  readonly name: string
  readonly sql: string
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial_control_plane",
    sql: `
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
        workspace_json TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        agent_spec_json TEXT NOT NULL,
        agent_catalog_digest TEXT NOT NULL CHECK(
          length(agent_catalog_digest) = 64
          AND agent_catalog_digest NOT GLOB '*[^0-9a-f]*'
        ),
        prompt TEXT NOT NULL,
        env_json TEXT NOT NULL,
        secret_refs_json TEXT NOT NULL,
        provider TEXT NOT NULL,
        artifact_paths_json TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL CHECK(timeout_ms > 0),
        deadline_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('queued','provisioning','running','succeeded','failed','cancelled','timed_out')),
        status_version INTEGER NOT NULL CHECK(status_version >= 1),
        runtime_id TEXT,
        process_id TEXT,
        resolved_revision TEXT,
        cancellation_requested_at TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        error_json TEXT,
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

      CREATE TABLE idempotency_keys (
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
        handle_json TEXT NOT NULL,
        process_handle_json TEXT,
        cleanup_status TEXT NOT NULL CHECK(cleanup_status IN ('pending','running','succeeded','failed')),
        cleanup_attempts INTEGER NOT NULL DEFAULT 0,
        cleanup_last_error_json TEXT,
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
        terminal_result_json TEXT,
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
        target_config_json TEXT NOT NULL,
        secret_refs_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')),
        url TEXT,
        error_json TEXT,
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
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(owner_id, actor_api_key_id) REFERENCES api_keys(owner_id, id)
      ) STRICT;
      CREATE INDEX audit_records_owner_created_idx ON audit_records(owner_id, created_at DESC, id);
      CREATE INDEX audit_records_owner_resource_idx ON audit_records(owner_id, resource_type, resource_id, created_at);
    `,
  },
  {
    version: 2,
    name: "execution_provenance",
    sql: `
      ALTER TABLE runs ADD COLUMN execution_provenance_json TEXT
        CHECK(execution_provenance_json IS NULL OR json_valid(execution_provenance_json));
    `,
  },
]

export const migrationSha256 = (migration: Migration): string =>
  new Bun.CryptoHasher("sha256").update(migration.sql).digest("hex")
