import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encodeArtifactManifest } from "../../src/artifacts/artifact-store"
import { LocalArtifactStore } from "../../src/artifacts/local-artifact-store"
import { WORKSPACE_BUNDLE_LIMITS, WorkspaceBundleStore } from "../../src/artifacts/workspace-bundle"
import {
  backupDataRoot,
  DataRootLease,
  garbageCollectDataRoot,
  restoreDataRoot,
  verifyDataBackup,
} from "../../src/data-root"
import { Store } from "../../src/persistence/store"
import {
  TEST_AGENT_CATALOG_DIGEST,
  testAgentSpec,
  testExecutionProvenanceFor,
} from "../fixtures/agent-intent"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("data-root lifecycle", () => {
  test("backs up, verifies, and restores one complete durable root", async () => {
    const sourceRoot = await temporary("meanwhile-data-source-")
    const backupRoot = join(await temporary("meanwhile-data-backup-parent-"), "backup")
    const restoredRoot = join(await temporary("meanwhile-data-restore-parent-"), "restored")
    const source = paths(sourceRoot)
    const restored = paths(restoredRoot)
    await prepare(source)

    const store = new Store(source.databasePath)
    store.createOwner({ id: "owner-a", name: "Owner A", createdAt: "2026-07-13T00:00:00.000Z" })
    const artifactStore = new LocalArtifactStore(source.artifactDir)
    const bundles = new WorkspaceBundleStore(store, artifactStore, WORKSPACE_BUNDLE_LIMITS)
    const bundle = await bundles.capture("owner-a", [
      { path: "README.md", content: new TextEncoder().encode("durable bytes") },
    ])
    const agentSpec = testAgentSpec()
    store.createRun({
      id: "run-a",
      ownerId: "owner-a",
      workspace: { type: "repository", url: "https://example.test/repo.git" },
      agentType: "demo",
      agentSpec,
      agentCatalogDigest: TEST_AGENT_CATALOG_DIGEST,
      executionProvenance: testExecutionProvenanceFor("local", agentSpec),
      prompt: "publish",
      env: {},
      secretRefs: {},
      provider: "local",
      artifactPaths: ["site"],
      timeoutMs: 60_000,
      createdAt: "2026-07-13T00:00:00.000Z",
      audit: { actorApiKeyId: null, requestId: "run:create", traceId: null, metadata: {} },
    })
    const previewBytes = new TextEncoder().encode("hello")
    const previewBlob = await artifactStore.put({ ownerId: "owner-a", bytes: previewBytes })
    const manifestBlob = await artifactStore.put({
      ownerId: "owner-a",
      bytes: encodeArtifactManifest({
        version: 1,
        runId: "run-a",
        logicalPath: "site",
        kind: "directory",
        payloadSize: previewBytes.byteLength,
        entries: [
          {
            path: "index.html",
            logicalPath: "site/index.html",
            mediaType: "text/html; charset=utf-8",
            digest: previewBlob.digest,
            size: previewBlob.size,
          },
        ],
      }),
    })
    store.insertArtifact({
      id: manifestBlob.digest,
      ownerId: "owner-a",
      runId: "run-a",
      logicalPath: "site",
      kind: "directory",
      digest: manifestBlob.digest,
      mediaType: "application/vnd.meanwhile.artifact-manifest+json; version=1",
      byteSize: manifestBlob.size,
      storageKey: manifestBlob.storageKey,
      createdAt: "2026-07-13T00:00:01.000Z",
    })
    store.claimRunOutcome({
      kind: "cancel",
      ownerId: "owner-a",
      runId: "run-a",
      at: "2026-07-13T00:00:01.500Z",
      systemLog: { eventType: "run.cancelled", data: "Run cancelled" },
      requestAudit: {
        actorApiKeyId: null,
        action: "run.cancel_requested",
        requestId: "run:cancel",
        traceId: null,
        metadata: {},
      },
      resultAudit: {
        actorApiKeyId: null,
        action: "run.cancelled",
        requestId: "run:cancel",
        traceId: null,
        metadata: {},
      },
    })
    const deploymentId = "deployment-aaaaaaaa"
    store.createDeployment(
      {
        id: deploymentId,
        ownerId: "owner-a",
        runId: "run-a",
        artifactId: manifestBlob.digest,
        target: "local-static",
        targetConfig: {},
        secretRefs: {},
        status: "succeeded",
        url: `http://127.0.0.1:3000/d/${deploymentId}/`,
        error: null,
        createdAt: "2026-07-13T00:00:02.000Z",
        startedAt: "2026-07-13T00:00:02.000Z",
        finishedAt: "2026-07-13T00:00:03.000Z",
        updatedAt: "2026-07-13T00:00:03.000Z",
      },
      {
        id: crypto.randomUUID(),
        ownerId: "owner-a",
        actorApiKeyId: null,
        action: "deployment.create",
        resourceType: "deployment",
        resourceId: deploymentId,
        requestId: "deployment:create",
        traceId: null,
        metadata: {},
        createdAt: "2026-07-13T00:00:02.000Z",
      },
      { key: "data-root-deployment", requestHash: "data-root-deployment-hash" },
    )
    store.close()
    await mkdir(join(source.deploymentDir, deploymentId, "public"), { recursive: true })
    await writeFile(join(source.deploymentDir, deploymentId, "public", "index.html"), previewBytes)
    await writeFile(
      join(source.deploymentDir, deploymentId, "manifest.json"),
      JSON.stringify({
        version: 1,
        artifactId: manifestBlob.digest,
        manifestDigest: manifestBlob.digest,
        files: [
          {
            path: "index.html",
            digest: previewBlob.digest,
            size: previewBlob.size,
            mediaType: "text/html; charset=utf-8",
          },
        ],
      }),
    )
    await mkdir(join(source.deploymentDir, "orphan-preview", "public"), { recursive: true })
    await writeFile(
      join(source.deploymentDir, "orphan-preview", "public/index.html"),
      "unreferenced",
    )

    const created = await backupDataRoot(source, backupRoot)
    expect(created.artifacts.length).toBe(4)
    expect(created.deployments).toHaveLength(2)
    expect(
      await Bun.file(join(backupRoot, "deployments/orphan-preview/public/index.html")).exists(),
    ).toBeFalse()
    expect((await verifyDataBackup(backupRoot)).database.digest).toBe(created.database.digest)

    await restoreDataRoot(backupRoot, restored)
    const restoredStore = new Store(restored.databasePath)
    try {
      const restoredBundles = new WorkspaceBundleStore(
        restoredStore,
        new LocalArtifactStore(restored.artifactDir),
        WORKSPACE_BUNDLE_LIMITS,
      )
      const files = await restoredBundles.read("owner-a", bundle.artifactId)
      expect(new TextDecoder().decode(files[0]?.content)).toBe("durable bytes")
    } finally {
      restoredStore.close()
    }
    expect(
      await Bun.file(join(restored.deploymentDir, deploymentId, "public/index.html")).text(),
    ).toBe("hello")
    expect(
      await Bun.file(join(restored.deploymentDir, "orphan-preview/public/index.html")).exists(),
    ).toBeFalse()

    await writeFile(join(source.deploymentDir, deploymentId, "public/index.html"), "tampered")
    const rejectedBackup = join(await temporary("meanwhile-data-rejected-backup-"), "backup")
    await expect(backupDataRoot(source, rejectedBackup)).rejects.toMatchObject({
      code: "DATA_BACKUP_INVALID",
    })
  })

  test("garbage collection is explicit, dry-run-first, and keeps referenced bytes", async () => {
    const root = await temporary("meanwhile-data-gc-")
    const data = paths(root)
    await prepare(data)
    const store = new Store(data.databasePath)
    store.createOwner({ id: "owner-a", name: "Owner A", createdAt: "2026-07-13T00:00:00.000Z" })
    const artifacts = new LocalArtifactStore(data.artifactDir)
    const bundles = new WorkspaceBundleStore(store, artifacts, WORKSPACE_BUNDLE_LIMITS)
    const bundle = await bundles.capture("owner-a", [
      { path: "kept.txt", content: new TextEncoder().encode("kept") },
    ])
    const orphan = await artifacts.put({
      ownerId: "owner-a",
      bytes: new TextEncoder().encode("orphan"),
    })
    store.close()
    await mkdir(join(data.deploymentDir, "orphan-preview", "public"), { recursive: true })
    await writeFile(join(data.deploymentDir, "orphan-preview", "public", "index.html"), "orphan")

    const dryRun = await garbageCollectDataRoot(data, true)
    expect(dryRun.objectPaths).toContain(orphan.storageKey)
    expect(dryRun.deploymentPaths).toEqual(["orphan-preview"])
    expect(await Bun.file(join(data.artifactDir, orphan.storageKey)).exists()).toBeTrue()

    const applied = await garbageCollectDataRoot(data, false)
    expect(applied.objectPaths).toEqual(dryRun.objectPaths)
    expect(await Bun.file(join(data.artifactDir, orphan.storageKey)).exists()).toBeFalse()
    const verifyStore = new Store(data.databasePath)
    try {
      const restoredBundles = new WorkspaceBundleStore(
        verifyStore,
        new LocalArtifactStore(data.artifactDir),
        WORKSPACE_BUNDLE_LIMITS,
      )
      expect(await restoredBundles.read("owner-a", bundle.artifactId)).toHaveLength(1)
    } finally {
      verifyStore.close()
    }
  })

  test("a live owner excludes a second control plane or maintenance command", async () => {
    const root = await temporary("meanwhile-data-lock-")
    const lease = await DataRootLease.acquire(root, "control-plane")
    try {
      await expect(DataRootLease.acquire(root, "maintenance")).rejects.toMatchObject({
        code: "DATA_ROOT_LOCKED",
      })
    } finally {
      await lease.release()
    }
    const successor = await DataRootLease.acquire(root, "maintenance")
    await successor.release()
  })

  test("maintenance never nests a backup into the live data root", async () => {
    const root = await temporary("meanwhile-data-overlap-")
    const data = paths(root)
    await prepare(data)
    new Store(data.databasePath).close()

    await expect(backupDataRoot(data, join(root, "backup"))).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    })
    await expect(restoreDataRoot(root, paths(join(root, "restored")))).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    })

    const aliasParent = await temporary("meanwhile-data-alias-parent-")
    const alias = join(aliasParent, "data-alias")
    await symlink(root, alias)
    await expect(backupDataRoot(data, join(alias, "backup"))).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    })
  })

  test("physical data-root identity cannot acquire a second lease through a symlink", async () => {
    const root = await temporary("meanwhile-data-physical-lock-")
    const aliasParent = await temporary("meanwhile-data-lock-alias-parent-")
    const alias = join(aliasParent, "data-alias")
    await symlink(root, alias)
    const lease = await DataRootLease.acquire(root, "control-plane")
    try {
      await expect(DataRootLease.acquire(alias, "maintenance")).rejects.toMatchObject({
        code: "DATA_ROOT_LOCKED",
      })
    } finally {
      await lease.release()
    }
  })
})

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root, `${root}.lock`)
  return root
}

function paths(dataDir: string) {
  return {
    dataDir,
    databasePath: join(dataDir, "meanwhile.sqlite"),
    artifactDir: join(dataDir, "artifacts"),
    runtimeDir: join(dataDir, "runtimes"),
    deploymentDir: join(dataDir, "deployments"),
  }
}

async function prepare(data: ReturnType<typeof paths>): Promise<void> {
  await Promise.all(
    [data.dataDir, data.artifactDir, data.runtimeDir, data.deploymentDir].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  )
}
