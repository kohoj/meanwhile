import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CreateRunRequestSchema } from "../../src/api/schemas"
import type { ArtifactStore } from "../../src/artifacts/artifact-store"
import { LocalArtifactStore } from "../../src/artifacts/local-artifact-store"
import { WorkspaceBundleStore } from "../../src/artifacts/workspace-bundle"
import type { RequestContext } from "../../src/domain"
import { Store } from "../../src/persistence/store"
import { EnvironmentSecretResolver } from "../../src/secrets"
import { RunService } from "../../src/services/run-service"
import { permissiveTestAgentIntents, testExecutionProvenance } from "../fixtures/agent-intent"
import { DeterministicClock, OWNER_A, OWNER_B, runInput, TestRunCommands } from "../harness"

const roots: string[] = []
const API_KEY_A = "40000000-0000-4000-8000-00000000000a"
const API_KEY_B = "40000000-0000-4000-8000-00000000000b"

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("workspace admission", () => {
  test("publishes the literal revision grammar in the request schema", () => {
    const request = {
      workspace: {
        type: "repository" as const,
        url: "https://github.com/example/project.git",
        revision: "release/2026.07",
      },
      agentType: "demo",
      prompt: "Run",
    }

    expect(CreateRunRequestSchema.safeParse(request).success).toBe(true)
    for (const revision of ["--upload-pack=attacker", "main^{commit}", "main..other", ".hidden"]) {
      expect(
        CreateRunRequestSchema.safeParse({
          ...request,
          workspace: { ...request.workspace, revision },
        }).success,
      ).toBe(false)
    }
  })

  test("rejects an unsafe repository revision before durable intent or execution", async () => {
    const fixture = await createFixture()
    try {
      await expect(
        fixture.service.create(
          context(OWNER_A),
          runInput({
            workspace: {
              type: "repository",
              url: "https://github.com/example/project.git",
              revision: "--upload-pack=attacker",
            },
            secretRefs: {},
          }),
        ),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" })

      expect((await fixture.service.list(OWNER_A, { limit: 100 })).items).toHaveLength(0)
      expect(fixture.commands.enqueued).toHaveLength(0)
      expect(fixture.artifacts.putCount).toBe(0)
    } finally {
      fixture.close()
    }
  })

  test("requires an existing bundle in the authenticated owner scope", async () => {
    const fixture = await createFixture()
    try {
      const foreign = await fixture.bundles.capture(OWNER_B, [
        { path: "README.md", content: bytes("foreign") },
      ])
      const publishedWrites = fixture.artifacts.putCount

      await expect(
        fixture.service.create(context(OWNER_A), runInput({ workspace: foreign, secretRefs: {} })),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })

      expect((await fixture.service.list(OWNER_A, { limit: 100 })).items).toHaveLength(0)
      expect(fixture.commands.enqueued).toHaveLength(0)
      expect(fixture.artifacts.putCount).toBe(publishedWrites)
    } finally {
      fixture.close()
    }
  })

  test("concurrent identical uploads publish once and create one run", async () => {
    const fixture = await createFixture()
    try {
      const input = runInput({
        workspace: {
          type: "files",
          files: [{ path: "src/main.ts", content: bytes("export const answer = 42") }],
        },
        secretRefs: {},
      })
      const [first, second] = await Promise.all([
        fixture.service.create(context(OWNER_A), input, "upload-once"),
        fixture.service.create(context(OWNER_A), input, "upload-once"),
      ])

      expect([first.replayed, second.replayed].sort()).toEqual([false, true])
      expect(first.run.id).toBe(second.run.id)
      expect(fixture.artifacts.putCount).toBe(2)
      expect(fixture.commands.enqueued).toEqual([first.run.id])
      expect((await fixture.service.list(OWNER_A, { limit: 100 })).items).toHaveLength(1)
    } finally {
      fixture.close()
    }
  })

  test("concurrent conflicting uploads reject the loser without publishing its bytes", async () => {
    const fixture = await createFixture()
    try {
      const results = await Promise.allSettled([
        fixture.service.create(
          context(OWNER_A),
          runInput({
            workspace: {
              type: "files",
              files: [{ path: "value.txt", content: bytes("first") }],
            },
            secretRefs: {},
          }),
          "upload-conflict",
        ),
        fixture.service.create(
          context(OWNER_A),
          runInput({
            workspace: {
              type: "files",
              files: [{ path: "value.txt", content: bytes("second") }],
            },
            secretRefs: {},
          }),
          "upload-conflict",
        ),
      ])

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
      const rejected = results.find((result) => result.status === "rejected")
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: { code: "IDEMPOTENCY_CONFLICT", status: 409 },
      })
      expect(fixture.artifacts.putCount).toBe(2)
      expect(fixture.commands.enqueued).toHaveLength(1)
      expect((await fixture.service.list(OWNER_A, { limit: 100 })).items).toHaveLength(1)
    } finally {
      fixture.close()
    }
  })
})

const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "meanwhile-workspace-admission-"))
  roots.push(root)
  const store = new Store(":memory:")
  const clock = new DeterministicClock()
  const createdAt = clock.now().toISOString()
  store.createOwner({ id: OWNER_A, name: "Owner A", createdAt })
  store.createOwner({ id: OWNER_B, name: "Owner B", createdAt })
  store.createApiKey({
    id: API_KEY_A,
    ownerId: OWNER_A,
    prefix: "mwk_aaaaaaaaaaaa",
    hash: `sha256:${"a".repeat(64)}`,
    name: "Owner A test key",
    createdAt,
  })
  store.createApiKey({
    id: API_KEY_B,
    ownerId: OWNER_B,
    prefix: "mwk_bbbbbbbbbbbb",
    hash: `sha256:${"b".repeat(64)}`,
    name: "Owner B test key",
    createdAt,
  })
  const commands = new TestRunCommands(store, clock)
  const artifacts = new CountingArtifactStore(new LocalArtifactStore(root))
  const bundles = new WorkspaceBundleStore(store, artifacts, {
    maxFiles: 8,
    maxFileBytes: 1_024,
    maxTotalBytes: 4_096,
  })
  let sequence = 0
  const service = new RunService({
    store,
    commands,
    workspaceInputs: bundles,
    agentIntents: permissiveTestAgentIntents,
    secretReferences: new EnvironmentSecretResolver({
      allowedOwnerIds: [OWNER_A, OWNER_B],
    }),
    providerNames: { has: (name) => name === "local" },
    executionProvenance: testExecutionProvenance,
    defaultProvider: "local",
    clock: clock.now,
    id: () => {
      sequence += 1
      return `30000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`
    },
  })
  return {
    store,
    service,
    commands,
    artifacts,
    bundles,
    close: () => store.close(),
  }
}

class CountingArtifactStore implements ArtifactStore {
  putCount = 0

  constructor(private readonly delegate: ArtifactStore) {}

  put(input: Parameters<ArtifactStore["put"]>[0]) {
    this.putCount += 1
    return this.delegate.put(input)
  }

  resolve(...input: Parameters<ArtifactStore["resolve"]>) {
    return this.delegate.resolve(...input)
  }

  stat(...input: Parameters<ArtifactStore["stat"]>) {
    return this.delegate.stat(...input)
  }

  read(...input: Parameters<ArtifactStore["read"]>) {
    return this.delegate.read(...input)
  }
}

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)

const context = (ownerId: string): RequestContext => ({
  ownerId,
  apiKeyId: ownerId === OWNER_A ? API_KEY_A : API_KEY_B,
  requestId: `request-${ownerId}`,
  traceId: null,
})
