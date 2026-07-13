import { posix } from "node:path"
import {
  type ArtifactBlob,
  type ArtifactStore,
  encodeArtifactManifest,
  type Sha256Digest,
} from "../artifacts/artifact-store"
import { SecretRedactor } from "../secrets"

export type WorkspaceEntryType = "file" | "directory" | "symlink"

export interface WorkspaceEntry {
  /** Workspace-root-relative POSIX path. `list` must use lstat semantics. */
  path: string
  type: WorkspaceEntryType
  size: number
  mediaType?: string
}

export interface ArtifactWorkspace {
  /** Includes the requested entry and all descendants, without following links. */
  list(
    path: string,
    limits: { readonly maxEntries: number; readonly maxDepth: number },
  ): Promise<readonly WorkspaceEntry[]>
  readFile(path: string, maxBytes: number): Promise<Uint8Array>
}

export interface ArtifactScanInput {
  logicalPath: string
  bytes: Uint8Array
}

export interface ArtifactPolicyFinding {
  /** Stable, safe identifier. It must not contain matched bytes. */
  ruleId: string
}

export interface ArtifactScanner {
  scan(input: ArtifactScanInput): Promise<ArtifactPolicyFinding | null>
  dispose?(): void
}

export interface ArtifactCollectionLimits {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
  /** Defaults to four times maxFiles, capped by the hard safety ceiling. */
  maxEntries?: number
  /** Defaults to 64 relative path segments. */
  maxDepth?: number
}

export interface ArtifactCollectorInput {
  ownerId: string
  runId: string
  declaredPaths: readonly string[]
  workspace: ArtifactWorkspace
  /** Operation-scoped and disposed by the collector on every exit path. */
  scanner?: ArtifactScanner
}

export type CollectedArtifactKind = "file" | "directory"

export interface CollectedArtifactEntry {
  /** Path relative to the artifact root, suitable for materialization. */
  path: string
  logicalPath: string
  mediaType: string
  blob: ArtifactBlob
}

export interface CollectedArtifact {
  /** Content-derived identity of the canonical manifest. */
  id: Sha256Digest
  ownerId: string
  runId: string
  logicalPath: string
  kind: CollectedArtifactKind
  digest: Sha256Digest
  /** Durable root; database storageKey/digest/byteSize point to this blob. */
  manifest: ArtifactBlob
  /** Sum of immutable payload bytes, also recorded inside the manifest. */
  size: number
  entries: readonly CollectedArtifactEntry[]
  createdAt: string
}

export interface CollectedArtifactMetadata {
  id: string
  ownerId: string
  runId: string
  logicalPath: string
  kind: CollectedArtifactKind
  digest: string
  mediaType: string
  byteSize: number
  storageKey: string
  createdAt: string
}

/** Maps the durable manifest root into the persistence Artifact shape. */
export function artifactMetadata(artifact: CollectedArtifact): CollectedArtifactMetadata {
  return {
    id: artifact.id,
    ownerId: artifact.ownerId,
    runId: artifact.runId,
    logicalPath: artifact.logicalPath,
    kind: artifact.kind,
    digest: artifact.manifest.digest,
    mediaType: "application/vnd.meanwhile.artifact-manifest+json; version=1",
    byteSize: artifact.manifest.size,
    storageKey: artifact.manifest.storageKey,
    createdAt: artifact.createdAt,
  }
}

export type ArtifactCollectionErrorCode =
  | "ARTIFACT_PATH_INVALID"
  | "ARTIFACT_PATH_UNDECLARED"
  | "ARTIFACT_PATH_DUPLICATE"
  | "ARTIFACT_SYMLINK_REJECTED"
  | "ARTIFACT_LIMIT_EXCEEDED"
  | "ARTIFACT_SOURCE_INCONSISTENT"
  | "ARTIFACT_SECRET_DETECTED"

export class ArtifactCollectionError extends Error {
  override readonly name = "ArtifactCollectionError"

