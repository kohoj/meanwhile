import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  discoverLocalConversations,
  inspectLocalConversation,
  localConversationDiscovery,
} from "../../src/connectors/transcript-discovery"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("local transcript discovery", () => {
  test("inspects source-neutral safe metadata without exposing source record metadata", async () => {
    const root = await temporaryRoot()
    const path = join(root, "session.jsonl")
    await writeFile(
      path,
      `${JSON.stringify({
        timestamp: "2026-07-27T01:00:00.000Z",
        type: "session_meta",
        payload: { id: "codex-session-1", cwd: "/private/secret/repository" },
      })}\n${JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Find the callback race.\nDo not duplicate it." }],
        },
      })}\n`,
    )

    const inspected = await inspectLocalConversation("codex", path)

    expect(inspected).toMatchObject({
      source: "codex",
      sourceConversationId: "codex-session-1",
      title: "Find the callback race.",
      modifiedAt: expect.any(String),
      transcriptPath: path,
    })
    expect(inspected.workspacePath).toBe("/private/secret/repository")
    expect(JSON.stringify(inspected)).not.toContain("/private/secret/repository")
  })

  test("returns a bounded newest-first list but never selects a conversation", async () => {
    const root = await temporaryRoot()
    const older = join(root, "older.jsonl")
    const newer = join(root, "nested", "newer.jsonl")
    await mkdir(join(root, "nested"))
    await writeCodexTranscript(older, "older-session", "Older work")
    await writeCodexTranscript(newer, "newer-session", "Newer work")
    await utimes(older, new Date("2026-07-26T00:00:00Z"), new Date("2026-07-26T00:00:00Z"))
    await utimes(newer, new Date("2026-07-27T00:00:00Z"), new Date("2026-07-27T00:00:00Z"))

    expect(await discoverLocalConversations("codex", root, 1)).toMatchObject([
      { sourceConversationId: "newer-session", title: "Newer work" },
    ])
    expect(await localConversationDiscovery("codex").find(root, "older-session")).toMatchObject({
      sourceConversationId: "older-session",
      transcriptPath: older,
    })
  })

  test("fails inspection when a file contains ambiguous source identities", async () => {
    const root = await temporaryRoot()
    const path = join(root, "mixed.jsonl")
    await writeFile(
      path,
      `${JSON.stringify({ type: "user", sessionId: "one", message: { content: "One" } })}\n${JSON.stringify(
        {
          type: "assistant",
          sessionId: "two",
          message: { content: "Two" },
        },
      )}\n`,
    )

    await expect(inspectLocalConversation("claude-code", path)).rejects.toThrow(
      "exactly one claude-code conversation",
    )
  })
})

async function writeCodexTranscript(path: string, id: string, title: string): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify({ type: "session_meta", payload: { id, cwd: "/private/test/repository" } })}\n${JSON.stringify(
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: title }],
        },
      },
    )}\n`,
  )
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meanwhile-transcript-discovery-"))
  roots.push(root)
  return root
}
