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

CREATE TABLE principals (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('person','service')),
        display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 120),
        owner_role TEXT NOT NULL CHECK(owner_role IN ('admin','member')),
        created_at TEXT NOT NULL,
        disabled_at TEXT,
        UNIQUE(owner_id, id)
      ) STRICT;

CREATE INDEX principals_owner_idx ON principals(owner_id, created_at, id);

CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
        slug TEXT NOT NULL CHECK(
          length(slug) BETWEEN 1 AND 80
          AND slug NOT GLOB '*[^a-z0-9-]*'
          AND substr(slug, 1, 1) GLOB '[a-z0-9]'
          AND substr(slug, -1, 1) GLOB '[a-z0-9]'
        ),
        created_at TEXT NOT NULL,
        archived_at TEXT,
        UNIQUE(owner_id, id),
        UNIQUE(owner_id, slug)
      ) STRICT;

CREATE INDEX projects_owner_idx ON projects(owner_id, created_at, id);

CREATE TABLE project_memberships (
        owner_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('maintainer','member')),
        joined_at TEXT NOT NULL,
        removed_at TEXT,
        PRIMARY KEY(project_id, principal_id),
        FOREIGN KEY(owner_id, project_id) REFERENCES projects(owner_id, id) ON DELETE CASCADE,
        FOREIGN KEY(owner_id, principal_id) REFERENCES principals(owner_id, id) ON DELETE CASCADE
      ) WITHOUT ROWID, STRICT;

CREATE INDEX project_memberships_principal_idx
        ON project_memberships(owner_id, principal_id, removed_at, project_id);

CREATE TABLE presence_leases (
        owner_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        client_id TEXT NOT NULL CHECK(length(client_id) BETWEEN 1 AND 128),
        connected_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, project_id, principal_id, client_id),
        FOREIGN KEY(owner_id, project_id) REFERENCES projects(owner_id, id) ON DELETE CASCADE,
        FOREIGN KEY(owner_id, principal_id) REFERENCES principals(owner_id, id) ON DELETE CASCADE
      ) WITHOUT ROWID, STRICT;

CREATE INDEX presence_leases_project_expiry_idx
        ON presence_leases(owner_id, project_id, expires_at, principal_id, client_id);

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

