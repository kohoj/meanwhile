import { expect, test } from "bun:test"
import type { RunEvent, SessionEvent } from "../../src/api/contracts"
import type { RunStatus } from "../../src/domain"
import {
  emptySessionTimeline,
  reduceSessionTimeline,
  runDurationSummaryFromEvents,
  sessionTimelineFromEvents,
} from "../../src/timeline"
import {
  API_OWNER_ID,
  API_RUN_ID,
  API_SESSION_ID,
  API_TIMESTAMP,
  API_TURN_ID,
} from "../fixtures/api"

test("summarizes queued, provisioning, and running time from durable run events", () => {
  const summary = runDurationSummaryFromEvents([
    runStatusEvent(1, null, "queued", "2025-01-01T00:00:00.000Z"),
    runStatusEvent(2, "queued", "provisioning", "2025-01-01T00:00:02.000Z"),
    runnerEvent(3, "2025-01-01T00:00:08.000Z"),
    runStatusEvent(4, "provisioning", "running", "2025-01-01T00:00:07.000Z"),
    runStatusEvent(5, "running", "succeeded", "2025-01-01T00:00:18.000Z"),
  ])

  expect(summary).toEqual({ provisioningMs: 5_000, runningMs: 11_000, totalMs: 18_000 })
})

test("session timeline is a deterministic projection over durable cross-turn evidence", () => {
  const events: SessionEvent[] = [
    statusEvent(1, "session.status", null, {
      fromStatus: null,
      toStatus: "queued",
      statusVersion: 1,
      reason: "created",
    }),
    statusEvent(2, "turn.status", API_TURN_ID, {
      fromStatus: null,
      toStatus: "queued",
      statusVersion: 1,
      reason: "created",
    }),
    statusEvent(3, "turn.status", API_TURN_ID, {
      fromStatus: "queued",
      toStatus: "running",
      statusVersion: 2,
      reason: "runner_started",
    }),
    updateEvent(4, {
      sessionUpdate: "agent_message_chunk",
      messageId: "answer",
      content: { type: "text", text: "hello " },
    }),
    updateEvent(5, {
      sessionUpdate: "agent_message_chunk",
      messageId: "answer",
      content: { type: "text", text: "world" },
    }),
    updateEvent(6, {
      sessionUpdate: "tool_call",
      toolCallId: "read-1",
      title: "Read file",
      kind: "read",
      status: "pending",
      rawInput: { path: "README.md" },
    }),
    updateEvent(7, {
      sessionUpdate: "tool_call_update",
      toolCallId: "read-1",
      status: "completed",
      rawOutput: { bytes: 42 },
    }),
    statusEvent(8, "turn.status", API_TURN_ID, {
      fromStatus: "running",
      toStatus: "succeeded",
      statusVersion: 3,
      reason: "runner_terminal",
    }),
    statusEvent(9, "session.status", API_TURN_ID, {
      fromStatus: "running",
      toStatus: "idle",
      statusVersion: 4,
      reason: "turn_finished",
    }),
  ]

  const timeline = sessionTimelineFromEvents(events)

  expect(timeline).toMatchObject({
    sessionId: API_SESSION_ID,
    cursor: 9,
    status: "idle",
    activeTurnId: null,
    turnStatuses: { [API_TURN_ID]: "succeeded" },
    messages: [
      {
        id: `${API_TURN_ID}:agent:answer`,
        turnId: API_TURN_ID,
        role: "agent",
        text: "hello world",
        firstSequence: 4,
        lastSequence: 5,
        firstOccurredAt: API_TIMESTAMP,
        lastOccurredAt: API_TIMESTAMP,
      },
    ],
    toolCalls: [
      {
        id: `${API_TURN_ID}:read-1`,
        turnId: API_TURN_ID,
        title: "Read file",
        kind: "read",
        status: "completed",
        rawInput: { path: "README.md" },
        rawOutput: { bytes: 42 },
        firstSequence: 6,
        lastSequence: 7,
        firstOccurredAt: API_TIMESTAMP,
        lastOccurredAt: API_TIMESTAMP,
      },
    ],
  })
  expect(reduceSessionTimeline(timeline, events.at(-1) as SessionEvent)).toBe(timeline)
  expect(() => reduceSessionTimeline(emptySessionTimeline(), events[1] as SessionEvent)).toThrow(
    "Session event sequence is not contiguous",
  )
})

test("keeps thought and final message separate when an ACP agent reuses message identity", () => {
  const timeline = sessionTimelineFromEvents([
    statusEvent(1, "session.status", null, {
      fromStatus: null,
      toStatus: "running",
      statusVersion: 1,
      reason: "running",
    }),
    updateEvent(2, {
      sessionUpdate: "agent_thought_chunk",
      messageId: "shared",
      content: { type: "text", text: "private reasoning" },
    }),
    updateEvent(3, {
      sessionUpdate: "agent_message_chunk",
      messageId: "shared",
      content: { type: "text", text: "public answer" },
    }),
  ])

  expect(timeline.messages).toEqual([
    expect.objectContaining({
      id: `${API_TURN_ID}:thought:shared`,
      role: "thought",
      text: "private reasoning",
    }),
    expect.objectContaining({
      id: `${API_TURN_ID}:agent:shared`,
      role: "agent",
      text: "public answer",
    }),
  ])
})

function statusEvent(
  sequence: number,
  type: "session.status" | "turn.status",
  turnId: string | null,
  payload: SessionEvent["payload"],
): SessionEvent {
  return {
    version: 1,
    sessionId: API_SESSION_ID,
    ownerId: API_OWNER_ID,
    sequence,
    turnId,
    type,
    source: "control-plane",
    payload,
    createdAt: API_TIMESTAMP,
  } as SessionEvent
}

function updateEvent(sequence: number, update: Record<string, unknown>): SessionEvent {
  return {
    version: 1,
    sessionId: API_SESSION_ID,
    ownerId: API_OWNER_ID,
    sequence,
    turnId: API_TURN_ID,
    type: "turn.update",
    source: "runner",
    payload: { turnId: API_TURN_ID, update, truncated: false },
    createdAt: API_TIMESTAMP,
  }
}

function runStatusEvent(
  sequence: number,
  fromStatus: RunStatus | null,
  toStatus: RunStatus,
  createdAt: string,
): RunEvent {
  return {
    version: 1,
    runId: API_RUN_ID,
    ownerId: API_OWNER_ID,
    sequence,
    type: "run.status",
    source: "control-plane",
    payload: { fromStatus, toStatus, statusVersion: sequence, reason: "test" },
    createdAt,
  } as RunEvent
}

function runnerEvent(sequence: number, createdAt: string): RunEvent {
  return {
    version: 1,
    runId: API_RUN_ID,
    ownerId: API_OWNER_ID,
    sequence,
    type: "runner.started",
    source: "runner",
    payload: {},
    createdAt,
  }
}