  constructor(
    readonly code: ArtifactCollectionErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export interface ArtifactCollectorOptions {
  store: ArtifactStore
  limits: ArtifactCollectionLimits
  /** Operation-scoped; disposed after the next collection attempt. */
  scanner?: ArtifactScanner
  now?: () => Date
}

/**
 * Captures declared output into immutable blobs and deterministic manifests.
 * Database metadata is intentionally returned to the executor for transactional
 * persistence; the collector never receives a SQL handle.
 */
export class ArtifactCollector {
  readonly #store: ArtifactStore
  readonly #limits: ResolvedArtifactCollectionLimits
  readonly #scanner: ArtifactScanner | undefined
  readonly #now: () => Date

  constructor(options: ArtifactCollectorOptions) {
    this.#store = options.store
    this.#limits = resolveLimits(options.limits)
    this.#scanner = options.scanner
    this.#now = options.now ?? (() => new Date())
  }

  async collect(input: ArtifactCollectorInput): Promise<CollectedArtifact[]> {
    const scanner = input.scanner ?? this.#scanner ?? NOOP_SCANNER
    try {
      return await this.#collect(input, scanner)
    } finally {
      scanner.dispose?.()
    }
  }

  async #collect(
    input: ArtifactCollectorInput,
    scanner: ArtifactScanner,
  ): Promise<CollectedArtifact[]> {
    if (input.declaredPaths.length === 0) return []

    const declarations = input.declaredPaths
      .map((path) => normalizeArtifactPath(path, true))
      .sort(compareText)
    assertUnique(declarations, "Artifact declaration is duplicated.")

    const captured = new Map<
      string,
      { source: WorkspaceEntry; blob: ArtifactBlob; mediaType: string }
    >()
    let totalBytes = 0

    const artifacts: CollectedArtifact[] = []
    let enumeratedEntries = 0
    for (const declaration of declarations) {
      const declarationFinding = await scanner.scan({
        logicalPath: declaration,
        bytes: new Uint8Array(),
      })
      if (declarationFinding !== null) {
        throw secretFinding(declarationFinding)
      }
      const remainingEntries = this.#limits.maxEntries - enumeratedEntries
      if (remainingEntries <= 0) throw limitError("workspace entries", this.#limits.maxEntries)
      const sourceEntries = await input.workspace.list(declaration, {
        maxEntries: remainingEntries,
        maxDepth: this.#limits.maxDepth,
      })
      enumeratedEntries += sourceEntries.length
      if (enumeratedEntries > this.#limits.maxEntries) {
        throw limitError("workspace entries", this.#limits.maxEntries)
      }
      const entries = sourceEntries
        .map(validateWorkspaceEntry)
        .sort((left, right) => compareText(left.path, right.path))
      assertUnique(
        entries.map((entry) => entry.path),
        "Workspace returned a path more than once.",
      )

      const root = entries.find((entry) => entry.path === declaration)
      if (root === undefined) {
        throw new ArtifactCollectionError(
          "ARTIFACT_SOURCE_INCONSISTENT",
          "Workspace did not return the declared artifact root.",
          { path: declaration },
        )
      }
      if (root.type === "symlink") rejectSymlink(root.path)

      for (const entry of entries) {
        if (!isWithin(declaration, entry.path)) {
          throw new ArtifactCollectionError(
            "ARTIFACT_PATH_UNDECLARED",
            "Workspace returned a path outside the declared artifact.",
            { path: entry.path },
          )
        }
        if (entry.type === "symlink") rejectSymlink(entry.path)
        if (relativeDepth(declaration, entry.path) > this.#limits.maxDepth) {
          throw limitError("workspace depth", this.#limits.maxDepth, entry.path)
        }
      }

      const files = entries.filter((entry) => entry.type === "file")
      const collectedEntries: CollectedArtifactEntry[] = []
      for (const file of files) {
        let item = captured.get(file.path)
        if (item !== undefined) {
          if (
            item.source.size !== file.size ||
            item.source.type !== file.type ||
            item.source.mediaType !== file.mediaType
          ) {
            throw new ArtifactCollectionError(
              "ARTIFACT_SOURCE_INCONSISTENT",
              "Workspace metadata changed during artifact collection.",
              { path: file.path },
            )
          }
        } else {
          if (captured.size + 1 > this.#limits.maxFiles) {
            throw limitError("file count", this.#limits.maxFiles)
          }
          if (file.size > this.#limits.maxFileBytes) {
            throw limitError("file bytes", this.#limits.maxFileBytes, file.path)
          }
          if (totalBytes + file.size > this.#limits.maxTotalBytes) {
            throw limitError("total bytes", this.#limits.maxTotalBytes)
          }

          const sourceBytes = await input.workspace.readFile(file.path, file.size)
          // Workspace buffers remain provider-owned until copied. Snapshot
          // before scanner or store awaits can observe caller mutation.
          const bytes = Uint8Array.from(sourceBytes)
          if (bytes.byteLength !== file.size) {
            throw new ArtifactCollectionError(
              "ARTIFACT_SOURCE_INCONSISTENT",
              "Workspace file size changed during artifact collection.",
              { path: file.path },
            )
          }

          const finding = await scanner.scan({
            logicalPath: file.path,
            bytes,
          })
          if (finding !== null) {
            throw secretFinding(finding)
          }

          const blob = await this.#store.put({ ownerId: input.ownerId, bytes })
          item = {
            source: file,
            blob,
            mediaType: inferMediaType(file.path),
          }
          captured.set(file.path, item)
          totalBytes += file.size
        }

        collectedEntries.push({
          path: materializedPath(declaration, root.type, file.path),
          logicalPath: file.path,
          mediaType: item.mediaType,
          blob: item.blob,
        })
      }

      const kind: CollectedArtifactKind = root.type === "file" ? "file" : "directory"
      const payloadSize = collectedEntries.reduce((sum, entry) => sum + entry.blob.size, 0)
      const canonicalManifest = encodeArtifactManifest({
        version: 1,
        runId: input.runId,
        logicalPath: declaration,
        kind,
        payloadSize,
        entries: collectedEntries.map((entry) => ({
          path: entry.path,
          logicalPath: entry.logicalPath,
          mediaType: entry.mediaType,
          digest: entry.blob.digest,
          size: entry.blob.size,
        })),
      })
      const manifest = await this.#store.put({
        ownerId: input.ownerId,
        bytes: canonicalManifest,
      })
      artifacts.push({
        id: manifest.digest,
        ownerId: input.ownerId,
        runId: input.runId,
        logicalPath: declaration,
        kind,
        digest: manifest.digest,
        manifest,
        size: payloadSize,
        entries: collectedEntries,
        createdAt: this.#now().toISOString(),
      })
    }

    return artifacts
  }
}

/** Exact-byte scanner for resolved values. Values are never included in findings. */
export class ExactSecretArtifactScanner implements ArtifactScanner {
  readonly #redactor: SecretRedactor

  constructor(secrets: Readonly<Record<string, string | Uint8Array>>) {
    this.#redactor = new SecretRedactor(Object.values(secrets))
  }

  async scan(input: ArtifactScanInput): Promise<ArtifactPolicyFinding | null> {
    return this.#redactor.contains(input) ? { ruleId: "resolved-secret" } : null
  }

  dispose(): void {
    this.#redactor.dispose()
  }
}

export function normalizeArtifactPath(path: string, allowRoot = false): string {
  if (path === "." && allowRoot) return path
  const encoder = new TextEncoder()
  if (
    path.length === 0 ||
    path.includes("\0") ||
    hasControlCharacter(path) ||
    encoder.encode(path).byteLength > 4_096 ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.endsWith("/")
  ) {
    throw invalidPath()
  }

  const segments = path.split("/")
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        encoder.encode(segment).byteLength > 255,
    )
  ) {
    throw invalidPath()
  }

  const normalized = posix.normalize(path)
  if (normalized !== path || normalized === ".." || normalized.startsWith("../")) {
    throw invalidPath()
  }
  return normalized
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function validateWorkspaceEntry(entry: WorkspaceEntry): WorkspaceEntry {
  const path = normalizeArtifactPath(entry.path, true)
  if (
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    (entry.type === "directory" && entry.size !== 0)
  ) {
    throw new ArtifactCollectionError(
      "ARTIFACT_SOURCE_INCONSISTENT",
      "Workspace returned invalid artifact metadata.",
      { path },
    )
  }
  if (entry.type !== "file" && entry.type !== "directory" && entry.type !== "symlink") {
    throw new ArtifactCollectionError(
      "ARTIFACT_SOURCE_INCONSISTENT",
      "Workspace returned an unsupported entry type.",
      { path },
    )
  }
  return { ...entry, path }
}

function materializedPath(
  declaration: string,
  rootType: WorkspaceEntryType,
  filePath: string,
): string {
  if (rootType === "file") return posix.basename(filePath)
  if (declaration === ".") return filePath
  return filePath.slice(declaration.length + 1)
}

function isWithin(root: string, path: string): boolean {
  return root === "." || path === root || path.startsWith(`${root}/`)
}

function rejectSymlink(path: string): never {
  throw new ArtifactCollectionError(
    "ARTIFACT_SYMLINK_REJECTED",
    "Symbolic links are not eligible for artifact capture.",
    { path },
  )
}

function secretFinding(finding: ArtifactPolicyFinding): ArtifactCollectionError {
  return new ArtifactCollectionError(
    "ARTIFACT_SECRET_DETECTED",
    "Artifact content was rejected by secret policy.",
    { ruleId: finding.ruleId },
  )
}

function assertUnique(values: readonly string[], message: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) {
      throw new ArtifactCollectionError("ARTIFACT_PATH_DUPLICATE", message, {
        path: value,
      })
    }
    seen.add(value)
  }
}

interface ResolvedArtifactCollectionLimits {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
  readonly maxEntries: number
  readonly maxDepth: number
}

const MAX_WORKSPACE_ENTRIES = 100_000
const MAX_WORKSPACE_DEPTH = 256

function resolveLimits(limits: ArtifactCollectionLimits): ResolvedArtifactCollectionLimits {
  const maxEntries =
    limits.maxEntries ??
    Math.min(MAX_WORKSPACE_ENTRIES, Math.max(limits.maxFiles, limits.maxFiles * 4))
  const maxDepth = limits.maxDepth ?? 64
  const resolved = { ...limits, maxEntries, maxDepth }
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ArtifactCollectionError(
        "ARTIFACT_LIMIT_EXCEEDED",
        "Artifact collection limits must be positive integers.",
        { limit: name },
      )
    }
  }
  if (
    maxEntries < limits.maxFiles ||
    maxEntries > MAX_WORKSPACE_ENTRIES ||
    maxDepth > MAX_WORKSPACE_DEPTH
  ) {
    throw new ArtifactCollectionError(
      "ARTIFACT_LIMIT_EXCEEDED",
      "Artifact collection limits exceed workspace safety bounds.",
    )
  }
  return resolved
}

function relativeDepth(root: string, path: string): number {
  if (path === root) return 0
  const relative = root === "." ? path : path.slice(root.length + 1)
  return relative.split("/").length
}

function limitError(kind: string, limit: number, path?: string): ArtifactCollectionError {
  return new ArtifactCollectionError(
    "ARTIFACT_LIMIT_EXCEEDED",
    "Artifact collection exceeded a configured limit.",
    path === undefined ? { kind, limit } : { kind, limit, path },
  )
}

function invalidPath(): ArtifactCollectionError {
  return new ArtifactCollectionError(
    "ARTIFACT_PATH_INVALID",
    "Artifact path must be a normalized workspace-relative POSIX path.",
  )
}

function inferMediaType(path: string): string {
  const extension = posix.extname(path).toLowerCase()
  return MEDIA_TYPES[extension] ?? "application/octet-stream"
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

const NOOP_SCANNER: ArtifactScanner = {
  async scan() {
    return null
  },
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
}
