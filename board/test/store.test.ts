import { expect, test } from "bun:test";
import type { RunEvent } from "@kohoz/meanwhile/contracts";
import { useBoard } from "../src/ui/store";

const RUN_ID = "18b01273-9dc6-4d18-b1cf-a1557a9192e1";
const OWNER_ID = "8582c2bd-7a42-40f7-a497-ac3255cd3e39";
const PROJECT_ID = "810590c0-8f4d-418a-9fea-13e49d2cb5a3";
const OCCURRED_AT = "2026-07-24T04:45:24.904Z";

const events: readonly RunEvent[] = [
  {
    version: 1,
    runId: RUN_ID,
    ownerId: OWNER_ID,
    sequence: 1,
    createdAt: OCCURRED_AT,
    type: "run.status",
    source: "control-plane",
    payload: {
      fromStatus: null,
      toStatus: "running",
      statusVersion: 1,
      reason: "agent.session_started",
    },
  },
  {
    version: 1,
    runId: RUN_ID,
    ownerId: OWNER_ID,
    sequence: 2,
    createdAt: OCCURRED_AT,
    type: "agent.update",
    source: "runner",
    payload: {
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "answer",
        content: { type: "text", text: "Authoritative answer" },
      },
      truncated: false,
    },
  },
];

test("concurrent transcript readers share one authoritative history request", async () => {
  useBoard.setState({
    runTimelines: {},
    sessionTimelines: {},
    taskAnnotations: {},
    taskRelays: {},
    loading: {},
    errors: {},
  });
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = (async () => {
    requests += 1;
    await gate;
    return Response.json({ events, relays: [], annotations: [] });
  }) as typeof fetch;

  try {
    const first = useBoard.getState().loadHistory("run", RUN_ID, PROJECT_ID);
    const second = useBoard.getState().loadHistory("run", RUN_ID, PROJECT_ID);

    expect(first).toBe(second);
    expect(requests).toBe(1);
    release?.();
    expect(await first).toBeTrue();
    expect(await second).toBeTrue();
    expect(useBoard.getState().runTimelines[RUN_ID]?.messages).toEqual([
      expect.objectContaining({ role: "agent", text: "Authoritative answer" }),
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    useBoard.setState({
      runTimelines: {},
      sessionTimelines: {},
      taskAnnotations: {},
      taskRelays: {},
      loading: {},
      errors: {},
    });
  }
});
