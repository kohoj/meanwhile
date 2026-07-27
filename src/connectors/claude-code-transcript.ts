import {
  boundedText,
  type NormalizedMirrorEvent,
  type NormalizedMirrorEventContent,
  normalizedEvent,
  printable,
  record,
  string,
  TranscriptIdentityMismatchError,
  type TranscriptNormalizer,
  type TranscriptRecordContext,
  TranscriptSchemaMismatchError,
} from "./external-transcript"

/** Normalizes the currently supported Claude Code transcript JSONL record shapes. */
export const claudeCodeTranscriptNormalizer: TranscriptNormalizer = {
  source: "claude-code",
  normalize: normalizeClaudeCodeTranscriptRecord,
}

export function normalizeClaudeCodeTranscriptRecord(
  value: unknown,
  context: TranscriptRecordContext,
): readonly NormalizedMirrorEvent[] {
  const outer = record(value)
  if (outer === null) return []
  const declaredSessionId = string(outer["sessionId"])
  if (declaredSessionId !== null && declaredSessionId !== context.sourceConversationId) {
    throw new TranscriptIdentityMismatchError(
      "Claude Code record does not match the selected conversation",
    )
  }
  const type = string(outer["type"])
  const message = record(outer["message"])
  if (type === "user") {
    if (declaredSessionId === null) throw schemaMismatch("user sessionId")
    if (message === null) throw schemaMismatch("user message")
    return normalizeClaudeUser(outer, message, context)
  }
  if (type === "assistant") {
    if (declaredSessionId === null) throw schemaMismatch("assistant sessionId")
    if (message === null) throw schemaMismatch("assistant message")
    return normalizeClaudeAssistant(outer, message, context)
  }
  return []
}

function normalizeClaudeUser(
  outer: Readonly<Record<string, unknown>>,
  message: Readonly<Record<string, unknown>>,
  context: TranscriptRecordContext,
): readonly NormalizedMirrorEvent[] {
  const content = message["content"]
  const sourceMessageId = string(outer["uuid"])
  const events: NormalizedMirrorEventContent[] = []
  if (typeof content === "string" && content.length > 0) {
    const body = boundedText(content)
    events.push({
      type: "message",
      payload: {
        role: "user",
        markdown: body.text,
        sourceMessageId,
        truncated: body.truncated,
      },
    })
  } else if (Array.isArray(content)) {
    for (const blockValue of content) {
      const block = record(blockValue)
      if (block === null) throw schemaMismatch("user content block")
      if (string(block["type"]) === "text") {
        const text = string(block["text"])
        if (text === null) throw schemaMismatch("user text block")
        if (text.length === 0) continue
        const body = boundedText(text)
        events.push({
          type: "message",
          payload: {
            role: "user",
            markdown: body.text,
            sourceMessageId,
            truncated: body.truncated,
          },
        })
      } else if (string(block["type"]) === "tool_result") {
        const sourceItemId = string(block["tool_use_id"])
        if (sourceItemId === null || !("content" in block)) {
          throw schemaMismatch("tool_result block")
        }
        const body = boundedText(printable(block["content"]))
        events.push({
          type: "work",
          payload: {
            kind: "tool",
            title: "Tool result",
            body: body.text,
            status: block["is_error"] === true ? "failed" : "completed",
            sourceItemId,
            truncated: body.truncated,
          },
        })
      }
    }
  } else throw schemaMismatch("user content")
  if (events.some((event) => event.type === "message")) {
    events.unshift({
      type: "source_status",
      payload: { status: "active", reason: "user message accepted" },
    })
  }
  return events.map((contentValue, index) => event(context, index, contentValue))
}

function normalizeClaudeAssistant(
  outer: Readonly<Record<string, unknown>>,
  message: Readonly<Record<string, unknown>>,
  context: TranscriptRecordContext,
): readonly NormalizedMirrorEvent[] {
  const content = message["content"]
  if (!Array.isArray(content)) throw schemaMismatch("assistant content")
  const sourceMessageId = string(outer["uuid"]) ?? string(message["id"])
  const events: NormalizedMirrorEventContent[] = []
  for (const blockValue of content) {
    const block = record(blockValue)
    if (block === null) throw schemaMismatch("assistant content block")
    const type = string(block["type"])
    if (type === "text") {
      const text = string(block["text"])
      if (text === null) throw schemaMismatch("assistant text block")
      if (text.length === 0) continue
      const body = boundedText(text)
      events.push({
        type: "message",
        payload: {
          role: "assistant",
          markdown: body.text,
          sourceMessageId,
          truncated: body.truncated,
        },
      })
    } else if (type === "thinking") {
      const text = string(block["thinking"])
      if (text === null) throw schemaMismatch("assistant thinking block")
      if (text.length === 0) continue
      const body = boundedText(text)
      events.push({
        type: "work",
        payload: {
          kind: "reasoning",
          title: "Reasoning",
          body: body.text,
          status: "completed",
          sourceItemId: sourceMessageId,
          truncated: body.truncated,
        },
      })
    } else if (type === "tool_use") {
      const name = string(block["name"])
      const sourceItemId = string(block["id"])
      if (name === null || sourceItemId === null) throw schemaMismatch("tool_use block")
      const body = boundedText(printable(block["input"]))
      events.push({
        type: "work",
        payload: {
          kind: name === "TodoWrite" ? "plan" : "tool",
          title: name,
          body: body.text,
          status: "running",
          sourceItemId,
          truncated: body.truncated,
        },
      })
    }
  }
  if (typeof message["stop_reason"] === "string") {
    events.push({
      type: "source_status",
      payload: { status: "idle", reason: string(message["stop_reason"]) },
    })
  }
  return events.map((contentValue, index) => event(context, index, contentValue))
}

function event(
  context: TranscriptRecordContext,
  index: number,
  content: NormalizedMirrorEventContent,
): NormalizedMirrorEvent {
  return normalizedEvent("claude-code", context, index, content)
}

function schemaMismatch(field: string): TranscriptSchemaMismatchError {
  return new TranscriptSchemaMismatchError(`Claude Code ${field} has an unsupported shape`)
}
