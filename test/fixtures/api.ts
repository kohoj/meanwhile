import type { Deployment, Run, RunLog } from "../../src/api/contracts"
import { digestExecutionProvenance } from "../../src/provenance"

export const API_RUN_ID = "00000000-0000-4000-8000-000000000001"
export const API_OWNER_ID = "00000000-0000-4000-8000-000000000002"
export const API_DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000003"
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
