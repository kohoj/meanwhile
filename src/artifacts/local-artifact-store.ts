import { constants } from "node:fs"
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import {
  type ArtifactBlob,
  type ArtifactContentReference,
  type ArtifactStore,
  ArtifactStoreError,
  asSha256Digest,
  type PutArtifactBlob,
  sha256,
} from "./artifact-store"

const OWNER_ID_MAX_BYTES = 512

/** Content-addressed, owner-scoped storage backed by a local directory. */
export class LocalArtifactStore implements ArtifactStore {
  readonly #root: string

  constructor(root: string) {
    if (root.trim().length === 0) {
      throw new ArtifactStoreError(
        "ARTIFACT_BLOB_INVALID",
        "Artifact storage root must not be empty.",
      )
    }

    this.#root = resolve(root)
  }

  async put(input: PutArtifactBlob): Promise<ArtifactBlob> {
    assertOwnerId(input.ownerId)
    // Uint8Array is mutable and caller-owned. Snapshot before the first await so
    // digest, size, and persisted bytes always describe one immutable value.
    const bytes = Uint8Array.from(input.bytes)
    const digest = sha256(bytes)
    if (input.expectedDigest !== undefined && input.expectedDigest !== digest) {
      throw new ArtifactStoreError(
        "ARTIFACT_BLOB_INVALID",
        "Artifact content does not match its expected digest.",
      )
    }

    const storageKey = this.#storageKey(input.ownerId, digest)
    const destination = this.#absolutePath(storageKey)
    const blob: ArtifactBlob = {
      storageKey,
      digest,
      size: bytes.byteLength,
    }

    await mkdir(dirname(destination), { recursive: true })
    await this.#assertStorageAncestors(storageKey, false)

    const existing = await this.stat(input.ownerId, blob)
    if (existing !== null) return existing

    const temporary = `${destination}.${crypto.randomUUID()}.tmp`
    try {
      const handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.#assertStorageAncestors(storageKey, false)
      await rename(temporary, destination)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)

      // A concurrent writer of the same digest may have won the rename race.
      const raced = await this.stat(input.ownerId, blob).catch(() => null)
      if (raced !== null) return raced

      throw new ArtifactStoreError("ARTIFACT_STORE_IO", "Artifact bytes could not be stored.", {
        cause: error,
      })
    }

    return blob
  }

  async resolve(ownerId: string, content: ArtifactContentReference): Promise<ArtifactBlob | null> {
    assertOwnerId(ownerId)
    assertContentReference(content)
    const blob: ArtifactBlob = {
      storageKey: this.#storageKey(ownerId, content.digest),
      digest: content.digest,
      size: content.size,
    }
    return this.stat(ownerId, blob)
  }

  async stat(ownerId: string, blob: ArtifactBlob): Promise<ArtifactBlob | null> {
    const path = this.#authorizedPath(ownerId, blob)
    if (!(await this.#assertStorageAncestors(blob.storageKey, true))) return null
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if (isMissing(error)) return null
      if (isSymlink(error)) throw corruptBlob()
      throw new ArtifactStoreError("ARTIFACT_STORE_IO", "Artifact metadata could not be read.", {
        cause: error,
      })
    }

    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size !== blob.size) throw corruptBlob()
      const bytes = new Uint8Array(await handle.readFile())
      if (bytes.byteLength !== blob.size || sha256(bytes) !== blob.digest) throw corruptBlob()
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error
      throw new ArtifactStoreError("ARTIFACT_STORE_IO", "Artifact metadata could not be read.", {
        cause: error,
      })
    } finally {
      await handle.close()
    }

    return blob
  }

  async read(ownerId: string, blob: ArtifactBlob): Promise<Uint8Array> {
    const path = this.#authorizedPath(ownerId, blob)
    if (!(await this.#assertStorageAncestors(blob.storageKey, true))) {
      throw new ArtifactStoreError("ARTIFACT_BLOB_NOT_FOUND", "Artifact bytes were not found.")
    }
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if (isMissing(error)) {
        throw new ArtifactStoreError("ARTIFACT_BLOB_NOT_FOUND", "Artifact bytes were not found.")
      }
      if (isSymlink(error)) throw corruptBlob()
      throw new ArtifactStoreError("ARTIFACT_STORE_IO", "Artifact bytes could not be read.", {
        cause: error,
      })
    }

    try {
      // Verify size on the opened descriptor before allocating the read buffer;
      // a path replacement cannot redirect this descriptor after open.
      const info = await handle.stat()
      if (!info.isFile() || info.size !== blob.size) throw corruptBlob()
      const bytes = new Uint8Array(await handle.readFile())
      if (bytes.byteLength !== blob.size || sha256(bytes) !== blob.digest) throw corruptBlob()
      return bytes
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error
      throw new ArtifactStoreError("ARTIFACT_STORE_IO", "Artifact bytes could not be read.", {
        cause: error,
      })
    } finally {
      await handle.close()
    }
  }

  #authorizedPath(ownerId: string, blob: ArtifactBlob): string {
    assertOwnerId(ownerId)
    assertContentReference(blob)

    const expectedKey = this.#storageKey(ownerId, blob.digest)
    if (blob.storageKey !== expectedKey) {
      // Deliberately indistinguishable from an absent owner-scoped blob.
      throw new ArtifactStoreError("ARTIFACT_BLOB_NOT_FOUND", "Artifact bytes were not found.")
    }

    return this.#absolutePath(expectedKey)
  }

  async #assertStorageAncestors(storageKey: string, allowMissing: boolean): Promise<boolean> {
    let current = this.#root
    const directories = storageKey.split("/").slice(0, -1)
    for (const segment of ["", ...directories]) {
      if (segment !== "") current = join(current, segment)
      let info: Awaited<ReturnType<typeof lstat>>
      try {
        info = await lstat(current)
      } catch (error) {
        if (allowMissing && isMissing(error)) return false
        throw new ArtifactStoreError(
          "ARTIFACT_STORE_IO",
          "Artifact storage directory could not be verified.",
          { cause: error },
        )
      }
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new ArtifactStoreError(
          "ARTIFACT_STORE_IO",
          "Artifact storage directory is not a real directory.",
        )
      }
    }
    return true
  }

  #storageKey(ownerId: string, digest: string): string {
    const ownerKey = new Bun.CryptoHasher("sha256").update(ownerId).digest("hex")
    return `owners/${ownerKey}/sha256/${digest.slice(0, 2)}/${digest}`
  }

  #absolutePath(storageKey: string): string {
    const path = resolve(join(this.#root, storageKey))
    if (path !== this.#root && !path.startsWith(`${this.#root}${sep}`)) {
      throw new ArtifactStoreError("ARTIFACT_BLOB_INVALID", "Artifact storage key is invalid.")
    }
    return path
  }
}

function assertContentReference(content: ArtifactContentReference): void {
  asSha256Digest(content.digest)
  if (!Number.isSafeInteger(content.size) || content.size < 0) {
    throw new ArtifactStoreError("ARTIFACT_BLOB_INVALID", "Artifact size is invalid.")
  }
}

function corruptBlob(): ArtifactStoreError {
  return new ArtifactStoreError(
    "ARTIFACT_BLOB_CORRUPT",
    "Stored artifact does not match its immutable metadata.",
  )
}

function assertOwnerId(ownerId: string): void {
  if (
    ownerId.trim().length === 0 ||
    new TextEncoder().encode(ownerId).byteLength > OWNER_ID_MAX_BYTES
  ) {
    throw new ArtifactStoreError("ARTIFACT_BLOB_INVALID", "Artifact owner identity is invalid.")
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function isSymlink(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ELOOP"
}
