import { Database } from "bun:sqlite"
import {
  type AgentLaunchSnapshot,
  type ApiKey,
  type Artifact,
  type AuditRecord,
  canTransitionRun,
  type Deployment,
  type DeploymentLogChunk,
  type DeploymentStatus,
  type ExecutionProvenance,
  isTerminalRunStatus,
  type JsonObject,
  type Run,
  type RunLogChunk,
  type RunnerSession,
  type RunStatus,
  type RunStatusEvent,
  type RuntimeInstance,
  type StructuredError,
  type WorkspaceSource,
} from "../domain"
import { AppError } from "../errors"
import { parseExecutionProvenance } from "../provenance"
import { migrationSha256, migrations } from "./migrations"

type Bind = string | number | bigint | boolean | null | Uint8Array

interface RunRow extends Record<string, Bind> {
  id: string
  owner_id: string
  workspace_json: string
  agent_type: string
  agent_spec_json: string
  agent_catalog_digest: string
  execution_provenance_json: string | null
  prompt: string
  env_json: string
  secret_refs_json: string
  provider: string
  artifact_paths_json: string
  timeout_ms: number
  deadline_at: string | null
  status: RunStatus
  status_version: number
  runtime_id: string | null
  process_id: string | null
  resolved_revision: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  updated_at: string
  error_json: string | null
  exit_code: number | null
}

interface RuntimeRow extends Record<string, Bind> {
  id: string
  owner_id: string
  run_id: string
  provider: string
  handle_json: string
  process_handle_json: string | null
  cleanup_status: RuntimeInstance["cleanupStatus"]
  cleanup_attempts: number
  cleanup_last_error_json: string | null
  cleanup_next_attempt_at: string | null
  created_at: string
  updated_at: string
  destroyed_at: string | null
}

interface RunnerSessionRow extends Record<string, Bind> {
  run_id: string
  owner_id: string
  runner_session_id: string
  protocol_version: number
  provider_cursor: string | null
  runner_sequence: number
  terminal_result_json: string | null
  created_at: string
  updated_at: string
}

interface ArtifactRow extends Record<string, Bind> {
  id: string
  owner_id: string
  run_id: string
  logical_path: string
  kind: Artifact["kind"]
  digest: string
  media_type: string
  byte_size: number
  storage_key: string
  created_at: string
}

interface DeploymentRow extends Record<string, Bind> {
  id: string
  owner_id: string
  run_id: string
  artifact_id: string
  target: string
  target_config_json: string
  secret_refs_json: string
  status: DeploymentStatus
  url: string | null
  error_json: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  updated_at: string
}

interface ApiKeyRow extends Record<string, Bind> {
  id: string
  owner_id: string
  prefix: string
  hash: string
  name: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

const stringify = (value: unknown): string => JSON.stringify(value)

const parse = <T>(value: string): T => JSON.parse(value) as T

const validateMigrationCatalog = (): void => {
  const names = new Set<string>()
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1 || names.has(migration.name)) {
      throw new AppError({
        code: "MIGRATION_CATALOG_INVALID",
        message: "Migration catalog is not contiguous and unique",
      })
    }
    names.add(migration.name)
  }
}

const encodeCreatedCursor = (resource: {
  readonly createdAt: string
  readonly id: string
}): string =>
  Buffer.from(JSON.stringify({ createdAt: resource.createdAt, id: resource.id }), "utf8").toString(
    "base64url",
  )

const decodeCreatedCursor = (
  cursor: string,
  resource: "Run" | "Deployment" | "Audit",
): { createdAt: string; id: string } => {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    if (
      typeof value !== "object" ||
      value === null ||
      !("createdAt" in value) ||
      !("id" in value) ||
      typeof value.createdAt !== "string" ||
      typeof value.id !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      value.id.length === 0
    ) {
      throw new Error("invalid cursor")
    }
    return { createdAt: value.createdAt, id: value.id }
  } catch (error) {
    throw new AppError({
      code: "INVALID_REQUEST",
      message: `${resource} cursor is invalid`,
      cause: error,
    })
  }
}

const runFromRow = (row: RunRow): Run => ({
  id: row.id,
  ownerId: row.owner_id,
  workspace: parse<WorkspaceSource>(row.workspace_json),
  agentType: row.agent_type,
  agentSpec: parse<AgentLaunchSnapshot>(row.agent_spec_json),
  agentCatalogDigest: row.agent_catalog_digest,
  executionProvenance:
    row.execution_provenance_json === null
      ? null
      : parseExecutionProvenance(parse<unknown>(row.execution_provenance_json)),
  prompt: row.prompt,
  env: parse<Record<string, string>>(row.env_json),
  secretRefs: parse<Record<string, string>>(row.secret_refs_json),
  provider: row.provider,
  artifactPaths: parse<string[]>(row.artifact_paths_json),
  timeoutMs: row.timeout_ms,
  deadlineAt: row.deadline_at,
  status: row.status,
  statusVersion: row.status_version,
  runtimeId: row.runtime_id,
  processId: row.process_id,
  resolvedRevision: row.resolved_revision,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  updatedAt: row.updated_at,
  error: row.error_json === null ? null : parse<StructuredError>(row.error_json),
  exitCode: row.exit_code,
})

const apiKeyFromRow = (row: ApiKeyRow): ApiKey => ({
  id: row.id,
  ownerId: row.owner_id,
  prefix: row.prefix,
  name: row.name,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  revokedAt: row.revoked_at,
})

const runtimeFromRow = (row: RuntimeRow): RuntimeInstance => ({
  id: row.id,
  ownerId: row.owner_id,
  runId: row.run_id,
  provider: row.provider,
  handle: parse<JsonObject>(row.handle_json),
  processHandle:
    row.process_handle_json === null ? null : parse<JsonObject>(row.process_handle_json),
  cleanupStatus: row.cleanup_status,
  cleanupAttempts: row.cleanup_attempts,
  cleanupLastError:
    row.cleanup_last_error_json === null
      ? null
      : parse<StructuredError>(row.cleanup_last_error_json),
  cleanupNextAttemptAt: row.cleanup_next_attempt_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  destroyedAt: row.destroyed_at,
})

const artifactFromRow = (row: ArtifactRow): Artifact => ({
  id: row.id,
  ownerId: row.owner_id,
  runId: row.run_id,
  logicalPath: row.logical_path,
  kind: row.kind,
  digest: row.digest,
  mediaType: row.media_type,
  byteSize: row.byte_size,
  storageKey: row.storage_key,
  createdAt: row.created_at,
})

const sameArtifactIdentity = (left: Artifact, right: Artifact): boolean =>
  left.id === right.id &&
  left.ownerId === right.ownerId &&
  left.runId === right.runId &&
  left.logicalPath === right.logicalPath &&
  left.kind === right.kind &&
  left.digest === right.digest &&
  left.mediaType === right.mediaType &&
  left.byteSize === right.byteSize &&
  left.storageKey === right.storageKey

const deploymentFromRow = (row: DeploymentRow): Deployment => ({
  id: row.id,
  ownerId: row.owner_id,
  runId: row.run_id,
  artifactId: row.artifact_id,
  target: row.target,
  targetConfig: parse<JsonObject>(row.target_config_json),
  secretRefs: parse<Record<string, string>>(row.secret_refs_json),
  status: row.status,
  url: row.url,
  error: row.error_json === null ? null : parse<StructuredError>(row.error_json),
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  updatedAt: row.updated_at,
})

const runLogFromEvidenceRow = (row: {
  owner_id: string
  run_id: string
  sequence: number
  stream: RunLogChunk["stream"]
  event_type: string
  data: string
  runner_session_id: string
  runner_sequence: number
  created_at: string
}): RunLogChunk => ({
  ownerId: row.owner_id,
  runId: row.run_id,
  sequence: row.sequence,
  stream: row.stream,
  eventType: row.event_type,
  data: row.data,
  runnerSessionId: row.runner_session_id,
  runnerSequence: row.runner_sequence,
  createdAt: row.created_at,
})

export interface CreateRunInput {
  readonly id: string
  readonly ownerId: string
  readonly workspace: WorkspaceSource
  readonly agentType: string
  readonly agentSpec: AgentLaunchSnapshot
  readonly agentCatalogDigest: string
  readonly executionProvenance: ExecutionProvenance
  readonly prompt: string
  readonly env: Readonly<Record<string, string>>
  readonly secretRefs: Readonly<Record<string, string>>
  readonly provider: string
  readonly artifactPaths: readonly string[]
  readonly timeoutMs: number
  readonly createdAt: string
  readonly idempotencyKey?: string
  readonly requestHash?: string
  readonly audit: Omit<
    AuditRecord,
    "id" | "ownerId" | "action" | "resourceType" | "resourceId" | "createdAt"
  >
}

