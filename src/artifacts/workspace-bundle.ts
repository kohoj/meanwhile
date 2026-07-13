import type { BundleWorkspaceSource } from "../domain"
import { AppError } from "../errors"
import type { Store } from "../persistence/store"
import { type RuntimeFile, relativePath } from "../providers/runtime-provider"
import { type ArtifactBlob, type ArtifactStore, asSha256Digest, sha256 } from "./artifact-store"

const BUNDLE_VERSION = 1

export interface UploadedWorkspaceFile {
  readonly path: string
  readonly content: Uint8Array
  readonly mode?: number
}

export interface WorkspaceBundleLimits {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
}

interface BundleManifest {
  readonly version: typeof BUNDLE_VERSION
  readonly files: readonly {
    readonly path: string
    readonly mode: number
    readonly digest: string
    readonly size: number
  }[]
}

/**
 * Fully validated, immutable-by-construction upload intent. Preparing computes
 * the portable source identity without touching durable blob storage, which
 * lets the control plane resolve idempotency before publication.
 */
export interface PreparedWorkspaceBundle {
  readonly source: BundleWorkspaceSource
  readonly files: readonly {
    readonly path: ReturnType<typeof relativePath>
    readonly content: Uint8Array
    readonly mode: number
    readonly digest: ReturnType<typeof sha256>
  }[]
  readonly manifestBytes: Uint8Array
  readonly manifestDigest: ReturnType<typeof sha256>
}

export class WorkspaceBundleStore {
  constructor(
    private readonly store: Pick<Store, "insertWorkspaceBundle" | "getWorkspaceBundle">,
    private readonly artifacts: ArtifactStore,
    private readonly limits: WorkspaceBundleLimits,
    private readonly clock: () => Date = () => new Date(),
  ) {
    assertBundleLimits(limits)
  }

  async capture(
    ownerId: string,
    files: readonly UploadedWorkspaceFile[],
  ): Promise<BundleWorkspaceSource> {
    const prepared = this.prepare(files)
    await this.publish(ownerId, prepared)
    return prepared.source
  }

  /** Validates and snapshots all caller-owned input without durable writes. */
  prepare(files: readonly UploadedWorkspaceFile[]): PreparedWorkspaceBundle {
    if (files.length === 0 || files.length > this.limits.maxFiles) {
      throw invalidBundle("Uploaded workspace file count is outside the configured limit")
    }
    let normalized: { path: ReturnType<typeof relativePath>; content: Uint8Array; mode: number }[]
    try {
      // Preflight and snapshot every caller-owned buffer before any blob write.
      normalized = files
        .map((file) => ({
          path: relativePath(file.path),
          content: Uint8Array.from(file.content),
          mode: validateMode(file.mode ?? 0o600),
        }))
        .sort((left, right) => compareText(left.path, right.path))
    } catch (error) {
      if (error instanceof AppError) throw error
      throw invalidBundle("Uploaded workspace contains an invalid file", error)
    }
    let totalBytes = 0
    let previous: string | null = null
    for (const file of normalized) {
      if (file.path === "." || file.path === previous) {
        throw invalidBundle("Uploaded workspace paths must be unique non-root paths")
      }
      previous = file.path
      if (file.content.byteLength > this.limits.maxFileBytes) {
        throw invalidBundle("An uploaded workspace file exceeds the configured byte limit")
      }
      totalBytes += file.content.byteLength
      if (totalBytes > this.limits.maxTotalBytes) {
        throw invalidBundle("Uploaded workspace exceeds the configured total byte limit")
      }
    }

    const preparedFiles = normalized.map((file) => ({
      ...file,
      digest: sha256(file.content),
    }))
    const entries: BundleManifest["files"][number][] = preparedFiles.map((file) => ({
      path: file.path,
      mode: file.mode,
      digest: file.digest,
      size: file.content.byteLength,
    }))
    const manifestBytes = encodeManifest({ version: BUNDLE_VERSION, files: entries })
    const manifestDigest = sha256(manifestBytes)
    return {
      source: { type: "bundle", artifactId: manifestDigest },
      files: preparedFiles,
      manifestBytes,
      manifestDigest,
    }
  }

  /**
   * Publishes one prepared input under an owner scope. Every write is
   * content-addressed and idempotent; the catalog row is the publication
   * commit point that makes the bundle an addressable control-plane input.
   */
  async publish(ownerId: string, prepared: PreparedWorkspaceBundle): Promise<void> {
    const existing = this.store.getWorkspaceBundle(ownerId, prepared.source.artifactId)
    if (existing !== null) {
      assertBundleMetadata(existing, prepared)
    }

    for (const file of prepared.files) {
      const blob = await this.artifacts.put({
        ownerId,
        bytes: file.content,
        expectedDigest: file.digest,
      })
      if (blob.digest !== file.digest || blob.size !== file.content.byteLength) {
        throw invalidBundle("Artifact storage returned inconsistent workspace content metadata")
      }
    }
    const manifest = await this.artifacts.put({
      ownerId,
      bytes: prepared.manifestBytes,
      expectedDigest: prepared.manifestDigest,
    })
    if (
      manifest.digest !== prepared.manifestDigest ||
      manifest.size !== prepared.manifestBytes.byteLength
    ) {
      throw invalidBundle("Artifact storage returned inconsistent workspace manifest metadata")
    }
    const createdAt = this.clock().toISOString()
    this.store.insertWorkspaceBundle({
      ownerId,
      id: manifest.digest,
      digest: manifest.digest,
      byteSize: manifest.size,
      storageKey: manifest.storageKey,
      createdAt,
    })
    const published = this.store.getWorkspaceBundle(ownerId, prepared.source.artifactId)
    if (published === null) {
      throw new AppError({
        code: "INTERNAL",
        message: "Workspace bundle publication was not recorded",
      })
    }
    assertBundleMetadata(published, prepared)
  }

