import * as acp from "@agentclientprotocol/sdk"

const sessions = new Map<string, AbortController>()
let nextSession = 1

const fixture = acp
  .agent({ name: "meanwhile-test-agent" })
  .onRequest(acp.methods.agent.initialize, ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentCapabilities: {
      loadSession: false,
      ...(environment("FIXTURE_SESSION_CLOSE") ? { sessionCapabilities: { close: {} } } : {}),
      promptCapabilities: {
        image: false,
        audio: false,
        embeddedContext: false,
      },
    },
    agentInfo: {
      name: "meanwhile-test-agent",
      title: "Meanwhile deterministic ACP fixture",
      version: "1",
    },
  }))
  .onRequest(acp.methods.agent.session.new, () => {
    const sessionId = `fixture-session-${nextSession++}`
    sessions.set(sessionId, new AbortController())
    return { sessionId }
  })
  .onRequest(acp.methods.agent.session.prompt, async (context) => {
    if (!sessions.has(context.params.sessionId)) {
      throw new Error("Unknown fixture session")
    }
    const session = new AbortController()
    sessions.set(context.params.sessionId, session)

    const text = context.params.prompt
      .filter((block): block is acp.TextContent & { type: "text" } => block.type === "text")
      .map((block) => block.text)
      .join("")

    if (environment("FIXTURE_REQUEST_PERMISSION") === "1") {
      const permission = await context.client.request(
        acp.methods.client.session.requestPermission,
        {
          sessionId: context.params.sessionId,
          toolCall: {
            toolCallId: "fixture-edit",
            kind: "edit",
            title: "Edit fixture output",
            status: "pending",
          },
          options: [
            {
              optionId: "allow-once",
              name: "Allow once",
              kind: "allow_once",
            },
            {
              optionId: "reject-once",
              name: "Reject",
              kind: "reject_once",
            },
          ],
        },
        { cancellationSignal: context.signal },
      )
      const allowed =
        permission.outcome.outcome === "selected" && permission.outcome.optionId === "allow-once"
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "fixture-edit",
          status: allowed ? "completed" : "failed",
          rawOutput: { permission: allowed ? "allowed" : "denied" },
        },
      })
    }

    const leak = environment("TEST_RUNNER_SECRET")
    if (environment("FIXTURE_MALFORMED_OUTPUT") === "1") {
      await writeStdout(`not-json${leak ? ` secret=${leak}` : ""}\n`)
    }
    const oversizedLineBytes = parseDelay(environment("FIXTURE_OVERSIZED_LINE_BYTES"))
    if (oversizedLineBytes > 0) {
      await writeStdout("x".repeat(oversizedLineBytes))
    }
    if (leak) {
      writeStderr(`fixture stderr secret=${leak}\n`)
    }

    const delayMs = parseDelay(environment("FIXTURE_DELAY_MS"))
    const completed = await cancellableDelay(delayMs, [context.signal, session.signal])
    if (!completed) {
      return { stopReason: "cancelled" }
    }

    const oversizedBytes = parseDelay(environment("FIXTURE_OVERSIZED_BYTES"))
    const responseText =
      oversizedBytes > 0
        ? "x".repeat(oversizedBytes)
        : `fixture response: ${text}${leak ? ` secret=${leak}` : ""}${
            environment("FIXTURE_REPORT_TZ") === "1" ? ` tz=${environment("TZ")}` : ""
          }`
    const outputPath = fixtureOutputPath(environment("FIXTURE_OUTPUT_PATH"))
    if (outputPath !== undefined) {
      await Bun.write(
        outputPath,
        `<!doctype html><meta charset="utf-8"><title>Meanwhile proof</title><pre>${escapeHtml(responseText)}</pre>`,
      )
    }
    await context.client.notify(acp.methods.client.session.update, {
      sessionId: context.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: responseText },
      },
    })

    return { stopReason: fixtureStopReason() }
  })
  .onRequest(acp.methods.agent.session.close, async ({ params }) => {
    if (environment("FIXTURE_SESSION_CLOSE") === "hang") {
      await new Promise<never>(() => {})
    }
    sessions.delete(params.sessionId)
    writeStderr(`fixture session closed: ${params.sessionId}\n`)
    return {}
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    sessions.get(params.sessionId)?.abort()
  })

const connection = fixture.connect(
  acp.ndJsonStream(fileSinkWritable(Bun.stdout.writer()), Bun.stdin.stream()),
)
await connection.closed

function fileSinkWritable(sink: Bun.FileSink): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      sink.write(chunk)
      await sink.flush()
    },
    close() {
      sink.end()
    },
    abort() {
      sink.end()
    },
  })
}

function writeStderr(message: string): void {
  const sink = Bun.stderr.writer()
  sink.write(message)
  void sink.flush()
}

async function writeStdout(message: string): Promise<void> {
  const sink = Bun.stdout.writer()
  sink.write(message)
  await sink.flush()
}

function environment(name: string): string | undefined {
  return Bun.env[name]
}

function fixtureOutputPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const segments = value.split("/")
  if (
    value.length === 0 ||
    value.length > 1_024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error("Fixture output path must be a normalized relative path")
  }
  return value
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function parseDelay(value: string | undefined): number {
  if (!value) {
    return 0
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

function fixtureStopReason(): acp.StopReason {
  const value = environment("FIXTURE_STOP_REASON")
  switch (value) {
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
    case "cancelled":
      return value
    default:
      return "end_turn"
  }
}

function cancellableDelay(milliseconds: number, signals: readonly AbortSignal[]): Promise<boolean> {
  if (signals.some((signal) => signal.aborted)) {
    return Promise.resolve(false)
  }
  if (milliseconds === 0) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (completed: boolean) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      for (const signal of signals) {
        signal.removeEventListener("abort", cancel)
      }
      resolve(completed)
    }
    const cancel = () => finish(false)
    const timer = setTimeout(() => finish(true), milliseconds)
    for (const signal of signals) {
      signal.addEventListener("abort", cancel, { once: true })
    }
  })
}
