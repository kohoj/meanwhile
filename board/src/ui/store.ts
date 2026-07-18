// Live board state. SWR owns the request/response snapshots (the board list);
// this store owns the append-only live layer: the fan-in SSE connection and the
// per-task timeline projections built with the kernel's own reducers.
import {
  type AgentTimeline,
  emptySessionTimeline,
  emptyTimeline,
  reduceSessionTimeline,
  reduceTimeline,
  type SessionTimeline,
} from "@kohoz/meanwhile/timeline";
import type { RunEvent, SessionEvent } from "@kohoz/meanwhile/contracts";
import { create } from "zustand";

export interface BoardRow {
  kind: "run" | "session";
  id: string;
  title: string;
  agentType: string;
  status: string;
  bucket: string;
  createdAt: string;
  updatedAt: string;
  live: boolean;
}

const key = (kind: string, id: string) => `${kind}:${id}`;

interface BoardState {
  connected: boolean;
  capped: boolean;
  // Live status overrides arriving via SSE, keyed by kind:id. The board list
  // (from SWR) is the baseline; these layer the latest live status on top.
  // Null when the timeline has not yet observed a status event.
  liveStatus: Record<string, string | null>;
  runTimelines: Record<string, AgentTimeline>;
  sessionTimelines: Record<string, SessionTimeline>;
  applyRunEvent: (id: string, event: RunEvent) => void;
  applySessionEvent: (id: string, event: SessionEvent) => void;
  setConnected: (connected: boolean) => void;
  setCapped: (capped: boolean) => void;
  runTimeline: (id: string) => AgentTimeline;
  sessionTimeline: (id: string) => SessionTimeline;
}

export const useBoard = create<BoardState>((set, get) => ({
  connected: false,
  capped: false,
  liveStatus: {},
  runTimelines: {},
  sessionTimelines: {},

  applyRunEvent: (id, event) =>
    set((state) => {
      const current = state.runTimelines[id] ?? emptyTimeline();
      const next = reduceTimeline(current, event);
      return {
        runTimelines: { ...state.runTimelines, [id]: next },
        liveStatus: { ...state.liveStatus, [key("run", id)]: next.status },
      };
    }),

  applySessionEvent: (id, event) =>
    set((state) => {
      const current = state.sessionTimelines[id] ?? emptySessionTimeline();
      const next = reduceSessionTimeline(current, event);
      return {
        sessionTimelines: { ...state.sessionTimelines, [id]: next },
        liveStatus: { ...state.liveStatus, [key("session", id)]: next.status },
      };
    }),

  setConnected: (connected) => set({ connected }),
  setCapped: (capped) => set({ capped }),
  runTimeline: (id) => get().runTimelines[id] ?? emptyTimeline(),
  sessionTimeline: (id) => get().sessionTimelines[id] ?? emptySessionTimeline(),
}));

// Connect the fan-in SSE stream to the store. Returns a disposer that closes the
// EventSource (which propagates abort to every upstream followEvents on the BFF).
export const connectStream = (): (() => void) => {
  const source = new EventSource("/stream");
  const store = useBoard.getState();

  source.addEventListener("ready", () => store.setConnected(true));
  source.addEventListener("event", (e) => {
    const { kind, id, event } = JSON.parse((e as MessageEvent).data);
    if (kind === "run") useBoard.getState().applyRunEvent(id, event);
    else useBoard.getState().applySessionEvent(id, event);
  });
  source.addEventListener("error", () => store.setConnected(false));

  return () => source.close();
};
