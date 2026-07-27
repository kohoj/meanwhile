import { describe, expect, test } from "bun:test"
import {
  EXTERNAL_TRANSCRIPT_PROTOCOL_VERSION,
  normalizedEvent,
  normalizedMirrorEventDigest,
} from "../../src/connectors/external-transcript"
import {
  redactNormalizedMirrorEvent,
  redactNormalizedMirrorEvents,
  TRANSCRIPT_REDACTION_RULESET_VERSION,
} from "../../src/connectors/transcript-redaction"

const context = {
  sourceConversationId: "local-source-1",
  sourceCursor: "42",
  sourceTimestamp: "2026-07-27T00:00:00.000Z" as const,
}

describe("transcript redaction contract", () => {
  test("redacts exact secrets and known provider tokens from every publishable text field", () => {
    const exactSecret = "companion-secret-value"
    const github = `ghp_${"a".repeat(36)}`
    const openai = `sk-proj-${"b".repeat(24)}`
    const anthropic = `sk-ant-api03-${"c".repeat(24)}`
    const meanwhile = `mwd_${"d".repeat(12)}_${"e".repeat(43)}`
    const event = normalizedEvent("codex", context, 0, {
      type: "work",
      payload: {
        kind: "tool",
        title: `Read ${exactSecret}`,
        body: JSON.stringify({ input: github, output: { openai, anthropic, meanwhile } }),
        status: `failed: ${exactSecret}`,
        sourceItemId: "tool-1",
        truncated: false,
      },
    })

    const redacted = redactNormalizedMirrorEvent(event, { knownSecrets: [exactSecret] })
    const published = JSON.stringify(redacted.event)
    expect(published).not.toContain(exactSecret)
    expect(published).not.toContain(github)
    expect(published).not.toContain(openai)
    expect(published).not.toContain(anthropic)
    expect(published).not.toContain(meanwhile)
    expect(redacted.event.payload).toMatchObject({
      title: "Read [redacted]",
      status: "failed: [redacted]",
    })
    expect(redacted.statistics).toEqual({
      rulesVersion: TRANSCRIPT_REDACTION_RULESET_VERSION,
      fieldsRedacted: 3,
      replacements: { exactSecret: 2, knownToken: 4, localPath: 0 },
    })
    expect(JSON.stringify(redacted.statistics)).not.toContain(exactSecret)
  })

  test("redacts current-style macOS, Linux, and Windows home roots while preserving relative paths", () => {
    const event = normalizedEvent("claude-code", context, 1, {
      type: "message",
      payload: {
        role: "assistant",
        markdown:
          "mac /Users/ada/work/a.ts; linux /home/ada/work/b.ts; windows C:\\Users\\Ada\\work\\c.ts; relative src/work.ts",
        sourceMessageId: "message-1",
        truncated: false,
      },
    })

    const redacted = redactNormalizedMirrorEvent(event, {
      homePaths: ["/Users/ada", "/home/ada", "C:\\Users\\Ada"],
    })
    expect(redacted.event.payload).toMatchObject({
      markdown:
        "mac [local-home]/work/a.ts; linux [local-home]/work/b.ts; windows [local-home]\\work\\c.ts; relative src/work.ts",
    })
    expect(redacted.statistics.replacements.localPath).toBe(3)
  })

  test("redacts user and assistant messages plus reasoning and tool work without changing event order", () => {
    const secret = "a-secret-only-the-companion-knows"
    const events = [
      normalizedEvent("codex", context, 3, {
        type: "message",
        payload: {
          role: "user",
          markdown: `Please inspect ${secret}`,
          sourceMessageId: "user-1",
          truncated: false,
        },
      }),
      normalizedEvent("codex", context, 4, {
        type: "message",
        payload: {
          role: "assistant",
          markdown: `I found ${secret}`,
          sourceMessageId: "assistant-1",
          truncated: false,
        },
      }),
      normalizedEvent("codex", context, 5, {
        type: "work",
        payload: {
          kind: "reasoning",
          title: null,
          body: `Reasoning about ${secret}`,
          status: null,
          sourceItemId: "reasoning-1",
          truncated: false,
        },
      }),
    ]

    const redacted = redactNormalizedMirrorEvents(events, { knownSecrets: [secret] })
    expect(redacted.map((item) => item.event.sourceCursor)).toEqual(
      events.map((event) => event.sourceCursor),
    )
    expect(redacted.map((item) => JSON.stringify(item.event))).toEqual([
      expect.not.stringContaining(secret),
      expect.not.stringContaining(secret),
      expect.not.stringContaining(secret),
    ])
    expect(redacted.map((item) => item.event.digest)).not.toEqual(
      events.map((event) => event.digest),
    )
  })

  test("redacts source-status reasons, preserves cursor identity, and recomputes the digest from redacted payload", () => {
    const secret = "do-not-publish"
    const event = normalizedEvent("codex", context, 2, {
      type: "source_status",
      payload: { status: "disconnected", reason: `agent error at /Users/ada/private: ${secret}` },
    })
    const redacted = redactNormalizedMirrorEvent(event, {
      knownSecrets: [secret],
      homePaths: ["/Users/ada"],
    })
    if (redacted.event.type !== "source_status") throw new Error("Expected source status event")
    expect(redacted.event.sourceCursor).toBe(event.sourceCursor)
    expect(redacted.event.payload).toEqual({
      status: "disconnected",
      reason: "agent error at [local-home]/private: [redacted]",
    })
    expect(redacted.event.digest).not.toBe(event.digest)
    expect(redacted.event.digest).toBe(
      normalizedMirrorEventDigest({
        version: EXTERNAL_TRANSCRIPT_PROTOCOL_VERSION,
        source: "codex",
        sourceTimestamp: context.sourceTimestamp,
        type: "source_status",
        payload: redacted.event.payload,
      }),
    )
  })
})
