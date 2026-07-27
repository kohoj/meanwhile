import { homedir } from "node:os"
import {
  type NormalizedMirrorEvent,
  type NormalizedMirrorEventContent,
  normalizedMirrorEventDigest,
} from "./external-transcript"

/**
 * Bump this whenever a redaction rule changes in a way that can alter a
 * published MirrorEvent. The number is persisted with Companion diagnostics,
 * never alongside source text.
 */
export const TRANSCRIPT_REDACTION_RULESET_VERSION = 1 as const

const REDACTED_VALUE = "[redacted]"
const REDACTED_HOME = "[local-home]"

export interface TranscriptRedactionOptions {
  /** Exact values known only to the local Companion, such as its device credential. */
  readonly knownSecrets?: readonly string[]
  /** Additional private local roots. Relative paths are intentionally ignored. */
  readonly homePaths?: readonly string[]
}

export interface TranscriptRedactionStatistics {
  readonly rulesVersion: typeof TRANSCRIPT_REDACTION_RULESET_VERSION
  readonly fieldsRedacted: number
  readonly replacements: {
    readonly exactSecret: number
    readonly knownToken: number
    readonly localPath: number
  }
}

export interface RedactedNormalizedMirrorEvent {
  readonly event: NormalizedMirrorEvent
  /** Aggregate-only diagnostics: it deliberately contains no matched value or path. */
  readonly statistics: TranscriptRedactionStatistics
}

export interface RedactedTranscriptText {
  readonly text: string
  /** Aggregate-only diagnostics: it deliberately contains no matched value or path. */
  readonly statistics: TranscriptRedactionStatistics
}

/** Redacts connector-authored metadata, such as an explicit mirror title. */
export function redactTranscriptText(
  value: string,
  options: TranscriptRedactionOptions = {},
): RedactedTranscriptText {
  const redactor = createTranscriptRedactor(options)
  return { text: redactor.text(value), statistics: redactor.statistics() }
}

/**
 * Redacts the complete project-visible payload while preserving the source
 * cursor and source identity. Its digest always describes the redacted value
 * that may leave the device, never the raw transcript record.
 */
export function redactNormalizedMirrorEvent(
  event: NormalizedMirrorEvent,
  options: TranscriptRedactionOptions = {},
): RedactedNormalizedMirrorEvent {
  const redactor = createTranscriptRedactor(options)
  const content = redactContent(event, redactor)
  const identity = {
    version: event.version,
    source: event.source,
    sourceTimestamp: event.sourceTimestamp,
    type: content.type,
    payload: content.payload,
  }

  return {
    event: {
      ...identity,
      sourceCursor: event.sourceCursor,
      digest: normalizedMirrorEventDigest(identity),
    } as NormalizedMirrorEvent,
    statistics: redactor.statistics(),
  }
}

/** Redacts a batch without sharing match state or local source text between events. */
export function redactNormalizedMirrorEvents(
  events: readonly NormalizedMirrorEvent[],
  options: TranscriptRedactionOptions = {},
): readonly RedactedNormalizedMirrorEvent[] {
  return events.map((event) => redactNormalizedMirrorEvent(event, options))
}

function redactContent(
  event: NormalizedMirrorEvent,
  redactor: TranscriptRedactor,
): NormalizedMirrorEventContent {
  switch (event.type) {
    case "message":
      return {
        type: event.type,
        payload: {
          ...event.payload,
          markdown: redactor.text(event.payload.markdown),
        },
      }
    case "work":
      return {
        type: event.type,
        payload: {
          ...event.payload,
          title: redactOptionalText(event.payload.title, redactor),
          body: redactor.text(event.payload.body),
          status: redactOptionalText(event.payload.status, redactor),
        },
      }
    case "source_status":
      return {
        type: event.type,
        payload: {
          ...event.payload,
          reason: redactOptionalText(event.payload.reason, redactor),
        },
      }
  }
}

function redactOptionalText(value: string | null, redactor: TranscriptRedactor): string | null {
  return value === null ? null : redactor.text(value)
}

interface TranscriptRedactor {
  text(value: string): string
  statistics(): TranscriptRedactionStatistics
}

function createTranscriptRedactor(options: TranscriptRedactionOptions): TranscriptRedactor {
  const exactSecrets = uniqueNonEmpty(options.knownSecrets).sort(
    (left, right) => right.length - left.length,
  )
  const localPaths = localPathsFor(options.homePaths)
  let fieldsRedacted = 0
  let exactSecret = 0
  let knownToken = 0
  let localPath = 0

  return {
    text(value) {
      let replacementsInField = 0
      let result = value

      for (const secret of exactSecrets) {
        const replacement = replaceAll(result, secret, REDACTED_VALUE)
        result = replacement.value
        exactSecret += replacement.count
        replacementsInField += replacement.count
      }

      for (const pattern of TOKEN_PATTERNS) {
        const replacement = replacePattern(result, pattern, REDACTED_VALUE)
        result = replacement.value
        knownToken += replacement.count
        replacementsInField += replacement.count
      }

      for (const path of localPaths) {
        const replacement = replacePattern(result, path.pattern, REDACTED_HOME)
        result = replacement.value
        localPath += replacement.count
        replacementsInField += replacement.count
      }

      if (replacementsInField > 0) fieldsRedacted += 1
      return result
    },
    statistics() {
      return {
        rulesVersion: TRANSCRIPT_REDACTION_RULESET_VERSION,
        fieldsRedacted,
        replacements: { exactSecret, knownToken, localPath },
      }
    },
  }
}

const TOKEN_PATTERNS: readonly RegExp[] = [
  /\b(?:mwk|mws|mwi|mwd)_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
  /\bsk-ant-(?:api\d+-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
]

function localPathsFor(
  extraPaths: readonly string[] | undefined,
): readonly { readonly pattern: RegExp }[] {
  const paths = uniqueNonEmpty([
    homedir(),
    Bun.env["HOME"] ?? "",
    Bun.env["USERPROFILE"] ?? "",
    `${Bun.env["HOMEDRIVE"] ?? ""}${Bun.env["HOMEPATH"] ?? ""}`,
    ...(extraPaths ?? []),
  ])
    .map(normalizeAbsolutePath)
    .filter((path): path is string => path !== null)
    .sort((left, right) => right.length - left.length)

  return paths.map((path) => ({
    pattern: new RegExp(`${escapeRegExp(path)}(?=$|[\\\\/])`, isWindowsPath(path) ? "gi" : "g"),
  }))
}

function normalizeAbsolutePath(value: string): string | null {
  const path = value.trim().replace(/[\\/]+$/, "")
  if (path.length === 0) return null
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path
  return null
}

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path)
}

function uniqueNonEmpty(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value) => value.length > 0))]
}

function replaceAll(
  value: string,
  needle: string,
  replacement: string,
): { readonly value: string; readonly count: number } {
  return replacePattern(value, new RegExp(escapeRegExp(needle), "g"), replacement)
}

function replacePattern(
  value: string,
  pattern: RegExp,
  replacement: string,
): { readonly value: string; readonly count: number } {
  let count = 0
  const replaced = value.replace(pattern, () => {
    count += 1
    return replacement
  })
  return { value: replaced, count }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
