export const RUN_STATUSES = [
  "queued",
  "provisioning",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const

export type RunStatus = (typeof RUN_STATUSES)[number]
export type TerminalRunStatus = Extract<
  RunStatus,
  "succeeded" | "failed" | "cancelled" | "timed_out"
>

export const DEPLOYMENT_STATUSES = ["queued", "running", "succeeded", "failed"] as const
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number]

export type CleanupStatus = "pending" | "running" | "succeeded" | "failed"
export type Timestamp = string
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export const AGENT_LAUNCH_SNAPSHOT_VERSION = 1 as const
export const EXECUTION_PROVENANCE_VERSION = 1 as const
export const RUN_EVENT_VERSION = 1 as const
export const SESSION_EVENT_VERSION = 1 as const

export const AGENT_SESSION_STATUSES = [
  "queued",
  "provisioning",
  "idle",
  "running",
  "closing",
  "closed",
  "failed",
  "continuity_lost",
] as const
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number]

export const TURN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "timed_out",
] as const
export type TurnStatus = (typeof TURN_STATUSES)[number]
export type TurnConflictPolicy = "reject" | "enqueue" | "interrupt_and_send"

export type AgentToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other"

export type AgentPermissionPolicy =
  | { readonly mode: "deny-all" }
  | { readonly mode: "allow-once"; readonly toolKinds: readonly AgentToolKind[] }

/** Immutable, self-contained launch policy captured when a run is created. */
export interface AgentLaunchSnapshot {
  readonly version: typeof AGENT_LAUNCH_SNAPSHOT_VERSION
  readonly catalogVersion: 1
  readonly definitionDigest: string
  readonly executable: string
  readonly args: readonly string[]
  readonly workingDirectory: "workspace"
  readonly capabilities: {
    readonly filesystem: boolean
    readonly terminal: boolean
  }
  readonly permissionPolicy: AgentPermissionPolicy
  readonly envNames: readonly string[]
  readonly secretEnvNames: readonly string[]
}

export interface ExecutionProvenance {
  readonly version: typeof EXECUTION_PROVENANCE_VERSION
  readonly agentDefinitionDigest: string
  readonly agentCatalogDigest: string
  readonly runnerDigest: string | null
  readonly provider: {
    readonly name: string
    readonly adapterVersion: string
    readonly capabilitiesDigest: string
    readonly runtimeImageReference: string | null
    readonly runtimeImageDigest: string | null
    readonly bridgeProtocolVersion: number | null
  }
  /** SHA-256 of every preceding field in this snapshot. */
  readonly digest: string
}

export interface RepositoryWorkspaceSource {
  readonly type: "repository"
  readonly url: string
  readonly revision?: string
  readonly credentialRef?: string
}

/**
 * Accepts one portable, literal Git ref or commit name, never a revision
 * expression. The deliberately small grammar keeps user input out of both
 * Git's option parser and its revision-expression language.
 */
export function isSafeRepositoryRevision(value: string): boolean {
  if (value === "HEAD") return true
  if (value.length === 0 || value.length > 255 || value.startsWith("-")) return false

  // A hexadecimal token is treated as a commit abbreviation, not a ref name.
  if (/^[0-9a-f]+$/i.test(value)) return value.length >= 7 && value.length <= 64

  if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(value)) return false
  if (value.endsWith("/") || value.endsWith(".") || value.includes("//")) return false
  if (value.includes("..")) return false

  return value.split("/").every((segment) => !segment.startsWith(".") && !segment.endsWith(".lock"))
}

export interface BundleWorkspaceSource {
  readonly type: "bundle"
  readonly artifactId: string
}

export type WorkspaceSource = RepositoryWorkspaceSource | BundleWorkspaceSource

export interface StructuredError {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly details?: JsonObject
}

export interface Run {
  readonly id: string
  readonly ownerId: string
  readonly workspace: WorkspaceSource
  readonly agentType: string
  readonly agentSpec: AgentLaunchSnapshot
  readonly agentCatalogDigest: string
  readonly executionProvenance: ExecutionProvenance | null
  readonly prompt: string
  readonly env: Readonly<Record<string, string>>
  readonly secretRefs: Readonly<Record<string, string>>
  readonly provider: string
  readonly artifactPaths: readonly string[]
  readonly timeoutMs: number
  readonly deadlineAt: Timestamp | null
  readonly status: RunStatus
  readonly statusVersion: number
  readonly runtimeId: string | null
  readonly processId: string | null
  readonly resolvedRevision: string | null
  readonly createdAt: Timestamp
  readonly startedAt: Timestamp | null
  readonly finishedAt: Timestamp | null
  readonly updatedAt: Timestamp
  readonly error: StructuredError | null
  readonly exitCode: number | null
}

