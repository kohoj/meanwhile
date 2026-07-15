import {
  MAX_RUNNER_FRAME_BYTES,
  RUNNER_PROTOCOL_VERSION,
  type RunnerFrame,
  type RunnerSpec,
  type RunnerTerminalPayload,
  runnerFrameSchema,
} from "../../runner/protocol"
import { AppError } from "../errors"
import {
  type EventCursor,
  type ProcessHandle,
  type RuntimeHandle,
  type RuntimeProvider,
  relativePath,
} from "../providers/runtime-provider"

export interface StartRunnerInput {
  readonly provider: RuntimeProvider
  readonly runtime: RuntimeHandle
  readonly processId: string
  readonly spec: RunnerSpec
  readonly credentialEnvironment: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly terminationGraceMs: number
}

export interface ConsumeRunnerInput {
  readonly provider: RuntimeProvider
  readonly process: ProcessHandle
  readonly runId: string
  readonly runnerSessionId: string
  readonly cursor: EventCursor
  readonly lastSequence: number
  readonly terminal?: RunnerTerminalPayload
  /** Releases control-plane observation without signalling the runner. */
  readonly signal?: AbortSignal
  readonly onFrame: (frame: RunnerFrame, cursor: Exclude<EventCursor, null>) => Promise<void>
  readonly onCursor: (cursor: Exclude<EventCursor, null>) => Promise<void>
  readonly onDiagnostic: (input: {
    cursor: Exclude<EventCursor, null>
    timestamp: string
    data: string
  }) => void
}

export interface RunnerConsumptionResult {
  readonly terminal: RunnerTerminalPayload
  readonly cursor: EventCursor
  readonly lastSequence: number
  readonly exitCode: number | null
}

/** Provider-neutral runner launch, protocol framing, replay, and cancellation. */
export class RunnerSessionController {
  async start(input: StartRunnerInput): Promise<ProcessHandle> {
    if (input.spec.runId === "" || input.spec.runnerSessionId !== input.processId) {
      throw new AppError({
        code: "RUNNER_PROTOCOL_ERROR",
        message: "Runner session identity is invalid",
      })
    }
    return input.provider.spawn(input.runtime, {
      processId: input.processId,
      argv: ["meanwhile-runner"],
      cwd: relativePath("."),
      env: input.credentialEnvironment,
      initialStdin: `${JSON.stringify(input.spec)}\n`,
      timeoutMs: input.timeoutMs,
      terminationGraceMs: input.terminationGraceMs,
    })
  }

  async consume(input: ConsumeRunnerInput): Promise<RunnerConsumptionResult> {
    throwIfAborted(input.signal)
    let cursor = input.cursor
    let lastSequence = input.lastSequence
    let buffer = ""
    let terminal: RunnerTerminalPayload | null = input.terminal ?? null

    for await (const event of input.provider.events(input.process, input.cursor, input.signal)) {
      if (event.stream === "stderr") {
        input.onDiagnostic({ cursor: event.cursor, timestamp: event.timestamp, data: event.data })
        if (buffer.length === 0) {
          cursor = event.cursor
          await input.onCursor(event.cursor)
        }
        continue
      }

      buffer += event.data
      if (new TextEncoder().encode(buffer).byteLength > MAX_RUNNER_FRAME_BYTES * 2) {
        throw protocolError("Runner output exceeded the framing buffer")
      }

      for (;;) {
        const newline = buffer.indexOf("\n")
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim() === "") continue
        if (new TextEncoder().encode(line).byteLength > MAX_RUNNER_FRAME_BYTES) {
          throw protocolError("Runner frame exceeded its byte limit")
        }
        const frame = decodeFrame(line)
        if (frame.runId !== input.runId || frame.runnerSessionId !== input.runnerSessionId) {
          throw protocolError("Runner frame identity did not match the process session")
        }
        if (frame.protocolVersion !== RUNNER_PROTOCOL_VERSION) {
          throw protocolError("Runner protocol version is unsupported")
        }
        if (frame.sequence <= lastSequence) continue
        if (terminal !== null) {
          throw protocolError("Runner emitted output after its terminal frame")
        }
        if (frame.sequence !== lastSequence + 1) {
          throw protocolError("Runner frame sequence contained a gap")
        }
        await input.onFrame(frame, event.cursor)
        lastSequence = frame.sequence
        if (frame.type === "terminal") terminal = frame.payload
      }

      if (buffer.length === 0) {
        cursor = event.cursor
        await input.onCursor(event.cursor)
      }
    }

    throwIfAborted(input.signal)
    const exit = await input.provider.wait(input.process)
    if (buffer.trim() !== "") throw protocolError("Runner output ended with an incomplete frame")
    if (terminal === null) {
      throw new AppError({
        code: "RUNNER_PROTOCOL_ERROR",
        message: "Runner exited without a terminal frame",
        retryable: false,
        details: { exitCode: exit.exitCode ?? -1 },
      })
    }
    return { terminal, cursor, lastSequence, exitCode: exit.exitCode }
  }

  async cancel(provider: RuntimeProvider, process: ProcessHandle): Promise<void> {
    const signal = (["SIGTERM", "SIGINT", "SIGKILL"] as const).find((candidate) =>
      provider.capabilities.processSignals.includes(candidate),
    )
    if (signal === undefined) {
      throw new AppError({
        code: "PROVIDER_CAPABILITY_UNAVAILABLE",
        message: "Runtime provider cannot terminate a running process",
        retryable: false,
        details: { provider: provider.name, capability: "processSignals" },
      })
    }
    await provider.signal(process, signal)
  }
}

const decodeFrame = (line: string): RunnerFrame => {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (error) {
    throw protocolError("Runner emitted invalid JSON", error)
  }
  const parsed = runnerFrameSchema.safeParse(value)
  if (!parsed.success) throw protocolError("Runner emitted an invalid protocol frame", parsed.error)
  return parsed.data
}

const protocolError = (message: string, cause?: unknown): AppError =>
  new AppError({
    code: "RUNNER_PROTOCOL_ERROR",
    message,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  })

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason
}
