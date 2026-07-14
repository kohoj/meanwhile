import {
  type RunnerTerminalPayload,
  runnerTerminalPayloadSchema,
  type SessionRunnerFrame,
} from "../../runner/protocol"
import type { JsonObject } from "../domain"
import { AppError } from "../errors"
import type { SecretRedactor } from "../secrets"

/** Redacts only diagnostic terminal fields; protocol control enums remain authoritative. */
export function sanitizeRunnerTerminal(
  value: RunnerTerminalPayload,
  redactor: SecretRedactor,
): RunnerTerminalPayload {
  const sanitized = {
    outcome: value.outcome,
    ...(value.stopReason === undefined ? {} : { stopReason: value.stopReason }),
    ...(value.error === undefined
      ? {}
      : {
          error: {
            code: value.error.code,
            message: redactor.redactString(value.error.message),
          },
        }),
    ...(value.agentExit === undefined
      ? {}
      : {
          agentExit: {
            exitCode: value.agentExit.exitCode,
            signal:
              value.agentExit.signal === null
                ? null
                : redactor.redactString(value.agentExit.signal),
          },
        }),
  }
  const parsed = runnerTerminalPayloadSchema.safeParse(sanitized)
  if (!parsed.success) {
    throw new AppError({
      code: "RUNNER_PROTOCOL_ERROR",
      message: "Redacted runner terminal evidence is invalid",
    })
  }
  return parsed.data
}

/**
 * A second, control-plane-owned redaction boundary for an untrusted runner.
 * Durable command identities and protocol decisions are preserved verbatim;
 * only agent-controlled evidence fields can be rewritten.
 */
export function sanitizeSessionRunnerPayload(
  frame: SessionRunnerFrame,
  redactor: SecretRedactor,
): JsonObject {
  switch (frame.type) {
    case "session.ready":
      return jsonObject({
        agentSessionId: redactor.redactString(frame.payload.agentSessionId),
        capabilities: frame.payload.capabilities,
      })
    case "turn.started":
      return jsonObject({ turnId: frame.payload.turnId })
    case "turn.update":
      return jsonObject({
        turnId: frame.payload.turnId,
        update: redactor.redact(frame.payload.update),
        truncated: frame.payload.truncated,
        ...(frame.payload.originalBytes === undefined
          ? {}
          : { originalBytes: frame.payload.originalBytes }),
      })
    case "turn.permission":
      return jsonObject({
        turnId: frame.payload.turnId,
        toolCallId: redactor.redactString(frame.payload.toolCallId),
        ...(frame.payload.toolKind === undefined ? {} : { toolKind: frame.payload.toolKind }),
        decision: frame.payload.decision,
        ...(frame.payload.selectedOptionKind === undefined
          ? {}
          : { selectedOptionKind: frame.payload.selectedOptionKind }),
      })
    case "agent.stderr":
      return jsonObject({
        chunk: redactor.redactString(frame.payload.chunk),
        truncated: frame.payload.truncated,
      })
    case "turn.terminal":
      return jsonObject({
        turnId: frame.payload.turnId,
        result: sanitizeRunnerTerminal(frame.payload.result, redactor),
      })
    case "session.closed":
      return jsonObject({ reason: frame.payload.reason })
  }
}

const jsonObject = (value: object): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject
