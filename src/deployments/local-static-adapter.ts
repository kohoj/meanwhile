import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { sha256 } from "../artifacts/artifact-store"
import { normalizeArtifactPath } from "../services/artifact-collector"
import {
  type DeployAdapter,
  DeployAdapterError,
  type DeployContext,
  type DeployInput,
  type DeploymentSourceEntry,
  type DeployResult,
} from "./deploy-adapter"
import { isPreviewDeploymentId, type LocalStaticServer } from "./local-static-server"

interface PublishedManifest {
  version: 1
  artifactId: string
  manifestDigest: string
  files: readonly {
    path: string
    digest: string
    size: number
    mediaType: string
  }[]
}

/** Atomically materializes immutable artifacts for the separate preview origin. */
export class LocalStaticAdapter implements DeployAdapter {
  readonly name = "local-static"
  readonly secretEnvNames: readonly string[] = []
  readonly #server: LocalStaticServer

  constructor(server: LocalStaticServer) {
    this.#server = server
  }

  validate(config: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    if (Object.keys(config).length !== 0) {
      throw new DeployAdapterError(
        "DEPLOYMENT_TARGET_INVALID",
        "Local static deployment does not accept target configuration.",
      )
    }
    return {}
  }

  async deploy(input: DeployInput, context: DeployContext): Promise<DeployResult> {
    if (input.target.name !== this.name) {
      throw new DeployAdapterError(
        "DEPLOYMENT_TARGET_INVALID",
        "Local static adapter received the wrong deployment target.",
      )
    }
    if (!isPreviewDeploymentId(input.deploymentId)) {
      throw new DeployAdapterError(
        "DEPLOYMENT_TARGET_INVALID",
        "Deployment identity is invalid for local preview.",
      )
    }
    if (Object.keys(input.target.config).length !== 0 || Object.keys(input.secrets).length !== 0) {
      throw new DeployAdapterError(
        "DEPLOYMENT_TARGET_INVALID",
        "Local static deployment does not accept target configuration or secrets.",
      )
    }

    const entries = validateEntries(input.source.entries)
    const manifest: PublishedManifest = {
      version: 1,
      artifactId: input.source.artifactId,
      manifestDigest: input.source.manifestDigest,
      files: entries.map((entry) => ({
        path: entry.path,
        digest: entry.blob.digest,
        size: entry.blob.size,
        mediaType: entry.mediaType,
      })),
    }
    const root = this.#server.root
    const destination = resolve(root, input.deploymentId)
    const temporary = resolve(root, `.${input.deploymentId}.${crypto.randomUUID()}.tmp`)
    assertContained(root, destination)
    assertContained(root, temporary)

    this.#server.start()
    const destinationExists = await pathExistsAsDirectory(destination)
    const existing = await readPublishedManifest(destination)
    if (existing !== null) {
      if (samePublication(existing, manifest)) {
        await context.emit({
          level: "info",
          event: "deployment.local_static.reused",
          message: "Immutable local preview already exists.",
        })
        return this.#result(input.deploymentId, manifest)
      }
      throw new DeployAdapterError(
        "DEPLOYMENT_TARGET_FAILED",
        "Deployment identity is already bound to different immutable content.",
      )
    }
    if (destinationExists) {
      throw new DeployAdapterError(
        "DEPLOYMENT_TARGET_FAILED",
        "Deployment identity is bound to an invalid local publication.",
      )
    }

    assertNotAborted(context.signal)
    await context.emit({
      level: "info",
      event: "deployment.local_static.materializing",
      message: "Materializing immutable artifact for local preview.",
      fields: { fileCount: entries.length },
    })

    try {
      await mkdir(resolve(temporary, "public"), { recursive: true })
      for (const entry of entries) {
        assertNotAborted(context.signal)
        const bytes = await input.source.read(entry)
        if (bytes.byteLength !== entry.blob.size || sha256(bytes) !== entry.blob.digest) {
          throw new DeployAdapterError(
            "DEPLOYMENT_SOURCE_INVALID",
            "Immutable deployment source failed its integrity check.",
            false,
            { path: entry.path },
          )
        }

        const output = resolve(temporary, "public", entry.path)
        assertContained(resolve(temporary, "public"), output)
        await mkdir(dirname(output), { recursive: true })
        await Bun.write(output, bytes)
      }
      await Bun.write(resolve(temporary, "manifest.json"), JSON.stringify(manifest))
      assertNotAborted(context.signal)
      await rename(temporary, destination)
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      if (error instanceof DeployAdapterError) throw error

      // Another execution may have atomically published the same deployment.
      const raced = await readPublishedManifest(destination)
      if (raced !== null && samePublication(raced, manifest)) {
        return this.#result(input.deploymentId, manifest)
      }

      throw new DeployAdapterError(
        "DEPLOYMENT_TARGET_FAILED",
        "Local static artifact could not be published.",
        false,
        {},
        { cause: error },
      )
    }

    await context.emit({
      level: "info",
      event: "deployment.local_static.published",
      message: "Immutable local preview is available.",
      fields: { fileCount: entries.length },
    })
    return this.#result(input.deploymentId, manifest)
  }