CREATE TABLE api_key_principals (
        api_key_id TEXT PRIMARY KEY REFERENCES api_keys(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(owner_id, principal_id) REFERENCES principals(owner_id, id),
        FOREIGN KEY(owner_id, api_key_id) REFERENCES api_keys(owner_id, id)
      ) WITHOUT ROWID, STRICT;

CREATE INDEX api_key_principals_principal_idx
        ON api_key_principals(owner_id, principal_id, api_key_id);

CREATE TABLE browser_sessions (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        prefix TEXT NOT NULL CHECK(
          length(prefix) = 16 AND substr(prefix, 1, 4) = 'mws_'
          AND substr(prefix, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        hash TEXT NOT NULL UNIQUE CHECK(
          length(hash) = 71 AND substr(hash, 1, 7) = 'sha256:'
          AND substr(hash, 8) NOT GLOB '*[^0-9a-f]*'
        ),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT,
        FOREIGN KEY(owner_id, principal_id) REFERENCES principals(owner_id, id),
        UNIQUE(owner_id, id)
      ) STRICT;

CREATE INDEX browser_sessions_prefix_idx ON browser_sessions(prefix, revoked_at, expires_at);

CREATE TABLE principal_invitations (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        prefix TEXT NOT NULL UNIQUE CHECK(
          length(prefix) = 16 AND substr(prefix, 1, 4) = 'mwi_'
          AND substr(prefix, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        hash TEXT NOT NULL UNIQUE CHECK(
          length(hash) = 71 AND substr(hash, 1, 7) = 'sha256:'
          AND substr(hash, 8) NOT GLOB '*[^0-9a-f]*'
        ),
        created_by_principal_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        redeemed_at TEXT,
        revoked_at TEXT,
        FOREIGN KEY(owner_id, principal_id) REFERENCES principals(owner_id, id),
        FOREIGN KEY(owner_id, created_by_principal_id) REFERENCES principals(owner_id, id),
        UNIQUE(owner_id, id)
      ) STRICT;

CREATE INDEX principal_invitations_prefix_idx
        ON principal_invitations(prefix, revoked_at, redeemed_at, expires_at);

CREATE INDEX principal_invitations_principal_idx
        ON principal_invitations(owner_id, principal_id, created_at, id);

CREATE TABLE external_identities (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('github','google')),
        subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 255),
        login TEXT CHECK(login IS NULL OR length(login) BETWEEN 1 AND 255),
        display_name TEXT CHECK(display_name IS NULL OR length(display_name) BETWEEN 1 AND 255),
        avatar_url TEXT CHECK(avatar_url IS NULL OR length(avatar_url) BETWEEN 1 AND 2048),
        created_at TEXT NOT NULL,
        last_verified_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE(owner_id, id),
        UNIQUE(owner_id, provider, subject_id),
        FOREIGN KEY(owner_id, principal_id) REFERENCES principals(owner_id, id)
      ) STRICT;

CREATE INDEX external_identities_principal_idx
        ON external_identities(owner_id, principal_id, revoked_at, provider, id);

CREATE TABLE identity_credentials (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        external_identity_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider = 'github'),
        sealed_payload TEXT NOT NULL CHECK(length(sealed_payload) BETWEEN 1 AND 16384),
        key_version TEXT NOT NULL CHECK(length(key_version) BETWEEN 1 AND 64),
        access_expires_at TEXT NOT NULL,
        refresh_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE(owner_id, id),
        FOREIGN KEY(owner_id, principal_id) REFERENCES principals(owner_id, id),
        FOREIGN KEY(owner_id, external_identity_id)
          REFERENCES external_identities(owner_id, id)
      ) STRICT;

CREATE UNIQUE INDEX identity_credentials_active_identity_idx
        ON identity_credentials(owner_id, external_identity_id)
        WHERE revoked_at IS NULL;

CREATE TABLE external_project_grants (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        external_identity_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider = 'github'),
        account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 255),
        account_name TEXT NOT NULL CHECK(length(account_name) BETWEEN 1 AND 255),
        installation_id TEXT NOT NULL CHECK(length(installation_id) BETWEEN 1 AND 255),
        repository_id TEXT NOT NULL CHECK(length(repository_id) BETWEEN 1 AND 255),
        repository_name TEXT NOT NULL CHECK(length(repository_name) BETWEEN 1 AND 255),
        repository_full_name TEXT NOT NULL CHECK(length(repository_full_name) BETWEEN 1 AND 511),
        repository_url TEXT NOT NULL CHECK(length(repository_url) BETWEEN 1 AND 2048),
        private INTEGER NOT NULL CHECK(private IN (0,1)),
        access TEXT NOT NULL CHECK(access IN ('watch','participate','administer')),
        observed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE(owner_id, id),
        UNIQUE(owner_id, principal_id, provider, repository_id),
        FOREIGN KEY(owner_id, principal_id) REFERENCES principals(owner_id, id),
        FOREIGN KEY(owner_id, external_identity_id)
          REFERENCES external_identities(owner_id, id)
      ) STRICT;

CREATE INDEX external_project_grants_principal_idx
        ON external_project_grants(
          owner_id,principal_id,revoked_at,expires_at,account_id,repository_full_name,id
        );

