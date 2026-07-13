import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
    const bundles = new WorkspaceBundleStore(
      store,
      new LocalArtifactStore(source.artifactDir),
      WORKSPACE_BUNDLE_LIMITS,
    )
    const bundle = await bundles.capture("owner-a", [
      { path: "README.md", content: new TextEncoder().encode("durable bytes") },
    ])
    store.close()
    await mkdir(join(source.deploymentDir, "deployment-a", "public"), { recursive: true })
    await writeFile(join(source.deploymentDir, "deployment-a", "public", "index.html"), "hello")

    const created = await backupDataRoot(source, backupRoot)
    expect(created.artifacts.length).toBe(2)
    expect(created.deployments).toHaveLength(1)
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
      await Bun.file(join(restored.deploymentDir, "deployment-a/public/index.html")).text(),
    ).toBe("hello")
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