export interface TransitionRunInput {
  readonly runId: string
  readonly expectedStatus: RunStatus
  readonly expectedVersion: number
  readonly toStatus: RunStatus
  readonly reason: string
  readonly at: string
  readonly deadlineAt?: string | null
  readonly error?: StructuredError | null
  readonly exitCode?: number | null
  readonly systemLog?: {
    readonly eventType: string
    readonly data: string
  }
  readonly audit: Omit<AuditRecord, "id" | "ownerId" | "resourceType" | "resourceId" | "createdAt">
}

export interface AcceptRunnerFrameInput {
  readonly ownerId: string
  readonly runId: string
  readonly runnerSessionId: string
  readonly protocolVersion: number
  readonly providerCursor: string | null
  readonly runnerSequence: number
  readonly stream: RunLogChunk["stream"]
  readonly eventType: string
  readonly data: string
  readonly terminalResult?: JsonObject
  readonly createdAt: string
  readonly runningTransition?: {
    readonly at: string
    readonly reason: string
    readonly audit: Omit<
      AuditRecord,
      "id" | "ownerId" | "resourceType" | "resourceId" | "createdAt"
    >
    readonly systemLog: {
      readonly eventType: string
      readonly data: string
    }
  }
}

export interface AcceptRunnerFrameResult {
  readonly accepted: boolean
  readonly log: RunLogChunk
  readonly run: Run
}

type RunMutationAudit = Omit<
  AuditRecord,
  "id" | "ownerId" | "resourceType" | "resourceId" | "createdAt"
>

interface InterruptionClaimBase {
  readonly ownerId: string
  readonly runId: string
  readonly at: string
  readonly resultAudit: RunMutationAudit
  readonly systemLog: { readonly eventType: string; readonly data: string }
}

export type ClaimRunInterruptionInput =
  | (InterruptionClaimBase & {
      readonly kind: "cancel"
      readonly requestAudit: RunMutationAudit
    })
  | (InterruptionClaimBase & {
      readonly kind: "timeout"
    })

export interface ClaimRunInterruptionResult {
  readonly outcome: "claimed" | "runner_terminal" | "already_terminal" | "not_due"
  readonly run: Run
}

export interface Page<T> {
  readonly items: readonly T[]
  readonly nextCursor: string | null
}

export interface DurableBlobRoot {
  readonly kind: "workspace" | "artifact"
  readonly ownerId: string
  readonly digest: string
  readonly byteSize: number
  readonly storageKey: string
}

export interface BootstrapIdentityInput {
  readonly ownerId: string
  readonly ownerName: string
  readonly apiKeyId: string
  readonly apiKeyPrefix: string
  readonly apiKeyHash: string
  readonly apiKeyName: string
  readonly createdAt: string
}

export type BootstrapIdentityStatus =
  | "required"
  | "available"
  | "initialized"
  | "matching"
  | "conflict"

export class Store {
  readonly database: Database

  constructor(path: string, options: { readonly?: boolean } = {}) {
    this.database = options.readonly
      ? new Database(path, { readonly: true, strict: true })
      : new Database(path, { create: true, strict: true })
    this.database.exec("PRAGMA foreign_keys = ON")
    this.database.exec("PRAGMA busy_timeout = 5000")
    if (!options.readonly) {
      this.database.exec("PRAGMA journal_mode = WAL")
      this.migrate()
    } else {
      validateMigrationCatalog()
      this.verifyMigrationHistory()
    }
  }

  close(): void {
    this.database.close()
  }

  /** Performs the bounded integrity and writer checks used by diagnostics. */
  assertHealthyWriter(): void {
    const result = this.database.query<{ quick_check: string }, []>("PRAGMA quick_check").get()
    if (result?.quick_check !== "ok") {
      throw new AppError({
        code: "DATABASE_INTEGRITY_FAILED",
        message: "Database integrity check failed",
      })
    }
    this.database.exec("BEGIN IMMEDIATE")
    this.database.exec("ROLLBACK")
  }

  assertQuiescent(): void {
    const state = this.countOperationalState()
    if (
      state.queuedRuns !== 0 ||
      state.activeRuns !== 0 ||
      state.activeRuntimes !== 0 ||
      state.cleanupBacklog !== 0 ||
      state.queuedDeployments !== 0 ||
      state.runningDeployments !== 0
    ) {
      throw new AppError({
        code: "DATA_ROOT_BUSY",
        status: 409,
        message: "Data-root maintenance requires no queued or active work",
        details: state,
      })
    }
  }

  serialize(): Uint8Array {
    const snapshot = Uint8Array.from(this.database.serialize())
    // sqlite3_serialize returns the complete main database, but preserves WAL
    // read/write-version header bytes. A standalone immutable backup has no
    // sidecar WAL, so normalize both file-format bytes to legacy rollback mode.
    if (snapshot.byteLength < 20 || snapshot[18] !== 2 || snapshot[19] !== 2) {
      throw new AppError({
        code: "DATABASE_SNAPSHOT_INVALID",
        message: "SQLite produced an unexpected snapshot format",
      })
    }
    snapshot[18] = 1
    snapshot[19] = 1
    return snapshot
  }

  migrationHistory(): readonly {
    readonly version: number
    readonly name: string
    readonly sha256: string
  }[] {
    return this.database
      .query<{ version: number; name: string; sha256: string }, []>(
        "SELECT version, name, sha256 FROM schema_migrations ORDER BY version",
      )
      .all()
  }

  listDurableBlobRoots(): readonly DurableBlobRoot[] {
    const workspaces = this.database
      .query<{ owner_id: string; digest: string; byte_size: number; storage_key: string }, []>(
        "SELECT owner_id, digest, byte_size, storage_key FROM workspace_bundles",
      )
      .all()
      .map(
        (row): DurableBlobRoot => ({
          kind: "workspace",
          ownerId: row.owner_id,
          digest: row.digest,
          byteSize: row.byte_size,
          storageKey: row.storage_key,
        }),
      )
    const artifacts = this.database
      .query<{ owner_id: string; digest: string; byte_size: number; storage_key: string }, []>(
        "SELECT owner_id, digest, byte_size, storage_key FROM artifacts",
      )
      .all()
      .map(
        (row): DurableBlobRoot => ({
          kind: "artifact",
          ownerId: row.owner_id,
          digest: row.digest,
          byteSize: row.byte_size,
          storageKey: row.storage_key,
        }),
      )
    return [...workspaces, ...artifacts]
  }

  listLocalDeploymentIds(): readonly string[] {
    return this.database
      .query<{ id: string }, []>(
        "SELECT id FROM deployments WHERE target = 'local-static' AND status = 'succeeded' ORDER BY id",
      )
      .all()
      .map(({ id }) => id)
  }