  async require(ownerId: string, artifactId: string): Promise<void> {
    // Reading validates the owner-scoped catalog entry, the canonical manifest,
    // and every referenced content blob before durable run intent is created.
    await this.read(ownerId, artifactId)
  }

  async read(ownerId: string, artifactId: string): Promise<readonly RuntimeFile[]> {
    const metadata = this.store.getWorkspaceBundle(ownerId, artifactId)
    if (metadata === null)
      throw new AppError({ code: "NOT_FOUND", message: "Workspace bundle not found" })
    const manifestBlob: ArtifactBlob = {
      storageKey: metadata.storageKey,
      digest: asSha256Digest(metadata.digest),
      size: metadata.byteSize,
    }
    const bytes = await this.artifacts.read(ownerId, manifestBlob)
    if (sha256(bytes) !== manifestBlob.digest) throw invalidBundle("Workspace bundle is corrupt")
    const manifest = decodeManifest(bytes, this.limits)
    const files: RuntimeFile[] = []
    for (const entry of manifest.files) {
      const blob = await this.artifacts.resolve(ownerId, {
        digest: asSha256Digest(entry.digest),
        size: entry.size,
      })
      if (blob === null) throw invalidBundle("Workspace bundle content is unavailable")
      const content = await this.artifacts.read(ownerId, blob)
      files.push({ path: relativePath(entry.path), content, mode: entry.mode })
    }
    return files
  }
}

const assertBundleMetadata = (
  metadata: NonNullable<ReturnType<Store["getWorkspaceBundle"]>>,
  prepared: PreparedWorkspaceBundle,
): void => {
  if (
    metadata.id !== prepared.source.artifactId ||
    metadata.digest !== prepared.manifestDigest ||
    metadata.byteSize !== prepared.manifestBytes.byteLength
  ) {
    throw new AppError({
      code: "INTERNAL",
      message: "Workspace bundle identity conflicts with existing immutable metadata",
    })
  }
}

const decodeManifest = (bytes: Uint8Array, limits: WorkspaceBundleLimits): BundleManifest => {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch (error) {
    throw new AppError({
      code: "INVALID_REQUEST",
      message: "Workspace bundle is invalid",
      cause: error,
    })
  }
  if (typeof value !== "object" || value === null || !("version" in value) || !("files" in value)) {
    throw invalidBundle("Workspace bundle manifest is invalid")
  }
  if (value.version !== BUNDLE_VERSION || !Array.isArray(value.files)) {
    throw invalidBundle("Workspace bundle version is unsupported")
  }
  if (value.files.length === 0 || value.files.length > limits.maxFiles) {
    throw invalidBundle("Workspace bundle file count is outside the configured limit")
  }
  let previous: string | null = null
  let totalBytes = 0
  const files = value.files.map((candidate): BundleManifest["files"][number] => {
    if (typeof candidate !== "object" || candidate === null) {
      throw invalidBundle("Workspace bundle entry is invalid")
    }
    const record = candidate as Record<string, unknown>
    if (
      typeof record["path"] !== "string" ||
      typeof record["mode"] !== "number" ||
      typeof record["digest"] !== "string" ||
      typeof record["size"] !== "number"
    ) {
      throw invalidBundle("Workspace bundle entry is invalid")
    }
    const path = relativePath(record["path"])
    if (path === "." || (previous !== null && compareText(previous, path) >= 0)) {
      throw invalidBundle("Workspace bundle paths are not uniquely ordered")
    }
    previous = path
    if (
      !Number.isSafeInteger(record["size"]) ||
      record["size"] < 0 ||
      record["size"] > limits.maxFileBytes
    ) {
      throw invalidBundle("Workspace bundle file size is invalid")
    }
    totalBytes += record["size"]
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
      throw invalidBundle("Workspace bundle total size is invalid")
    }
    return {
      path,
      mode: validateMode(record["mode"]),
      digest: asSha256Digest(record["digest"]),
      size: record["size"],
    }
  })
  const manifest = { version: BUNDLE_VERSION, files } as const
  if (!equalBytes(bytes, encodeManifest(manifest))) {
    throw invalidBundle("Workspace bundle manifest is not canonical")
  }
  return manifest
}

const validateMode = (mode: number): number => {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777 || (mode & 0o600) !== 0o600) {
    throw invalidBundle("Workspace file mode is invalid")
  }
  return mode
}

const invalidBundle = (message: string, cause?: unknown): AppError =>
  new AppError({ code: "INVALID_REQUEST", message, retryable: false, cause })

const encodeManifest = (manifest: BundleManifest): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(manifest))

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((value, index) => value === right[index])

const assertBundleLimits = (limits: WorkspaceBundleLimits): void => {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError("Workspace bundle limits must be positive safe integers")
    }
  }
  if (limits.maxFileBytes > limits.maxTotalBytes) {
    throw new TypeError("Workspace file byte limit cannot exceed the bundle total byte limit")
  }
}
