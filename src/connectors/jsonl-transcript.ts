import { stat } from "node:fs/promises"
import type { ConnectorSource } from "../domain"
import {
  diagnosticTimestamp,
  type NormalizedMirrorEvent,
  TranscriptIdentityMismatchError,
  type TranscriptNormalizer,
} from "./external-transcript"

export const JSONL_TRANSCRIPT_CURSOR_VERSION = 1 as const
const DEFAULT_MAX_BATCH_BYTES = 16 * 1024 * 1024

export interface JsonlTranscriptCursor {
  readonly version: typeof JSONL_TRANSCRIPT_CURSOR_VERSION
  readonly source: ConnectorSource
  readonly sourceConversationId: string
  readonly device: string
  readonly inode: string
  readonly generation: string
  /** Digest of the bounded byte window immediately before byteOffset. */
  readonly checkpoint: string
  /** Byte offset after the final complete line accepted from this generation. */
  readonly byteOffset: number
  /** Number of complete physical lines accepted from this generation. */
  readonly lineNumber: number
}

export type TranscriptResetReason = "rotated" | "truncated"

export interface TranscriptReadIssue {
  readonly kind: "invalid_json" | "invalid_utf8" | "line_too_large" | "normalization_failed"
  readonly lineNumber: number
  readonly byteOffset: number
  readonly message: string
  /** The cursor remains at this record until the operator or adapter resolves it. */
  readonly blocked: true
}

export interface ReadTranscriptIncrementInput {
  readonly path: string
  readonly sourceConversationId: string
  readonly normalizer: TranscriptNormalizer
  readonly cursor?: JsonlTranscriptCursor
  readonly maxBatchBytes?: number
}

export interface ReadTranscriptIncrementResult {
  readonly events: readonly NormalizedMirrorEvent[]
  readonly cursor: JsonlTranscriptCursor
  readonly issues: readonly TranscriptReadIssue[]
  readonly reset: TranscriptResetReason | null
  readonly caughtUp: boolean
}

/**
 * Reads only newline-terminated JSONL records and advances by bytes, not UTF-16
 * string offsets. An incomplete final line remains unread until the next poll.
 */
export async function readTranscriptIncrement(
  input: ReadTranscriptIncrementInput,
): Promise<ReadTranscriptIncrementResult> {
  if (input.path.length === 0) throw new TypeError("path must not be empty")
  if (input.sourceConversationId.length === 0) {
    throw new TypeError("sourceConversationId must not be empty")
  }
  const maxBatchBytes = input.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES
  if (!Number.isSafeInteger(maxBatchBytes) || maxBatchBytes < 1) {
    throw new TypeError("maxBatchBytes must be positive")
  }

  const info = await stat(input.path)
  if (!info.isFile()) throw new TypeError("Transcript path must identify a regular file")
  const device = String(info.dev)
  const inode = String(info.ino)
  const existing = validateCursor(input.cursor, input.normalizer.source, input.sourceConversationId)

  let reset: TranscriptResetReason | null = null
  let byteOffset = existing?.byteOffset ?? 0
  let lineNumber = existing?.lineNumber ?? 0
  if (existing !== undefined && (existing.device !== device || existing.inode !== inode)) {
    reset = "rotated"
    byteOffset = 0
    lineNumber = 0
  } else if (existing !== undefined && info.size < existing.byteOffset) {
    reset = "truncated"
    byteOffset = 0
    lineNumber = 0
  } else if (
    existing !== undefined &&
    (await checkpointForFile(input.path, existing.byteOffset)) !== existing.checkpoint
  ) {
    reset = "truncated"
    byteOffset = 0
    lineNumber = 0
  }

  const generation =
    reset === null && existing !== undefined
      ? existing.generation
      : generationDigest(
          input.normalizer.source,
          input.sourceConversationId,
          device,
          inode,
          reset === null ? "initial" : `${existing?.generation ?? "initial"}:${reset}`,
        )

  const end = Math.min(info.size, byteOffset + maxBatchBytes)
  const bytes = new Uint8Array(await Bun.file(input.path).slice(byteOffset, end).arrayBuffer())
  const finalNewline = bytes.lastIndexOf(10)
  if (finalNewline < 0) {
    const issue =
      bytes.byteLength === maxBatchBytes && end < info.size
        ? [
            {
              kind: "line_too_large" as const,
              lineNumber: lineNumber + 1,
              byteOffset,
              message: `JSONL line exceeds the ${maxBatchBytes} byte batch limit`,
              blocked: true as const,
            },
          ]
        : []
    return {
      events: [],
      cursor: await makeCursor(
        input.path,
        input.normalizer.source,
        input.sourceConversationId,
        device,
        inode,
        generation,
        byteOffset,
        lineNumber,
      ),
      issues: issue,
      reset,
      caughtUp: end === info.size && bytes.byteLength === 0,
    }
  }

  const events: NormalizedMirrorEvent[] = []
  const issues: TranscriptReadIssue[] = []
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let lineStart = 0
  let committedByteOffset = byteOffset
  let committedLineNumber = lineNumber
  let blocked = false
  for (let newline = bytes.indexOf(10); newline >= 0 && newline <= finalNewline; ) {
    const physicalLineNumber = committedLineNumber + 1
    const absoluteLineEnd = byteOffset + newline + 1
    let lineBytes = bytes.subarray(lineStart, newline)
    if (lineBytes.at(-1) === 13) lineBytes = lineBytes.subarray(0, lineBytes.byteLength - 1)
    if (lineBytes.byteLength > 0) {
      let line: string
      try {
        line = decoder.decode(lineBytes)
      } catch (error) {
        issues.push({
          kind: "invalid_utf8",
          lineNumber: physicalLineNumber,
          byteOffset: byteOffset + lineStart,
          message: error instanceof Error ? error.message : "Invalid UTF-8",
          blocked: true,
        })
        blocked = true
        break
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(line) as unknown
      } catch (error) {
        issues.push({
          kind: "invalid_json",
          lineNumber: physicalLineNumber,
          byteOffset: byteOffset + lineStart,
          message: error instanceof Error ? error.message : "Invalid JSON",
          blocked: true,
        })
        blocked = true
        break
      }
      const sourceTimestamp = diagnosticTimestamp(
        typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>)["timestamp"]
          : undefined,
      )
      try {
        events.push(
          ...input.normalizer.normalize(parsed, {
            sourceConversationId: input.sourceConversationId,
            sourceCursor: `jsonl:v1:${generation}:${absoluteLineEnd}`,
            sourceTimestamp,
          }),
        )
      } catch (error) {
        if (error instanceof TranscriptIdentityMismatchError) throw error
        issues.push({
          kind: "normalization_failed",
          lineNumber: physicalLineNumber,
          byteOffset: byteOffset + lineStart,
          message: error instanceof Error ? error.message : "Transcript normalization failed",
          blocked: true,
        })
        blocked = true
        break
      }
    }
    committedLineNumber = physicalLineNumber
    committedByteOffset = absoluteLineEnd
    lineStart = newline + 1
    newline = bytes.indexOf(10, lineStart)
  }
  byteOffset = committedByteOffset
  lineNumber = committedLineNumber

  return {
    events,
    cursor: await makeCursor(
      input.path,
      input.normalizer.source,
      input.sourceConversationId,
      device,
      inode,
      generation,
      byteOffset,
      lineNumber,
    ),
    issues,
    reset,
    caughtUp: !blocked && byteOffset === info.size,
  }
}

