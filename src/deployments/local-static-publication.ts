import { constants } from "node:fs"
import { lstat, open, readdir } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { sha256 } from "../artifacts/artifact-store"
import { normalizeArtifactPath } from "../services/artifact-collector"

const publicationManifestSchema = z
  .object({
    version: z.literal(1),
    artifactId: z.string().regex(/^[a-f0-9]{64}$/),
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    files: z.array(
      z
        .object({
          path: z.string().min(1),
          digest: z.string().regex(/^[a-f0-9]{64}$/),
          size: z.number().int().nonnegative(),
          mediaType: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict()

export type LocalStaticPublicationManifest = z.infer<typeof publicationManifestSchema>

export interface LocalStaticPublicationInputFile {
  readonly path: string
  readonly digest: string
  readonly size: number
  readonly mediaType: string
}

export interface VerifiedLocalStaticPublicationFile {
  /** Path relative to the deployment publication root. */
  readonly path: string
  readonly bytes: Uint8Array
}

export class LocalStaticPublicationError extends Error {
  override readonly name = "LocalStaticPublicationError"
}

/** One canonical identity shared by publication, reconciliation, backup, and restore. */
export function localStaticPublicationManifest(input: {
  readonly artifactId: string
  readonly manifestDigest: string
  readonly files: readonly LocalStaticPublicationInputFile[]
}): LocalStaticPublicationManifest {
  const manifest = publicationManifestSchema.parse({
    version: 1,
    artifactId: input.artifactId,
    manifestDigest: input.manifestDigest,
    files: [...input.files]
      .map((file) => ({
        path: normalizeArtifactPath(file.path),
        digest: file.digest,
        size: file.size,
        mediaType: file.mediaType,
      }))
      .sort((left, right) => comparePath(left.path, right.path)),
  })
  const paths = new Set<string>()
  for (const file of manifest.files) {
    if (paths.has(file.path)) throw new LocalStaticPublicationError("Publication paths collide")
    paths.add(file.path)
  }
  return manifest
}

/**
 * Proves that a published preview is exactly the immutable artifact graph.
 * It rejects missing files, extra files, links, non-files, and changed bytes.
 */
export async function verifyLocalStaticPublication(
  deploymentRoot: string,
  expected: LocalStaticPublicationManifest,
): Promise<readonly VerifiedLocalStaticPublicationFile[]> {
  try {
    const canonicalExpected = publicationManifestSchema.parse(expected)
    const root = resolve(deploymentRoot)
    const rootInfo = await lstat(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new LocalStaticPublicationError("Publication root is not a real directory")
    }

    const actualPaths = await listPublicationFiles(root)
    const expectedPaths = [
      "manifest.json",
      ...canonicalExpected.files.map((file) => `public/${file.path}`),
    ].sort(comparePath)
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      throw new LocalStaticPublicationError("Publication graph contains missing or extra files")
    }

    const manifestBytes = await readStableFile(root, "manifest.json")
    const published = publicationManifestSchema.parse(
      JSON.parse(new TextDecoder().decode(manifestBytes)),
    )
    if (JSON.stringify(published) !== JSON.stringify(canonicalExpected)) {
      throw new LocalStaticPublicationError("Publication manifest does not match its artifact")
    }

    const verified: VerifiedLocalStaticPublicationFile[] = [
      { path: "manifest.json", bytes: manifestBytes },
    ]
    for (const file of canonicalExpected.files) {
      const path = `public/${file.path}`
      const bytes = await readStableFile(root, path)
      if (bytes.byteLength !== file.size || sha256(bytes) !== file.digest) {
        throw new LocalStaticPublicationError("Publication bytes failed integrity verification")
      }
      verified.push({ path, bytes })
    }
    return verified
  } catch (cause) {
    if (cause instanceof LocalStaticPublicationError) throw cause
    throw new LocalStaticPublicationError("Local static publication is invalid", { cause })
  }
}

async function listPublicationFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const names = (await readdir(directory)).sort(comparePath)
    for (const name of names) {
      const absolute = join(directory, name)
      const info = await lstat(absolute)
      if (info.isSymbolicLink())
        throw new LocalStaticPublicationError("Publication contains a link")
      if (info.isDirectory()) {
        await visit(absolute)
      } else if (info.isFile()) {
        files.push(relative(root, absolute).split(sep).join("/"))
      } else {
        throw new LocalStaticPublicationError("Publication contains a non-file entry")
      }
    }
  }
  await visit(root)
  return files.sort(comparePath)
}

async function readStableFile(root: string, path: string): Promise<Uint8Array> {
  const absolute = resolve(root, path)
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new LocalStaticPublicationError("Publication path escapes its root")
  }
  const before = await lstat(absolute)
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new LocalStaticPublicationError("Publication entry is not a real file")
  }
  const handle = await open(absolute, constants.O_RDONLY | noFollowFlag())
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new LocalStaticPublicationError("Publication changed during verification")
    }
    const bytes = new Uint8Array(await handle.readFile())
    if (bytes.byteLength !== opened.size) {
      throw new LocalStaticPublicationError("Publication changed during verification")
    }
    return bytes
  } finally {
    await handle.close()
  }
}

const noFollowFlag = (): number => ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)

const comparePath = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0
