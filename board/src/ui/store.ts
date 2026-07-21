import {
  type AgentTimeline,
  type SessionTimeline,
  sessionTimelineFromEvents,
  timelineFromEvents,
} from "@kohoz/meanwhile/timeline";
import { create } from "zustand";

interface BoardState {
  runTimelines: Record<string, AgentTimeline>;
  sessionTimelines: Record<string, SessionTimeline>;
  loading: Record<string, boolean>;
  loadHistory: (kind: "run" | "session", id: string) => Promise<void>;
}

export const useBoard = create<BoardState>((set, get) => ({
  runTimelines: {},
  sessionTimelines: {},
  loading: {},
  loadHistory: async (kind, id) => {
    const key = `${kind}:${id}`;
    const state = get();
    if (state.loading[key] || state.runTimelines[id] || state.sessionTimelines[id]) return;
    set((current) => ({ loading: { ...current.loading, [key]: true } }));
    try {
      const response = await fetch(`/task/${kind}/${id}/events`);
      if (!response.ok) return;
      const { events } = (await response.json()) as { events: unknown[] };
      if (kind === "run") {
        const timeline = timelineFromEvents(events as never[]);
        set((current) => ({ runTimelines: { ...current.runTimelines, [id]: timeline } }));
      } else {
        const timeline = sessionTimelineFromEvents(events as never[]);
        set((current) => ({
          sessionTimelines: { ...current.sessionTimelines, [id]: timeline },
        }));
      }
    } finally {
      set((current) => ({ loading: { ...current.loading, [key]: false } }));
    }
  },
}));
