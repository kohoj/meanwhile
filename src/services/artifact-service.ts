import {
  type ArtifactBlob,
  type ArtifactManifestEntryV1,
  type ArtifactStore,
  asSha256Digest,
  decodeArtifactManifest,
} from "../artifacts/artifact-store"
import type { Artifact, RequestContext } from "../domain"
import { AppError } from "../errors"
import type { Store } from "../persistence/store"
import { relativePath } from "../providers/runtime-provider"

export interface ArtifactDetail {
  readonly artifact: Artifact
  readonly entries: readonly ArtifactManifestEntryV1[]
}

export interface ArtifactContent {
  readonly bytes: Uint8Array
  readonly digest: string
  readonly mediaType: string
  readonly path: string
}

/** Owner-scoped read boundary from durable metadata to immutable bytes. */
export class ArtifactService {
  constructor(
    private readonly catalog: Pick<Store, "getArtifact" | "getArtifactForPrincipal">,
    private readonly blobs: ArtifactStore,
  ) {}

  async get(scope: string | RequestContext, artifactId: string): Promise<ArtifactDetail> {
    const artifact =
      typeof scope === "string"
        ? this.catalog.getArtifact(scope, artifactId)
        : this.catalog.getArtifactForPrincipal(scope.ownerId, scope.principalId, artifactId)
    if (artifact === null) throw notFound()
    const manifest = await this.readManifest(artifact)
    return { artifact, entries: manifest.entries }
  }

  async read(
    scope: string | RequestContext,
    artifactId: string,
    requestedPath?: string,
  ): Promise<ArtifactContent> {
    const detail = await this.get(scope, artifactId)
    const ownerId = typeof scope === "string" ? scope : scope.ownerId
    let entry: ArtifactManifestEntryV1 | undefined
    if (requestedPath === undefined) {
      if (detail.artifact.kind !== "file" || detail.entries.length !== 1) {
        throw new AppError({
          code: "INVALID_REQUEST",
          message: "A path is required when downloading a directory or workspace artifact",
        })
      }
      entry = detail.entries[0]
    } else {
      let path: string
      try {
        path = relativePath(requestedPath)
      } catch (cause) {
        throw new AppError({
          code: "INVALID_REQUEST",
          message: "Artifact path must be normalized and relative",
          cause,
        })
      }
      entry = detail.entries.find(({ path: candidate }) => candidate === path)
    }
    if (entry === undefined) throw notFound()

    const blob = await this.resolveBlob(ownerId, entry)
    try {
      return {
        bytes: await this.blobs.read(ownerId, blob),
        digest: entry.digest,
        mediaType: entry.mediaType,
        path: entry.path,
      }
    } catch (cause) {
      throw unavailable(cause)
    }
  }

  private async readManifest(artifact: Artifact) {
    let bytes: Uint8Array
    try {
      bytes = await this.blobs.read(artifact.ownerId, {
        storageKey: artifact.storageKey,
        digest: asSha256Digest(artifact.digest),
        size: artifact.byteSize,
      })
      const manifest = decodeArtifactManifest(bytes)
      if (
        manifest.runId !== artifact.runId ||
        manifest.logicalPath !== artifact.logicalPath ||
        manifest.kind !== artifact.kind
      ) {
        throw new Error("Artifact manifest identity mismatch")
      }
      return manifest
    } catch (cause) {
      throw unavailable(cause)
    }
  }

  private async resolveBlob(
    ownerId: string,
    entry: ArtifactManifestEntryV1,
  ): Promise<ArtifactBlob> {
    try {
      const blob = await this.blobs.resolve(ownerId, {
        digest: entry.digest,
        size: entry.size,
      })
      if (blob !== null) return blob
    } catch (cause) {
      throw unavailable(cause)
    }
    throw unavailable()
  }
}

const notFound = (): AppError => new AppError({ code: "NOT_FOUND", message: "Artifact not found" })

const unavailable = (cause?: unknown): AppError =>
  new AppError({
    code: "ARTIFACT_UNAVAILABLE",
    status: 500,
    message: "Artifact bytes are unavailable or invalid",
    ...(cause === undefined ? {} : { cause }),
  })
