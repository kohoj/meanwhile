import { describe, expect, test } from "bun:test";
import {
  boardRoutePath,
  parseBoardRoute,
  resolveConversationRef,
} from "../src/ui/navigation";

describe("Board browser addresses", () => {
  test("round-trips Project rooms and exact conversations", () => {
    const room = {
      surface: "project" as const,
      projectId: "project-1",
      conversation: null,
    };
    const detail = {
      surface: "project" as const,
      projectId: "project-1",
      conversation: { kind: "mirror" as const, id: "conversation-9" },
    };

    expect(parseBoardRoute(boardRoutePath(room))).toEqual(room);
    expect(parseBoardRoute(boardRoutePath(detail))).toEqual(detail);
  });

  test("falls back to the Lobby for malformed or unsupported locations", () => {
    for (const pathname of [
      "/projects/project-1/conversations/run",
      "/projects/project-1/conversations/other/item-1",
      "/projects/%2Fprivate",
      "/projects/project-1/settings",
      "/anything",
    ]) {
      expect(parseBoardRoute(pathname)).toEqual({ surface: "lobby" });
    }
  });

  test("resolves an initial conversation by both kind and id without a fallback", () => {
    const rows = [
      { kind: "run" as const, id: "same", title: "Native run" },
      { kind: "mirror" as const, id: "same", title: "Linked conversation" },
    ];

    expect(resolveConversationRef(rows, { kind: "mirror", id: "same" })?.title)
      .toBe("Linked conversation");
    expect(resolveConversationRef(rows, { kind: "session", id: "missing" })).toBeNull();
  });
});
