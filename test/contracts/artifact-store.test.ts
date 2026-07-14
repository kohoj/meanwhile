import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ArtifactStore,
  ArtifactStoreError,
  asSha256Digest,
  decodeArtifactManifest,
  sha256,
} from "../../src/artifacts/artifact-store"
import { LocalArtifactStore } from "../../src/artifacts/local-artifact-store"
import { WorkspaceBundleStore } from "../../src/artifacts/workspace-bundle"
import type { Store } from "../../src/persistence/store"
import {
  ArtifactCollectionError,
  ArtifactCollector,
  artifactMetadata,
  ExactSecretArtifactScanner,
  type WorkspaceEntry,
} from "../../src/services/artifact-collector"

interface ArtifactStoreHarness {
  store: ArtifactStore
  root: string
}

const roots: string[] = []
const TEST_SIGNAL = new AbortController().signal

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

export function artifactStoreContract(
  name: string,
  create: () => Promise<ArtifactStoreHarness>,
): void {
  describe(`${name} artifact store contract`, () => {
    test("stores immutable content-addressed bytes", async () => {
      const { store } = await create()
      const bytes = new TextEncoder().encode("immutable")
      const first = await store.put({ ownerId: "owner-a", bytes })
      const second = await store.put({ ownerId: "owner-a", bytes })

      expect(first).toEqual(second)
      expect(first.digest).toBe(sha256(bytes))
      expect(await store.read("owner-a", first)).toEqual(bytes)
    })

    test("snapshots mutable input before yielding", async () => {
      const { store } = await create()
      const bytes = new TextEncoder().encode("original")
      const expected = bytes.slice()
      const pending = store.put({ ownerId: "owner-a", bytes })

      bytes.fill(0)

      const blob = await pending
      expect(blob.digest).toBe(sha256(expected))
      expect(await store.read("owner-a", blob)).toEqual(expected)
      expect(await store.resolve("owner-a", blob)).toEqual(blob)
      expect(await store.resolve("owner-b", blob)).toBeNull()
    })

    test("does not disclose a blob across owners", async () => {
      const { store } = await create()
      const blob = await store.put({
        ownerId: "owner-a",
        bytes: new TextEncoder().encode("private"),
      })

      await expect(store.read("owner-b", blob)).rejects.toMatchObject({
        code: "ARTIFACT_BLOB_NOT_FOUND",
      })
      await expect(store.stat("owner-b", blob)).rejects.toMatchObject({
        code: "ARTIFACT_BLOB_NOT_FOUND",
      })
    })

    test("rejects an expected digest mismatch", async () => {
      const { store } = await create()
      const expectedDigest = sha256(new TextEncoder().encode("expected"))

      await expect(
        store.put({
          ownerId: "owner-a",
          bytes: new TextEncoder().encode("different"),
          expectedDigest,
        }),
      ).rejects.toMatchObject({ code: "ARTIFACT_BLOB_INVALID" })
    })

    test("concurrent identical writes converge on one reference", async () => {
      const { store } = await create()
      const bytes = new TextEncoder().encode("same bytes")
      const blobs = await Promise.all(
        Array.from({ length: 16 }, () => store.put({ ownerId: "owner-a", bytes })),
      )

      expect(new Set(blobs.map((blob) => blob.storageKey)).size).toBe(1)
      expect(await store.read("owner-a", required(blobs[0]))).toEqual(bytes)
    })
  })
}

artifactStoreContract("local", async () => {
  const root = await mkdtemp(join(tmpdir(), "meanwhile-artifacts-"))
  roots.push(root)
  return { root, store: new LocalArtifactStore(root) }
})

describe("artifact collector", () => {
  test("captures a deterministic declared manifest", async () => {
    const { store } = await createLocalStore()
    const workspace = memoryWorkspace(
      [
        { path: "dist", type: "directory", size: 0 },
        { path: "dist/index.html", type: "file", size: 14 },
        { path: "dist/main.js", type: "file", size: 17 },
      ],
      {
        "dist/index.html": "<h1>Hello</h1>",
        "dist/main.js": "console.log('ok')",
      },
    )
    const collector = new ArtifactCollector({
      store,
      limits: { maxFiles: 10, maxFileBytes: 1_000, maxTotalBytes: 2_000 },
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    })

    const [first] = await collector.collect({
      ownerId: "owner-a",
      runId: "run-a",
      declaredPaths: ["dist"],
      signal: TEST_SIGNAL,
      workspace,
    })
    const [second] = await collector.collect({
      ownerId: "owner-a",
      runId: "run-a",
      declaredPaths: ["dist"],
      signal: TEST_SIGNAL,
      workspace,
    })

    const artifact = required(first)
    const duplicate = required(second)
    expect(artifact.id).toBe(duplicate.id)
    expect(artifact.entries.map((entry) => entry.path)).toEqual(["index.html", "main.js"])
    expect(artifact.size).toBe(31)
    expect(artifact.manifest.digest).toBe(artifact.digest)
    const manifest = decodeArtifactManifest(await store.read("owner-a", artifact.manifest))
    expect(manifest).toMatchObject({
      version: 1,
      runId: "run-a",
      logicalPath: "dist",
      payloadSize: 31,
    })
    expect(manifest.entries.every((entry) => !("storageKey" in entry))).toBe(true)
    expect(artifactMetadata(artifact)).toMatchObject({
      storageKey: artifact.manifest.storageKey,
      byteSize: artifact.manifest.size,
    })
  })

  test("rejects symlinks instead of following them", async () => {
    const { store } = await createLocalStore()
    const collector = new ArtifactCollector({
      store,
      limits: { maxFiles: 10, maxFileBytes: 1_000, maxTotalBytes: 2_000 },
    })
    const workspace = memoryWorkspace(
      [
        { path: "dist", type: "directory", size: 0 },
        { path: "dist/outside", type: "symlink", size: 14 },
      ],
      {},
    )

    await expect(
      collector.collect({
        ownerId: "owner-a",
        runId: "run-a",
        declaredPaths: ["dist"],
        signal: TEST_SIGNAL,
        workspace,
      }),
    ).rejects.toBeInstanceOf(ArtifactCollectionError)
    await expect(
      collector.collect({
        ownerId: "owner-a",
        runId: "run-a",
        declaredPaths: ["dist"],
        signal: TEST_SIGNAL,
        workspace,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_SYMLINK_REJECTED" })
  })

  test("rejects known secret bytes before persistence", async () => {
    const { store } = await createLocalStore()
    const secret = "sk-private-value"
    const collector = new ArtifactCollector({
      store,
      scanner: new ExactSecretArtifactScanner({ API_KEY: secret }),
      limits: { maxFiles: 10, maxFileBytes: 1_000, maxTotalBytes: 2_000 },
    })
    const workspace = memoryWorkspace([{ path: "leak.txt", type: "file", size: secret.length }], {
      "leak.txt": secret,
    })

    await expect(
      collector.collect({
        ownerId: "owner-a",
        runId: "run-a",
        declaredPaths: ["leak.txt"],
        signal: TEST_SIGNAL,
        workspace,
      }),
    ).rejects.toMatchObject({
      code: "ARTIFACT_SECRET_DETECTED",
      details: { ruleId: "resolved-secret" },
    })
  })

  test("does not echo a secret discovered in an artifact path", async () => {
    const { store } = await createLocalStore()
    const secret = "private-path-value"
    const collector = new ArtifactCollector({
      store,
      scanner: new ExactSecretArtifactScanner({ API_KEY: secret }),
      limits: { maxFiles: 10, maxFileBytes: 1_000, maxTotalBytes: 2_000 },
    })

    let failure: unknown
    try {
      await collector.collect({
        ownerId: "owner-a",
        runId: "run-a",
        declaredPaths: [secret],
        signal: TEST_SIGNAL,
        workspace: memoryWorkspace([{ path: secret, type: "file", size: 1 }], { [secret]: "x" }),
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({ code: "ARTIFACT_SECRET_DETECTED" })
    expect(JSON.stringify(failure)).not.toContain(secret)
  })

  test("rejects undeclared and traversal-shaped paths", async () => {
    const { store } = await createLocalStore()
    const collector = new ArtifactCollector({
      store,
      limits: { maxFiles: 10, maxFileBytes: 1_000, maxTotalBytes: 2_000 },
    })

    await expect(
      collector.collect({
        ownerId: "owner-a",
        runId: "run-a",
        declaredPaths: ["dist"],
        signal: TEST_SIGNAL,
        workspace: memoryWorkspace(
          [
            { path: "dist", type: "directory", size: 0 },
            { path: "../secret", type: "file", size: 1 },
          ],
          { "../secret": "x" },
        ),
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_PATH_INVALID" })
  })

  test("enforces workspace enumeration and depth bounds before reads", async () => {
    const { store } = await createLocalStore()
    const collector = new ArtifactCollector({
      store,
      limits: {
        maxFiles: 2,
        maxFileBytes: 100,
        maxTotalBytes: 200,
        maxEntries: 2,
        maxDepth: 1,
      },
    })
    let reads = 0
    const workspace = {
      async list(_path: string, limits: { maxEntries: number; maxDepth: number }) {
        expect(limits).toEqual({ maxEntries: 2, maxDepth: 1 })
        return [
          { path: "dist", type: "directory" as const, size: 0 },
          { path: "dist/nested", type: "directory" as const, size: 0 },
          { path: "dist/nested/result.txt", type: "file" as const, size: 1 },
        ]
      },
      async readFile() {
        reads += 1
        return new Uint8Array([1])
      },
    }

    await expect(
      collector.collect({
        ownerId: "owner-a",
        runId: "run-a",
        declaredPaths: ["dist"],
        signal: TEST_SIGNAL,
        workspace,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_LIMIT_EXCEEDED" })
    expect(reads).toBe(0)
  })
})

describe("workspace bundle storage", () => {
  test("prepares a stable source identity without writing durable bytes", async () => {
    const { store } = await createLocalStore()
    const counting = new CountingArtifactStore(store)
    const bundles = new WorkspaceBundleStore(memoryBundleCatalog(), counting, {
      maxFiles: 4,
      maxFileBytes: 32,
      maxTotalBytes: 64,
    })

    const first = bundles.prepare([
      { path: "src/main.ts", content: new TextEncoder().encode("source") },
    ])
    const second = bundles.prepare([
      { path: "src/main.ts", content: new TextEncoder().encode("source") },
    ])

    expect(first.source).toEqual(second.source)
    expect(counting.putCount).toBe(0)
    await bundles.publish("owner-a", first)
    expect(counting.putCount).toBe(2)
  })

  test("preflights the complete upload before writing any blob", async () => {
    const { store } = await createLocalStore()
    const counting = new CountingArtifactStore(store)
    const bundles = new WorkspaceBundleStore(memoryBundleCatalog(), counting, {
      maxFiles: 4,
      maxFileBytes: 4,
      maxTotalBytes: 8,
    })

    await expect(
      bundles.capture("owner-a", [
        { path: "first.txt", content: new TextEncoder().encode("ok") },
        { path: "later.txt", content: new TextEncoder().encode("too large") },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    expect(counting.putCount).toBe(0)
  })

  test("uses a backend-neutral manifest and snapshots uploaded buffers", async () => {
    const { store } = await createLocalStore()
    const catalog = memoryBundleCatalog()
    const bundles = new WorkspaceBundleStore(catalog, store, {
      maxFiles: 4,
      maxFileBytes: 32,
      maxTotalBytes: 64,
    })
    const content = new TextEncoder().encode("immutable upload")
    const expected = content.slice()
    const pending = bundles.capture("owner-a", [{ path: "src/main.ts", content }])
    content.fill(0)

    const source = await pending
    const files = await bundles.read("owner-a", source.artifactId)
    expect(files).toHaveLength(1)
    expect(files[0]?.content).toEqual(expected)
    const metadata = catalog.getWorkspaceBundle("owner-a", source.artifactId)
    if (metadata === null) throw new Error("Bundle metadata was not recorded.")
    const manifest = new TextDecoder().decode(
      await store.read("owner-a", {
        storageKey: metadata.storageKey,
        digest: asSha256Digest(metadata.digest),
        size: metadata.byteSize,
      }),
    )
    expect(manifest).not.toContain("storageKey")
  })
})

async function createLocalStore(): Promise<ArtifactStoreHarness> {
  const root = await mkdtemp(join(tmpdir(), "meanwhile-artifacts-"))
  roots.push(root)
  return { root, store: new LocalArtifactStore(root) }
}

function memoryWorkspace(
  entries: readonly WorkspaceEntry[],
  contents: Readonly<Record<string, string>>,
) {
  return {
    async list() {
      return entries
    },
    async readFile(path: string) {
      const value = contents[path]
      if (value === undefined) throw new ArtifactStoreError("ARTIFACT_STORE_IO", "Missing fixture.")
      return new TextEncoder().encode(value)
    },
  }
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required test value is missing.")
  return value
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

function memoryBundleCatalog(): Pick<Store, "insertWorkspaceBundle" | "getWorkspaceBundle"> {
  const metadata = new Map<string, ReturnType<Store["getWorkspaceBundle"]>>()
  return {
    insertWorkspaceBundle(input) {
      metadata.set(`${input.ownerId}/${input.id}`, input)
    },
    getWorkspaceBundle(ownerId, id) {
      return metadata.get(`${ownerId}/${id}`) ?? null
    },
  }
}
