import {
  type AgentTimeline,
  type MirrorTimeline,
  mirrorTimelineFromEvents,
  reduceMirrorTimeline,
  reduceSessionTimeline,
  reduceTimeline,
  type SessionTimeline,
  sessionTimelineFromEvents,
  timelineFromEvents,
} from "@kohoz/meanwhile/timeline";
import type {
  RunEvent,
  MirrorEvent,
  SessionEvent,
  TaskAnnotation,
  TaskRelay,
} from "@kohoz/meanwhile/contracts";
import { create } from "zustand";

interface BoardState {
  runTimelines: Record<string, AgentTimeline>;
  sessionTimelines: Record<string, SessionTimeline>;
  mirrorTimelines: Record<string, MirrorTimeline>;
  taskAnnotations: Record<string, readonly TaskAnnotation[]>;
  taskRelays: Record<string, readonly TaskRelay[]>;
  loading: Record<string, boolean>;
  errors: Record<string, string | null>;
  loadHistory: (kind: "run" | "session" | "mirror", id: string, projectId: string) => Promise<boolean>;
  refreshRelays: (kind: "run" | "session" | "mirror", id: string, projectId: string) => Promise<void>;
  refreshAnnotations: (kind: "run" | "session" | "mirror", id: string, projectId: string) => Promise<void>;
  ingestEvent: (kind: "run" | "session" | "mirror", id: string, event: RunEvent | SessionEvent | MirrorEvent) => void;
  replaceRelay: (relay: TaskRelay) => void;
  replaceAnnotation: (annotation: TaskAnnotation) => void;
}

const historyRequests = new Map<string, Promise<boolean>>();

