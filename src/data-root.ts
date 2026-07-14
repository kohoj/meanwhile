import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { z } from "zod"
import {
  type ArtifactBlob,
  asSha256Digest,
  decodeArtifactManifest,
  sha256,
} from "./artifacts/artifact-store"
import { LocalArtifactStore } from "./artifacts/local-artifact-store"
import {
  decodeWorkspaceBundleManifest,
  WORKSPACE_BUNDLE_LIMITS,
} from "./artifacts/workspace-bundle"
import {
  localStaticPublicationManifest,
  verifyLocalStaticPublication,
} from "./deployments/local-static-publication"
import { isPreviewDeploymentId } from "./deployments/local-static-server"
import { AppError } from "./errors"
import { type DurableBlobRoot, type DurableLocalDeploymentRoot, Store } from "./persistence/store"
import { SERVICE_VERSION } from "./version"

const BACKUP_VERSION = 1 as const
const MAX_BACKUP_FILES = 100_000
const MAX_BACKUP_BYTES = 8 * 1024 * 1024 * 1024
const OBJECT_PATH = /^owners\/[a-f0-9]{64}\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/
const TEMP_OBJECT_PATH =
  /^owners\/[a-f0-9]{64}\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.[0-9a-f-]{36}\.tmp$/

const backupEntrySchema = z.object({
  path: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().nonnegative(),
})

