import { constants } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { relativePath } from "./providers/runtime-provider"

const MAX_UPLOAD_FILES = 256
const MAX_UPLOAD_FILE_BYTES = 4 * 1024 * 1024
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

export interface UploadedWorkspaceFile {
  readonly path: string
  readonly contentBase64: string
  readonly mode: number
}

export class WorkspaceCaptureError extends Error {
  readonly code = "INVALID_ARGUMENT"
  readonly details: Readonly<Record<string, unknown>>

  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message)
    this.name = "WorkspaceCaptureError"
    this.details = details
  }
}

/** Captures one portable, bounded directory without following links. */
export async function captureWorkspace(
  directory: string,
  cwd = process.cwd(),
): Promise<UploadedWorkspaceFile[]> {
  const requestedRoot = isAbsolute(directory) ? resolve(directory) : resolve(cwd, directory)
  let rootInfo: Awaited<ReturnType<typeof lstat>>
  try {
    rootInfo = await lstat(requestedRoot)
  } catch {
    throw captureError("Uploaded workspace directory does not exist")
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw captureError("Uploaded workspace root must be a real directory")
  }

  const canonicalRoot = await realpath(requestedRoot)
  const files: UploadedWorkspaceFile[] = []
  let totalBytes = 0

  const visit = async (directoryPath: string): Promise<void> => {
    const entries = await readdir(directoryPath, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const candidate = resolve(directoryPath, entry.name)
      const logical = relative(canonicalRoot, candidate).split(sep).join("/")
      let portablePath: string
      try {
        portablePath = relativePath(logical)
      } catch {
        throw captureError("Uploaded workspace contains a non-portable path", { path: logical })
      }

      const info = await lstat(candidate)
      if (info.isSymbolicLink()) {
        throw captureError("Uploaded workspace must not contain symbolic links", {
          path: portablePath,
        })
      }
      const canonical = await realpath(candidate)
      if (!isContained(canonicalRoot, canonical)) {
        throw captureError("Uploaded workspace path escapes its root", { path: portablePath })
      }
      if (info.isDirectory()) {
        await visit(candidate)
        continue
      }
      if (!info.isFile()) {
        throw captureError("Uploaded workspace contains a non-file entry", {
          path: portablePath,
        })
      }
      if (files.length >= MAX_UPLOAD_FILES) {
        throw captureError("Uploaded workspace exceeds the file-count limit", {
          limit: MAX_UPLOAD_FILES,
        })
      }
      if (info.size > MAX_UPLOAD_FILE_BYTES) {
        throw captureError("Uploaded workspace contains a file over the byte limit", {
          path: portablePath,
          limit: MAX_UPLOAD_FILE_BYTES,
        })
      }
      totalBytes += info.size
      if (totalBytes > MAX_UPLOAD_BYTES) {
        throw captureError("Uploaded workspace exceeds the total byte limit", {
          limit: MAX_UPLOAD_BYTES,
        })
      }

      let handle: Awaited<ReturnType<typeof open>>
      try {
        handle = await open(candidate, constants.O_RDONLY | noFollowFlag())
      } catch {
        throw captureError("Uploaded workspace file changed during capture", {
          path: portablePath,
        })
      }
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
          throw captureError("Uploaded workspace file changed during capture", {
            path: portablePath,
          })
        }
        const bytes = new Uint8Array(await handle.readFile())
        if (bytes.byteLength !== info.size) {
          throw captureError("Uploaded workspace file changed during capture", {
            path: portablePath,
          })
        }
        files.push({
          path: portablePath,
          contentBase64: bytes.toBase64(),
          mode: 0o600 | (info.mode & 0o111),
        })
      } finally {
        await handle.close()
      }
    }
  }

  await visit(canonicalRoot)
  if (files.length === 0) throw captureError("Uploaded workspace must contain at least one file")
  return files
}

const captureError = (
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): WorkspaceCaptureError => new WorkspaceCaptureError(message, details)

const noFollowFlag = (): number => ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)

const isContained = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`)