  #result(deploymentId: string, manifest: PublishedManifest): DeployResult {
    const url = this.#server.deploymentUrl(deploymentId)
    return {
      url,
      previewUrl: url,
      metadata: {
        adapter: this.name,
        manifestDigest: manifest.manifestDigest,
        fileCount: manifest.files.length,
      },
    }
  }
}

function validateEntries(
  entries: readonly DeploymentSourceEntry[],
): readonly DeploymentSourceEntry[] {
  for (const entry of entries) {
    try {
      normalizeArtifactPath(entry.path)
    } catch (error) {
      throw new DeployAdapterError(
        "DEPLOYMENT_SOURCE_INVALID",
        "Immutable deployment source contains an invalid path.",
        false,
        {},
        { cause: error },
      )
    }
  }
  const ordered = [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )
  const files = new Set<string>()
  const portableNodes = new Map<string, string>()
  for (const entry of ordered) {
    const pathSegments = entry.path.split("/")
    let originalNode = ""
    for (const segment of pathSegments) {
      originalNode = originalNode === "" ? segment : `${originalNode}/${segment}`
      const portableNode = originalNode.normalize("NFC").toLowerCase()
      const existingNode = portableNodes.get(portableNode)
      if (existingNode !== undefined && existingNode !== originalNode) {
        throw new DeployAdapterError(
          "DEPLOYMENT_SOURCE_INVALID",
          "Immutable deployment source contains a colliding path.",
          false,
          { path: entry.path },
        )
      }
      portableNodes.set(portableNode, originalNode)
    }
    if (files.has(entry.path)) {
      throw new DeployAdapterError(
        "DEPLOYMENT_SOURCE_INVALID",
        "Immutable deployment source contains a colliding path.",
        false,
        { path: entry.path },
      )
    }
    const segments = entry.path.split("/")
    let parent = ""
    for (let index = 0; index < segments.length - 1; index++) {
      parent = parent === "" ? (segments[index] as string) : `${parent}/${segments[index]}`
      if (files.has(parent)) {
        throw new DeployAdapterError(
          "DEPLOYMENT_SOURCE_INVALID",
          "Immutable deployment source has a file and directory collision.",
          false,
          { path: entry.path },
        )
      }
    }
    files.add(entry.path)
  }
  return ordered
}

async function readPublishedManifest(destination: string): Promise<PublishedManifest | null> {
  try {
    const manifestPath = resolve(destination, "manifest.json")
    const info = await lstat(manifestPath)
    if (!info.isFile() || info.isSymbolicLink()) return null
    const raw = await readFile(manifestPath, "utf8")
    const value: unknown = JSON.parse(raw)
    if (!isPublishedManifest(value)) return null
    return value
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null
    }
    return null
  }
}

async function pathExistsAsDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new DeployAdapterError(
        "DEPLOYMENT_TARGET_FAILED",
        "Deployment identity is bound to an invalid local publication.",
      )
    }
    return true
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return false
    throw error
  }
}

function isPublishedManifest(value: unknown): value is PublishedManifest {
  if (typeof value !== "object" || value === null) return false
  const record = value as Partial<PublishedManifest>
  return (
    record.version === 1 &&
    typeof record.artifactId === "string" &&
    typeof record.manifestDigest === "string" &&
    Array.isArray(record.files)
  )
}

function samePublication(left: PublishedManifest, right: PublishedManifest): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.manifestDigest === right.manifestDigest &&
    JSON.stringify(left.files) === JSON.stringify(right.files)
  )
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DeployAdapterError("DEPLOYMENT_ABORTED", "Deployment was aborted.")
  }
}

function assertContained(root: string, candidate: string): void {
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new DeployAdapterError(
      "DEPLOYMENT_TARGET_FAILED",
      "Local deployment path escaped its publication root.",
    )
  }
}
