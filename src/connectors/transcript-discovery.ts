import { opendir, stat } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import type { ConnectorSource } from "../domain"

const DEFAULT_DISCOVERY_LIMIT = 20
const MAX_DISCOVERY_LIMIT = 100
const MAX_INSPECTION_BYTES = 2 * 1024 * 1024
const MAX_INSPECTION_LINES = 512
const TITLE_LIMIT = 120

/** Safe, device-local metadata for one inspectable source conversation. */
export interface LocalConversation {
  readonly source: ConnectorSource
  readonly sourceConversationId: string
  readonly title: string
  readonly modifiedAt: string
  /** Device-local only. This value must never cross the Connector API boundary. */
  readonly transcriptPath: string
  /** Device-local source cwd used to prove the selected GitHub repository. */
  readonly workspacePath: string
}

/**
 * Source-neutral discovery boundary. Source-specific record knowledge is kept
 * behind inspect; callers select only the resulting stable conversation ID.
 */
export interface LocalConversationDiscovery {
  inspect(path: string): Promise<LocalConversation>
  discover(root: string, limit?: number): Promise<readonly LocalConversation[]>
  find(root: string, sourceConversationId: string): Promise<LocalConversation | null>
}

export function localConversationDiscovery(source: ConnectorSource): LocalConversationDiscovery {
  return {
    inspect: (path) => inspectLocalConversation(source, path),
    discover: (root, limit) => discoverLocalConversations(source, root, limit),
    find: (root, sourceConversationId) => findLocalConversation(source, root, sourceConversationId),
  }
}

export function defaultTranscriptRoot(source: ConnectorSource, home: string): string {
  return source === "codex"
    ? join(resolve(home), ".codex", "sessions")
    : join(resolve(home), ".claude", "projects")
}

export async function inspectLocalConversation(
  source: ConnectorSource,
  path: string,
): Promise<LocalConversation> {
  const transcriptPath = resolve(path)
  const info = await stat(transcriptPath)
  if (!info.isFile()) throw new TypeError("Transcript path must identify a regular file")

  const text = await Bun.file(transcriptPath).slice(0, MAX_INSPECTION_BYTES).text()
  const identities = new Set<string>()
  const workspacePaths = new Set<string>()
  let title: string | null = null
  for (const line of text.split("\n").slice(0, MAX_INSPECTION_LINES)) {
    if (line.trim().length === 0) continue
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch {
      continue
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue
    const record = value as Readonly<Record<string, unknown>>
    const identity = sourceIdentity(source, record)
    if (identity !== null) identities.add(identity)
    const workspacePath = sourceWorkspacePath(source, record)
    if (workspacePath !== null) workspacePaths.add(resolve(workspacePath))
    title ??= sourceTitle(source, record)
  }
  if (identities.size !== 1) {
    throw new Error(`Could not identify exactly one ${source} conversation in ${basename(path)}`)
  }
  if (workspacePaths.size !== 1) {
    throw new Error(`Could not identify exactly one ${source} workspace in ${basename(path)}`)
  }
  const sourceConversationId = [...identities][0] as string
  const conversation = {
    source,
    sourceConversationId,
    title: title ?? `${source === "codex" ? "Codex" : "Claude Code"} conversation`,
    modifiedAt: info.mtime.toISOString(),
    transcriptPath,
  } as LocalConversation
  Object.defineProperty(conversation, "workspacePath", {
    value: [...workspacePaths][0] as string,
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return conversation
}

export async function discoverLocalConversations(
  source: ConnectorSource,
  root: string,
  limit = DEFAULT_DISCOVERY_LIMIT,
): Promise<readonly LocalConversation[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DISCOVERY_LIMIT) {
    throw new TypeError(`Discovery limit must be between 1 and ${MAX_DISCOVERY_LIMIT}`)
  }
  const paths = await jsonlCandidates(root)
  const conversations: LocalConversation[] = []
  for (const candidate of paths) {
    try {
      conversations.push(await inspectLocalConversation(source, candidate.path))
    } catch {
      // Unrecognized JSONL files are not selectable source conversations.
    }
    if (conversations.length === limit) break
  }
  return conversations
}

export async function findLocalConversation(
  source: ConnectorSource,
  root: string,
  sourceConversationId: string,
): Promise<LocalConversation | null> {
  if (sourceConversationId.trim().length === 0) {
    throw new TypeError("Source conversation ID must not be empty")
  }
  for (const candidate of await jsonlCandidates(root)) {
    try {
      const conversation = await inspectLocalConversation(source, candidate.path)
      if (conversation.sourceConversationId === sourceConversationId) return conversation
    } catch {
      // Continue across unrelated or partially written JSONL files.
    }
  }
  return null
}

async function jsonlCandidates(
  root: string,
): Promise<readonly { readonly path: string; readonly modified: number }[]> {
  const candidates: { path: string; modified: number }[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await opendir(directory)
    for await (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        candidates.push({ path, modified: (await stat(path)).mtimeMs })
      }
    }
  }
  try {
    await visit(resolve(root))
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return []
    }
    throw error
  }
  return candidates.sort(
    (left, right) => right.modified - left.modified || left.path.localeCompare(right.path),
  )
}

function sourceIdentity(
  source: ConnectorSource,
  record: Readonly<Record<string, unknown>>,
): string | null {
  if (source === "claude-code") {
    return typeof record["sessionId"] === "string" ? record["sessionId"] : null
  }
  if (record["type"] !== "session_meta") return null
  const payload = objectRecord(record["payload"])
  return typeof payload?.["id"] === "string" ? payload["id"] : null
}

function sourceTitle(
  source: ConnectorSource,
  record: Readonly<Record<string, unknown>>,
): string | null {
  if (source === "claude-code") {
    if (record["type"] !== "user") return null
    const message = objectRecord(record["message"])
    return typeof message?.["content"] === "string" ? shortTitle(message["content"]) : null
  }
  if (record["type"] !== "response_item") return null
  const payload = objectRecord(record["payload"])
  if (payload?.["type"] !== "message" || payload["role"] !== "user") return null
  const content = payload["content"]
  if (!Array.isArray(content)) return null
  for (const item of content) {
    const part = objectRecord(item)
    if (part?.["type"] === "input_text" && typeof part["text"] === "string") {
      return shortTitle(part["text"])
    }
  }
  return null
}

function sourceWorkspacePath(
  source: ConnectorSource,
  record: Readonly<Record<string, unknown>>,
): string | null {
  if (source === "claude-code") {
    return typeof record["cwd"] === "string" && record["cwd"].startsWith("/") ? record["cwd"] : null
  }
  if (record["type"] !== "session_meta") return null
  const payload = objectRecord(record["payload"])
  return typeof payload?.["cwd"] === "string" && payload["cwd"].startsWith("/")
    ? payload["cwd"]
    : null
}

function shortTitle(value: string): string | null {
  const title = value
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (title === undefined) return null
  return title.length <= TITLE_LIMIT ? title : `${title.slice(0, TITLE_LIMIT - 1)}…`
}

function objectRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null
}
