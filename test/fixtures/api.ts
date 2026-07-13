import type {
  AgentSession,
  Deployment,
  Run,
  RunEvent,
  RunLog,
  SessionEvent,
  SessionTurn,
} from "../../src/api/contracts"
import { digestExecutionProvenance } from "../../src/provenance"

export const API_RUN_ID = "00000000-0000-4000-8000-000000000001"
export const API_OWNER_ID = "00000000-0000-4000-8000-000000000002"
export const API_DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000003"
export const API_SESSION_ID = "00000000-0000-4000-8000-000000000004"
export const API_TURN_ID = "00000000-0000-4000-8000-000000000005"
export const API_TIMESTAMP = "2026-07-13T00:00:00.000Z"

export function apiRun(status: Run["status"] = "queued"): Run {
  const executionSnapshot = {
    version: 1 as const,
    agentDefinitionDigest: "b".repeat(64),
    agentCatalogDigest: "c".repeat(64),
    runnerDigest: "d".repeat(64),
    provider: {
      name: "local",
      adapterVersion: "0.1.0",
      capabilitiesDigest: "e".repeat(64),
      runtimeImageReference: null,
      runtimeImageDigest: null,
      bridgeProtocolVersion: null,
    },
  }
  return {
    id: API_RUN_ID,
    ownerId: API_OWNER_ID,
    workspace: { type: "bundle", artifactId: "a".repeat(64) },
    agentType: "demo",
    agentSpec: {
      version: 1,
      catalogVersion: 1,
      definitionDigest: "b".repeat(64),
      executable: "meanwhile-demo-agent",
      args: [],
      workingDirectory: "workspace",
      capabilities: { filesystem: true, terminal: false },
      permissionPolicy: { mode: "allow-once", toolKinds: ["read", "edit"] },
      envNames: [],
      secretEnvNames: [],
    },
    agentCatalogDigest: "c".repeat(64),
    executionProvenance: {
      ...executionSnapshot,
      digest: digestExecutionProvenance(executionSnapshot),
    },
    prompt: "make it work",
    env: {},
    secretRefs: {},
    provider: "local",
    artifactPaths: ["dist"],
    timeoutMs: 60_000,
    deadlineAt: null,
    status,
    statusVersion: status === "queued" ? 1 : 2,
    runtimeId: null,
    processId: null,
    resolvedRevision: null,
    createdAt: API_TIMESTAMP,
    startedAt: status === "queued" ? null : API_TIMESTAMP,
    finishedAt: status === "queued" || status === "running" ? null : API_TIMESTAMP,
    updatedAt: API_TIMESTAMP,
    error: null,
    exitCode: status === "succeeded" ? 0 : null,
  }
}

export function apiRunLog(sequence: number, data: string): RunLog {
  return {
    runId: API_RUN_ID,
    ownerId: API_OWNER_ID,
    sequence,
    stream: "agent",
    eventType: "agent.message",
    data,
    createdAt: API_TIMESTAMP,
  }
}

export function apiRunEvent(sequence: number): RunEvent {
  return {
    version: 1,
    runId: API_RUN_ID,
    ownerId: API_OWNER_ID,
    sequence,
    type: "agent.update",
    source: "runner",
    payload: {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `chunk-${sequence}` },
      },
      truncated: false,
    },
    createdAt: API_TIMESTAMP,
  }
}

export function apiDeployment(status: Deployment["status"] = "queued"): Deployment {
  return {
    id: API_DEPLOYMENT_ID,
    ownerId: API_OWNER_ID,
    runId: API_RUN_ID,
    artifactId: "d".repeat(64),
    target: "local-static",
    targetConfig: {},
    secretRefs: {},
    status,
    url: status === "succeeded" ? "http://127.0.0.1:7332/d/example/" : null,
    error: null,
    createdAt: API_TIMESTAMP,
    startedAt: status === "queued" ? null : API_TIMESTAMP,
    finishedAt: status === "succeeded" || status === "failed" ? API_TIMESTAMP : null,
    updatedAt: API_TIMESTAMP,
  }
}

export function apiSession(status: AgentSession["status"] = "idle"): AgentSession {
  const run = apiRun()
  return {
    id: API_SESSION_ID,
    ownerId: API_OWNER_ID,
    workspace: run.workspace,
    agentType: run.agentType,
    agentSpec: run.agentSpec,
    agentCatalogDigest: run.agentCatalogDigest,
    executionProvenance: run.executionProvenance as NonNullable<Run["executionProvenance"]>,
    env: {},
    secretRefs: {},
    provider: "local",
    status,
    statusVersion: status === "queued" ? 1 : 2,
    activeTurnId: status === "running" ? API_TURN_ID : null,
    runtimeId: status === "queued" ? null : `session-${API_SESSION_ID}`,
    processId: status === "queued" ? null : `session-runner-${API_SESSION_ID}`,
    agentSessionId: status === "queued" ? null : "agent-session-1",
    capabilities: status === "queued" ? null : {},
    idleTimeoutMs: 1_800_000,
    createdAt: API_TIMESTAMP,
    startedAt: status === "queued" ? null : API_TIMESTAMP,
    closedAt: ["closed", "failed", "continuity_lost"].includes(status) ? API_TIMESTAMP : null,
    updatedAt: API_TIMESTAMP,
    error: null,
  }
}

export function apiTurn(status: SessionTurn["status"] = "queued"): SessionTurn {
  return {
    id: API_TURN_ID,
    ownerId: API_OWNER_ID,
    sessionId: API_SESSION_ID,
    sequence: 1,
    prompt: "inspect the failure",
    timeoutMs: 60_000,
    deadlineAt: status === "running" ? API_TIMESTAMP : null,
    status,
    statusVersion: status === "queued" ? 1 : 2,
    createdAt: API_TIMESTAMP,
    startedAt: status === "queued" ? null : API_TIMESTAMP,
    finishedAt: ["succeeded", "failed", "interrupted", "timed_out"].includes(status)
      ? API_TIMESTAMP
      : null,
    updatedAt: API_TIMESTAMP,
    error: null,
  }
}

export function apiSessionEvent(sequence: number): SessionEvent {
  return {
    version: 1,
    sessionId: API_SESSION_ID,
    ownerId: API_OWNER_ID,
    sequence,
    turnId: API_TURN_ID,
    type: "turn.update",
    source: "runner",
    payload: {
      turnId: API_TURN_ID,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `chunk-${sequence}` },
      },
      truncated: false,
    },
    createdAt: API_TIMESTAMP,
  }
}
