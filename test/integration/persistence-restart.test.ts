import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "../../src/persistence/store"
import {
  TEST_AGENT_CATALOG_DIGEST,
  testAgentSpec,
  testExecutionProvenanceFor,
} from "../fixtures/agent-intent"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("SQLite persistence", () => {
  test("run history, logs, idempotency, and audit survive a service restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meanwhile-store-"))
    directories.push(directory)
    const path = join(directory, "control-plane.sqlite")
    const createdAt = "2026-07-13T00:00:00.000Z"

    const first = new Store(path)
    first.createOwner({ id: "owner-a", name: "Owner A", createdAt })
    const created = first.createRun({
      id: "run-a",
      ownerId: "owner-a",
      workspace: { type: "repository", url: "https://example.test/repository.git" },
      agentType: "demo",
      agentSpec: testAgentSpec(),
      agentCatalogDigest: TEST_AGENT_CATALOG_DIGEST,
      executionProvenance: testExecutionProvenanceFor("local"),
      prompt: "Create the artifact",
      env: {},
      secretRefs: {},
      provider: "local",
      contextArtifacts: [
        {
          artifactId: "a".repeat(64),
          sourceRunId: "prior-run",
          sourceWorkspace: null,
          path: "findings.md",
          digest: "b".repeat(64),
          mediaType: "text/markdown; charset=utf-8",
          byteSize: 42,
        },
      ],
      artifactPaths: ["dist"],
      timeoutMs: 60_000,
      createdAt,
      idempotencyKey: "request-a",
      requestHash: "sha256:request-a",
      audit: {
        actorApiKeyId: null,
        requestId: "request-a",
        traceId: null,
        metadata: {},
      },
    })
    expect(created.replayed).toBeFalse()
    first.appendRunLog({
      ownerId: "owner-a",
      runId: "run-a",
      sequence: 1,
      stream: "system",
      eventType: "run.queued",
      data: "queued",
      createdAt,
    })
    first.close()

    const second = new Store(path)
    expect(second.getRun("owner-a", "run-a")).toMatchObject({
      status: "queued",
      executionProvenance: testExecutionProvenanceFor("local"),
      contextArtifacts: [
        {
          artifactId: "a".repeat(64),
          sourceRunId: "prior-run",
          sourceWorkspace: null,
          path: "findings.md",
          digest: "b".repeat(64),
          mediaType: "text/markdown; charset=utf-8",
          byteSize: 42,
        },
      ],
    })
    expect(second.listRunLogs("owner-a", "run-a", 0, 10)).toHaveLength(1)
    expect(second.listAudit("owner-a", "run-a").map((record) => record.action)).toEqual([
      "run.create",
    ])
    const replay = second.createRun({
      id: "ignored-new-id",
      ownerId: "owner-a",
      workspace: { type: "repository", url: "https://example.test/repository.git" },
      agentType: "demo",
      agentSpec: testAgentSpec(),
      agentCatalogDigest: TEST_AGENT_CATALOG_DIGEST,
      executionProvenance: testExecutionProvenanceFor("local"),
      prompt: "Create the artifact",
      env: {},
      secretRefs: {},
      provider: "local",
      contextArtifacts: [
        {
          artifactId: "a".repeat(64),
          sourceRunId: "prior-run",
          sourceWorkspace: null,
          path: "findings.md",
          digest: "b".repeat(64),
          mediaType: "text/markdown; charset=utf-8",
          byteSize: 42,
        },
      ],
      artifactPaths: ["dist"],
      timeoutMs: 60_000,
      createdAt,
      idempotencyKey: "request-a",
      requestHash: "sha256:request-a",
      audit: {
        actorApiKeyId: null,
        requestId: "request-retry",
        traceId: null,
        metadata: {},
      },
    })
    expect(replay.replayed).toBeTrue()
    expect(replay.run.id).toBe("run-a")
    second.close()
  })

  test("session workspace basis and turn-scoped context survive restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meanwhile-session-context-store-"))
    directories.push(directory)
    const path = join(directory, "control-plane.sqlite")
    const createdAt = "2026-07-21T00:00:00.000Z"
    const sourceWorkspace = {
      type: "repository" as const,
      url: "https://example.test/repository.git",
      requestedRevision: "main",
      resolvedRevision: "b".repeat(40),
    }

    const first = new Store(path)
    first.createOwner({ id: "owner-session", name: "Session owner", createdAt })
    first.createAgentSession({
      id: "session-context",
      ownerId: "owner-session",
      workspace: {
        type: "repository",
        url: sourceWorkspace.url,
        revision: sourceWorkspace.requestedRevision,
      },
      agentType: "demo",
      agentSpec: testAgentSpec(),
      agentCatalogDigest: TEST_AGENT_CATALOG_DIGEST,
      executionProvenance: testExecutionProvenanceFor("local"),
      env: {},
      secretRefs: {},
      provider: "local",
      idleTimeoutMs: 60_000,
      createdAt,
      audit: {
        actorApiKeyId: null,
        requestId: "session-context",
        traceId: null,
        metadata: {},
      },
    })
    expect(
      first.setAgentSessionResolvedRevision("session-context", "c".repeat(40), createdAt),
    ).toBeTrue()
    first.createSessionTurn({
      id: "turn-context",
      ownerId: "owner-session",
      sessionId: "session-context",
      prompt: "Use the finding",
      contextArtifacts: [
        {
          artifactId: "a".repeat(64),
          sourceRunId: "source-run",
          sourceWorkspace,
          path: "finding.md",
          digest: "d".repeat(64),
          mediaType: "text/markdown; charset=utf-8",
          byteSize: 42,
        },
      ],
      timeoutMs: 60_000,
      conflictPolicy: "reject",
      createdAt,
      audit: {
        actorApiKeyId: null,
        requestId: "turn-context",
        traceId: null,
        metadata: {},
      },
    })
    first.close()

    const second = new Store(path)
    expect(second.getAgentSession("owner-session", "session-context")?.resolvedRevision).toBe(
      "c".repeat(40),
    )
    expect(
      second.getSessionTurn("owner-session", "session-context", "turn-context")?.contextArtifacts,
    ).toEqual([
      expect.objectContaining({
        sourceRunId: "source-run",
        sourceWorkspace,
        digest: "d".repeat(64),
      }),
    ])
    second.close()
  })
})
