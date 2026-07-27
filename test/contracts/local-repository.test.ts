import { describe, expect, test } from "bun:test"
import { requireConversationRepository } from "../../src/connectors/local-repository"
import type { LocalConversation } from "../../src/connectors/transcript-discovery"

const conversation: LocalConversation = {
  source: "codex",
  sourceConversationId: "session-1",
  title: "Work",
  modifiedAt: "2026-07-27T00:00:00.000Z",
  transcriptPath: "/private/transcript.jsonl",
  workspacePath: "/private/worktree/packages/app",
}

describe("local conversation repository identity", () => {
  test("accepts the approved GitHub repository across SSH and HTTPS spelling", async () => {
    await expect(
      requireConversationRepository(conversation, "Acme/Northstar", async (argv) =>
        argv.includes("--show-toplevel")
          ? { exitCode: 0, stdout: "/private/worktree\n" }
          : { exitCode: 0, stdout: "git@github.com:acme/northstar.git\n" },
      ),
    ).resolves.toBeUndefined()
  })

  test("rejects a transcript whose local git origin belongs to another room", async () => {
    await expect(
      requireConversationRepository(conversation, "acme/northstar", async (argv) =>
        argv.includes("--show-toplevel")
          ? { exitCode: 0, stdout: "/private/worktree\n" }
          : { exitCode: 0, stdout: "https://github.com/acme/other.git\n" },
      ),
    ).rejects.toThrow("belongs to acme/other")
  })
})