CREATE TABLE project_repository_bindings (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider = 'github'),
        account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 255),
        account_name TEXT NOT NULL CHECK(length(account_name) BETWEEN 1 AND 255),
        installation_id TEXT NOT NULL CHECK(length(installation_id) BETWEEN 1 AND 255),
        repository_id TEXT NOT NULL CHECK(length(repository_id) BETWEEN 1 AND 255),
        repository_name TEXT NOT NULL CHECK(length(repository_name) BETWEEN 1 AND 255),
        repository_full_name TEXT NOT NULL CHECK(length(repository_full_name) BETWEEN 1 AND 511),
        repository_url TEXT NOT NULL CHECK(length(repository_url) BETWEEN 1 AND 2048),
        private INTEGER NOT NULL CHECK(private IN (0,1)),
        bound_by_principal_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE(owner_id, id),
        FOREIGN KEY(owner_id, project_id) REFERENCES projects(owner_id, id) ON DELETE CASCADE,
        FOREIGN KEY(owner_id, grant_id) REFERENCES external_project_grants(owner_id, id),
        FOREIGN KEY(owner_id, bound_by_principal_id) REFERENCES principals(owner_id, id)
      ) STRICT;

CREATE UNIQUE INDEX project_repository_bindings_active_project_idx
        ON project_repository_bindings(owner_id, project_id) WHERE revoked_at IS NULL;

CREATE INDEX project_repository_bindings_repository_idx
        ON project_repository_bindings(owner_id, provider, repository_id, revoked_at, project_id);

CREATE TABLE agent_connections (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        agent_type TEXT NOT NULL CHECK(length(agent_type) BETWEEN 1 AND 128),
        label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 128),
        capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
        created_at TEXT NOT NULL,
        last_verified_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE(owner_id, id),
        FOREIGN KEY(owner_id, principal_id) REFERENCES principals(owner_id, id)
      ) STRICT;

CREATE UNIQUE INDEX agent_connections_active_agent_idx
        ON agent_connections(owner_id, principal_id, agent_type) WHERE revoked_at IS NULL;

CREATE INDEX agent_connections_principal_idx
        ON agent_connections(owner_id, principal_id, revoked_at, agent_type, id);

CREATE TABLE project_selections (
        owner_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        selected_at TEXT NOT NULL,
        hidden_at TEXT,
        PRIMARY KEY(owner_id, principal_id, project_id),
        FOREIGN KEY(owner_id, principal_id) REFERENCES principals(owner_id, id),
        FOREIGN KEY(owner_id, project_id) REFERENCES projects(owner_id, id) ON DELETE CASCADE
      ) WITHOUT ROWID, STRICT;

CREATE INDEX project_selections_principal_idx
        ON project_selections(owner_id, principal_id, hidden_at, selected_at, project_id);

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
        context_artifacts_json TEXT NOT NULL CHECK(json_valid(context_artifacts_json)),
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

CREATE TABLE run_project_bindings (
        run_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        delegated_by_principal_id TEXT NOT NULL,
        delegated_by_name TEXT NOT NULL,
        delegated_by_kind TEXT NOT NULL CHECK(delegated_by_kind IN ('person','service')),
        created_at TEXT NOT NULL,
        FOREIGN KEY(owner_id, run_id) REFERENCES runs(owner_id, id) ON DELETE CASCADE,
        FOREIGN KEY(owner_id, project_id) REFERENCES projects(owner_id, id),
        FOREIGN KEY(owner_id, delegated_by_principal_id) REFERENCES principals(owner_id, id)
      ) WITHOUT ROWID, STRICT;

CREATE INDEX run_project_bindings_project_idx
        ON run_project_bindings(owner_id, project_id, created_at DESC, run_id);

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
        principal_id TEXT NOT NULL,
        key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        run_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, principal_id, key),
        FOREIGN KEY(owner_id, principal_id) REFERENCES principals(owner_id, id),
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

CREATE TABLE credential_leases (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owners(id),
        resource_type TEXT NOT NULL CHECK(resource_type IN ('run','session')),
        resource_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        runtime_handle_json TEXT NOT NULL CHECK(json_valid(runtime_handle_json)),
        provider TEXT NOT NULL,
        policy_digest TEXT NOT NULL CHECK(
          length(policy_digest) = 64
          AND policy_digest NOT GLOB '*[^0-9a-f]*'
        ),
        handle_json TEXT CHECK(handle_json IS NULL OR json_valid(handle_json)),
        status TEXT NOT NULL CHECK(
          status IN ('attaching','active','revoke_pending','revoking','revoked','failed')
        ),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        last_error_json TEXT CHECK(last_error_json IS NULL OR json_valid(last_error_json)),
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE(owner_id, resource_type, resource_id)
      ) STRICT;

