import { expect, test } from "bun:test";
import type { TimelineMessage, TimelineToolCall } from "@kohoz/meanwhile/timeline";
import { composeTranscript, workSummary } from "../src/ui/transcript";

const message = (
  id: string,
  role: TimelineMessage["role"],
  firstSequence: number,
  lastSequence = firstSequence,
): TimelineMessage => ({
  id,
  role,
  turnId: "turn-1",
  text: id,
  firstSequence,
  lastSequence,
  firstOccurredAt: "2026-07-23T08:32:00.000Z",
  lastOccurredAt: "2026-07-23T08:32:00.000Z",
});

const tool = (
  id: string,
  firstSequence: number,
  lastSequence = firstSequence,
  kind = "read",
): TimelineToolCall => ({
  id,
  turnId: "turn-1",
  title: "Read board/src/ui/app.tsx",
  kind,
  status: "completed",
  rawInput: { path: "board/src/ui/app.tsx" },
  rawOutput: { bytes: 42 },
  firstSequence,
  lastSequence,
  firstOccurredAt: "2026-07-23T08:32:00.000Z",
  lastOccurredAt: "2026-07-23T08:32:00.000Z",
});

test("composes a Codex-like conversational spine with foldable work groups", () => {
  const blocks = composeTranscript(
    [message("thinking", "thought", 2), message("answer", "agent", 5, 6)],
    [tool("read-1", 3, 4)],
  );

  expect(blocks).toEqual([
    expect.objectContaining({
      type: "work",
      firstSequence: 2,
      lastSequence: 4,
      details: [
        expect.objectContaining({ type: "thought" }),
        expect.objectContaining({ type: "tool" }),
      ],
    }),
    expect.objectContaining({ type: "message", firstSequence: 5, lastSequence: 6 }),
  ]);
  const working = blocks[0];
  expect(working?.type).toBe("work");
  if (working?.type === "work") {
    expect(workSummary(working.details)).toEqual({
      title: "Reasoning",
      status: "completed",
    });
  }
});

test("names pure discovery work from the tools it actually ran", () => {
  expect(workSummary([{ type: "tool", value: tool("read-1", 2, 3) }])).toEqual({
    title: "Explored 1 file",
    status: "completed",
  });
});

test("does not merge working details across conversational turns", () => {
  const first = message("thinking-1", "thought", 1);
  const second = { ...message("thinking-2", "thought", 2), turnId: "turn-2" };

  expect(composeTranscript([first, second], [])).toHaveLength(2);
});

test("keeps the latest durable anchor when one streamed thought spans a tool call", () => {
  const blocks = composeTranscript([message("thinking", "thought", 1, 4)], [tool("read-1", 2, 3)]);

  expect(blocks).toEqual([
    expect.objectContaining({ type: "work", firstSequence: 1, lastSequence: 4 }),
  ]);
});

test("keeps discovery, reasoning, and execution as separate foldable phases", () => {
  const blocks = composeTranscript(
    [message("reasoning", "thought", 3)],
    [
      tool("read-1", 1, 2),
      tool("tests", 4, 5, "execute"),
      tool("edit", 6, 7, "edit"),
    ],
  );

  expect(blocks.map((block) => block.type)).toEqual(["work", "work", "work", "work"]);
  expect(blocks.map((block) => block.type === "work" ? block.details[0]?.type : null)).toEqual([
    "tool",
    "thought",
    "tool",
    "tool",
  ]);
});
