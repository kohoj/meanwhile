import { describe, expect, test } from "bun:test"
import { RUNNER_PROTOCOL_VERSION, type SessionRunnerFrame } from "../../runner/protocol"
import {
  sanitizeRunnerTerminal,
  sanitizeSessionRunnerPayload,
} from "../../src/agents/runner-evidence"
import { SecretRedactor } from "../../src/secrets"

describe("control-plane runner evidence boundary", () => {
  test("redacts agent-controlled session evidence without rewriting protocol decisions", () => {
    const redactor = new SecretRedactor(["credential-value", "succeeded"])
    try {
      const update = sanitizeSessionRunnerPayload(
        frame({
          type: "turn.update",
          payload: {
            turnId: "turn-1",
            update: { content: "credential-value succeeded" },
            truncated: false,
          },
        }),
        redactor,
      )
      expect(JSON.stringify(update)).not.toContain("credential-value")
      expect(JSON.stringify(update)).not.toContain("succeeded")
      expect(JSON.stringify(update)).toContain("[REDACTED]")

      const terminal = sanitizeRunnerTerminal(
        { outcome: "succeeded", stopReason: "end_turn" },
        redactor,
      )
      expect(terminal).toEqual({ outcome: "succeeded", stopReason: "end_turn" })

      const stderr = sanitizeSessionRunnerPayload(
        frame({
          type: "agent.stderr",
          payload: { chunk: "credential-value", truncated: false },
        }),
        redactor,
      )
      expect(stderr).toEqual({ chunk: "[REDACTED]", truncated: false })
    } finally {
      redactor.dispose()
    }
  })
})

function frame(
  event:
    | Pick<Extract<SessionRunnerFrame, { type: "turn.update" }>, "type" | "payload">
    | Pick<Extract<SessionRunnerFrame, { type: "agent.stderr" }>, "type" | "payload">,
): SessionRunnerFrame {
  return {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    sessionId: "session-1",
    runnerSessionId: "runner-1",
    sequence: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    ...event,
  }
}
