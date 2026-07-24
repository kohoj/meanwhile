import type { RunEvent, SessionEvent } from "./api/contracts"
import { isTerminalRunStatus, type RunStatus } from "./domain"

export type TimelineRole = "agent" | "thought" | "user"

export interface TimelineMessage {
  readonly id: string
  readonly role: TimelineRole
  readonly turnId: string | null
  readonly text: string
  readonly firstSequence: number
  readonly lastSequence: number
  readonly firstOccurredAt: string
  readonly lastOccurredAt: string
}

export interface TimelineToolCall {
  readonly id: string
  readonly turnId: string | null
  readonly title: string | null
  readonly kind: string | null
  readonly status: string | null
  readonly rawInput: unknown
  readonly rawOutput: unknown
  readonly firstSequence: number
  readonly lastSequence: number
  readonly firstOccurredAt: string
  readonly lastOccurredAt: string
}

export interface SessionTimeline {
  readonly sessionId: string | null
  readonly cursor: number
  readonly status: string | null
  readonly activeTurnId: string | null
  readonly turnStatuses: Readonly<Record<string, string>>
  readonly messages: readonly TimelineMessage[]
  readonly toolCalls: readonly TimelineToolCall[]
  readonly plan: unknown
  readonly usage: unknown
}

export interface AgentTimeline {
  readonly runId: string | null
  readonly cursor: number
  readonly status: string | null
  readonly messages: readonly TimelineMessage[]
  readonly toolCalls: readonly TimelineToolCall[]
  readonly plan: unknown
  readonly usage: unknown
}

export const emptyTimeline = (): AgentTimeline => ({
  runId: null,
  cursor: 0,
  status: null,
  messages: [],
  toolCalls: [],
  plan: null,
  usage: null,
})

/**
 * Reduces the durable event stream into a presentation-neutral agent timeline.
 * Stable ACP identities are preserved; retransmitted events are harmless.
 */
export const reduceTimeline = (timeline: AgentTimeline, event: RunEvent): AgentTimeline => {
  if (timeline.runId !== null && timeline.runId !== event.runId) {
    throw new TypeError("A timeline cannot contain events from different runs")
  }
  if (event.sequence <= timeline.cursor) return timeline
  if (event.sequence !== timeline.cursor + 1) {
    throw new TypeError(
      `Run event sequence is not contiguous: expected ${timeline.cursor + 1}, received ${event.sequence}`,
    )
  }

  const base = { ...timeline, runId: event.runId, cursor: event.sequence }
  if (event.type === "run.status") return { ...base, status: event.payload.toStatus }
  if (event.type !== "agent.update") return base

  const update = record(event.payload["update"])
  return reduceAgentUpdate(base, update, event.sequence, event.createdAt, null)
}

export const timelineFromEvents = (events: Iterable<RunEvent>): AgentTimeline => {
  let timeline = emptyTimeline()
  for (const event of events) timeline = reduceTimeline(timeline, event)
  return timeline
}

export interface RunDurationSummary {
  readonly provisioningMs: number
  readonly runningMs: number
  readonly totalMs: number
}

export const runDurationSummaryFromEvents = (events: Iterable<RunEvent>): RunDurationSummary => {
  let runId: string | null = null
  let cursor = 0
  let status: RunStatus | null = null
  let previousAt: number | null = null
  let provisioningMs = 0
  let runningMs = 0
  let totalMs = 0

  for (const event of events) {
    if (runId !== null && runId !== event.runId) {
      throw new TypeError("A duration summary cannot contain events from different runs")
    }
    if (event.sequence <= cursor) continue
    if (event.sequence !== cursor + 1) {
      throw new TypeError(
        `Run event sequence is not contiguous: expected ${cursor + 1}, received ${event.sequence}`,
      )
    }

    runId = event.runId
    cursor = event.sequence
    if (event.type !== "run.status") continue

    const at = Date.parse(event.createdAt)
    if (!Number.isFinite(at)) throw new TypeError("Run status timestamp is invalid")
    if (previousAt !== null) {
      if (at < previousAt) throw new TypeError("Run status timestamps are not monotonic")
      const elapsed = at - previousAt
      if (status !== null && !isTerminalRunStatus(status)) totalMs += elapsed
      if (status === "provisioning") provisioningMs += elapsed
      if (status === "running") runningMs += elapsed
    }

    previousAt = at
    status = event.payload.toStatus
  }

  return { provisioningMs, runningMs, totalMs }
}

export const emptySessionTimeline = (): SessionTimeline => ({
  sessionId: null,
  cursor: 0,
  status: null,
  activeTurnId: null,
  turnStatuses: {},
  messages: [],
  toolCalls: [],
  plan: null,
  usage: null,
})