const backupManifestSchema = z
  .object({
    version: z.literal(BACKUP_VERSION),
    serviceVersion: z.string(),
    bunVersion: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
    database: backupEntrySchema,
    schema: z
      .object({
        name: z.string().min(1),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    artifacts: z.array(backupEntrySchema),
    deployments: z.array(backupEntrySchema),
  })
  .strict()

export type DataBackupManifest = z.infer<typeof backupManifestSchema>

interface LeaseOwner {
  readonly version: 1
  readonly token: string
  readonly pid: number
  readonly hostname: string
  readonly purpose: "control-plane" | "maintenance"
  readonly acquiredAt: string
}

/** Cross-process single-writer lease for one local data root. */
export class DataRootLease {
  readonly #lockPath: string
  readonly #owner: LeaseOwner
  #released = false

  private constructor(lockPath: string, owner: LeaseOwner) {
    this.#lockPath = lockPath
    this.#owner = owner
  }

  static async acquire(dataDir: string, purpose: LeaseOwner["purpose"]): Promise<DataRootLease> {
    // Canonicalize an existing root or its nearest existing ancestor. A data
    // root reached through a symlink must not acquire a second writer lease.
    const lockPath = `${await physicalPath(dataDir)}.lock`
    const owner: LeaseOwner = {
      version: 1,
      token: crypto.randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      purpose,
      acquiredAt: new Date().toISOString(),
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await mkdir(lockPath, { mode: 0o700 })
        try {
          await writeFile(join(lockPath, "owner.json"), JSON.stringify(owner), {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          })
        } catch (cause) {
          await rm(lockPath, { recursive: true, force: true })
          throw cause
        }
        return new DataRootLease(lockPath, owner)
      } catch (cause) {
        if (!isCode(cause, "EEXIST")) throw dataRootIo(cause)
        const existing = await readLeaseOwner(lockPath)
        if (existing === null) {
          if (attempt < 2) {
            await Bun.sleep(20)
            continue
          }
          throw locked()
        }
        if (existing.hostname !== hostname() || processIsAlive(existing.pid)) throw locked()
        const stale = `${lockPath}.stale.${crypto.randomUUID()}`
        try {
          await rename(lockPath, stale)
          await rm(stale, { recursive: true, force: true })
        } catch (error) {
          if (!isCode(error, "ENOENT")) throw locked()
        }
      }
    }
    throw locked()
  }

  async release(): Promise<void> {
    if (this.#released) return
    const existing = await readLeaseOwner(this.#lockPath)
    if (existing?.token !== this.#owner.token) {
      throw new AppError({
        code: "DATA_ROOT_LEASE_LOST",
        message: "Data-root ownership changed before release",
      })
    }
    await rm(this.#lockPath, { recursive: true, force: true })
    this.#released = true
  }
}

export interface DataRootPaths {
  readonly dataDir: string
  readonly databasePath: string
  readonly artifactDir: string
  readonly runtimeDir: string
  readonly deploymentDir: string
}

export async function backupDataRoot(
  paths: DataRootPaths,
  output: string,
): Promise<DataBackupManifest> {
  await assertMaintenancePaths(paths)
  const destination = await physicalPath(output)
  assertDisjointTrees(await physicalPath(paths.dataDir), destination, "Backup output")
  if (await pathExists(destination)) {
    throw new AppError({ code: "INVALID_REQUEST", message: "Backup output already exists" })
  }
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`
  const lease = await DataRootLease.acquire(paths.dataDir, "maintenance")
  let store: Store | undefined
  try {
    store = new Store(paths.databasePath)
    store.assertQuiescent()
    const databaseBytes = store.serialize()
    const schema = store.schemaIdentity()
    await mkdir(temporary, { recursive: true, mode: 0o700 })
    const databasePath = join(temporary, "meanwhile.sqlite")
    await writeFile(databasePath, databaseBytes, { mode: 0o600 })

    const snapshot = new Store(databasePath, { readonly: true })
    let artifacts: readonly BackupBlob[]
    let deployments: readonly DurableLocalDeploymentRoot[]
    try {
      snapshot.assertQuiescent()
      artifacts = await reachableBlobs(snapshot, new LocalArtifactStore(paths.artifactDir))
      deployments = snapshot.listLocalDeploymentRoots()
    } finally {
      snapshot.close()
    }

    const artifactEntries: DataBackupManifest["artifacts"] = []
    for (const artifact of artifacts) {
      const path = `artifacts/${artifact.blob.storageKey}`
      await writeBackupFile(temporary, path, artifact.bytes)
      artifactEntries.push(entry(path, artifact.bytes))
    }
    const deploymentEntries = await copyVerifiedDeployments(
      paths.deploymentDir,
      temporary,
      deployments,
      new LocalArtifactStore(paths.artifactDir),
    )
    const manifest: DataBackupManifest = {
      version: BACKUP_VERSION,
      serviceVersion: SERVICE_VERSION,
      bunVersion: Bun.version,
      createdAt: new Date().toISOString(),
      database: entry("meanwhile.sqlite", databaseBytes),
      schema,
      artifacts: artifactEntries.sort(compareEntry),
      deployments: deploymentEntries.sort(compareEntry),
    }
    await writeFile(join(temporary, "manifest.json"), JSON.stringify(manifest), {
      encoding: "utf8",
      mode: 0o600,
    })
    await mkdir(dirname(destination), { recursive: true })
    await rename(temporary, destination)
    return manifest
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  } finally {
    store?.close()
    await lease.release()
  }
}

export async function verifyDataBackup(path: string): Promise<DataBackupManifest> {
  const root = resolve(path)
  try {
    const manifest = backupManifestSchema.parse(await Bun.file(join(root, "manifest.json")).json())
    const allEntries = [manifest.database, ...manifest.artifacts, ...manifest.deployments]
    assertUniqueEntries(allEntries)
    for (const item of allEntries) await readVerifiedBackupFile(root, item)

    const store = new Store(join(root, manifest.database.path), { readonly: true })
    try {
      store.assertQuiescent()
      if (JSON.stringify(store.schemaIdentity()) !== JSON.stringify(manifest.schema)) {
        throw invalidBackup("Backup schema identity does not match its database")
      }
      const reachable = await reachableBlobs(store, new LocalArtifactStore(join(root, "artifacts")))
      const expected = reachable
        .map(({ blob, bytes }) => entry(`artifacts/${blob.storageKey}`, bytes))
        .sort(compareEntry)
      if (JSON.stringify(expected) !== JSON.stringify([...manifest.artifacts].sort(compareEntry))) {
        throw invalidBackup("Backup artifact graph is incomplete or contains extra objects")
      }
      const expectedDeployments = await inspectVerifiedDeployments(
        join(root, "deployments"),
        store.listLocalDeploymentRoots(),
        new LocalArtifactStore(join(root, "artifacts")),
      )
      if (
        JSON.stringify(expectedDeployments) !==
        JSON.stringify([...manifest.deployments].sort(compareEntry))
      ) {
        throw invalidBackup("Backup deployment graph is incomplete or contains extra files")
      }
    } finally {
      store.close()
    }

    const actualFiles = await listTreeFiles(root)
    const expectedFiles = new Set(["manifest.json", ...allEntries.map(({ path }) => path)])
    if (
      actualFiles.length !== expectedFiles.size ||
      actualFiles.some((file) => !expectedFiles.has(file))
    ) {
      throw invalidBackup("Backup contains untracked files")
    }
    return manifest
  } catch (cause) {
    if (cause instanceof AppError && cause.code === "DATA_BACKUP_INVALID") throw cause
    throw invalidBackup("Backup manifest or data is invalid", cause)
  }
}

export async function restoreDataRoot(
  backup: string,
  paths: DataRootPaths,
): Promise<DataBackupManifest> {
  await assertMaintenancePaths(paths)
  const source = await physicalPath(backup)
  const destination = await physicalPath(paths.dataDir)
  assertDisjointTrees(destination, source, "Backup input")
  const manifest = await verifyDataBackup(source)
  const lease = await DataRootLease.acquire(destination, "maintenance")
  const stage = `${destination}.restore.${crypto.randomUUID()}`
  try {
    if (await pathExists(destination)) {
      const entries = await readdir(destination)
      if (entries.length !== 0) {
        throw new AppError({
          code: "INVALID_REQUEST",
          message: "Restore requires an absent or empty data root",
        })
      }
    }
    await mkdir(stage, { recursive: true, mode: 0o700 })
    for (const item of [manifest.database, ...manifest.artifacts, ...manifest.deployments]) {
      // Verification and restore are separate reads. Recheck each byte here so
      // replacing a backup file between those phases cannot publish it.
      const bytes = await readVerifiedBackupFile(source, item)
      await writeBackupFile(stage, item.path, bytes)
    }
    await mkdir(join(stage, basename(paths.runtimeDir)), { recursive: true, mode: 0o700 })
    await rm(destination, { recursive: true, force: true })
    await rename(stage, destination)

    const restored = new Store(join(destination, manifest.database.path), { readonly: true })
    try {
      restored.assertQuiescent()
    } finally {
      restored.close()
    }
    return manifest
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  } finally {
    await lease.release()
  }
}

export interface GarbageCollectionResult {
  readonly dryRun: boolean
  readonly objectPaths: readonly string[]
  readonly deploymentPaths: readonly string[]
  readonly byteSize: number
}

export async function garbageCollectDataRoot(
  paths: DataRootPaths,
  dryRun: boolean,
): Promise<GarbageCollectionResult> {
  await assertMaintenancePaths(paths)
  const lease = await DataRootLease.acquire(paths.dataDir, "maintenance")
  let store: Store | undefined
  try {
    store = new Store(paths.databasePath)
    store.assertQuiescent()
    const reachable = new Set(
      (await reachableBlobs(store, new LocalArtifactStore(paths.artifactDir))).map(
        ({ blob }) => blob.storageKey,
      ),
    )
    const objectPaths: string[] = []
    let byteSize = 0
    for (const path of await listTreeFiles(paths.artifactDir)) {
      if (reachable.has(path)) continue
      if (!OBJECT_PATH.test(path) && !TEMP_OBJECT_PATH.test(path)) continue
      const absolute = contained(paths.artifactDir, path)
      const info = await lstat(absolute)
      objectPaths.push(path)
      byteSize += info.size
      if (!dryRun) await rm(absolute, { force: true })
    }

    const retainedDeployments = new Set(store.listLocalDeploymentRoots().map(({ id }) => id))
    const deploymentPaths: string[] = []
    if (await pathExists(paths.deploymentDir)) {
      for (const name of await readdir(paths.deploymentDir)) {
        const absolute = contained(paths.deploymentDir, name)
        const info = await lstat(absolute)
        if (info.isSymbolicLink()) throw invalidBackup("Deployment root contains a symlink")
        if (!info.isDirectory() || retainedDeployments.has(name)) continue
        deploymentPaths.push(name)
        byteSize += await treeByteSize(absolute)
        if (!dryRun) await rm(absolute, { recursive: true, force: true })
      }
    }
    return {
      dryRun,
      objectPaths: objectPaths.sort(),
      deploymentPaths: deploymentPaths.sort(),
      byteSize,
    }
  } finally {
    store?.close()
    await lease.release()
  }
}

interface BackupBlob {
  readonly ownerId: string
  readonly blob: ArtifactBlob
  readonly bytes: Uint8Array
}

async function reachableBlobs(store: Store, artifacts: LocalArtifactStore): Promise<BackupBlob[]> {
  const blobs = new Map<string, BackupBlob>()
  const add = async (
    ownerId: string,
    reference: { digest: string; size: number },
    storageKey?: string,
  ): Promise<BackupBlob> => {
    const resolved = await artifacts.resolve(ownerId, {
      digest: asSha256Digest(reference.digest),
      size: reference.size,
    })
    if (resolved === null || (storageKey !== undefined && resolved.storageKey !== storageKey)) {
      throw invalidBackup("A durable artifact object is missing")
    }
    const existing = blobs.get(resolved.storageKey)
    if (existing !== undefined) return existing
    const bytes = await artifacts.read(ownerId, resolved)
    const item = { ownerId, blob: resolved, bytes }
    blobs.set(resolved.storageKey, item)
    return item
  }

  for (const root of store.listDurableBlobRoots()) {
    const manifest = await add(
      root.ownerId,
      { digest: root.digest, size: root.byteSize },
      root.storageKey,
    )
    for (const child of childReferences(root, manifest.bytes)) {
      await add(root.ownerId, child)
    }
  }
  return [...blobs.values()].sort((left, right) =>
    left.blob.storageKey.localeCompare(right.blob.storageKey),
  )
}

function childReferences(
  root: DurableBlobRoot,
  bytes: Uint8Array,
): readonly { digest: string; size: number }[] {
  if (root.kind === "artifact") {
    return decodeArtifactManifest(bytes).entries
  }
  return decodeWorkspaceBundleManifest(bytes, WORKSPACE_BUNDLE_LIMITS).files
}

async function copyVerifiedDeployments(
  sourceRoot: string,
  backupRoot: string,
  deployments: readonly DurableLocalDeploymentRoot[],
  artifacts: LocalArtifactStore,
): Promise<DataBackupManifest["deployments"]> {
  const entries = await inspectVerifiedDeployments(sourceRoot, deployments, artifacts)
  for (const item of entries) {
    const sourcePath = item.path.slice("deployments/".length)
    const bytes = await readFile(contained(sourceRoot, sourcePath))
    if (bytes.byteLength !== item.byteSize || sha256(bytes) !== item.digest) {
      throw invalidBackup("A local deployment changed during backup")
    }
    await writeBackupFile(backupRoot, item.path, bytes)
  }
  return entries
}

async function inspectVerifiedDeployments(
  sourceRoot: string,
  deployments: readonly DurableLocalDeploymentRoot[],
  artifacts: LocalArtifactStore,
): Promise<DataBackupManifest["deployments"]> {
  const entries: DataBackupManifest["deployments"] = []
  try {
    for (const deployment of deployments) {
      if (!isPreviewDeploymentId(deployment.id)) {
        throw invalidBackup("A local deployment identity is invalid")
      }
      const artifactBytes = await artifacts.read(deployment.ownerId, {
        storageKey: deployment.manifestStorageKey,
        digest: asSha256Digest(deployment.manifestDigest),
        size: deployment.manifestByteSize,
      })
      const artifactManifest = decodeArtifactManifest(artifactBytes)
      const expectedManifest = localStaticPublicationManifest({
        artifactId: deployment.artifactId,
        manifestDigest: deployment.manifestDigest,
        files: artifactManifest.entries.map((file) => ({
          path: file.path,
          digest: file.digest,
          size: file.size,
          mediaType: file.mediaType,
        })),
      })

      const deploymentRoot = contained(sourceRoot, deployment.id)
      const verified = await verifyLocalStaticPublication(deploymentRoot, expectedManifest)
      for (const file of verified) {
        entries.push(entry(`deployments/${deployment.id}/${file.path}`, file.bytes))
      }
    }
  } catch (cause) {
    if (cause instanceof AppError && cause.code === "DATA_BACKUP_INVALID") throw cause
    throw invalidBackup("Local deployment publication is invalid", cause)
  }
  return entries.sort(compareEntry)
}

async function listTreeFiles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) return []
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = join(directory, name)
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw invalidBackup("Data root contains a symlink")
      if (info.isDirectory()) await visit(absolute)
      else if (info.isFile()) files.push(relative(root, absolute).split(sep).join("/"))
      else throw invalidBackup("Data root contains an unsupported filesystem entry")
      if (files.length > MAX_BACKUP_FILES) throw invalidBackup("Data root contains too many files")
    }
  }
  await visit(resolve(root))
  return files
}

async function treeByteSize(root: string): Promise<number> {
  let total = 0
  for (const path of await listTreeFiles(root)) {
    total += (await lstat(contained(root, path))).size
    if (total > MAX_BACKUP_BYTES) throw invalidBackup("Data root exceeds the maintenance limit")
  }
  return total
}

async function writeBackupFile(root: string, path: string, bytes: Uint8Array): Promise<void> {
  const destination = contained(root, path)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await writeFile(destination, bytes, { mode: 0o600 })
}

async function readVerifiedBackupFile(
  root: string,
  item: DataBackupManifest["database"],
): Promise<Uint8Array> {
  const absolute = contained(root, item.path)
  const info = await lstat(absolute).catch(() => null)
  if (info === null || !info.isFile() || info.isSymbolicLink() || info.size !== item.byteSize) {
    throw invalidBackup("Backup file metadata is invalid")
  }
  const bytes = await readFile(absolute)
  if (sha256(bytes) !== item.digest) throw invalidBackup("Backup file digest is invalid")
  return bytes
}

function entry(path: string, bytes: Uint8Array): DataBackupManifest["database"] {
  return { path, digest: sha256(bytes), byteSize: bytes.byteLength }
}

function assertUniqueEntries(entries: readonly DataBackupManifest["database"][]): void {
  const paths = new Set<string>()
  let bytes = 0
  for (const item of entries) {
    contained("/backup", item.path)
    if (paths.has(item.path)) throw invalidBackup("Backup contains duplicate paths")
    paths.add(item.path)
    bytes += item.byteSize
    if (paths.size > MAX_BACKUP_FILES || bytes > MAX_BACKUP_BYTES) {
      throw invalidBackup("Backup exceeds maintenance limits")
    }
  }
}

function contained(root: string, path: string): string {
  if (path.length === 0 || path.includes("\\") || path.startsWith("/")) {
    throw invalidBackup("Backup path is invalid")
  }
  const destination = resolve(root, path)
  const absoluteRoot = resolve(root)
  if (!destination.startsWith(`${absoluteRoot}${sep}`))
    throw invalidBackup("Backup path escapes root")
  return destination
}

async function assertMaintenancePaths(paths: DataRootPaths): Promise<void> {
  const root = await physicalPath(paths.dataDir)
  const owned = await Promise.all(
    [paths.databasePath, paths.artifactDir, paths.runtimeDir, paths.deploymentDir].map(
      physicalPath,
    ),
  )
  if (
    owned.some((path) => !path.startsWith(`${root}${sep}`)) ||
    new Set(owned).size !== owned.length
  ) {
    throw new AppError({
      code: "INVALID_REQUEST",
      message: "Maintenance paths must be distinct children of one data root",
    })
  }
}

function assertDisjointTrees(left: string, right: string, subject: string): void {
  if (left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`)) {
    throw new AppError({
      code: "INVALID_REQUEST",
      message: `${subject} must be outside the data root`,
    })
  }
}

/** Resolves symlinks without requiring the final path to exist. */
async function physicalPath(path: string): Promise<string> {
  let current = resolve(path)
  const suffix: string[] = []
  while (true) {
    try {
      return resolve(await realpath(current), ...suffix)
    } catch (cause) {
      if (!isCode(cause, "ENOENT")) throw dataRootIo(cause)
      const existing = await lstat(current).catch((error: unknown) => {
        if (isCode(error, "ENOENT")) return null
        throw dataRootIo(error)
      })
      if (existing !== null) {
        throw new AppError({
          code: "INVALID_REQUEST",
          message: "Data-root maintenance path contains an unresolved symbolic link",
          cause,
        })
      }
      const parent = dirname(current)
      if (parent === current) throw dataRootIo(cause)
      suffix.unshift(basename(current))
      current = parent
    }
  }
}

function compareEntry(
  left: DataBackupManifest["database"],
  right: DataBackupManifest["database"],
): number {
  return left.path.localeCompare(right.path)
}

async function readLeaseOwner(path: string): Promise<LeaseOwner | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(path, "owner.json"), "utf8"))
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      !("token" in value) ||
      !("pid" in value) ||
      !("hostname" in value) ||
      !("purpose" in value) ||
      !("acquiredAt" in value) ||
      value.version !== 1 ||
      typeof value.token !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.hostname !== "string" ||
      (value.purpose !== "control-plane" && value.purpose !== "maintenance") ||
      typeof value.acquiredAt !== "string"
    ) {
      return null
    }
    return value as LeaseOwner
  } catch {
    return null
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isCode(error, "ESRCH")
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isCode(error, "ENOENT")) return false
    throw error
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

const locked = (): AppError =>
  new AppError({
    code: "DATA_ROOT_LOCKED",
    status: 409,
    message: "Data root is already owned by another process",
  })

const dataRootIo = (cause: unknown): AppError =>
  new AppError({ code: "DATA_ROOT_IO", message: "Data-root lease could not be acquired", cause })

const invalidBackup = (message: string, cause?: unknown): AppError =>
  new AppError({
    code: "DATA_BACKUP_INVALID",
    status: 422,
    message,
    ...(cause === undefined ? {} : { cause }),
  })
