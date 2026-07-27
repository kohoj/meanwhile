import type {
  ConnectorSource,
  ConversationMirrorStatus,
  MirrorWorkKind,
  Timestamp,
} from "../domain"

export const EXTERNAL_TRANSCRIPT_PROTOCOL_VERSION = 1 as const
export const DEFAULT_TRANSCRIPT_TEXT_LIMIT = 64 * 1024

interface NormalizedMirrorEventBase {
  readonly version: typeof EXTERNAL_TRANSCRIPT_PROTOCOL_VERSION
  readonly source: ConnectorSource
  /** Opaque file position scoped to one source conversation; never a local path. */
  readonly sourceCursor: string
  /** SHA-256 of this normalized event, excluding the cursor. */
  readonly digest: string
  readonly sourceTimestamp: Timestamp | null
}

/**
 * Connector-owned form of a MirrorEvent. The control plane supplies mirror,
 * owner, sequence, and acceptance-time fields only after authorization.
 */
export type NormalizedMirrorEvent =
  | (NormalizedMirrorEventBase & {
      readonly type: "message"
      readonly payload: {
        readonly role: "user" | "assistant"
        readonly markdown: string
        readonly sourceMessageId: string | null
        readonly truncated: boolean
      }
    })
  | (NormalizedMirrorEventBase & {
      readonly type: "work"
      readonly payload: {
        readonly kind: MirrorWorkKind
        readonly title: string | null
        readonly body: string
        readonly status: string | null
        readonly sourceItemId: string | null
        readonly truncated: boolean
      }
    })
  | (NormalizedMirrorEventBase & {
      readonly type: "source_status"
      readonly payload: {
        readonly status: ConversationMirrorStatus
        readonly reason: string | null
      }
    })

export type NormalizedMirrorEventContent =
  | {
      readonly type: "message"
      readonly payload: {
        readonly role: "user" | "assistant"
        readonly markdown: string
        readonly sourceMessageId: string | null
        readonly truncated: boolean
      }
    }
  | {
      readonly type: "work"
      readonly payload: {
        readonly kind: MirrorWorkKind
        readonly title: string | null
        readonly body: string
        readonly status: string | null
        readonly sourceItemId: string | null
        readonly truncated: boolean
      }
    }
  | {
      readonly type: "source_status"
      readonly payload: {
        readonly status: ConversationMirrorStatus
        readonly reason: string | null
      }
    }

export interface TranscriptRecordContext {
  readonly sourceConversationId: string
  readonly sourceCursor: string
  readonly sourceTimestamp: Timestamp | null
}

export interface TranscriptNormalizer {
  readonly source: ConnectorSource
  normalize(record: unknown, context: TranscriptRecordContext): readonly NormalizedMirrorEvent[]
}

/** A selected transcript file declared a different source conversation. */
export class TranscriptIdentityMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TranscriptIdentityMismatchError"
  }
}

/** A recognized source record no longer satisfies the supported adapter shape. */
export class TranscriptSchemaMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TranscriptSchemaMismatchError"
  }
}

export function normalizedEvent(
  source: ConnectorSource,
  context: TranscriptRecordContext,
  index: number,
  content: NormalizedMirrorEventContent,
): NormalizedMirrorEvent {
  const identity = {
    version: EXTERNAL_TRANSCRIPT_PROTOCOL_VERSION,
    source,
    sourceTimestamp: context.sourceTimestamp,
    type: content.type,
    payload: content.payload,
  }
  return {
    ...identity,
    sourceCursor: `${context.sourceCursor}:${index}`,
    digest: normalizedMirrorEventDigest(identity),
  } as NormalizedMirrorEvent
}

/** Exact digest algorithm shared by connector and control-plane verification. */
export function normalizedMirrorEventDigest(input: {
  readonly version: typeof EXTERNAL_TRANSCRIPT_PROTOCOL_VERSION
  readonly source: ConnectorSource
  readonly sourceTimestamp: Timestamp | null
  readonly type: NormalizedMirrorEventContent["type"]
  readonly payload: NormalizedMirrorEventContent["payload"]
}): string {
  const canonical = JSON.stringify({
    version: input.version,
    source: input.source,
    sourceTimestamp: input.sourceTimestamp,
    type: input.type,
    payload: input.payload,
  })
  return sha256(canonical)
}

export function boundedText(
  value: string,
  limit = DEFAULT_TRANSCRIPT_TEXT_LIMIT,
): { readonly text: string; readonly truncated: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("limit must be positive")
  if (value.length <= limit) return { text: value, truncated: false }
  const candidate = value.slice(0, limit)
  const finalCodeUnit = candidate.charCodeAt(candidate.length - 1)
  const safeEnd =
    finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff ? candidate.length - 1 : candidate.length
  return { text: candidate.slice(0, safeEnd), truncated: true }
}

export function diagnosticTimestamp(value: unknown): Timestamp | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null
  return new Date(value).toISOString()
}

export function printable(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  try {
    return JSON.stringify(value, null, 2) ?? ""
  } catch {
    return "[unserializable value]"
  }
}

export function record(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  return value as Readonly<Record<string, unknown>>
}

export function string(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}