  private migrate(): void {
    validateMigrationCatalog()
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        sha256 TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT
    `)
    const appliedCount = this.verifyMigrationHistory()
    const apply = this.database.transaction(
      (version: number, name: string, sha256: string, sql: string) => {
        this.database.exec(sql)
        this.database
          .query(
            "INSERT INTO schema_migrations(version, name, sha256, applied_at) VALUES (?, ?, ?, ?)",
          )
          .run(version, name, sha256, new Date().toISOString())
      },
    )
    for (const migration of migrations.slice(appliedCount)) {
      apply(migration.version, migration.name, migrationSha256(migration), migration.sql)
    }
  }

  private verifyMigrationHistory(): number {
    let rows: readonly { version: number; name: string; sha256: string }[]
    try {
      rows = this.database
        .query<{ version: number; name: string; sha256: string }, []>(
          "SELECT version, name, sha256 FROM schema_migrations ORDER BY version",
        )
        .all()
    } catch (cause) {
      throw new AppError({
        code: "MIGRATION_HISTORY_INVALID",
        message: "Database migration history is missing or invalid",
        cause,
      })
    }

    if (rows.some((row) => row.version > migrations.length)) {
      throw new AppError({
        code: "DATABASE_TOO_NEW",
        message: "Database was created by a newer Meanwhile version",
      })
    }
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      const expected = migrations[index]
      if (row === undefined || expected === undefined || row.version !== index + 1) {
        throw new AppError({
          code: "MIGRATION_HISTORY_INVALID",
          message: "Database migration history is not a known prefix",
        })
      }
      if (row.name !== expected.name || row.sha256 !== migrationSha256(expected)) {
        throw new AppError({
          code: "MIGRATION_DRIFT",
          message: "Database migration history does not match this build",
        })
      }
    }
    return rows.length
  }

  createOwner(input: { id: string; name: string; createdAt: string }): boolean {
    return (
      this.database
        .query(
          "INSERT INTO owners(id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
        )
        .run(input.id, input.name, input.createdAt).changes === 1
    )
  }

  createApiKey(input: {
    id: string
    ownerId: string
    prefix: string
    hash: string
    name: string
    createdAt: string
  }): void {
    this.database
      .query(
        "INSERT INTO api_keys(id, owner_id, prefix, hash, name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(input.id, input.ownerId, input.prefix, input.hash, input.name, input.createdAt)
  }

  createApiKeyWithAudit(input: {
    key: ApiKey & { readonly hash: string }
    audit: AuditRecord
  }): ApiKey {
    const transaction = this.database.transaction(() => {
      this.createApiKey({
        id: input.key.id,
        ownerId: input.key.ownerId,
        prefix: input.key.prefix,
        hash: input.key.hash,
        name: input.key.name,
        createdAt: input.key.createdAt,
      })
      this.insertAudit(input.audit)
      return input.key
    })
    const created = transaction.immediate()
    return {
      id: created.id,
      ownerId: created.ownerId,
      prefix: created.prefix,
      name: created.name,
      createdAt: created.createdAt,
      lastUsedAt: null,
      revokedAt: null,
    }
  }

  listApiKeys(ownerId: string): readonly ApiKey[] {
    return this.database
      .query<ApiKeyRow, [string]>(
        "SELECT * FROM api_keys WHERE owner_id = ? ORDER BY created_at DESC, id",
      )
      .all(ownerId)
      .map(apiKeyFromRow)
  }

  revokeApiKeyWithAudit(input: {
    ownerId: string
    id: string
    at: string
    audit: AuditRecord
  }): ApiKey | null {
    const transaction = this.database.transaction(() => {
      const key = this.database
        .query<ApiKeyRow, [string, string]>("SELECT * FROM api_keys WHERE owner_id = ? AND id = ?")
        .get(input.ownerId, input.id)
      if (key === null) return null
      if (key.revoked_at !== null) return apiKeyFromRow(key)
      const active = this.database
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM api_keys WHERE owner_id = ? AND revoked_at IS NULL",
        )
        .get(input.ownerId)?.count
      if ((active ?? 0) <= 1) {
        throw new AppError({
          code: "LAST_API_KEY",
          status: 409,
          message: "The last active API key cannot be revoked",
        })
      }
      this.database
        .query("UPDATE api_keys SET revoked_at = ? WHERE owner_id = ? AND id = ?")
        .run(input.at, input.ownerId, input.id)
      this.insertAudit(input.audit)
      return { ...apiKeyFromRow(key), revokedAt: input.at }
    })
    return transaction.immediate()
  }

  isBootstrapIdentityRequired(): boolean {
    const counts = this.database
      .query<{ owners: number; api_keys: number }, []>(`
        SELECT (SELECT COUNT(*) FROM owners) AS owners,
          (SELECT COUNT(*) FROM api_keys) AS api_keys
      `)
      .get()
    return counts?.owners === 0 && counts.api_keys === 0
  }

  inspectBootstrapIdentity(input?: BootstrapIdentityInput): BootstrapIdentityStatus {
    const counts = this.database
      .query<{ owners: number; api_keys: number }, []>(`
        SELECT (SELECT COUNT(*) FROM owners) AS owners,
          (SELECT COUNT(*) FROM api_keys) AS api_keys
      `)
      .get()
    const empty = counts?.owners === 0 && counts.api_keys === 0
    if (empty) return input === undefined ? "required" : "available"
    if (input === undefined) return "initialized"
    const owner = this.database
      .query<{ id: string }, [string]>("SELECT id FROM owners WHERE id = ?")
      .get(input.ownerId)
    const key = this.database
      .query<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE id = ?")
      .get(input.apiKeyId)
    return owner !== null &&
      key?.owner_id === input.ownerId &&
      key.hash === input.apiKeyHash &&
      key.prefix === input.apiKeyPrefix
      ? "matching"
      : "conflict"
  }

  bootstrapIdentity(input: BootstrapIdentityInput): { readonly created: boolean } {
    if (
      !/^mwk_[A-Za-z0-9_-]{12}$/.test(input.apiKeyPrefix) ||
      !/^sha256:[0-9a-f]{64}$/.test(input.apiKeyHash)
    ) {
      throw new AppError({
        code: "INVALID_REQUEST",
        message: "Bootstrap API-key metadata is invalid",
      })
    }

    const transaction = this.database.transaction(() => {
      const status = this.inspectBootstrapIdentity(input)
      if (status === "matching") return { created: false }
      if (status !== "available") {
        throw new AppError({
          code: "BOOTSTRAP_KEY_CONFLICT",
          message: "Bootstrap identity is already initialized with different credentials",
          status: 409,
        })
      }
      this.database
        .query("INSERT INTO owners(id, name, created_at) VALUES (?, ?, ?)")
        .run(input.ownerId, input.ownerName, input.createdAt)
      this.database
        .query(`
            INSERT INTO api_keys(id, owner_id, prefix, hash, name, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `)
        .run(
          input.apiKeyId,
          input.ownerId,
          input.apiKeyPrefix,
          input.apiKeyHash,
          input.apiKeyName,
          input.createdAt,
        )
      this.insertAudit({
        id: crypto.randomUUID(),
        ownerId: input.ownerId,
        actorApiKeyId: null,
        action: "owner.create",
        resourceType: "owner",
        resourceId: input.ownerId,
        requestId: "bootstrap",
        traceId: null,
        metadata: {},
        createdAt: input.createdAt,
      })
      this.insertAudit({
        id: crypto.randomUUID(),
        ownerId: input.ownerId,
        actorApiKeyId: null,
        action: "api_key.create",
        resourceType: "api_key",
        resourceId: input.apiKeyId,
        requestId: "bootstrap",
        traceId: null,
        metadata: { prefix: input.apiKeyPrefix },
        createdAt: input.createdAt,
      })
      return { created: true }
    })
    return transaction.immediate()
  }

  findActiveApiKeysByPrefix(prefix: string): readonly ApiKeyRow[] {
    return this.database
      .query<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE prefix = ? AND revoked_at IS NULL")
      .all(prefix)
  }

  async findByPrefix(prefix: string): Promise<
    readonly {
      id: string
      ownerId: string
      prefix: string
      hash: string
      revokedAt?: Date | null
    }[]
  > {
    return this.findActiveApiKeysByPrefix(prefix).map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      prefix: row.prefix,
      hash: row.hash,
      revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at),
    }))
  }

  touchApiKey(id: string, at: string): void {
    this.database.query("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(at, id)
  }

  revokeApiKey(ownerId: string, id: string, at: string): boolean {
    return (
      this.database
        .query(
          "UPDATE api_keys SET revoked_at = ? WHERE owner_id = ? AND id = ? AND revoked_at IS NULL",
        )
        .run(at, ownerId, id).changes === 1
    )
  }

  createRun(input: CreateRunInput): { run: Run; replayed: boolean } {
    const transaction = this.database.transaction(() => {
      if (input.idempotencyKey !== undefined) {
        if (input.requestHash === undefined) {
          throw new AppError({ code: "INVALID_REQUEST", message: "Request hash is required" })
        }
        const existing = this.database
          .query<{ request_hash: string; run_id: string }, [string, string]>(
            "SELECT request_hash, run_id FROM idempotency_keys WHERE owner_id = ? AND key = ?",
          )
          .get(input.ownerId, input.idempotencyKey)
        if (existing !== null) {
          if (existing.request_hash !== input.requestHash) {
            throw new AppError({
              code: "IDEMPOTENCY_CONFLICT",
              message: "Idempotency key was already used with different input",
            })
          }
          const existingRun = this.getRun(input.ownerId, existing.run_id)
          if (existingRun === null) throw new Error("Idempotency key references a missing run")
          return { run: existingRun, replayed: true }
        }
      }

      this.database
        .query(`
          INSERT INTO runs(
            id, owner_id, workspace_json, agent_type, agent_spec_json, agent_catalog_digest,
            execution_provenance_json,
            prompt, env_json, secret_refs_json, provider, artifact_paths_json, timeout_ms,
            status, status_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?)
        `)
        .run(
          input.id,
          input.ownerId,
          stringify(input.workspace),
          input.agentType,
          stringify(input.agentSpec),
          input.agentCatalogDigest,
          stringify(input.executionProvenance),
          input.prompt,
          stringify(input.env),
          stringify(input.secretRefs),
          input.provider,
          stringify(input.artifactPaths),
          input.timeoutMs,
          input.createdAt,
          input.createdAt,
        )
      this.database
        .query(`
          INSERT INTO run_status_events(
            id, owner_id, run_id, from_status, to_status, status_version, reason, created_at
          ) VALUES (?, ?, ?, NULL, 'queued', 1, 'run.created', ?)
        `)
        .run(crypto.randomUUID(), input.ownerId, input.id, input.createdAt)
      if (input.idempotencyKey !== undefined && input.requestHash !== undefined) {
        this.database
          .query(
            "INSERT INTO idempotency_keys(owner_id, key, request_hash, run_id, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(input.ownerId, input.idempotencyKey, input.requestHash, input.id, input.createdAt)
      }
      this.insertAudit({
        id: crypto.randomUUID(),
        ownerId: input.ownerId,
        actorApiKeyId: input.audit.actorApiKeyId,
        action: "run.create",
        resourceType: "run",
        resourceId: input.id,
        requestId: input.audit.requestId,
        traceId: input.audit.traceId,
        metadata: input.audit.metadata,
        createdAt: input.createdAt,
      })
      const created = this.getRun(input.ownerId, input.id)
      if (created === null) throw new Error("Created run is missing")
      return { run: created, replayed: false }
    })
    return transaction()
  }

  getIdempotentRun(ownerId: string, key: string, requestHash: string): Run | null {
    const existing = this.database
      .query<{ request_hash: string; run_id: string }, [string, string]>(
        "SELECT request_hash, run_id FROM idempotency_keys WHERE owner_id = ? AND key = ?",
      )
      .get(ownerId, key)
    if (existing === null) return null
    if (existing.request_hash !== requestHash) {
      throw new AppError({
        code: "IDEMPOTENCY_CONFLICT",
        message: "Idempotency key was already used with different input",
      })
    }
    const run = this.getRun(ownerId, existing.run_id)
    if (run === null) {
      throw new AppError({ code: "INTERNAL", message: "Idempotency record is inconsistent" })
    }
    return run
  }

  getRun(ownerId: string, runId: string): Run | null {
    const row = this.database
      .query<RunRow, [string, string]>("SELECT * FROM runs WHERE owner_id = ? AND id = ?")
      .get(ownerId, runId)
    return row === null ? null : runFromRow(row)
  }

  getRunInternal(runId: string): Run | null {
    const row = this.database.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(runId)
    return row === null ? null : runFromRow(row)
  }

  listRuns(ownerId: string, options: { limit: number; before?: string }): Page<Run> {
    const limit = Math.min(Math.max(options.limit, 1), 100)
    const cursor = options.before === undefined ? null : decodeCreatedCursor(options.before, "Run")
    const rows =
      cursor === null
        ? this.database
            .query<RunRow, [string, number]>(
              "SELECT * FROM runs WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
            )
            .all(ownerId, limit + 1)
        : this.database
            .query<RunRow, [string, string, string, string, number]>(
              `SELECT * FROM runs
             WHERE owner_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
             ORDER BY created_at DESC, id DESC LIMIT ?`,
            )
            .all(ownerId, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1)
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map(runFromRow)
    const last = items.at(-1)
    return { items, nextCursor: hasMore && last !== undefined ? encodeCreatedCursor(last) : null }
  }

  listClaimableRuns(limit: number): readonly Run[] {
    return this.database
      .query<RunRow, [number]>(
        "SELECT * FROM runs WHERE status = 'queued' ORDER BY created_at LIMIT ?",
      )
      .all(Math.min(Math.max(limit, 1), 100))
      .map(runFromRow)
  }

  listRecoverableRuns(): readonly Run[] {
    return this.database
      .query<RunRow, []>(
        "SELECT * FROM runs WHERE status IN ('provisioning','running') ORDER BY updated_at",
      )
      .all()
      .map(runFromRow)
  }

  countOperationalState(): {
    readonly queuedRuns: number
    readonly activeRuns: number
    readonly activeRuntimes: number
    readonly cleanupBacklog: number
    readonly queuedDeployments: number
    readonly runningDeployments: number
  } {
    const row = this.database
      .query<
        {
          queued_runs: number
          active_runs: number
          active_runtimes: number
          cleanup_backlog: number
          queued_deployments: number
          running_deployments: number
        },
        []
      >(`
        SELECT
          (SELECT COUNT(*) FROM runs WHERE status = 'queued') AS queued_runs,
          (SELECT COUNT(*) FROM runs WHERE status IN ('provisioning','running')) AS active_runs,
          (SELECT COUNT(*) FROM runtime_instances ri
            JOIN runs r ON r.owner_id = ri.owner_id AND r.id = ri.run_id
            WHERE ri.destroyed_at IS NULL AND r.status IN ('provisioning','running')) AS active_runtimes,
          (SELECT COUNT(*) FROM runtime_instances
            WHERE cleanup_status != 'succeeded' AND cleanup_next_attempt_at IS NOT NULL)
            AS cleanup_backlog,
          (SELECT COUNT(*) FROM deployments WHERE status = 'queued') AS queued_deployments,
          (SELECT COUNT(*) FROM deployments WHERE status = 'running') AS running_deployments
      `)
      .get()
    if (row === null)
      throw new AppError({ code: "INTERNAL", message: "Operational state is missing" })
    return {
      queuedRuns: row.queued_runs,
      activeRuns: row.active_runs,
      activeRuntimes: row.active_runtimes,
      cleanupBacklog: row.cleanup_backlog,
      queuedDeployments: row.queued_deployments,
      runningDeployments: row.running_deployments,
    }
  }

  requestCancellation(ownerId: string, runId: string, at: string, audit?: AuditRecord): Run | null {
    const transaction = this.database.transaction(() => {
      const result = this.database
        .query(
          "UPDATE runs SET cancellation_requested_at = COALESCE(cancellation_requested_at, ?), updated_at = ? WHERE owner_id = ? AND id = ?",
        )
        .run(at, at, ownerId, runId)
      if (result.changes === 0) return null
      if (audit !== undefined) this.insertAudit(audit)
      return this.getRun(ownerId, runId)
    })
    return transaction()
  }

  claimRunInterruption(input: ClaimRunInterruptionInput): ClaimRunInterruptionResult | null {
    const transaction = this.database.transaction((): ClaimRunInterruptionResult | null => {
      const run = this.getRun(input.ownerId, input.runId)
      if (run === null) return null
      if (isTerminalRunStatus(run.status)) return { outcome: "already_terminal", run }
      const session = this.database
        .query<{ terminal_result_json: string | null }, [string, string]>(
          "SELECT terminal_result_json FROM runner_sessions WHERE owner_id = ? AND run_id = ?",
        )
        .get(run.ownerId, run.id)
      if (session?.terminal_result_json != null) return { outcome: "runner_terminal", run }
      if (
        input.kind === "timeout" &&
        (run.status === "queued" || run.deadlineAt === null || run.deadlineAt > input.at)
      ) {
        return { outcome: "not_due", run }
      }

      const toStatus = input.kind === "cancel" ? "cancelled" : "timed_out"
      const changed = this.database
        .query(`
          UPDATE runs SET status = ?, status_version = status_version + 1,
            cancellation_requested_at = CASE WHEN ? = 'cancel' THEN COALESCE(cancellation_requested_at, ?) ELSE cancellation_requested_at END,
            finished_at = ?, error_json = NULL, exit_code = NULL, updated_at = ?
          WHERE owner_id = ? AND id = ? AND status = ? AND status_version = ?
        `)
        .run(
          toStatus,
          input.kind,
          input.at,
          input.at,
          input.at,
          run.ownerId,
          run.id,
          run.status,
          run.statusVersion,
        )
      if (changed.changes !== 1) {
        throw new AppError({ code: "INTERNAL", message: "Run interruption claim was lost" })
      }
      const claimed = this.getRun(run.ownerId, run.id)
      if (claimed === null)
        throw new AppError({ code: "INTERNAL", message: "Claimed run is missing" })
      this.database
        .query(`
          INSERT INTO run_status_events(
            id, owner_id, run_id, from_status, to_status, status_version, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          crypto.randomUUID(),
          run.ownerId,
          run.id,
          run.status,
          toStatus,
          claimed.statusVersion,
          input.resultAudit.action,
          input.at,
        )
      const writeAudit = (audit: RunMutationAudit): void =>
        this.insertAudit({
          id: crypto.randomUUID(),
          ownerId: run.ownerId,
          actorApiKeyId: audit.actorApiKeyId,
          action: audit.action,
          resourceType: "run",
          resourceId: run.id,
          requestId: audit.requestId,
          traceId: audit.traceId,
          metadata: audit.metadata,
          createdAt: input.at,
        })
      if (input.kind === "cancel") writeAudit(input.requestAudit)
      writeAudit(input.resultAudit)
      const log = this.insertNextRunLog({
        ownerId: run.ownerId,
        runId: run.id,
        stream: "system",
        eventType: input.systemLog.eventType,
        data: input.systemLog.data,
        createdAt: input.at,
      })
      if (log === null) throw new AppError({ code: "INTERNAL", message: "Run log claim was lost" })
      return { outcome: "claimed", run: claimed }
    })
    return transaction.immediate()
  }

  isCancellationRequested(runId: string): boolean {
    const row = this.database
      .query<{ requested: number }, [string]>(
        "SELECT cancellation_requested_at IS NOT NULL AS requested FROM runs WHERE id = ?",
      )
      .get(runId)
    return row?.requested === 1
  }

  transitionRun(input: TransitionRunInput): Run | null {
    if (!canTransitionRun(input.expectedStatus, input.toStatus)) {
      throw new AppError({
        code: "INVALID_STATE_TRANSITION",
        message: `Cannot transition run from ${input.expectedStatus} to ${input.toStatus}`,
      })
    }
    const transaction = this.database.transaction(() => {
      const terminal = isTerminalRunStatus(input.toStatus)
      const result = this.database
        .query(`
          UPDATE runs SET
            status = ?,
            status_version = status_version + 1,
            deadline_at = COALESCE(?, deadline_at),
            started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
            finished_at = CASE WHEN ? THEN ? ELSE finished_at END,
            error_json = ?,
            exit_code = ?,
            updated_at = ?
          WHERE id = ? AND status = ? AND status_version = ?
        `)
        .run(
          input.toStatus,
          input.deadlineAt ?? null,
          input.toStatus,
          input.at,
          terminal ? 1 : 0,
          input.at,
          input.error === undefined || input.error === null ? null : stringify(input.error),
          input.exitCode ?? null,
          input.at,
          input.runId,
          input.expectedStatus,
          input.expectedVersion,
        )
      if (result.changes !== 1) return null
      const run = this.getRunInternal(input.runId)
      if (run === null) throw new Error("Transitioned run is missing")
      this.database
        .query(`
          INSERT INTO run_status_events(
            id, owner_id, run_id, from_status, to_status, status_version, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          crypto.randomUUID(),
          run.ownerId,
          run.id,
          input.expectedStatus,
          input.toStatus,
          run.statusVersion,
          input.reason,
          input.at,
        )
      this.insertAudit({
        id: crypto.randomUUID(),
        ownerId: run.ownerId,
        actorApiKeyId: input.audit.actorApiKeyId,
        action: input.audit.action,
        resourceType: "run",
        resourceId: run.id,
        requestId: input.audit.requestId,
        traceId: input.audit.traceId,
        metadata: input.audit.metadata,
        createdAt: input.at,
      })
      if (input.systemLog !== undefined) {
        const log = this.insertNextRunLog({
          ownerId: run.ownerId,
          runId: run.id,
          stream: "system",
          eventType: input.systemLog.eventType,
          data: input.systemLog.data,
          createdAt: input.at,
        })
        if (log === null)
          throw new AppError({ code: "INTERNAL", message: "Run log claim was lost" })
      }
      return run
    })
    return transaction()
  }

  setRunRuntime(input: {
    runId: string
    runtimeId: string
    processId?: string | null
    at: string
  }): boolean {
    return (
      this.database
        .query(
          "UPDATE runs SET runtime_id = ?, process_id = COALESCE(?, process_id), updated_at = ? WHERE id = ? AND status IN ('provisioning','running')",
        )
        .run(input.runtimeId, input.processId ?? null, input.at, input.runId).changes === 1
    )
  }

  setRunResolvedRevision(runId: string, revision: string, at: string): boolean {
    if (!/^[0-9a-f]{40,64}$/.test(revision)) {
      throw new AppError({ code: "INVALID_REQUEST", message: "Resolved revision is invalid" })
    }
    const result = this.database
      .query(`
        UPDATE runs SET resolved_revision = ?, updated_at = ?
        WHERE id = ? AND (resolved_revision IS NULL OR resolved_revision = ?)
      `)
      .run(revision, at, runId, revision)
    if (result.changes === 1) return true
    const existing = this.getRunInternal(runId)
    if (existing === null) return false
    throw new AppError({
      code: "RUNNER_EVIDENCE_CONFLICT",
      message: "Resolved revision conflicts with persisted run intent",
      status: 409,
    })
  }

  listRunStatusEvents(ownerId: string, runId: string): readonly RunStatusEvent[] {
    return this.database
      .query<
        {
          id: string
          owner_id: string
          run_id: string
          from_status: RunStatus | null
          to_status: RunStatus
          status_version: number
          reason: string
          created_at: string
        },
        [string, string]
      >("SELECT * FROM run_status_events WHERE owner_id = ? AND run_id = ? ORDER BY status_version")
      .all(ownerId, runId)
      .map((row) => ({
        id: row.id,
        ownerId: row.owner_id,
        runId: row.run_id,
        fromStatus: row.from_status,
        toStatus: row.to_status,
        statusVersion: row.status_version,
        reason: row.reason,
        createdAt: row.created_at,
      }))
  }

  acceptRunnerFrame(input: AcceptRunnerFrameInput): AcceptRunnerFrameResult {
    const terminalJson = input.terminalResult === undefined ? null : stringify(input.terminalResult)
    if (
      (input.eventType === "terminal") !== (terminalJson !== null) ||
      (terminalJson !== null && terminalJson !== input.data) ||
      (input.eventType === "session.started") !== (input.runningTransition !== undefined)
    ) {
      throw new AppError({
        code: "RUNNER_EVIDENCE_CONFLICT",
        message: "Runner evidence is inconsistent with its event type",
        status: 409,
      })
    }

    const transaction = this.database.transaction((): AcceptRunnerFrameResult => {
      const run = this.getRun(input.ownerId, input.runId)
      if (run === null) {
        throw new AppError({ code: "NOT_FOUND", message: "Run not found" })
      }
      const existing = this.database
        .query<
          {
            owner_id: string
            run_id: string
            sequence: number
            stream: RunLogChunk["stream"]
            event_type: string
            data: string
            runner_session_id: string
            runner_sequence: number
            provider_cursor: string | null
            created_at: string
          },
          [string, string, number]
        >(`
          SELECT * FROM run_logs
          WHERE run_id = ? AND runner_session_id = ? AND runner_sequence = ?
        `)
        .get(input.runId, input.runnerSessionId, input.runnerSequence)
      if (existing !== null) {
        const persistedSession = this.database
          .query<RunnerSessionRow, [string]>("SELECT * FROM runner_sessions WHERE run_id = ?")
          .get(input.runId)
        if (
          existing.owner_id !== input.ownerId ||
          existing.run_id !== input.runId ||
          existing.stream !== input.stream ||
          existing.event_type !== input.eventType ||
          existing.data !== input.data ||
          existing.runner_session_id !== input.runnerSessionId ||
          existing.runner_sequence !== input.runnerSequence ||
          existing.provider_cursor !== input.providerCursor ||
          existing.created_at !== input.createdAt ||
          persistedSession === null ||
          persistedSession.owner_id !== input.ownerId ||
          persistedSession.runner_session_id !== input.runnerSessionId ||
          persistedSession.protocol_version !== input.protocolVersion ||
          (terminalJson !== null && persistedSession.terminal_result_json !== terminalJson)
        ) {
          throw new AppError({
            code: "RUNNER_EVIDENCE_CONFLICT",
            message: "Runner sequence conflicts with immutable accepted evidence",
            status: 409,
          })
        }
        return {
          accepted: false,
          log: runLogFromEvidenceRow(existing),
          run,
        }
      }

      const session = this.database
        .query<RunnerSessionRow, [string]>("SELECT * FROM runner_sessions WHERE run_id = ?")
        .get(input.runId)
      if (
        session === null ||
        session.owner_id !== input.ownerId ||
        session.runner_session_id !== input.runnerSessionId ||
        session.protocol_version !== input.protocolVersion ||
        session.runner_sequence + 1 !== input.runnerSequence ||
        session.terminal_result_json !== null
      ) {
        throw new AppError({
          code: "RUNNER_EVIDENCE_CONFLICT",
          message: "Runner evidence does not extend the persisted session",
          status: 409,
        })
      }

      const sequence =
        this.database
          .query<{ sequence: number }, [string]>(
            "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM run_logs WHERE run_id = ?",
          )
          .get(input.runId)?.sequence ?? 1
      this.database
        .query(`
          INSERT INTO run_logs(
            owner_id, run_id, sequence, stream, event_type, data, runner_session_id,
            runner_sequence, provider_cursor, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.ownerId,
          input.runId,
          sequence,
          input.stream,
          input.eventType,
          input.data,
          input.runnerSessionId,
          input.runnerSequence,
          input.providerCursor,
          input.createdAt,
        )
      const advanced = this.database
        .query(`
          UPDATE runner_sessions SET provider_cursor = ?, runner_sequence = ?,
            terminal_result_json = COALESCE(?, terminal_result_json), updated_at = ?
          WHERE owner_id = ? AND run_id = ? AND runner_session_id = ?
            AND protocol_version = ? AND runner_sequence = ? AND terminal_result_json IS NULL
        `)
        .run(
          input.providerCursor,
          input.runnerSequence,
          terminalJson,
          input.createdAt,
          input.ownerId,
          input.runId,
          input.runnerSessionId,
          input.protocolVersion,
          input.runnerSequence - 1,
        )
      if (advanced.changes !== 1) {
        throw new AppError({
          code: "RUNNER_EVIDENCE_CONFLICT",
          message: "Runner evidence session claim was lost",
          status: 409,
        })
      }

      let resultingRun = run
      if (input.runningTransition !== undefined) {
        if (run.status !== "provisioning") {
          throw new AppError({
            code: "RUNNER_EVIDENCE_CONFLICT",
            message: "Session-start evidence conflicts with run state",
            status: 409,
          })
        }
        const at = input.runningTransition.at
        const transitioned = this.database
          .query(`
            UPDATE runs SET status = 'running', status_version = status_version + 1,
              started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE owner_id = ? AND id = ? AND status = 'provisioning' AND status_version = ?
          `)
          .run(at, at, run.ownerId, run.id, run.statusVersion)
        if (transitioned.changes !== 1) {
          throw new AppError({
            code: "RUNNER_EVIDENCE_CONFLICT",
            message: "Session-start run claim was lost",
            status: 409,
          })
        }
        resultingRun = this.getRun(run.ownerId, run.id) as Run
        this.database
          .query(`
            INSERT INTO run_status_events(
              id, owner_id, run_id, from_status, to_status, status_version, reason, created_at
            ) VALUES (?, ?, ?, 'provisioning', 'running', ?, ?, ?)
          `)
          .run(
            crypto.randomUUID(),
            run.ownerId,
            run.id,
            resultingRun.statusVersion,
            input.runningTransition.reason,
            at,
          )
        this.insertAudit({
          id: crypto.randomUUID(),
          ownerId: run.ownerId,
          actorApiKeyId: input.runningTransition.audit.actorApiKeyId,
          action: input.runningTransition.audit.action,
          resourceType: "run",
          resourceId: run.id,
          requestId: input.runningTransition.audit.requestId,
          traceId: input.runningTransition.audit.traceId,
          metadata: input.runningTransition.audit.metadata,
          createdAt: at,
        })
        const log = this.insertNextRunLog({
          ownerId: run.ownerId,
          runId: run.id,
          stream: "system",
          eventType: input.runningTransition.systemLog.eventType,
          data: input.runningTransition.systemLog.data,
          createdAt: at,
        })
        if (log === null)
          throw new AppError({ code: "INTERNAL", message: "Run log claim was lost" })
      }

      return {
        accepted: true,
        log: {
          ownerId: input.ownerId,
          runId: input.runId,
          sequence,
          stream: input.stream,
          eventType: input.eventType,
          data: input.data,
          runnerSessionId: input.runnerSessionId,
          runnerSequence: input.runnerSequence,
          createdAt: input.createdAt,
        },
        run: resultingRun,
      }
    })
    return transaction.immediate()
  }

  appendRunLog(chunk: RunLogChunk): boolean {
    return (
      this.database
        .query(`
          INSERT INTO run_logs(
            owner_id, run_id, sequence, stream, event_type, data,
            runner_session_id, runner_sequence, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
        `)
        .run(
          chunk.ownerId,
          chunk.runId,
          chunk.sequence,
          chunk.stream,
          chunk.eventType,
          chunk.data,
          chunk.runnerSessionId ?? null,
          chunk.runnerSequence ?? null,
          chunk.createdAt,
        ).changes === 1
    )
  }

  appendRunLogNext(input: Omit<RunLogChunk, "sequence">): RunLogChunk | null {
    const transaction = this.database.transaction(() => this.insertNextRunLog(input))
    return transaction.immediate()
  }

  private insertNextRunLog(input: Omit<RunLogChunk, "sequence">): RunLogChunk | null {
    if (input.runnerSessionId !== undefined && input.runnerSequence !== undefined) {
      const existing = this.database
        .query<{ sequence: number }, [string, string, number]>(`
          SELECT sequence FROM run_logs
          WHERE run_id = ? AND runner_session_id = ? AND runner_sequence = ?
        `)
        .get(input.runId, input.runnerSessionId, input.runnerSequence)
      if (existing !== null) return null
    }
    const row = this.database
      .query<{ sequence: number }, [string]>(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM run_logs WHERE run_id = ?",
      )
      .get(input.runId)
    const chunk: RunLogChunk = { ...input, sequence: row?.sequence ?? 1 }
    if (!this.appendRunLog(chunk)) return null
    return chunk
  }

  listRunLogs(
    ownerId: string,
    runId: string,
    after: number,
    limit: number,
  ): readonly RunLogChunk[] {
    return this.database
      .query<
        {
          owner_id: string
          run_id: string
          sequence: number
          stream: RunLogChunk["stream"]
          event_type: string
          data: string
          runner_session_id: string | null
          runner_sequence: number | null
          created_at: string
        },
        [string, string, number, number]
      >(`
        SELECT * FROM run_logs
        WHERE owner_id = ? AND run_id = ? AND sequence > ?
        ORDER BY sequence LIMIT ?
      `)
      .all(ownerId, runId, after, Math.min(Math.max(limit, 1), 1000))
      .map((row) => ({
        ownerId: row.owner_id,
        runId: row.run_id,
        sequence: row.sequence,
        stream: row.stream,
        eventType: row.event_type,
        data: row.data,
        ...(row.runner_session_id === null ? {} : { runnerSessionId: row.runner_session_id }),
        ...(row.runner_sequence === null ? {} : { runnerSequence: row.runner_sequence }),
        createdAt: row.created_at,
      }))
  }

  createRuntime(runtime: RuntimeInstance, audit?: AuditRecord): void {
    const transaction = this.database.transaction(() => {
      this.database
        .query(`
        INSERT INTO runtime_instances(
          id, owner_id, run_id, provider, handle_json, process_handle_json, cleanup_status,
          cleanup_attempts, cleanup_last_error_json, cleanup_next_attempt_at, created_at, updated_at, destroyed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          runtime.id,
          runtime.ownerId,
          runtime.runId,
          runtime.provider,
          stringify(runtime.handle),
          runtime.processHandle === null ? null : stringify(runtime.processHandle),
          runtime.cleanupStatus,
          runtime.cleanupAttempts,
          runtime.cleanupLastError === null ? null : stringify(runtime.cleanupLastError),
          runtime.cleanupNextAttemptAt,
          runtime.createdAt,
          runtime.updatedAt,
          runtime.destroyedAt,
        )
      if (audit !== undefined) this.insertAudit(audit)
    })
    transaction()
  }

  getRuntimeForRun(runId: string): RuntimeInstance | null {
    const row = this.database
      .query<RuntimeRow, [string]>("SELECT * FROM runtime_instances WHERE run_id = ?")
      .get(runId)
    return row === null ? null : runtimeFromRow(row)
  }

  setRuntimeProcess(
    runtimeId: string,
    handle: JsonObject,
    at: string,
    audit?: AuditRecord,
  ): boolean {
    const transaction = this.database.transaction(() => {
      const changed =
        this.database
          .query(
            "UPDATE runtime_instances SET process_handle_json = ?, updated_at = ? WHERE id = ?",
          )
          .run(stringify(handle), at, runtimeId).changes === 1
      if (changed && audit !== undefined) this.insertAudit(audit)
      return changed
    })
    return transaction()
  }

  markRuntimeCleanupPending(runtimeId: string, at: string): void {
    this.database
      .query(`
        UPDATE runtime_instances SET cleanup_status = 'pending', cleanup_next_attempt_at = ?,
          updated_at = ? WHERE id = ? AND cleanup_status IN ('pending','failed')
      `)
      .run(at, at, runtimeId)
  }

  recoverInterruptedRuntimeCleanups(at: string): number {
    const error: StructuredError = {
      code: "CLEANUP_INTERRUPTED",
      message: "Runtime cleanup was interrupted and will be reconciled",
      retryable: true,
    }
    return this.database
      .query(`
        UPDATE runtime_instances SET cleanup_status = 'failed',
          cleanup_last_error_json = ?, cleanup_next_attempt_at = ?, updated_at = ?
        WHERE cleanup_status = 'running'
      `)
      .run(stringify(error), at, at).changes
  }

  listCleanupEligible(at: string, limit: number, maxAttempts = 5): readonly RuntimeInstance[] {
    return this.database
      .query<RuntimeRow, [number, string, number]>(`
        SELECT ri.* FROM runtime_instances ri
        JOIN runs r ON r.owner_id = ri.owner_id AND r.id = ri.run_id
        WHERE r.status IN ('succeeded','failed','cancelled','timed_out')
          AND ri.cleanup_status IN ('pending','failed')
          AND ri.cleanup_attempts < ?
          AND ri.cleanup_next_attempt_at IS NOT NULL AND ri.cleanup_next_attempt_at <= ?
        ORDER BY ri.updated_at LIMIT ?
      `)
      .all(maxAttempts, at, Math.min(Math.max(limit, 1), 100))
      .map(runtimeFromRow)
  }

  claimRuntimeCleanup(runtimeId: string, at: string): boolean {
    return (
      this.database
        .query(`
          UPDATE runtime_instances SET cleanup_status = 'running',
            cleanup_attempts = cleanup_attempts + 1, updated_at = ?
          WHERE id = ? AND cleanup_status IN ('pending','failed')
        `)
        .run(at, runtimeId).changes === 1
    )
  }

  finishRuntimeCleanup(input: {
    runtimeId: string
    at: string
    succeeded: boolean
    error?: StructuredError
    nextAttemptAt?: string
    audit: AuditRecord
  }): void {
    const transaction = this.database.transaction(() => {
      const result = this.database
        .query(`
          UPDATE runtime_instances SET cleanup_status = ?, cleanup_last_error_json = ?,
            cleanup_next_attempt_at = ?, destroyed_at = ?, updated_at = ?
          WHERE id = ? AND cleanup_status = 'running'
        `)
        .run(
          input.succeeded ? "succeeded" : "failed",
          input.error === undefined ? null : stringify(input.error),
          input.succeeded ? null : (input.nextAttemptAt ?? null),
          input.succeeded ? input.at : null,
          input.at,
          input.runtimeId,
        )
      if (result.changes !== 1) throw new Error("Runtime cleanup claim was lost")
      this.insertAudit(input.audit)
    })
    transaction()
  }

  upsertRunnerSession(session: RunnerSession): void {
    const transaction = this.database.transaction(() => {
      const terminalJson =
        session.terminalResult === null ? null : stringify(session.terminalResult)
      const existing = this.database
        .query<RunnerSessionRow, [string]>("SELECT * FROM runner_sessions WHERE run_id = ?")
        .get(session.runId)
      if (existing === null) {
        this.database
          .query(`
            INSERT INTO runner_sessions(
              run_id, owner_id, runner_session_id, protocol_version, provider_cursor,
              runner_sequence, terminal_result_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            session.runId,
            session.ownerId,
            session.runnerSessionId,
            session.protocolVersion,
            session.providerCursor,
            session.runnerSequence,
            terminalJson,
            session.createdAt,
            session.updatedAt,
          )
        return
      }
      if (
        existing.owner_id !== session.ownerId ||
        existing.runner_session_id !== session.runnerSessionId ||
        existing.protocol_version !== session.protocolVersion ||
        session.runnerSequence < existing.runner_sequence ||
        (existing.terminal_result_json !== null &&
          terminalJson !== null &&
          existing.terminal_result_json !== terminalJson)
      ) {
        throw new AppError({
          code: "RUNNER_EVIDENCE_CONFLICT",
          message: "Runner session conflicts with immutable accepted evidence",
          status: 409,
        })
      }
      this.database
        .query(`
          UPDATE runner_sessions SET provider_cursor = ?, runner_sequence = ?,
            terminal_result_json = COALESCE(?, terminal_result_json), updated_at = ?
          WHERE run_id = ?
        `)
        .run(
          session.providerCursor,
          session.runnerSequence,
          terminalJson,
          session.updatedAt,
          session.runId,
        )
    })
    transaction.immediate()
  }

  getRunnerSession(runId: string): RunnerSession | null {
    const row = this.database
      .query<RunnerSessionRow, [string]>("SELECT * FROM runner_sessions WHERE run_id = ?")
      .get(runId)
    if (row === null) return null
    return {
      runId: row.run_id,
      ownerId: row.owner_id,
      runnerSessionId: row.runner_session_id,
      protocolVersion: row.protocol_version,
      providerCursor: row.provider_cursor,
      runnerSequence: row.runner_sequence,
      terminalResult:
        row.terminal_result_json === null ? null : parse<JsonObject>(row.terminal_result_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  insertArtifact(artifact: Artifact): void {
    this.insertArtifacts([artifact])
  }

  insertArtifacts(artifacts: readonly Artifact[]): void {
    const transaction = this.database.transaction(() => {
      for (const artifact of artifacts) {
        const inserted = this.database
          .query(`
            INSERT INTO artifacts(
              id, owner_id, run_id, logical_path, kind, digest, media_type, byte_size, storage_key,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO NOTHING
          `)
          .run(
            artifact.id,
            artifact.ownerId,
            artifact.runId,
            artifact.logicalPath,
            artifact.kind,
            artifact.digest,
            artifact.mediaType,
            artifact.byteSize,
            artifact.storageKey,
            artifact.createdAt,
          )
        if (inserted.changes === 1) continue
        const existing = this.database
          .query<ArtifactRow, [string]>("SELECT * FROM artifacts WHERE id = ?")
          .get(artifact.id)
        if (existing === null || !sameArtifactIdentity(artifactFromRow(existing), artifact)) {
          throw new AppError({
            code: "INTERNAL",
            message: "Artifact identity conflicts with existing immutable metadata",
          })
        }
      }
    })
    transaction.immediate()
  }

  insertWorkspaceBundle(input: {
    ownerId: string
    id: string
    digest: string
    byteSize: number
    storageKey: string
    createdAt: string
  }): void {
    this.database
      .query(`
        INSERT INTO workspace_bundles(owner_id, id, digest, byte_size, storage_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, id) DO NOTHING
      `)
      .run(input.ownerId, input.id, input.digest, input.byteSize, input.storageKey, input.createdAt)
  }

  getWorkspaceBundle(
    ownerId: string,
    id: string,
  ): {
    ownerId: string
    id: string
    digest: string
    byteSize: number
    storageKey: string
    createdAt: string
  } | null {
    const row = this.database
      .query<
        {
          owner_id: string
          id: string
          digest: string
          byte_size: number
          storage_key: string
          created_at: string
        },
        [string, string]
      >("SELECT * FROM workspace_bundles WHERE owner_id = ? AND id = ?")
      .get(ownerId, id)
    return row === null
      ? null
      : {
          ownerId: row.owner_id,
          id: row.id,
          digest: row.digest,
          byteSize: row.byte_size,
          storageKey: row.storage_key,
          createdAt: row.created_at,
        }
  }

  getArtifact(ownerId: string, artifactId: string): Artifact | null {
    const row = this.database
      .query<ArtifactRow, [string, string]>("SELECT * FROM artifacts WHERE owner_id = ? AND id = ?")
      .get(ownerId, artifactId)
    return row === null ? null : artifactFromRow(row)
  }

  findArtifactByPath(ownerId: string, runId: string, logicalPath: string): Artifact | null {
    const row = this.database
      .query<ArtifactRow, [string, string, string]>(`
        SELECT * FROM artifacts WHERE owner_id = ? AND run_id = ? AND logical_path = ?
        ORDER BY created_at DESC LIMIT 1
      `)
      .get(ownerId, runId, logicalPath)
    return row === null ? null : artifactFromRow(row)
  }

  listArtifacts(ownerId: string, runId: string): readonly Artifact[] {
    return this.database
      .query<ArtifactRow, [string, string]>(
        "SELECT * FROM artifacts WHERE owner_id = ? AND run_id = ? ORDER BY logical_path, created_at",
      )
      .all(ownerId, runId)
      .map(artifactFromRow)
  }

  createDeployment(deployment: Deployment, audit: AuditRecord): Deployment {
    const transaction = this.database.transaction(() => {
      this.database
        .query(`
          INSERT INTO deployments(
            id, owner_id, run_id, artifact_id, target, target_config_json, secret_refs_json,
            status, url, error_json, created_at, started_at, finished_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          deployment.id,
          deployment.ownerId,
          deployment.runId,
          deployment.artifactId,
          deployment.target,
          stringify(deployment.targetConfig),
          stringify(deployment.secretRefs),
          deployment.status,
          deployment.url,
          deployment.error === null ? null : stringify(deployment.error),
          deployment.createdAt,
          deployment.startedAt,
          deployment.finishedAt,
          deployment.updatedAt,
        )
      this.insertAudit(audit)
    })
    transaction()
    const created = this.getDeployment(deployment.ownerId, deployment.id)
    if (created === null) throw new Error("Created deployment is missing")
    return created
  }

  getDeployment(ownerId: string, deploymentId: string): Deployment | null {
    const row = this.database
      .query<DeploymentRow, [string, string]>(
        "SELECT * FROM deployments WHERE owner_id = ? AND id = ?",
      )
      .get(ownerId, deploymentId)
    return row === null ? null : deploymentFromRow(row)
  }

  getDeploymentInternal(deploymentId: string): Deployment | null {
    const row = this.database
      .query<DeploymentRow, [string]>("SELECT * FROM deployments WHERE id = ?")
      .get(deploymentId)
    return row === null ? null : deploymentFromRow(row)
  }

  listDeployments(ownerId: string, options: { limit: number; before?: string }): Page<Deployment> {
    const limit = Math.min(Math.max(options.limit, 1), 100)
    const cursor =
      options.before === undefined ? null : decodeCreatedCursor(options.before, "Deployment")
    const rows =
      cursor === null
        ? this.database
            .query<DeploymentRow, [string, number]>(`
              SELECT * FROM deployments WHERE owner_id = ?
              ORDER BY created_at DESC, id DESC LIMIT ?
            `)
            .all(ownerId, limit + 1)
        : this.database
            .query<DeploymentRow, [string, string, string, string, number]>(`
              SELECT * FROM deployments WHERE owner_id = ?
                AND (created_at < ? OR (created_at = ? AND id < ?))
              ORDER BY created_at DESC, id DESC LIMIT ?
            `)
            .all(ownerId, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1)
    const items = rows.slice(0, limit).map(deploymentFromRow)
    const last = items.at(-1)
    return {
      items,
      nextCursor: rows.length > limit && last !== undefined ? encodeCreatedCursor(last) : null,
    }
  }

  listQueuedDeployments(limit: number): readonly Deployment[] {
    return this.database
      .query<DeploymentRow, [number]>(
        "SELECT * FROM deployments WHERE status = 'queued' ORDER BY created_at LIMIT ?",
      )
      .all(Math.min(Math.max(limit, 1), 100))
      .map(deploymentFromRow)
  }

  listRunningDeployments(limit: number): readonly Deployment[] {
    return this.database
      .query<DeploymentRow, [number]>(
        "SELECT * FROM deployments WHERE status = 'running' ORDER BY updated_at, id LIMIT ?",
      )
      .all(Math.min(Math.max(limit, 1), 100))
      .map(deploymentFromRow)
  }

  transitionDeployment(input: {
    deploymentId: string
    fromStatus: DeploymentStatus
    toStatus: DeploymentStatus
    at: string
    url?: string | null
    error?: StructuredError | null
    audit: AuditRecord
  }): Deployment | null {
    const transaction = this.database.transaction(() => {
      const terminal = input.toStatus === "succeeded" || input.toStatus === "failed"
      const result = this.database
        .query(`
          UPDATE deployments SET status = ?,
            started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
            finished_at = CASE WHEN ? THEN ? ELSE finished_at END,
            url = COALESCE(?, url), error_json = ?, updated_at = ?
          WHERE id = ? AND status = ?
        `)
        .run(
          input.toStatus,
          input.toStatus,
          input.at,
          terminal ? 1 : 0,
          input.at,
          input.url ?? null,
          input.error === undefined || input.error === null ? null : stringify(input.error),
          input.at,
          input.deploymentId,
          input.fromStatus,
        )
      if (result.changes !== 1) return null
      this.insertAudit(input.audit)
      return this.getDeploymentInternal(input.deploymentId)
    })
    return transaction()
  }

  appendDeploymentLog(chunk: DeploymentLogChunk): boolean {
    return (
      this.database
        .query(`
          INSERT INTO deployment_logs(owner_id, deployment_id, sequence, stream, data, created_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(deployment_id, sequence) DO NOTHING
        `)
        .run(
          chunk.ownerId,
          chunk.deploymentId,
          chunk.sequence,
          chunk.stream,
          chunk.data,
          chunk.createdAt,
        ).changes === 1
    )
  }

  appendDeploymentLogNext(input: {
    ownerId: string
    deploymentId: string
    stream: DeploymentLogChunk["stream"]
    data: string
    createdAt: string
  }): DeploymentLogChunk {
    const transaction = this.database.transaction(() => {
      const owned = this.getDeployment(input.ownerId, input.deploymentId)
      if (owned === null) {
        throw new AppError({ code: "NOT_FOUND", message: "Deployment not found" })
      }
      const row = this.database
        .query<{ sequence: number }, [string]>(
          "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM deployment_logs WHERE deployment_id = ?",
        )
        .get(input.deploymentId)
      const sequence = row?.sequence ?? 1
      const chunk: DeploymentLogChunk = { ...input, sequence }
      if (!this.appendDeploymentLog(chunk)) throw new Error("Deployment log sequence collision")
      return chunk
    })
    return transaction.immediate()
  }

  listDeploymentLogs(
    ownerId: string,
    deploymentId: string,
    after: number,
    limit: number,
  ): readonly DeploymentLogChunk[] {
    return this.database
      .query<
        {
          owner_id: string
          deployment_id: string
          sequence: number
          stream: DeploymentLogChunk["stream"]
          data: string
          created_at: string
        },
        [string, string, number, number]
      >(`
        SELECT * FROM deployment_logs
        WHERE owner_id = ? AND deployment_id = ? AND sequence > ?
        ORDER BY sequence LIMIT ?
      `)
      .all(ownerId, deploymentId, after, Math.min(Math.max(limit, 1), 1000))
      .map((row) => ({
        ownerId: row.owner_id,
        deploymentId: row.deployment_id,
        sequence: row.sequence,
        stream: row.stream,
        data: row.data,
        createdAt: row.created_at,
      }))
  }

  insertAudit(record: AuditRecord): void {
    this.database
      .query(`
        INSERT INTO audit_records(
          id, owner_id, actor_api_key_id, action, resource_type, resource_id,
          request_id, trace_id, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.ownerId,
        record.actorApiKeyId,
        record.action,
        record.resourceType,
        record.resourceId,
        record.requestId,
        record.traceId,
        stringify(record.metadata),
        record.createdAt,
      )
  }

  listAudit(ownerId: string, resourceId?: string): readonly AuditRecord[] {
    const rows =
      resourceId === undefined
        ? this.database
            .query<
              {
                id: string
                owner_id: string
                actor_api_key_id: string | null
                action: string
                resource_type: AuditRecord["resourceType"]
                resource_id: string
                request_id: string
                trace_id: string | null
                metadata_json: string
                created_at: string
              },
              [string]
            >("SELECT * FROM audit_records WHERE owner_id = ? ORDER BY created_at, id")
            .all(ownerId)
        : this.database
            .query<
              {
                id: string
                owner_id: string
                actor_api_key_id: string | null
                action: string
                resource_type: AuditRecord["resourceType"]
                resource_id: string
                request_id: string
                trace_id: string | null
                metadata_json: string
                created_at: string
              },
              [string, string]
            >(
              "SELECT * FROM audit_records WHERE owner_id = ? AND resource_id = ? ORDER BY created_at, id",
            )
            .all(ownerId, resourceId)
    return rows.map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      actorApiKeyId: row.actor_api_key_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      requestId: row.request_id,
      traceId: row.trace_id,
      metadata: parse<JsonObject>(row.metadata_json),
      createdAt: row.created_at,
    }))
  }

  listAuditPage(
    ownerId: string,
    options: {
      limit: number
      before?: string
      resourceType?: AuditRecord["resourceType"]
      resourceId?: string
      action?: string
    },
  ): Page<AuditRecord> {
    const limit = Math.min(Math.max(options.limit, 1), 100)
    const cursor =
      options.before === undefined ? null : decodeCreatedCursor(options.before, "Audit")
    const clauses = ["owner_id = ?"]
    const bindings: Bind[] = [ownerId]
    if (options.resourceType !== undefined) {
      clauses.push("resource_type = ?")
      bindings.push(options.resourceType)
    }
    if (options.resourceId !== undefined) {
      clauses.push("resource_id = ?")
      bindings.push(options.resourceId)
    }
    if (options.action !== undefined) {
      clauses.push("action = ?")
      bindings.push(options.action)
    }
    if (cursor !== null) {
      clauses.push("(created_at < ? OR (created_at = ? AND id < ?))")
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id)
    }
    bindings.push(limit + 1)
    const rows = this.database
      .query<
        {
          id: string
          owner_id: string
          actor_api_key_id: string | null
          action: string
          resource_type: AuditRecord["resourceType"]
          resource_id: string
          request_id: string
          trace_id: string | null
          metadata_json: string
          created_at: string
        },
        Bind[]
      >(`
        SELECT * FROM audit_records WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC, id DESC LIMIT ?
      `)
      .all(...bindings)
    const items = rows.slice(0, limit).map(auditFromRow)
    const last = items.at(-1)
    return {
      items,
      nextCursor: rows.length > limit && last !== undefined ? encodeCreatedCursor(last) : null,
    }
  }
}

const auditFromRow = (row: {
  id: string
  owner_id: string
  actor_api_key_id: string | null
  action: string
  resource_type: AuditRecord["resourceType"]
  resource_id: string
  request_id: string
  trace_id: string | null
  metadata_json: string
  created_at: string
}): AuditRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  actorApiKeyId: row.actor_api_key_id,
  action: row.action,
  resourceType: row.resource_type,
  resourceId: row.resource_id,
  requestId: row.request_id,
  traceId: row.trace_id,
  metadata: parse<JsonObject>(row.metadata_json),
  createdAt: row.created_at,
})
