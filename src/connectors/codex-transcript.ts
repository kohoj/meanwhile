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

/**
 * Normalizes the currently supported Codex session JSONL record shapes. This
 * versioned adapter consumes stored source records rather than scraping Codex
 * UI text or claiming app-server as a stable production integration boundary.
 */
export const codexTranscriptNormalizer: TranscriptNormalizer = {
  source: "codex",
  normalize: normalizeCodexTranscriptRecord,
}

export function normalizeCodexTranscriptRecord(
  value: unknown,
  context: TranscriptRecordContext,
): readonly NormalizedMirrorEvent[] {
  const outer = record(value)
  if (outer === null) return []
  const recordType = string(outer["type"])
  const payload = record(outer["payload"])
  if (recordType === "session_meta") {
    if (payload === null) throw schemaMismatch("session_meta payload")
    const declaredSessionId = string(payload["id"])
    if (declaredSessionId === null) throw schemaMismatch("session_meta id")
    if (declaredSessionId !== context.sourceConversationId) {
      throw new TranscriptIdentityMismatchError(
        "Codex session metadata does not match the selected conversation",
      )
    }
    return []
  }
  if (recordType === "event_msg") {
    if (payload === null) throw schemaMismatch("event_msg payload")
    return normalizeCodexEventMessage(payload, context)
  }
  if (recordType !== "response_item") return []
  if (payload === null) throw schemaMismatch("response_item payload")
  return normalizeCodexResponseItem(payload, context)
}

function normalizeCodexEventMessage(
  payload: Readonly<Record<string, unknown>>,
  context: TranscriptRecordContext,
): readonly NormalizedMirrorEvent[] {
  const type = string(payload["type"])
  if (type === null) throw schemaMismatch("event_msg type")
  switch (type) {
    case "task_started":
      return [
        event(context, 0, {
          type: "source_status",
          payload: { status: "active", reason: "turn started" },
        }),
      ]
    case "task_complete":
      return [
        event(context, 0, {
          type: "source_status",
          payload: { status: "idle", reason: "turn completed" },
        }),
      ]
    case "turn_aborted":
      return [
        event(context, 0, {
          type: "source_status",
          payload: { status: "idle", reason: "turn aborted" },
        }),
      ]
    default:
      return []
  }
}

function normalizeCodexResponseItem(
  payload: Readonly<Record<string, unknown>>,
  context: TranscriptRecordContext,
): readonly NormalizedMirrorEvent[] {
  const type = string(payload["type"])
  if (type === null) throw schemaMismatch("response_item type")
  switch (type) {
    case "message":
      return normalizeCodexMessage(payload, context)
    case "reasoning":
      return normalizeCodexReasoning(payload, context)
    case "custom_tool_call":
    case "function_call":
      return normalizeCodexToolCall(payload, context)
    case "custom_tool_call_output":
    case "function_call_output":
      return normalizeCodexToolOutput(payload, context)
    default:
      return []
  }
}

function normalizeCodexMessage(
  payload: Readonly<Record<string, unknown>>,
  context: TranscriptRecordContext,
): readonly NormalizedMirrorEvent[] {
  const nativeRole = string(payload["role"])
  const role = nativeRole === "user" ? "user" : nativeRole === "assistant" ? "assistant" : null
  if (role === null) return []
  if (!Array.isArray(payload["content"])) throw schemaMismatch("message content")
  const parts: string[] = []
  for (const value of payload["content"]) {
    const part = record(value)
    if (part === null) throw schemaMismatch("message content block")
    const type = string(part["type"])
    if (type !== "input_text" && type !== "output_text") continue
    const text = string(part["text"])
    if (text === null) throw schemaMismatch(`${type} text`)
    if (text.length > 0) parts.push(text)
  }
  if (parts.length === 0) return []
  const body = boundedText(parts.join("\n\n"))
  return [
    event(context, 0, {
      type: "message",
      payload: {
        role,
        markdown: body.text,
        sourceMessageId: string(payload["id"]),
        truncated: body.truncated,
      },
    }),
  ]
}

function normalizeCodexReasoning(
  payload: Readonly<Record<string, unknown>>,
  context: TranscriptRecordContext,
): readonly NormalizedMirrorEvent[] {
  if (!Array.isArray(payload["summary"])) throw schemaMismatch("reasoning summary")
  const summaries: string[] = []
  for (const value of payload["summary"]) {
    const part = record(value)
    if (part === null) throw schemaMismatch("reasoning summary block")
    if (string(part["type"]) !== "summary_text") continue
    const text = string(part["text"])
    if (text === null) throw schemaMismatch("reasoning summary text")
    if (text.length > 0) summaries.push(text)
  }
  if (summaries.length === 0) return []
  const body = boundedText(summaries.join("\n\n"))
  return [
    event(context, 0, {
      type: "work",
      payload: {
        kind: "reasoning",
        title: "Reasoning",
        body: body.text,
        status: "completed",
        sourceItemId: string(payload["id"]),
        truncated: body.truncated,
      },
    }),
  ]
}

function normalizeCodexToolCall(
  payload: Readonly<Record<string, unknown>>,
  context: TranscriptRecordContext,
): readonly NormalizedMirrorEvent[] {
  const name = string(payload["name"])
  const sourceItemId = string(payload["call_id"]) ?? string(payload["id"])
  if (name === null) throw schemaMismatch("tool name")
  if (sourceItemId === null) throw schemaMismatch("tool identity")
  const rawInput = payload["input"] ?? payload["arguments"]
  const body = boundedText(printable(rawInput))
  return [
    event(context, 0, {
      type: "work",
      payload: {
        kind: name === "update_plan" ? "plan" : "tool",
        title: name,
        body: body.text,
        status: string(payload["status"]) ?? "running",
        sourceItemId,
        truncated: body.truncated,
      },
    }),
  ]
}

function normalizeCodexToolOutput(
  payload: Readonly<Record<string, unknown>>,
  context: TranscriptRecordContext,
): readonly NormalizedMirrorEvent[] {
  const sourceItemId = string(payload["call_id"]) ?? string(payload["id"])
  if (sourceItemId === null) throw schemaMismatch("tool result identity")
  if (!("output" in payload) && !("result" in payload)) {
    throw schemaMismatch("tool result body")
  }
  const body = boundedText(printable(payload["output"] ?? payload["result"]))
  return [
    event(context, 0, {
      type: "work",
      payload: {
        kind: "tool",
        title: "Tool result",
        body: body.text,
        status: "completed",
        sourceItemId,
        truncated: body.truncated,
      },
    }),
  ]
}

function event(
  context: TranscriptRecordContext,
  index: number,
  content: NormalizedMirrorEventContent,
): NormalizedMirrorEvent {
  return normalizedEvent("codex", context, index, content)
}

function schemaMismatch(field: string): TranscriptSchemaMismatchError {
  return new TranscriptSchemaMismatchError(`Codex ${field} has an unsupported shape`)
}
