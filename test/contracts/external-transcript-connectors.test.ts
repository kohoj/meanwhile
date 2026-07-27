import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  claudeCodeTranscriptNormalizer,
  codexTranscriptNormalizer,
  type JsonlTranscriptCursor,
  type NormalizedMirrorEvent,
  normalizedMirrorEventDigest,
  readTranscriptIncrement,
} from "../../src/connectors"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe("external transcript connector contract", () => {
  test("normalizes Codex messages and foldable work without leaking local metadata", async () => {
    const result = await readFixture("codex.jsonl", "codex-session-1", codexTranscriptNormalizer)

    expect(result.issues).toEqual([])
    expect(result.events.map((event) => event.type)).toEqual([
      "source_status",
      "message",
      "work",
      "work",
      "work",
      "message",
      "source_status",
    ])
    expect(result.events[1]).toMatchObject({
      source: "codex",
      type: "message",
      payload: { role: "user", markdown: "Find the callback race." },
    })
    expect(result.events[2]).toMatchObject({
      type: "work",
      payload: { kind: "reasoning", body: "Inspect the token exchange ownership." },
    })
    expect(JSON.stringify(result.events)).not.toContain("/private/local/path")
    expect(JSON.stringify(result.events)).not.toContain("not-shared")
    assertDigests(result.events)
  })

  test("normalizes Claude Code text, reasoning, tools, and observed source state", async () => {
    const result = await readFixture(
      "claude-code.jsonl",
      "claude-session-1",
      claudeCodeTranscriptNormalizer,
    )

    expect(result.issues).toEqual([])
    expect(result.events.map((event) => event.type)).toEqual([
      "source_status",
      "message",
      "work",
      "work",
      "work",
      "message",
      "source_status",
    ])
    expect(result.events[2]).toMatchObject({
      type: "work",
      payload: { kind: "reasoning", body: "Check the schema transition." },
    })
    expect(result.events[3]).toMatchObject({
      type: "work",
      payload: { kind: "tool", title: "Read", sourceItemId: "tool-1" },
    })
    expect(result.events[4]).toMatchObject({
      type: "work",
      payload: { status: "completed", sourceItemId: "tool-1" },
    })
    expect(result.events.at(-1)).toMatchObject({
      type: "source_status",
      payload: { status: "idle", reason: "end_turn" },
    })
    expect(JSON.stringify(result.events)).not.toContain("/private/local/path")
    expect(JSON.stringify(result.events)).not.toContain("private-signature")
    assertDigests(result.events)
  })

  test("advances only through complete lines and resumes without duplicates", async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, "session.jsonl")
    const first = `${JSON.stringify(codexMessage("first", "First"))}\n`
    const second = JSON.stringify(codexMessage("second", "Second"))
    await writeFile(path, first + second.slice(0, 24))

    const initial = await readTranscriptIncrement({
      path,
      sourceConversationId: "codex-session-1",
      normalizer: codexTranscriptNormalizer,
    })
    expect(initial.events).toHaveLength(1)
    expect(initial.caughtUp).toBeFalse()
    expect(initial.cursor.byteOffset).toBe(new TextEncoder().encode(first).byteLength)

    await appendFile(path, `${second.slice(24)}\n`)
    const resumed = await readTranscriptIncrement({
      path,
      sourceConversationId: "codex-session-1",
      normalizer: codexTranscriptNormalizer,
      cursor: initial.cursor,
    })
    expect(resumed.events).toHaveLength(1)
    expect(resumed.events[0]).toMatchObject({ payload: { markdown: "Second" } })
    expect(resumed.caughtUp).toBeTrue()

    const replay = await readTranscriptIncrement({
      path,
      sourceConversationId: "codex-session-1",
      normalizer: codexTranscriptNormalizer,
      cursor: initial.cursor,
    })
    expect(replay.events[0]?.sourceCursor).toBe(resumed.events[0]?.sourceCursor)
    expect(replay.events[0]?.digest).toBe(resumed.events[0]?.digest)
  })

  test("blocks at malformed JSON without advancing the durable cursor", async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, "session.jsonl")
    await writeFile(path, '{"broken":}\n')
    const malformed = await readTranscriptIncrement({
      path,
      sourceConversationId: "codex-session-1",
      normalizer: codexTranscriptNormalizer,
    })
    expect(malformed.issues).toHaveLength(1)
    expect(malformed.issues[0]?.kind).toBe("invalid_json")
    expect(malformed.issues[0]?.blocked).toBeTrue()
    expect(malformed.cursor.byteOffset).toBe(0)
    expect(malformed.cursor.lineNumber).toBe(0)
    expect(malformed.caughtUp).toBeFalse()

    await truncate(path, 0)
    await appendFile(path, `${JSON.stringify(codexMessage("after-reset", "Recovered"))}\n`)
    const recovered = await readTranscriptIncrement({
      path,
      sourceConversationId: "codex-session-1",
      normalizer: codexTranscriptNormalizer,
      cursor: malformed.cursor,
    })
    expect(recovered.reset).toBeNull()
    expect(recovered.events[0]).toMatchObject({ payload: { markdown: "Recovered" } })
  })

  test("commits earlier lines then blocks on a recognized incompatible record", async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, "session.jsonl")
    const first = `${JSON.stringify(codexMessage("first", "Accepted before drift"))}\n`
    const incompatible = `${JSON.stringify({
      timestamp: "2026-07-27T03:00:01.000Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: "new-shape" },
    })}\n`
    await writeFile(
      path,
      `${first}${incompatible}${JSON.stringify(codexMessage("later", "Must wait"))}\n`,
    )

    const blocked = await readTranscriptIncrement({
      path,
      sourceConversationId: "codex-session-1",
      normalizer: codexTranscriptNormalizer,
    })
    expect(blocked.events).toHaveLength(1)
    expect(blocked.events[0]).toMatchObject({ payload: { markdown: "Accepted before drift" } })
    expect(blocked.issues).toEqual([
      expect.objectContaining({ kind: "normalization_failed", lineNumber: 2, blocked: true }),
    ])
    expect(blocked.cursor.byteOffset).toBe(new TextEncoder().encode(first).byteLength)
    expect(blocked.cursor.lineNumber).toBe(1)

    const retried = await readTranscriptIncrement({
      path,
      sourceConversationId: "codex-session-1",
      normalizer: codexTranscriptNormalizer,
      cursor: blocked.cursor,
    })
    expect(retried.events).toEqual([])
    expect(retried.issues[0]).toMatchObject({
      kind: "normalization_failed",
      lineNumber: 2,
      blocked: true,
    })
    expect(retried.cursor).toEqual(blocked.cursor)
  })

  test("blocks invalid UTF-8 but ignores unrelated source records", async () => {
    const directory = await temporaryDirectory()
    const invalidPath = join(directory, "invalid.jsonl")
    await writeFile(invalidPath, new Uint8Array([0xff, 0x0a]))
    const invalid = await readTranscriptIncrement({
      path: invalidPath,
      sourceConversationId: "codex-session-1",
      normalizer: codexTranscriptNormalizer,
    })
    expect(invalid.events).toEqual([])
    expect(invalid.issues[0]).toMatchObject({ kind: "invalid_utf8", blocked: true })
    expect(invalid.cursor.byteOffset).toBe(0)

    const unrelatedPath = join(directory, "unrelated.jsonl")
    const unknown = `${JSON.stringify({ type: "world_state", payload: { opaque: true } })}\n`
    await writeFile(
      unrelatedPath,
      `${unknown}${JSON.stringify(codexMessage("known", "Still accepted"))}\n`,
    )
    const unrelated = await readTranscriptIncrement({
      path: unrelatedPath,
      sourceConversationId: "codex-session-1",
      normalizer: codexTranscriptNormalizer,
    })
    expect(unrelated.issues).toEqual([])
    expect(unrelated.events).toHaveLength(1)
    expect(unrelated.events[0]).toMatchObject({ payload: { markdown: "Still accepted" } })
    expect(unrelated.cursor.lineNumber).toBe(2)
  })

  test("rejects a cursor from another conversation", async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, "session.jsonl")
    await writeFile(path, "")
    const cursor: JsonlTranscriptCursor = {
      version: 1,
      source: "codex",
      sourceConversationId: "different-session",
      device: "1",
      inode: "1",
      generation: "initial",
      checkpoint: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      byteOffset: 0,
      lineNumber: 0,
    }
    await expect(
      readTranscriptIncrement({
        path,
        sourceConversationId: "codex-session-1",
        normalizer: codexTranscriptNormalizer,
        cursor,
      }),
    ).rejects.toThrow("another source conversation")
  })

  test("fails closed when transcript metadata belongs to another conversation", async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, "session.jsonl")
    await writeFile(
      path,
      `${JSON.stringify({
        timestamp: "2026-07-27T03:00:00.000Z",
        type: "session_meta",
        payload: { id: "unexpected-session" },
      })}\n${JSON.stringify(codexMessage("must-not-pass", "Wrong conversation"))}\n`,
    )
    await expect(
      readTranscriptIncrement({
        path,
        sourceConversationId: "codex-session-1",
        normalizer: codexTranscriptNormalizer,
      }),
    ).rejects.toThrow("does not match the selected conversation")
  })
})

async function readFixture(
  name: string,
  sourceConversationId: string,
  normalizer: typeof codexTranscriptNormalizer | typeof claudeCodeTranscriptNormalizer,
) {
  return readTranscriptIncrement({
    path: fileURLToPath(new URL(`../fixtures/external-transcripts/${name}`, import.meta.url)),
    sourceConversationId,
    normalizer,
  })
}

function assertDigests(events: readonly NormalizedMirrorEvent[]): void {
  for (const event of events) {
    expect(event.digest).toBe(
      normalizedMirrorEventDigest({
        version: event.version,
        source: event.source,
        sourceTimestamp: event.sourceTimestamp,
        type: event.type,
        payload: event.payload,
      }),
    )
    expect(event.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(event.sourceCursor).not.toContain("/")
  }
}

function codexMessage(id: string, text: string): unknown {
  return {
    timestamp: "2026-07-27T03:00:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      id,
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  }
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "meanwhile-transcript-"))
  temporaryDirectories.push(path)
  return path
}