CREATE INDEX credential_leases_revoke_idx
        ON credential_leases(status, next_attempt_at, updated_at);

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

CREATE TABLE briefs (
        id TEXT PRIMARY KEY CHECK(
          length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'
        ),
        owner_id TEXT NOT NULL REFERENCES owners(id),
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
        artifact_id TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        source_workspace_json TEXT NOT NULL CHECK(json_valid(source_workspace_json)),
        path TEXT NOT NULL,
        digest TEXT NOT NULL CHECK(
          length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'
        ),
        media_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
        created_at TEXT NOT NULL,
        UNIQUE(owner_id, id),
        UNIQUE(owner_id, artifact_id, path),
        FOREIGN KEY(owner_id, source_run_id, artifact_id)
          REFERENCES artifacts(owner_id, run_id, id)
      ) STRICT;

CREATE INDEX briefs_owner_created_idx ON briefs(owner_id, created_at DESC, id DESC);

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
        principal_id TEXT NOT NULL,
        key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, principal_id, key),
        FOREIGN KEY(owner_id, principal_id) REFERENCES principals(owner_id, id),
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
        resolved_revision TEXT,
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

CREATE TABLE session_project_bindings (
        session_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        delegated_by_principal_id TEXT NOT NULL,
        delegated_by_name TEXT NOT NULL,
        delegated_by_kind TEXT NOT NULL CHECK(delegated_by_kind IN ('person','service')),
        created_at TEXT NOT NULL,
        FOREIGN KEY(owner_id, session_id) REFERENCES agent_sessions(owner_id, id) ON DELETE CASCADE,
        FOREIGN KEY(owner_id, project_id) REFERENCES projects(owner_id, id),
        FOREIGN KEY(owner_id, delegated_by_principal_id) REFERENCES principals(owner_id, id)
      ) WITHOUT ROWID, STRICT;

CREATE INDEX session_project_bindings_project_idx
        ON session_project_bindings(owner_id, project_id, created_at DESC, session_id);

CREATE TABLE session_idempotency_keys (
        owner_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, principal_id, key),
        FOREIGN KEY(owner_id, principal_id) REFERENCES principals(owner_id, id),
        FOREIGN KEY(owner_id, session_id) REFERENCES agent_sessions(owner_id, id)
      ) WITHOUT ROWID, STRICT;

CREATE TABLE session_turns (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        prompt TEXT NOT NULL,
        context_artifacts_json TEXT NOT NULL CHECK(json_valid(context_artifacts_json)),
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

CREATE TABLE task_relays (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        run_id TEXT,
        session_id TEXT,
        anchor_sequence INTEGER NOT NULL CHECK(anchor_sequence >= 0),
        author_principal_id TEXT NOT NULL,
        author_name TEXT NOT NULL CHECK(length(author_name) BETWEEN 1 AND 120),
        author_kind TEXT NOT NULL CHECK(author_kind IN ('person','service')),
        recipient_principal_id TEXT NOT NULL,
        recipient_name TEXT NOT NULL CHECK(length(recipient_name) BETWEEN 1 AND 120),
        recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('person','service')),
        body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
        created_at TEXT NOT NULL,
        CHECK((run_id IS NOT NULL) != (session_id IS NOT NULL)),
        UNIQUE(owner_id, id),
        FOREIGN KEY(owner_id, project_id) REFERENCES projects(owner_id, id) ON DELETE CASCADE,
        FOREIGN KEY(owner_id, run_id) REFERENCES runs(owner_id, id) ON DELETE CASCADE,
        FOREIGN KEY(owner_id, session_id) REFERENCES agent_sessions(owner_id, id) ON DELETE CASCADE,
        FOREIGN KEY(owner_id, author_principal_id) REFERENCES principals(owner_id, id),
        FOREIGN KEY(owner_id, recipient_principal_id) REFERENCES principals(owner_id, id)
      ) STRICT;

