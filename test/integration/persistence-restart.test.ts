import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "../../src/persistence/store"
import { TEST_AGENT_CATALOG_DIGEST, testAgentSpec } from "../fixtures/agent-intent"

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
      prompt: "Create the artifact",
      env: {},
      secretRefs: {},
      provider: "local",
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
    expect(second.getRun("owner-a", "run-a")?.status).toBe("queued")
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
      prompt: "Create the artifact",
      env: {},
      secretRefs: {},
      provider: "local",
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
})