function validateCursor(
  cursor: JsonlTranscriptCursor | undefined,
  source: ConnectorSource,
  sourceConversationId: string,
): JsonlTranscriptCursor | undefined {
  if (cursor === undefined) return undefined
  if (cursor.version !== JSONL_TRANSCRIPT_CURSOR_VERSION) {
    throw new TypeError("Unsupported JSONL transcript cursor version")
  }
  if (cursor.source !== source || cursor.sourceConversationId !== sourceConversationId) {
    throw new TypeError("JSONL transcript cursor belongs to another source conversation")
  }
  if (
    !Number.isSafeInteger(cursor.byteOffset) ||
    cursor.byteOffset < 0 ||
    !Number.isSafeInteger(cursor.lineNumber) ||
    cursor.lineNumber < 0 ||
    cursor.generation.length === 0 ||
    !/^[0-9a-f]{64}$/.test(cursor.checkpoint)
  ) {
    throw new TypeError("JSONL transcript cursor position is invalid")
  }
  return cursor
}

function makeCursor(
  path: string,
  source: ConnectorSource,
  sourceConversationId: string,
  device: string,
  inode: string,
  generation: string,
  byteOffset: number,
  lineNumber: number,
): Promise<JsonlTranscriptCursor> {
  return Promise.resolve(checkpointForFile(path, byteOffset)).then((checkpoint) => ({
    version: JSONL_TRANSCRIPT_CURSOR_VERSION,
    source,
    sourceConversationId,
    device,
    inode,
    generation,
    checkpoint,
    byteOffset,
    lineNumber,
  }))
}

function generationDigest(
  source: ConnectorSource,
  sourceConversationId: string,
  device: string,
  inode: string,
  salt: string,
): string {
  return new Bun.CryptoHasher("sha256")
    .update(`${source}\0${sourceConversationId}\0${device}\0${inode}\0${salt}`)
    .digest("hex")
    .slice(0, 24)
}

async function checkpointForFile(path: string, byteOffset: number): Promise<string> {
  const start = Math.max(0, byteOffset - 256)
  const bytes = await Bun.file(path).slice(start, byteOffset).arrayBuffer()
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}
