/**
 * Immutable byte storage. Ownership, logical paths, and retention live in the
 * control-plane database; this contract deliberately owns bytes only.
 */
export interface ArtifactStore {
  put(input: PutArtifactBlob): Promise<ArtifactBlob>
  /** Resolves backend-private location metadata from a portable content reference. */
  resolve(ownerId: string, content: ArtifactContentReference): Promise<ArtifactBlob | null>
  stat(ownerId: string, blob: ArtifactBlob): Promise<ArtifactBlob | null>
  read(ownerId: string, blob: ArtifactBlob): Promise<Uint8Array>
}

export interface PutArtifactBlob {
  ownerId: string
  bytes: Uint8Array
  expectedDigest?: Sha256Digest
}

export interface ArtifactBlob {
  /** Opaque to callers. Never expose it through the public API. */
  storageKey: string
  digest: Sha256Digest
  size: number
}

/** Backend-neutral identity suitable for canonical manifests and protocols. */
export interface ArtifactContentReference {
  digest: Sha256Digest
  size: number
}

export interface ArtifactManifestEntryV1 {
  path: string
  logicalPath: string
  mediaType: string
  digest: Sha256Digest
  size: number
}

export interface ArtifactManifestV1 {
  version: 1
  runId: string
  logicalPath: string
  kind: "file" | "directory" | "workspace"
  payloadSize: number
  entries: readonly ArtifactManifestEntryV1[]
}

export type Sha256Digest = string & { readonly __sha256Digest: unique symbol }

export type ArtifactStoreErrorCode =
  | "ARTIFACT_BLOB_INVALID"
  | "ARTIFACT_BLOB_NOT_FOUND"
  | "ARTIFACT_BLOB_CORRUPT"
  | "ARTIFACT_STORE_IO"

export class ArtifactStoreError extends Error {
  override readonly name = "ArtifactStoreError"

  constructor(
    readonly code: ArtifactStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024
const MAX_MANIFEST_ENTRIES = 100_000

export function asSha256Digest(value: string): Sha256Digest {
  if (!SHA256_PATTERN.test(value)) {
    throw new ArtifactStoreError(
      "ARTIFACT_BLOB_INVALID",
      "Artifact digest must be a lowercase SHA-256 value.",
    )
  }

  return value as Sha256Digest
}

export function sha256(bytes: Uint8Array): Sha256Digest {
  return asSha256Digest(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"))
}

/** Canonical bytes are themselves stored as the durable artifact root blob. */
export function encodeArtifactManifest(manifest: ArtifactManifestV1): Uint8Array {
  assertArtifactManifest(manifest)
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      runId: manifest.runId,
      logicalPath: manifest.logicalPath,
      kind: manifest.kind,
      payloadSize: manifest.payloadSize,
      entries: manifest.entries.map((entry) => ({
        path: entry.path,
        logicalPath: entry.logicalPath,
        mediaType: entry.mediaType,
        digest: entry.digest,
        size: entry.size,
      })),
    }),
  )
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw corruptManifest()
  return bytes
}

export function decodeArtifactManifest(bytes: Uint8Array): ArtifactManifestV1 {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw corruptManifest()
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch (error) {
    throw corruptManifest(error)
  }
  if (!isRecord(value)) {
    throw corruptManifest()
  }
  const raw = value as RawArtifactManifest
  if (!Array.isArray(raw.entries)) {
    throw corruptManifest()
  }
  const manifest: ArtifactManifestV1 = {
    version: raw.version as 1,
    runId: raw.runId as string,
    logicalPath: raw.logicalPath as string,
    kind: raw.kind as ArtifactManifestV1["kind"],
    payloadSize: raw.payloadSize as number,
    entries: raw.entries.map((entry) => {
      if (!isRecord(entry)) throw corruptManifest()
      const rawEntry = entry as RawArtifactManifestEntry
      return {
        path: rawEntry.path as string,
        logicalPath: rawEntry.logicalPath as string,
        mediaType: rawEntry.mediaType as string,
        digest: rawEntry.digest as Sha256Digest,
        size: rawEntry.size as number,
      }
    }),
  }
  assertArtifactManifest(manifest)
  const canonical = encodeArtifactManifest(manifest)
  if (!equalBytes(bytes, canonical)) throw corruptManifest()
  return manifest
}

interface RawArtifactManifest {
  version?: unknown
  runId?: unknown
  logicalPath?: unknown
  kind?: unknown
  payloadSize?: unknown
  entries?: unknown
}

interface RawArtifactManifestEntry {
  path?: unknown
  logicalPath?: unknown
  mediaType?: unknown
  digest?: unknown
  size?: unknown
}

function assertArtifactManifest(manifest: ArtifactManifestV1): void {
  if (
    manifest.version !== 1 ||
    !isBoundedString(manifest.runId, 1, 256) ||
    !isBoundedString(manifest.logicalPath, 1, 4_096) ||
    (manifest.kind !== "file" && manifest.kind !== "directory" && manifest.kind !== "workspace") ||
    !Number.isSafeInteger(manifest.payloadSize) ||
    manifest.payloadSize < 0 ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length > MAX_MANIFEST_ENTRIES
  ) {
    throw corruptManifest()
  }

  let previous = ""
  let payloadSize = 0
  for (const entry of manifest.entries) {
    if (
      !isBoundedString(entry.path, 1, 4_096) ||
      !isBoundedString(entry.logicalPath, 1, 4_096) ||
      !isBoundedString(entry.mediaType, 1, 256) ||
      !SHA256_PATTERN.test(entry.digest) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      (previous !== "" && entry.path <= previous)
    ) {
      throw corruptManifest()
    }
    previous = entry.path
    payloadSize += entry.size
    if (!Number.isSafeInteger(payloadSize)) throw corruptManifest()
  }
  if (payloadSize !== manifest.payloadSize) throw corruptManifest()
}

function corruptManifest(cause?: unknown): ArtifactStoreError {
  return new ArtifactStoreError(
    "ARTIFACT_BLOB_CORRUPT",
    "Artifact manifest is invalid.",
    cause === undefined ? undefined : { cause },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    !value.includes("\0")
  )
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  return left.every((value, index) => value === right[index])
}
