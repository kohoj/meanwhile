// Pure read-side projection: map a run's or session's durable status (plus, where
// a status alone is ambiguous, its latest event type) into one of four buckets a
// delegator cares about. No kernel field is added; this only reads what the
// control plane already publishes. Shared by the BFF and the browser.
import type { AgentSession, Run } from "@kohoz/meanwhile/contracts";

// Derive the status unions from the public contract types rather than importing
// domain.ts (which the package does not export). Run["status"] / AgentSession
// ["status"] are the same zod-derived enums.
type RunStatus = Run["status"];
type AgentSessionStatus = AgentSession["status"];

export type Bucket = "running" | "waiting" | "recovering" | "closed";

export const BUCKET_ORDER: readonly Bucket[] = ["waiting", "recovering", "running", "closed"];

export const BUCKET_LABEL: Record<Bucket, string> = {
  running: "Running",
  waiting: "Waiting on you",
  recovering: "Recovering",
  closed: "Closed",
};

// A task is "active" (worth following live) unless it has reached a terminal
// state. Mirrors client.ts TERMINAL_* sets so the board and client agree.
const TERMINAL_RUN: ReadonlySet<RunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);
const TERMINAL_SESSION: ReadonlySet<AgentSessionStatus> = new Set([
  "closed",
  "failed",
  "continuity_lost",
]);

export const isRunActive = (status: RunStatus): boolean => !TERMINAL_RUN.has(status);
export const isSessionActive = (status: AgentSessionStatus): boolean =>
  !TERMINAL_SESSION.has(status);

// Event types that mean "the agent is blocked on a human decision". Permission
// requests are evidence-only today (no approval action), which is exactly why a
// read-only board is the right surface for them.
const PERMISSION_EVENT = /permission/i;

export const runBucket = (status: RunStatus, latestEventType?: string): Bucket => {
  if (TERMINAL_RUN.has(status)) return "closed";
  if (latestEventType && PERMISSION_EVENT.test(latestEventType)) return "waiting";
  return "running";
};

export const sessionBucket = (
  status: AgentSessionStatus,
  latestEventType?: string,
): Bucket => {
  // continuity_lost is terminal, but it is the one terminal state that means
  // "the system tried to recover and is surfacing that it could not" — show it
  // as recovering so the delegator sees the recovery story, not a bare failure.
  if (status === "continuity_lost") return "recovering";
  if (status === "closed" || status === "failed") return "closed";
  if (status === "idle" && latestEventType && PERMISSION_EVENT.test(latestEventType)) {
    return "waiting";
  }
  return "running";
};
