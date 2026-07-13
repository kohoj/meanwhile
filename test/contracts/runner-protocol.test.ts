import { describe, expect, test } from "bun:test"

import {
  decodeRunnerSpec,
  encodeRunnerFrame,
  MAX_RUNNER_FRAME_BYTES,
  RUNNER_PROTOCOL_VERSION,
  type RunnerSpec,
  runnerFrameSchema,
  runnerSpecSchema,
  runnerTerminalPayloadSchema,
} from "../../runner/protocol"

describe("runner protocol", () => {
  test("keeps prompt data separate from argv and accepts a complete specification", () => {
    const input = validSpec()
    const decoded = decodeRunnerSpec(JSON.stringify(input))

    expect(decoded.prompt).toBe("repair the parser")
    expect(decoded.agent).toEqual({
      executable: "codex-acp",
      args: ["--quiet"],
    })
    expect(decoded.secretEnvironmentNames).toEqual(["OPENAI_API_KEY"])
  })

  test("rejects path traversal and absolute artifact paths", () => {
    expect(() =>
      runnerSpecSchema.parse({ ...validSpec(), artifactPaths: ["../secrets"] }),
    ).toThrow()
    expect(() =>
      runnerSpecSchema.parse({ ...validSpec(), artifactPaths: ["/etc/passwd"] }),
    ).toThrow()
    expect(() =>
      runnerSpecSchema.parse({
        ...validSpec(),
        agent: { ...validSpec().agent, workingDirectory: "src/../private" },
      }),
    ).toThrow()
  })

  test("does not accept a provider-private physical workspace path", () => {
    expect(() =>
      runnerSpecSchema.parse({
        ...validSpec(),
        workspaceRoot: "/provider/private/workspace",
      }),
    ).toThrow()
  })

  test("rejects persisted values that are also declared secret", () => {
    expect(() =>
      runnerSpecSchema.parse({
        ...validSpec(),
        environment: { OPENAI_API_KEY: "must-not-persist" },
      }),
    ).toThrow()
  })

  test("deduplicates an allow-once tool-kind policy", () => {
    const parsed = runnerSpecSchema.parse({
      ...validSpec(),
      permissionPolicy: {
        mode: "allow-once",
        toolKinds: ["read", "read", "search"],
      },
    })
    expect(parsed.permissionPolicy).toEqual({
      mode: "allow-once",
      toolKinds: ["read", "search"],
    })
  })

  test("requires monotonic positive runner sequence values", () => {
    const frame = {
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      runId: "run-1",
      runnerSessionId: "runner-session-1",
      sequence: 0,
      timestamp: new Date().toISOString(),
      type: "runner.started",
      payload: { timeoutBudgetMs: 60_000 },
    }
    expect(() => runnerFrameSchema.parse(frame)).toThrow()
  })

  test("makes ACP stop-reason outcome semantics part of the protocol", () => {
    expect(() =>
      runnerTerminalPayloadSchema.parse({
        outcome: "succeeded",
        stopReason: "max_tokens",
      }),
    ).toThrow()
    expect(() =>
      runnerTerminalPayloadSchema.parse({
        outcome: "failed",
        stopReason: "refusal",
      }),
    ).toThrow()
    expect(
      runnerTerminalPayloadSchema.parse({
        outcome: "failed",
        stopReason: "refusal",
        error: { code: "ACP_REFUSAL", message: "The ACP agent refused to continue the turn" },
      }),
    ).toMatchObject({ outcome: "failed", stopReason: "refusal" })
  })

  test("encodes one bounded NDJSON-safe frame", () => {
    const frame = {
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      runId: "run-1",
      runnerSessionId: "runner-session-1",
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: "agent.stderr" as const,
      payload: { chunk: "first\nsecond", truncated: false },
    }
    const encoded = encodeRunnerFrame(frame)

    expect(encoded.includes("\n")).toBe(false)
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(MAX_RUNNER_FRAME_BYTES)
    expect(runnerFrameSchema.parse(JSON.parse(encoded))).toEqual(frame)
  })
})

function validSpec(): RunnerSpec {
  return {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    runId: "run-1",
    runnerSessionId: "runner-session-1",
    agent: {
      executable: "codex-acp",
      args: ["--quiet"],
    },
    prompt: "repair the parser",
    permissionPolicy: { mode: "deny-all" },
    artifactPaths: ["dist"],
    timeoutBudgetMs: 60_000,
    environment: { CI: "1" },
    secretEnvironmentNames: ["OPENAI_API_KEY"],
  }
}