export const reduceSessionTimeline = (
  timeline: SessionTimeline,
  event: SessionEvent,
): SessionTimeline => {
  if (timeline.sessionId !== null && timeline.sessionId !== event.sessionId) {
    throw new TypeError("A timeline cannot contain events from different sessions")
  }
  if (event.sequence <= timeline.cursor) return timeline
  if (event.sequence !== timeline.cursor + 1) {
    throw new TypeError(
      `Session event sequence is not contiguous: expected ${timeline.cursor + 1}, received ${event.sequence}`,
    )
  }
  let base: SessionTimeline = {
    ...timeline,
    sessionId: event.sessionId,
    cursor: event.sequence,
  }
  if (event.type === "session.status") {
    return {
      ...base,
      status: event.payload.toStatus,
      ...(event.payload.toStatus === "idle" || event.payload.toStatus === "closed"
        ? { activeTurnId: null }
        : {}),
    }
  }
  if (event.type === "turn.status" && event.turnId !== null) {
    base = {
      ...base,
      activeTurnId: event.payload.toStatus === "running" ? event.turnId : base.activeTurnId,
      turnStatuses: { ...base.turnStatuses, [event.turnId]: event.payload.toStatus },
    }
    return base
  }
  if (event.type !== "turn.update" || event.turnId === null) return base
  return reduceAgentUpdate(
    base,
    record(event.payload["update"]),
    event.sequence,
    event.createdAt,
    event.turnId,
  )
}

export const sessionTimelineFromEvents = (events: Iterable<SessionEvent>): SessionTimeline => {
  let timeline = emptySessionTimeline()
  for (const event of events) timeline = reduceSessionTimeline(timeline, event)
  return timeline
}

type TimelineProjection = Pick<
  AgentTimeline | SessionTimeline,
  "messages" | "toolCalls" | "plan" | "usage"
>

const reduceAgentUpdate = <Timeline extends TimelineProjection>(
  timeline: Timeline,
  update: Readonly<Record<string, unknown>>,
  sequence: number,
  occurredAt: string,
  turnId: string | null,
): Timeline => {
  const kind = string(update["sessionUpdate"])
  if (kind === null) return timeline
  const identityPrefix = turnId === null ? "run" : turnId
  const messageRole = roleForUpdate(kind)
  if (messageRole !== null) {
    const text = textContent(update["content"])
    if (text === null) return timeline
    const messageId = string(update["messageId"]) ?? `${messageRole}-message`
    const id = `${identityPrefix}:${messageRole}:${messageId}`
    return {
      ...timeline,
      messages: appendMessage(
        timeline.messages,
        id,
        messageRole,
        text,
        sequence,
        occurredAt,
        turnId,
      ),
    }
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    const rawId = string(update["toolCallId"])
    if (rawId === null) return timeline
    const id = `${identityPrefix}:${rawId}`
    return {
      ...timeline,
      toolCalls: upsertToolCall(timeline.toolCalls, id, update, sequence, occurredAt, turnId),
    }
  }
  if (kind === "plan") return { ...timeline, plan: update["entries"] ?? update }
  if (kind === "usage_update") return { ...timeline, usage: update }
  return timeline
}

const roleForUpdate = (kind: string): TimelineRole | null => {
  if (kind === "agent_message_chunk") return "agent"
  if (kind === "agent_thought_chunk") return "thought"
  if (kind === "user_message_chunk") return "user"
  return null
}

const appendMessage = (
  messages: readonly TimelineMessage[],
  id: string,
  role: TimelineRole,
  text: string,
  sequence: number,
  occurredAt: string,
  turnId: string | null,
): readonly TimelineMessage[] => {
  const index = messages.findIndex((message) => message.id === id)
  if (index < 0) {
    return [
      ...messages,
      {
        id,
        role,
        turnId,
        text,
        firstSequence: sequence,
        lastSequence: sequence,
        firstOccurredAt: occurredAt,
        lastOccurredAt: occurredAt,
      },
    ]
  }
  const current = messages[index] as TimelineMessage
  const next = [...messages]
  next[index] = {
    ...current,
    text: current.text + text,
    lastSequence: sequence,
    lastOccurredAt: occurredAt,
  }
  return next
}

const upsertToolCall = (
  toolCalls: readonly TimelineToolCall[],
  id: string,
  update: Readonly<Record<string, unknown>>,
  sequence: number,
  occurredAt: string,
  turnId: string | null,
): readonly TimelineToolCall[] => {
  const index = toolCalls.findIndex((toolCall) => toolCall.id === id)
  const current = index < 0 ? undefined : (toolCalls[index] as TimelineToolCall)
  const next: TimelineToolCall = {
    id,
    turnId,
    title: string(update["title"]) ?? current?.title ?? null,
    kind: string(update["kind"]) ?? current?.kind ?? null,
    status: string(update["status"]) ?? current?.status ?? null,
    rawInput: update["rawInput"] ?? current?.rawInput ?? null,
    rawOutput: update["rawOutput"] ?? current?.rawOutput ?? null,
    firstSequence: current?.firstSequence ?? sequence,
    lastSequence: sequence,
    firstOccurredAt: current?.firstOccurredAt ?? occurredAt,
    lastOccurredAt: occurredAt,
  }
  if (index < 0) return [...toolCalls, next]
  const result = [...toolCalls]
  result[index] = next
  return result
}

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}

const string = (value: unknown): string | null => (typeof value === "string" ? value : null)

const textContent = (value: unknown): string | null => {
  if (typeof value === "string") return value
  const content = record(value)
  return content["type"] === "text" && typeof content["text"] === "string" ? content["text"] : null
}