export interface RunStatusEvent {
  readonly id: string
  readonly ownerId: string
  readonly runId: string
  readonly fromStatus: RunStatus | null
  readonly toStatus: RunStatus
  readonly statusVersion: number
  readonly reason: string
  readonly createdAt: Timestamp
}

export type RunLogStream = "stdout" | "stderr" | "agent" | "system"

export interface RunLogChunk {
  readonly runId: string
  readonly ownerId: string
  readonly sequence: number
  readonly stream: RunLogStream
  readonly eventType: string
  readonly data: string
  readonly runnerSessionId?: string
  readonly runnerSequence?: number
  readonly createdAt: Timestamp
}

interface RunEventBase {
  readonly version: typeof RUN_EVENT_VERSION
  readonly runId: string
  readonly ownerId: string
  readonly sequence: number
  readonly createdAt: Timestamp
}

export type RunEvent =
  | (RunEventBase & {
      readonly type: "run.status"
      readonly source: "control-plane"
      readonly payload: {
        readonly fromStatus: RunStatus | null
        readonly toStatus: RunStatus
        readonly statusVersion: number
        readonly reason: string
      }
    })
  | (RunEventBase & {
      readonly type:
        | "runner.started"
        | "agent.initialized"
        | "agent.session_started"
        | "agent.update"
        | "agent.permission"
        | "agent.diagnostic"
        | "agent.stderr"
        | "agent.terminal"
      readonly source: "runner"
      readonly payload: JsonObject
    })
  | (RunEventBase & {
      readonly type: "artifact.captured"
      readonly source: "control-plane"
      readonly payload: {
        readonly artifactId: string
        readonly logicalPath: string
        readonly kind: Artifact["kind"]
        readonly digest: string
        readonly byteSize: number
      }
    })
  | (RunEventBase & {
      readonly type: "runtime.cleanup"
      readonly source: "control-plane"
      readonly payload: {
        readonly runtimeId: string
        readonly status: CleanupStatus
        readonly attempt: number
        readonly error: StructuredError | null
      }
    })
  | (RunEventBase & {
      readonly type: "run.log"
      readonly source: "control-plane" | "runner"
      readonly payload: {
        readonly stream: RunLogStream
        readonly eventType: string
        readonly data: string
      }
    })

export interface AgentSession {
  readonly id: string
  readonly ownerId: string
  readonly workspace: WorkspaceSource
  readonly agentType: string
  readonly agentSpec: AgentLaunchSnapshot
  readonly agentCatalogDigest: string
  readonly executionProvenance: ExecutionProvenance
  readonly env: Readonly<Record<string, string>>
  readonly secretRefs: Readonly<Record<string, string>>
  readonly provider: string
  readonly status: AgentSessionStatus
  readonly statusVersion: number
  readonly activeTurnId: string | null
  readonly runtimeId: string | null
  readonly processId: string | null
  readonly agentSessionId: string | null
  readonly capabilities: JsonObject | null
  readonly idleTimeoutMs: number
  readonly createdAt: Timestamp
  readonly startedAt: Timestamp | null
  readonly closedAt: Timestamp | null
  readonly updatedAt: Timestamp
  readonly error: StructuredError | null
}

export interface SessionTurn {
  readonly id: string
  readonly ownerId: string
  readonly sessionId: string
  readonly sequence: number
  readonly prompt: string
  readonly timeoutMs: number
  readonly deadlineAt: Timestamp | null
  readonly status: TurnStatus
  readonly statusVersion: number
  readonly createdAt: Timestamp
  readonly startedAt: Timestamp | null
  readonly finishedAt: Timestamp | null
  readonly updatedAt: Timestamp
  readonly error: StructuredError | null
}

interface SessionEventBase {
  readonly version: typeof SESSION_EVENT_VERSION
  readonly sessionId: string
  readonly ownerId: string
  readonly sequence: number
  readonly turnId: string | null
  readonly createdAt: Timestamp
}

