import { describe, expect, test } from "bun:test";
import {
  isRunActive,
  isSessionActive,
  runBucket,
  sessionBucket,
} from "../src/buckets";

describe("run buckets", () => {
  test("in-flight runs are running", () => {
    for (const s of ["queued", "provisioning", "running"] as const) {
      expect(runBucket(s)).toBe("running");
    }
  });
  test("terminal runs are closed", () => {
    for (const s of ["succeeded", "failed", "cancelled", "timed_out"] as const) {
      expect(runBucket(s)).toBe("closed");
      expect(isRunActive(s)).toBe(false);
    }
  });
  test("a permission event moves a running run to waiting", () => {
    expect(runBucket("running", "agent.permission")).toBe("waiting");
  });
  test("a terminal run stays closed even with a stray event", () => {
    expect(runBucket("succeeded", "agent.permission")).toBe("closed");
  });
});

describe("session buckets", () => {
  test("in-flight sessions are running", () => {
    for (const s of ["queued", "provisioning", "running", "closing"] as const) {
      expect(sessionBucket(s)).toBe("running");
    }
  });
  test("idle with a pending permission is waiting", () => {
    expect(sessionBucket("idle", "turn.permission")).toBe("waiting");
    expect(sessionBucket("idle")).toBe("running"); // idle without permission is just live
  });
  test("continuity_lost surfaces as recovering, not a bare failure", () => {
    expect(sessionBucket("continuity_lost")).toBe("recovering");
    expect(isSessionActive("continuity_lost")).toBe(false);
  });
  test("closed and failed are closed", () => {
    expect(sessionBucket("closed")).toBe("closed");
    expect(sessionBucket("failed")).toBe("closed");
  });
});
