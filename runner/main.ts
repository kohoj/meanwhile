import { RunnerAbort, RunnerSessionError, runAcpSession } from "./acp-session"
import {
  decodeRunnerSpec,
  encodeRunnerFrame,
  MAX_RUNNER_SPEC_BYTES,
  RUNNER_PROTOCOL_VERSION,
  type RunnerEvent,
  type RunnerFrame,
  type RunnerSpec,
  type RunnerTerminalPayload,
} from "./protocol"

const EXIT_FAILED = 1
const EXIT_INVALID_INPUT = 64
const EXIT_TIMED_OUT = 124
const EXIT_CANCELLED = 130
const MAX_TIMER_DELAY_MS = 2_147_000_000

interface FrameSink {
  write(chunk: string | Uint8Array): number | Promise<number>
  flush(): number | Promise<number>
  end(error?: Error): number | Promise<number>
}

export class RunnerFrameWriter {
  private sequence = 0
  private pending: Promise<void> = Promise.resolve()

  constructor(
    private readonly runId: string,
    private readonly runnerSessionId: string,
    private readonly sink: FrameSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  emit(event: RunnerEvent): Promise<void> {
    const write = this.pending.then(async () => {
      const frame = {
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        runId: this.runId,
        runnerSessionId: this.runnerSessionId,
        sequence: ++this.sequence,
        timestamp: this.now().toISOString(),
        ...event,
      } as RunnerFrame
      this.sink.write(`${encodeRunnerFrame(frame)}\n`)
      await this.sink.flush()
    })
    this.pending = write.catch(() => {})
    return write
  }

  async close(): Promise<void> {
    await this.pending
    await this.sink.end()
  }
}

export async function runMain(): Promise<number> {
  let spec: RunnerSpec
  try {
    const input = await readBoundedInput(Bun.stdin.stream(), MAX_RUNNER_SPEC_BYTES)
    spec = decodeRunnerSpec(new TextDecoder().decode(input).trim())
  } catch {
    await writeDiagnostic("INVALID_RUNNER_SPEC")
    return EXIT_INVALID_INPUT
  }

  const frames = new RunnerFrameWriter(spec.runId, spec.runnerSessionId, Bun.stdout.writer())
  const abortController = new AbortController()
  const removeDeadline = scheduleTimeout(spec.timeoutBudgetMs, abortController)
  const cancel = () => {
    if (!abortController.signal.aborted) {
      abortController.abort(new RunnerAbort("cancelled"))
    }
  }
  process.on("SIGTERM", cancel)
  process.on("SIGINT", cancel)

  let terminal: RunnerTerminalPayload
  try {
    await frames.emit({
      type: "runner.started",
      payload: { timeoutBudgetMs: spec.timeoutBudgetMs },
    })
    terminal = await runAcpSession(spec, {
      signal: abortController.signal,
      events: frames,
    })
  } catch (error) {
    const normalized =
      error instanceof RunnerSessionError
        ? error
        : new RunnerSessionError("RUNNER_INTERNAL_ERROR", "The runner failed internally", {
            cause: error,
          })
    terminal = {
      outcome: "failed",
      error: { code: normalized.code, message: normalized.message },
    }
  } finally {
    removeDeadline()
  }

  try {
    await frames.emit({ type: "terminal", payload: terminal })
    await frames.close()
  } finally {
    // Keep cancellation handlers installed until the protocol stream is
    // durably closed. Repeated cancellation signals must remain idempotent
    // instead of reverting to the operating system's default termination.
    // After a signal has been accepted, retain the no-op handlers through
    // process exit: the control plane may repeat a signal while observing the
    // terminal frame. Signal listeners do not keep the Bun event loop alive.
    if (!abortController.signal.aborted) {
      process.off("SIGTERM", cancel)
      process.off("SIGINT", cancel)
    }
  }
  return exitCodeFor(terminal.outcome)
}

async function readBoundedInput(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      if (!value) {
        continue
      }
      byteLength += value.byteLength
      if (byteLength > maximumBytes) {
        throw new Error("Runner specification exceeds the byte limit")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const input = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    input.set(chunk, offset)
    offset += chunk.byteLength
  }
  return input
}

function scheduleTimeout(timeoutBudgetMs: number, abortController: AbortController): () => void {
  const startedAt = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const schedule = () => {
    if (stopped || abortController.signal.aborted) {
      return
    }
    const remaining = timeoutBudgetMs - (performance.now() - startedAt)
    if (remaining <= 0) {
      abortController.abort(new RunnerAbort("timed_out"))
      return
    }
    timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_DELAY_MS))
  }
  schedule()

  return () => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
    }
  }
}

async function writeDiagnostic(code: "INVALID_RUNNER_SPEC"): Promise<void> {
  const sink = Bun.stderr.writer()
  sink.write(`${JSON.stringify({ event: "runner.input_rejected", code })}\n`)
  await sink.end()
}

function exitCodeFor(outcome: RunnerTerminalPayload["outcome"]): number {
  switch (outcome) {
    case "succeeded":
      return 0
    case "timed_out":
      return EXIT_TIMED_OUT
    case "cancelled":
      return EXIT_CANCELLED
    case "failed":
      return EXIT_FAILED
  }
}

if (import.meta.main) {
  process.exitCode = await runMain()
}