export type SessionEvent =
  | (SessionEventBase & {
      readonly type: "session.status"
      readonly source: "control-plane"
      readonly payload: {
        readonly fromStatus: AgentSessionStatus | null
        readonly toStatus: AgentSessionStatus
        readonly statusVersion: number
        readonly reason: string
      }
    })
  | (SessionEventBase & {
      readonly type: "turn.status"
      readonly source: "control-plane"
      readonly payload: {
        readonly fromStatus: TurnStatus | null
        readonly toStatus: TurnStatus
        readonly statusVersion: number
        readonly reason: string
      }
    })
  | (SessionEventBase & {
      readonly type:
        | "session.ready"
        | "turn.started"
        | "turn.update"
        | "turn.permission"
        | "agent.stderr"
        | "turn.terminal"
        | "session.closed"
      readonly source: "runner"
      readonly payload: JsonObject
    })
  | (SessionEventBase & {
      readonly type: "session.diagnostic"
      readonly source: "control-plane"
      readonly payload: JsonObject
    })

export interface SessionRuntimeLease {
  readonly sessionId: string
  readonly ownerId: string
  readonly provider: string
  readonly runtimeHandle: JsonObject
  readonly processHandle: JsonObject | null
  readonly providerCursor: string | null
  readonly runnerSequence: number
  readonly commandSequence: number
  readonly cleanupStatus: CleanupStatus
  readonly cleanupAttempts: number
  readonly cleanupLastError: StructuredError | null
  readonly cleanupNextAttemptAt: Timestamp | null
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
  readonly destroyedAt: Timestamp | null
}

export interface RuntimeInstance {
  readonly id: string
  readonly ownerId: string
  readonly runId: string
  readonly provider: string
  readonly handle: JsonObject
  readonly processHandle: JsonObject | null
  readonly cleanupStatus: CleanupStatus
  readonly cleanupAttempts: number
  readonly cleanupLastError: StructuredError | null
  readonly cleanupNextAttemptAt: Timestamp | null
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
  readonly destroyedAt: Timestamp | null
}

export interface RunnerSession {
  readonly runId: string
  readonly ownerId: string
  readonly runnerSessionId: string
  readonly protocolVersion: number
  readonly providerCursor: string | null
  readonly runnerSequence: number
  readonly terminalResult: JsonObject | null
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

export interface Artifact {
  readonly id: string
  readonly ownerId: string
  readonly runId: string
  readonly logicalPath: string
  readonly kind: "file" | "directory" | "workspace"
  readonly digest: string
  readonly mediaType: string
  readonly byteSize: number
  readonly storageKey: string
  readonly createdAt: Timestamp
}

export interface ApiKey {
  readonly id: string
  readonly ownerId: string
  readonly prefix: string
  readonly name: string
  readonly createdAt: Timestamp
  readonly lastUsedAt: Timestamp | null
  readonly revokedAt: Timestamp | null
}

export interface Deployment {
  readonly id: string
  readonly ownerId: string
  readonly runId: string
  readonly artifactId: string
  readonly target: string
  readonly targetConfig: JsonObject
  readonly secretRefs: Readonly<Record<string, string>>
  readonly status: DeploymentStatus
  readonly url: string | null
  readonly error: StructuredError | null
  readonly createdAt: Timestamp
  readonly startedAt: Timestamp | null
  readonly finishedAt: Timestamp | null
  readonly updatedAt: Timestamp
}

export interface DeploymentLogChunk {
  readonly deploymentId: string
  readonly ownerId: string
  readonly sequence: number
  readonly stream: "stdout" | "stderr" | "system"
  readonly data: string
  readonly createdAt: Timestamp
}

export interface AuditRecord {
  readonly id: string
  readonly ownerId: string
  readonly actorApiKeyId: string | null
  readonly action: string
  readonly resourceType:
    | "owner"
    | "api_key"
    | "run"
    | "session"
    | "turn"
    | "runtime"
    | "artifact"
    | "deployment"
  readonly resourceId: string
  readonly requestId: string
  readonly traceId: string | null
  readonly metadata: JsonObject
  readonly createdAt: Timestamp
}

export interface RequestContext {
  readonly requestId: string
  readonly traceId: string | null
  readonly ownerId: string
  readonly apiKeyId: string
}

export const isTerminalRunStatus = (status: RunStatus): status is TerminalRunStatus =>
  status === "succeeded" || status === "failed" || status === "cancelled" || status === "timed_out"

const ALLOWED_RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["provisioning", "cancelled"],
  provisioning: ["running", "failed", "cancelled", "timed_out"],
  running: ["succeeded", "failed", "cancelled", "timed_out"],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
}

export const canTransitionRun = (from: RunStatus, to: RunStatus): boolean =>
  ALLOWED_RUN_TRANSITIONS[from].includes(to)

export const nowIso = (clock: () => Date = () => new Date()): Timestamp => clock().toISOString()