export const useBoard = create<BoardState>((set, get) => ({
  runTimelines: {},
  sessionTimelines: {},
  mirrorTimelines: {},
  taskAnnotations: {},
  taskRelays: {},
  loading: {},
  errors: {},
  loadHistory: (kind, id, projectId) => {
    const key = `${kind}:${id}`;
    const state = get();
    if (state.runTimelines[id] || state.sessionTimelines[id] || state.mirrorTimelines[id]) return Promise.resolve(true);
    const pending = historyRequests.get(key);
    if (pending !== undefined) return pending;
    set((current) => ({
      loading: { ...current.loading, [key]: true },
      errors: { ...current.errors, [key]: null },
    }));
    const request = (async () => {
      try {
        const events: unknown[] = [];
        let relays: readonly TaskRelay[] = [];
        let annotations: readonly TaskAnnotation[] = [];
        let after: number | null = null;
        for (;;) {
          const query = new URLSearchParams({ projectId });
          if (after !== null) query.set("after", String(after));
          const response = await fetch(`/task/${kind}/${id}/events?${query.toString()}`);
          if (!response.ok) {
            set((current) => ({
              errors: { ...current.errors, [key]: "Conversation history is unavailable." },
            }));
            return false;
          }
          const page = (await response.json()) as {
            events: unknown[];
            nextCursor?: number | null;
            relays: readonly TaskRelay[];
            annotations: readonly TaskAnnotation[];
          };
          events.push(...page.events);
          relays = page.relays;
          annotations = page.annotations;
          const next = page.nextCursor ?? null;
          if (next === null) break;
          if (!Number.isSafeInteger(next) || next < 1 || (after !== null && next <= after)) {
            throw new Error("Invalid conversation history cursor");
          }
          after = next;
        }
        if (kind === "run") {
          const timeline = timelineFromEvents(events as never[]);
          set((current) => ({
            runTimelines: { ...current.runTimelines, [id]: timeline },
            taskAnnotations: { ...current.taskAnnotations, [key]: annotations },
            taskRelays: { ...current.taskRelays, [key]: relays },
          }));
        } else if (kind === "session") {
          const timeline = sessionTimelineFromEvents(events as never[]);
          set((current) => ({
            sessionTimelines: { ...current.sessionTimelines, [id]: timeline },
            taskAnnotations: { ...current.taskAnnotations, [key]: annotations },
            taskRelays: { ...current.taskRelays, [key]: relays },
          }));
        } else {
          const timeline = mirrorTimelineFromEvents(events as never[]);
          set((current) => ({
            mirrorTimelines: { ...current.mirrorTimelines, [id]: timeline },
            taskAnnotations: { ...current.taskAnnotations, [key]: annotations },
            taskRelays: { ...current.taskRelays, [key]: relays },
          }));
        }
        return true;
      } catch {
        set((current) => ({
          errors: { ...current.errors, [key]: "Conversation history is unavailable." },
        }));
        return false;
      } finally {
        historyRequests.delete(key);
        set((current) => ({ loading: { ...current.loading, [key]: false } }));
      }
    })();
    historyRequests.set(key, request);
    return request;
  },
  ingestEvent: (kind, id, event) => {
    if (kind === "run") {
      set((current) => {
        const timeline = current.runTimelines[id];
        return timeline === undefined
          ? current
          : { runTimelines: { ...current.runTimelines, [id]: reduceTimeline(timeline, event as RunEvent) } };
      });
      return;
    }
    if (kind === "session") set((current) => {
      const timeline = current.sessionTimelines[id];
      return timeline === undefined
        ? current
        : {
            sessionTimelines: {
              ...current.sessionTimelines,
              [id]: reduceSessionTimeline(timeline, event as SessionEvent),
            },
          };
    });
    else set((current) => {
      const timeline = current.mirrorTimelines[id];
      return timeline === undefined
        ? current
        : {
            mirrorTimelines: {
              ...current.mirrorTimelines,
              [id]: reduceMirrorTimeline(timeline, event as MirrorEvent),
            },
          };
    });
  },
  refreshRelays: async (kind, id, projectId) => {
    const response = await fetch(
      `/task/${kind}/${id}/relays?projectId=${encodeURIComponent(projectId)}`,
    );
    if (!response.ok) return;
    const { relays } = (await response.json()) as { relays: readonly TaskRelay[] };
    const key = `${kind}:${id}`;
    set((current) => ({ taskRelays: { ...current.taskRelays, [key]: relays } }));
  },
  refreshAnnotations: async (kind, id, projectId) => {
    const response = await fetch(
      `/task/${kind}/${id}/annotations?projectId=${encodeURIComponent(projectId)}`,
    );
    if (!response.ok) return;
    const { annotations } = (await response.json()) as {
      annotations: readonly TaskAnnotation[];
    };
    const key = `${kind}:${id}`;
    set((current) => ({
      taskAnnotations: { ...current.taskAnnotations, [key]: annotations },
    }));
  },
  replaceRelay: (relay) => {
    const key = `${relay.task.kind}:${relay.task.id}`;
    set((current) => {
      const relays = current.taskRelays[key] ?? [];
      const index = relays.findIndex((candidate) => candidate.id === relay.id);
      const next = [...relays];
      if (index < 0) next.push(relay);
      else next[index] = relay;
      next.sort(
        (left, right) =>
          left.anchorSequence - right.anchorSequence || left.createdAt.localeCompare(right.createdAt),
      );
      return { taskRelays: { ...current.taskRelays, [key]: next } };
    });
  },
  replaceAnnotation: (annotation) => {
    const key = `${annotation.task.kind}:${annotation.task.id}`;
    set((current) => {
      const annotations = current.taskAnnotations[key] ?? [];
      const index = annotations.findIndex((candidate) => candidate.id === annotation.id);
      const next = [...annotations];
      if (index < 0) next.push(annotation);
      else next[index] = annotation;
      next.sort(
        (left, right) =>
          left.anchor.sequence - right.anchor.sequence ||
          left.anchor.startOffset - right.anchor.startOffset ||
          left.createdAt.localeCompare(right.createdAt),
      );
      return { taskAnnotations: { ...current.taskAnnotations, [key]: next } };
    });
  },
}));
