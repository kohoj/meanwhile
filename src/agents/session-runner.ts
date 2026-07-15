import {
  MAX_RUNNER_FRAME_BYTES,
  RUNNER_PROTOCOL_VERSION,
  type SessionRunnerFrame,
  type SessionRunnerSpec,
  sessionRunnerFrameSchema,
} from "../../runner/protocol"
import { AppError } from "../errors"
import {
  type EventCursor,
  type ProcessHandle,
  type RuntimeHandle,
  type RuntimeProvider,
  relativePath,
} from "../providers/runtime-provider"

export interface StartSessionRunnerInput {
  readonly provider: RuntimeProvider
  readonly runtime: RuntimeHandle
  readonly processId: string
  readonly spec: SessionRunnerSpec
  readonly credentialEnvironment: Readonly<Record<string, string>>
}

export class SessionRunnerController {
  start(input: StartSessionRunnerInput): Promise<ProcessHandle> {
    if (!input.provider.capabilities.processInput || input.provider.send === undefined) {
      throw new AppError({
        code: "PROVIDER_CAPABILITY_UNAVAILABLE",
        status: 422,
        message: "Runtime provider does not support durable process input",
        details: { provider: input.provider.name, capability: "processInput" },
      })
    }
    if (input.spec.sessionId === "" || input.spec.runnerSessionId !== input.processId) {
      throw protocolError("Session runner identity is invalid")
    }
    return input.provider.spawn(input.runtime, {
      processId: input.processId,
      argv: ["meanwhile-runner"],
      cwd: relativePath("."),
      env: input.credentialEnvironment,
      initialStdin: `${JSON.stringify(input.spec)}\n`,
      input: "mailbox",
    })
  }

  async consume(input: {
    readonly provider: RuntimeProvider
    readonly process: ProcessHandle
    readonly sessionId: string
    readonly runnerSessionId: string
    readonly cursor: EventCursor
    readonly lastSequence: number
    readonly signal: AbortSignal
    readonly onFrame: (frame: SessionRunnerFrame, cursor: string) => Promise<void>
    readonly onCursor: (cursor: string) => Promise<void>
  }): Promise<void> {
    let buffer = ""
    let lastSequence = input.lastSequence
    for await (const event of input.provider.events(input.process, input.cursor, input.signal)) {
      if (event.stream === "stderr") {
        if (buffer.length === 0) await input.onCursor(event.cursor)
        continue
      }
      buffer += event.data
      if (new TextEncoder().encode(buffer).byteLength > MAX_RUNNER_FRAME_BYTES * 2) {
        throw protocolError("Session runner output exceeded the framing buffer")
      }
      for (;;) {
        const newline = buffer.indexOf("\n")
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim() === "") continue
        const frame = decodeFrame(line)
        if (
          frame.sessionId !== input.sessionId ||
          frame.runnerSessionId !== input.runnerSessionId ||
          frame.protocolVersion !== RUNNER_PROTOCOL_VERSION
        ) {
          throw protocolError("Session runner frame identity is inconsistent")
        }
        if (frame.sequence <= lastSequence) continue
        if (frame.sequence !== lastSequence + 1) {
          throw protocolError("Session runner frame sequence contained a gap")
        }
        await input.onFrame(frame, event.cursor)
        lastSequence = frame.sequence
      }
      if (buffer.length === 0) await input.onCursor(event.cursor)
    }
    if (buffer.trim() !== "") throw protocolError("Session runner output ended mid-frame")
  }
}

const decodeFrame = (line: string): SessionRunnerFrame => {
  if (new TextEncoder().encode(line).byteLength > MAX_RUNNER_FRAME_BYTES) {
    throw protocolError("Session runner frame exceeded its byte limit")
  }
  try {
    return sessionRunnerFrameSchema.parse(JSON.parse(line))
  } catch (cause) {
    throw protocolError("Session runner emitted an invalid frame", cause)
  }
}

const protocolError = (message: string, cause?: unknown): AppError =>
  new AppError({
    code: "RUNNER_PROTOCOL_ERROR",
    message,
    ...(cause === undefined ? {} : { cause }),
  })