CREATE INDEX task_relays_project_task_idx
        ON task_relays(owner_id, project_id, run_id, session_id, anchor_sequence, created_at, id);

CREATE INDEX task_relays_recipient_idx
        ON task_relays(owner_id, project_id, recipient_principal_id, created_at, id);

CREATE TABLE task_relay_acknowledgements (
        relay_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        acknowledged_at TEXT NOT NULL,
        FOREIGN KEY(owner_id, relay_id) REFERENCES task_relays(owner_id, id) ON DELETE CASCADE,
        FOREIGN KEY(owner_id, principal_id) REFERENCES principals(owner_id, id)
      ) WITHOUT ROWID, STRICT;

CREATE INDEX task_relay_acknowledgements_principal_idx
        ON task_relay_acknowledgements(owner_id, principal_id, acknowledged_at, relay_id);

CREATE TABLE task_annotations (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        run_id TEXT,
        session_id TEXT,
        anchor_sequence INTEGER NOT NULL CHECK(anchor_sequence >= 0),
        anchor_block_id TEXT NOT NULL CHECK(
          length(anchor_block_id) BETWEEN 1 AND 256
          AND anchor_block_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        ),
        anchor_start_offset INTEGER NOT NULL CHECK(
          anchor_start_offset >= 0 AND anchor_start_offset <= 10000000
        ),
        anchor_end_offset INTEGER NOT NULL CHECK(
          anchor_end_offset > anchor_start_offset AND anchor_end_offset <= 10000000
        ),
        anchor_quote TEXT NOT NULL CHECK(length(anchor_quote) BETWEEN 1 AND 4096),
        anchor_prefix TEXT NOT NULL CHECK(length(anchor_prefix) <= 256),
        anchor_suffix TEXT NOT NULL CHECK(length(anchor_suffix) <= 256),
        anchor_content_digest TEXT NOT NULL CHECK(
          length(anchor_content_digest) = 64
          AND anchor_content_digest NOT GLOB '*[^0-9a-f]*'
        ),
        author_principal_id TEXT NOT NULL,
        author_name TEXT NOT NULL CHECK(length(author_name) BETWEEN 1 AND 120),
        author_kind TEXT NOT NULL CHECK(author_kind IN ('person','service')),
        body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
        created_at TEXT NOT NULL,
        CHECK((run_id IS NOT NULL) != (session_id IS NOT NULL)),
        UNIQUE(owner_id, id),
        FOREIGN KEY(owner_id, project_id) REFERENCES projects(owner_id, id) ON DELETE CASCADE,
        FOREIGN KEY(owner_id, run_id) REFERENCES runs(owner_id, id) ON DELETE CASCADE,
        FOREIGN KEY(owner_id, session_id) REFERENCES agent_sessions(owner_id, id) ON DELETE CASCADE,
        FOREIGN KEY(owner_id, author_principal_id) REFERENCES principals(owner_id, id)
      ) STRICT;

CREATE INDEX task_annotations_project_task_idx
        ON task_annotations(
          owner_id,project_id,run_id,session_id,
          anchor_sequence,anchor_start_offset,created_at,id
        );

CREATE TABLE task_annotation_resolutions (
        annotation_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        resolver_principal_id TEXT NOT NULL,
        resolver_name TEXT NOT NULL CHECK(length(resolver_name) BETWEEN 1 AND 120),
        resolver_kind TEXT NOT NULL CHECK(resolver_kind IN ('person','service')),
        resolved_at TEXT NOT NULL,
        FOREIGN KEY(owner_id, annotation_id)
          REFERENCES task_annotations(owner_id, id) ON DELETE CASCADE,
        FOREIGN KEY(owner_id, resolver_principal_id) REFERENCES principals(owner_id, id)
      ) WITHOUT ROWID, STRICT;

CREATE INDEX task_annotation_resolutions_resolver_idx
        ON task_annotation_resolutions(owner_id,resolver_principal_id,resolved_at,annotation_id);

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
