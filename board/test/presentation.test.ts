import { describe, expect, test } from "bun:test";
import type { ProjectWorkItem } from "@kohoz/meanwhile/contracts";
import {
  type PresentedBoardRow,
  projectVerdict,
  taskAttention,
} from "../src/ui/presentation";

const row = (
  section: PresentedBoardRow["section"],
  delegatedBy: { readonly id: string; readonly displayName: string },
): PresentedBoardRow =>
  ({
    kind: "run",
    id: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000002",
    delegatedBy: { ...delegatedBy, kind: "person" },
    title: "Ship the collaboration slice",
    agentType: "codex",
    status: section === "attention" ? "failed" : section === "active" ? "running" : "succeeded",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:01:00.000Z",
    section,
  }) satisfies ProjectWorkItem & { readonly section: PresentedBoardRow["section"] };

describe("Project Watch presentation truth", () => {
  test("never labels healthy or completed work as needing its delegator", () => {
    expect(taskAttention(row("active", { id: "alice", displayName: "Alice" }), "alice")).toBeNull();
    expect(taskAttention(row("completed", { id: "alice", displayName: "Alice" }), "alice")).toBeNull();
  });

  test("attributes attention to the delegator without assigning it to another viewer", () => {
    const failed = row("attention", { id: "alice", displayName: "Alice" });
    expect(taskAttention(failed, "alice")).toBe("Needs you");
    expect(taskAttention(failed, "bob")).toBe("Needs Alice, not you");
  });

  test("distinguishes an empty Project from an all-clear populated Project", () => {
    expect(projectVerdict([], "alice", 1)).toEqual({
      personal: "Nothing needs you.",
      project: "No work has been delegated to this Project yet.",
      projectNeedsAttention: false,
    });
    expect(projectVerdict([row("completed", { id: "alice", displayName: "Alice" })], "alice", 1))
      .toEqual({
        personal: "Nothing needs you.",
        project: "Project work is clear.",
        projectNeedsAttention: false,
      });
  });

  test("does not call Project work clear when the viewer has attention", () => {
    expect(projectVerdict([row("attention", { id: "alice", displayName: "Alice" })], "alice", 1))
      .toEqual({
        personal: "1 task needs you.",
        project: "No other work needs attention.",
        projectNeedsAttention: false,
      });
  });
});
