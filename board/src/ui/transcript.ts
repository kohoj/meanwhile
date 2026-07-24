import type { TimelineMessage, TimelineToolCall } from "@kohoz/meanwhile/timeline";

export type TranscriptDetail =
  | { readonly type: "thought"; readonly value: TimelineMessage }
  | { readonly type: "tool"; readonly value: TimelineToolCall };

export type TranscriptBlock =
  | {
      readonly type: "message";
      readonly firstSequence: number;
      readonly lastSequence: number;
      readonly value: TimelineMessage;
    }
  | {
      readonly type: "work";
      readonly id: string;
      readonly turnId: string | null;
      readonly firstSequence: number;
      readonly lastSequence: number;
      readonly details: readonly TranscriptDetail[];
    };

type OrderedTranscriptItem =
  | {
      readonly type: "message";
      readonly firstSequence: number;
      readonly lastSequence: number;
      readonly value: TimelineMessage;
    }
  | {
      readonly type: "thought";
      readonly firstSequence: number;
      readonly lastSequence: number;
      readonly value: TimelineMessage;
    }
  | {
      readonly type: "tool";
      readonly firstSequence: number;
      readonly lastSequence: number;
      readonly value: TimelineToolCall;
    };

const CONTEXT_TOOL_KINDS = new Set(["glob", "grep", "list", "read"]);

const isContextTool = (detail: TranscriptDetail): boolean =>
  detail.type === "tool" && CONTEXT_TOOL_KINDS.has(detail.value.kind ?? "");

const belongsToPreviousWork = (
  previous: Extract<TranscriptBlock, { readonly type: "work" }>,
  detail: TranscriptDetail,
): boolean => {
  if (detail.type === "thought") {
    return previous.details.some((candidate) => candidate.type === "thought");
  }
  if (!isContextTool(detail)) return false;
  return previous.details.every(
    (candidate) => candidate.type === "thought" || isContextTool(candidate),
  );
};

/**
 * Turns presentation-neutral ACP projections into readable agent-thread blocks.
 * Consecutive working notes and tool calls become one foldable work section;
 * user and agent messages remain the durable conversational spine.
 */
export const composeTranscript = (
  messages: readonly TimelineMessage[],
  toolCalls: readonly TimelineToolCall[],
): readonly TranscriptBlock[] => {
  const ordered: OrderedTranscriptItem[] = [
    ...messages.map((value) => ({
      type: value.role === "thought" ? ("thought" as const) : ("message" as const),
      firstSequence: value.firstSequence,
      lastSequence: value.lastSequence,
      value,
    })),
    ...toolCalls.map((value) => ({
      type: "tool" as const,
      firstSequence: value.firstSequence,
      lastSequence: value.lastSequence,
      value,
    })),
  ].sort(
    (left, right) =>
      left.firstSequence - right.firstSequence || left.lastSequence - right.lastSequence,
  );

  const blocks: TranscriptBlock[] = [];
  for (const item of ordered) {
    if (item.type === "message") {
      blocks.push(item);
      continue;
    }
    const turnId = item.value.turnId;
    const previous = blocks.at(-1);
    const detail: TranscriptDetail =
      item.type === "thought"
        ? { type: "thought", value: item.value }
        : { type: "tool", value: item.value };
    if (
      previous?.type === "work" &&
      previous.turnId === turnId &&
      belongsToPreviousWork(previous, detail)
    ) {
      blocks[blocks.length - 1] = {
        ...previous,
        lastSequence: Math.max(previous.lastSequence, item.lastSequence),
        details: [...previous.details, detail],
      };
      continue;
    }
    blocks.push({
      type: "work",
      id: `work:${turnId ?? "run"}:${item.firstSequence}`,
      turnId,
      firstSequence: item.firstSequence,
      lastSequence: item.lastSequence,
      details: [detail],
    });
  }
  return blocks;
};

export const workSummary = (
  details: readonly TranscriptDetail[],
): { readonly title: string; readonly status: string | null } => {
  const tools = details.filter((detail) => detail.type === "tool");
  const lastTool = [...details].reverse().find((detail) => detail.type === "tool");
  if (details.some((detail) => detail.type === "thought")) {
    return {
      title: "Reasoning",
      status: lastTool?.type === "tool" ? lastTool.value.status : null,
    };
  }
  if (lastTool?.type === "tool") {
    if (
      tools.length > 0 &&
      tools.every((detail) => detail.type === "tool" && CONTEXT_TOOL_KINDS.has(detail.value.kind ?? ""))
    ) {
      const fileCount = tools.reduce((count, detail) => {
        if (detail.type !== "tool") return count;
        const input = detail.value.rawInput;
        if (typeof input !== "object" || input === null) return count;
        const record = input as Record<string, unknown>;
        if (Array.isArray(record.paths)) {
          return count + record.paths.filter((value) => typeof value === "string").length;
        }
        return count + (typeof record.filePath === "string" || typeof record.path === "string" ? 1 : 0);
      }, 0);
      return {
        title: fileCount > 0
          ? `Explored ${fileCount} ${fileCount === 1 ? "file" : "files"}`
          : "Gathered project context",
        status: lastTool.value.status,
      };
    }
    return {
      title: lastTool.value.title ?? lastTool.value.kind ?? "Used a tool",
      status: lastTool.value.status,
    };
  }
  return { title: "Reasoned through the task", status: null };
};
