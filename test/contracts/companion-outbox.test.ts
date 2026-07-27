import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CompanionOutbox, type NormalizedMirrorEvent, normalizedEvent } from "../../src/connectors"
import type { JsonlTranscriptCursor } from "../../src/connectors/jsonl-transcript"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe("CompanionOutbox", () => {
  test("does not advance the transcript cursor when its bounded outbox is full", async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, "nested", "outbox.sqlite")
    const outbox = await CompanionOutbox.open(path, { maxEvents: 1, maxBytes: 1_000_000 })
    try {
      outbox.initialize({
        source: "codex",
        projectId: "project-1",
        transcriptPath: "/local/session.jsonl",
        sourceConversationId: "source-1",
        sourceConversationKey: "a".repeat(64),
        mirrorId: "mirror-1",
        title: "Local session",
      })
      const cursor = transcriptCursor(42)
      expect(() => outbox.stage([message("one", "One"), message("two", "Two")], cursor)).toThrow(
        "outbox capacity reached",
      )
      expect(outbox.pending()).toEqual([])
      expect(outbox.state()?.cursor).toBeNull()

      const staged = outbox.stage([message("one", "One")], cursor)
      expect(staged.nextSequence).toBe(2)
      expect(staged.cursor).toEqual(cursor)
      expect(outbox.pending()).toHaveLength(1)
      expect(() => outbox.stage([message("two", "Two")], transcriptCursor(84))).toThrow(
        "outbox capacity reached",
      )
      expect(outbox.state()?.cursor).toEqual(cursor)
    } finally {
      outbox.close()
    }
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test("accepts only a checkpoint that identifies an exact staged event", async () => {
    const directory = await temporaryDirectory()
    const outbox = await CompanionOutbox.open(join(directory, "outbox.sqlite"))
    try {
      outbox.initialize({
        source: "codex",
        projectId: "project-1",
        transcriptPath: "/local/session.jsonl",
        sourceConversationId: "source-1",
        sourceConversationKey: "b".repeat(64),
        mirrorId: "mirror-1",
        title: "Local session",
      })
      outbox.stage([message("one", "One"), message("two", "Two")], transcriptCursor(84))
      expect(() => outbox.reconcileRemote(2, "wrong-cursor")).toThrow(
        "does not identify a local staged event",
      )
      expect(outbox.state()?.acknowledgedSequence).toBe(0)
      expect(outbox.pending()).toHaveLength(2)

      const accepted = outbox.reconcileRemote(2, outbox.pending()[1]?.sourceCursor ?? null)
      expect(accepted.acknowledgedSequence).toBe(2)
      expect(outbox.pending()).toEqual([])
      expect(() => outbox.reconcileRemote(1, outbox.pending()[0]?.sourceCursor ?? null)).toThrow(
        "behind local durable state",
      )
    } finally {
      outbox.close()
    }
  })
})

function message(cursor: string, markdown: string): NormalizedMirrorEvent {
  return normalizedEvent(
    "codex",
    {
      sourceConversationId: "source-1",
      sourceCursor: `jsonl:v1:generation:${cursor}`,
      sourceTimestamp: "2026-07-27T00:00:00.000Z",
    },
    0,
    {
      type: "message",
      payload: { role: "assistant", markdown, sourceMessageId: cursor, truncated: false },
    },
  )
}

function transcriptCursor(byteOffset: number): JsonlTranscriptCursor {
  return {
    version: 1,
    source: "codex",
    sourceConversationId: "source-1",
    device: "1",
    inode: "2",
    generation: "c".repeat(64),
    checkpoint: "d".repeat(64),
    byteOffset,
    lineNumber: 1,
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "meanwhile-companion-outbox-"))
  temporaryDirectories.push(directory)
  return directory
}
