import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  MAX_ACP_LINE_BYTES,
  MAX_RUNNER_FRAME_BYTES,
  RUNNER_PROTOCOL_VERSION,
  type RunnerFrame,
  type RunnerPermissionPolicy,
  type RunnerSpec,
  runnerFrameSchema,
} from "../../runner/protocol"

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "")
const runnerPath = `${root}/runner/main.ts`
const fixturePath = `${root}/test/fixtures/acp-agent.ts`
const children = new Set<Bun.Subprocess>()
const sessionUpdateKey = "sessionUpdate"
const rawOutputKey = "rawOutput"

interface CancelableOutputProcess {
  readonly stdout: ReadableStream<Uint8Array>
  kill(signal: NodeJS.Signals): void
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill("SIGKILL")
    }
    await child.exited.catch(() => {})
  }
  children.clear()
})

describe("meanwhile runner", () => {
  test("performs initialize, session creation, prompt, update, and terminal", async () => {
    const result = await executeRunner(spec())

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.frames.map((frame) => frame.type)).toEqual([
      "runner.started",
      "agent.initialized",
      "session.started",
      "session.update",
      "terminal",
    ])
    expect(result.frames.map((frame) => frame.sequence)).toEqual([1, 2, 3, 4, 5])

    const update = result.frames.find((frame) => frame.type === "session.update")
    expect(update?.payload.update).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "fixture response: do the work" },
    })
    expect(result.frames.at(-1)).toMatchObject({
      type: "terminal",
      payload: { outcome: "succeeded", stopReason: "end_turn" },
    })
  })

  test("allows an ACP agent to materialize declared output inside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "meanwhile-runner-output-"))
    try {
      await mkdir(join(workspace, "site"))
      const result = await executeRunner(
        spec({ environment: { FIXTURE_OUTPUT_PATH: "site/index.html" } }),
        {},
        { cwd: workspace },
      )

      expect(result.exitCode).toBe(0)
      expect(await Bun.file(join(workspace, "site/index.html")).text()).toContain(
        "fixture response: do the work",
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  for (const [stopReason, errorCode] of [
    ["max_tokens", "ACP_MAX_TOKENS"],
    ["max_turn_requests", "ACP_MAX_TURN_REQUESTS"],
    ["refusal", "ACP_REFUSAL"],
  ] as const) {
    test(`treats ACP stop reason ${stopReason} as a structured failure`, async () => {
      const result = await executeRunner(spec({ environment: { FIXTURE_STOP_REASON: stopReason } }))

      expect(result.exitCode).toBe(1)
      expect(result.frames.at(-1)).toMatchObject({
        type: "terminal",
        payload: {
          outcome: "failed",
          stopReason,
          error: { code: errorCode },
        },
      })
    })
  }

  test("preserves an ACP cancelled stop as a cancelled result", async () => {
    const result = await executeRunner(spec({ environment: { FIXTURE_STOP_REASON: "cancelled" } }))

    expect(result.exitCode).toBe(130)
    expect(result.frames.at(-1)).toMatchObject({
      type: "terminal",
      payload: { outcome: "cancelled", stopReason: "cancelled" },
    })
  })

  test("closes an ACP session when the agent advertises the capability", async () => {
    const result = await executeRunner(spec({ environment: { FIXTURE_SESSION_CLOSE: "1" } }))

    expect(result.exitCode).toBe(0)
    expect(result.frames).toContainEqual(
      expect.objectContaining({
        type: "agent.initialized",
        payload: expect.objectContaining({
          capabilities: expect.objectContaining({ session: { close: true } }),
        }),
      }),
    )
    expect(result.frames).toContainEqual(
      expect.objectContaining({
        type: "agent.stderr",
        payload: expect.objectContaining({
          chunk: expect.stringContaining("fixture session closed"),
        }),
      }),
    )
  })

  test("bounds an unresponsive ACP session close", async () => {
    const result = await executeRunner(spec({ environment: { FIXTURE_SESSION_CLOSE: "hang" } }))

    expect(result.exitCode).toBe(0)
    expect(result.frames.at(-1)).toMatchObject({
      type: "terminal",
      payload: { outcome: "succeeded", stopReason: "end_turn" },
    })
  }, 5_000)

  test("applies a non-interactive deny permission policy", async () => {
    const result = await executeRunner(spec({ environment: { FIXTURE_REQUEST_PERMISSION: "1" } }))

    expect(result.exitCode).toBe(0)
    expect(result.frames).toContainEqual(
      expect.objectContaining({
        type: "permission.resolved",
        payload: expect.objectContaining({
          toolCallId: "fixture-edit",
          decision: "denied",
          selectedOptionKind: "reject_once",
        }),
      }),
    )
    const permissionUpdate = result.frames.find(
      (frame): frame is Extract<RunnerFrame, { type: "session.update" }> =>
        frame.type === "session.update" &&
        frame.payload.update[sessionUpdateKey] === "tool_call_update",
    )
    expect(permissionUpdate?.payload.update[rawOutputKey]).toEqual({
      permission: "denied",
    })
  })

  test("allows only explicitly listed tool kinds and never grants persistently", async () => {
    const permissionPolicy: RunnerPermissionPolicy = {
      mode: "allow-once",
      toolKinds: ["edit"],
    }
    const result = await executeRunner(
      spec({
        environment: { FIXTURE_REQUEST_PERMISSION: "1" },
        permissionPolicy,
      }),
    )

    expect(result.frames).toContainEqual(
      expect.objectContaining({
        type: "permission.resolved",
        payload: expect.objectContaining({
          decision: "allowed",
          selectedOptionKind: "allow_once",
        }),
      }),
    )
  })

  test("redacts secret values across ACP updates and agent stderr", async () => {
    const secret = "runner-secret-value"
    const result = await executeRunner(spec({ secretEnvironmentNames: ["TEST_RUNNER_SECRET"] }), {
      TEST_RUNNER_SECRET: secret,
    })
    const serializedFrames = JSON.stringify(result.frames)

    expect(result.exitCode).toBe(0)
    expect(serializedFrames).not.toContain(secret)
    expect(result.stderr).not.toContain(secret)
    expect(serializedFrames).toContain("[REDACTED]")
    expect(result.frames.some((frame) => frame.type === "agent.stderr")).toBe(true)
  })

  test("normalizes the agent process timezone to UTC", async () => {
    const result = await executeRunner(
      spec({ environment: { FIXTURE_REPORT_TZ: "1", TZ: "Pacific/Honolulu" } }),
      { TZ: "Asia/Shanghai" },
    )
    expect(JSON.stringify(result.frames)).toContain("tz=UTC")
    expect(JSON.stringify(result.frames)).not.toContain("Pacific/Honolulu")
  })

  test("contains SDK diagnostics without echoing malformed agent output", async () => {
    const secret = "malformed-output-secret"
    const result = await executeRunner(
      spec({
        environment: { FIXTURE_MALFORMED_OUTPUT: "1" },
        secretEnvironmentNames: ["TEST_RUNNER_SECRET"],
      }),
      { TEST_RUNNER_SECRET: secret },
    )
    const evidence = `${JSON.stringify(result.frames)}${result.stderr}`

    expect(result.exitCode).toBe(0)
    expect(evidence).not.toContain(secret)
    expect(result.stderr).toBe("")
    expect(result.frames).toContainEqual(
      expect.objectContaining({
        type: "runner.diagnostic",
        payload: { code: "ACP_SDK_DIAGNOSTIC", severity: "error" },
      }),
    )
  })

  test("enforces a monotonic timeout budget and emits one immutable timeout result", async () => {
    const result = await executeRunner(
      spec({
        timeoutBudgetMs: 100,
        environment: { FIXTURE_DELAY_MS: "5000" },
      }),
    )
    const terminals = result.frames.filter((frame) => frame.type === "terminal")

    expect(result.exitCode).toBe(124)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      payload: { outcome: "timed_out", stopReason: "cancelled" },
    })
  }, 5_000)

  test("idempotently cancels an active ACP turn across repeated SIGTERM", async () => {
    const result = await executeRunner(
      spec({ environment: { FIXTURE_DELAY_MS: "5000" } }),
      {},
      { cancelAtSessionStart: true },
    )
    const terminals = result.frames.filter((frame) => frame.type === "terminal")

    expect(result.exitCode).toBe(130)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      payload: { outcome: "cancelled", stopReason: "cancelled" },
    })
  }, 5_000)

  test("bounds oversized ACP updates without emitting an invalid frame", async () => {
    const result = await executeRunner(spec({ environment: { FIXTURE_OVERSIZED_BYTES: "300000" } }))
    const update = result.frames.find((frame) => frame.type === "session.update")

    expect(result.exitCode).toBe(0)
    expect(update).toMatchObject({
      type: "session.update",
      payload: { truncated: true, originalBytes: expect.any(Number) },
    })
    for (const line of result.lines) {
      expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(MAX_RUNNER_FRAME_BYTES)
    }
  })

  test("rejects an oversized unterminated ACP stdout line before SDK buffering", async () => {
    const result = await executeRunner(
      spec({
        environment: { FIXTURE_OVERSIZED_LINE_BYTES: String(MAX_ACP_LINE_BYTES + 1) },
      }),
    )

    expect(result.exitCode).toBe(1)
    expect(result.frames.at(-1)).toMatchObject({
      type: "terminal",
      payload: {
        outcome: "failed",
        error: { code: "ACP_OUTPUT_LIMIT_EXCEEDED" },
      },
    })
  }, 5_000)

  test("derives the physical workspace from cwd and rejects symlink escape", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "meanwhile-runner-"))
    try {
      await symlink(tmpdir(), join(workspace, "escape"), "dir")
      const invalidSpec = spec()
      invalidSpec.agent = { ...invalidSpec.agent, workingDirectory: "escape" }
      const result = await executeRunner(invalidSpec, {}, { cwd: workspace })

      expect(result.exitCode).toBe(1)
      expect(result.frames.at(-1)).toMatchObject({
        type: "terminal",
        payload: {
          outcome: "failed",
          error: { code: "WORKSPACE_INVALID" },
        },
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

async function executeRunner(
  runnerSpec: RunnerSpec,
  environment: Record<string, string> = {},
  options: { cancelAtSessionStart?: boolean; cwd?: string } = {},
): Promise<{
  exitCode: number
  frames: RunnerFrame[]
  lines: string[]
  stderr: string
}> {
  const child = Bun.spawn({
    cmd: ["bun", runnerPath],
    cwd: options.cwd ?? root,
    env: { ...Bun.env, ...environment },
    stdin: new TextEncoder().encode(`${JSON.stringify(runnerSpec)}\n`),
    stdout: "pipe",
    stderr: "pipe",
  })
  children.add(child)

  const stdoutPromise = options.cancelAtSessionStart
    ? readAndCancelAtSessionStart(child)
    : new Response(child.stdout).text()
  const [stdout, stderr, exitCode] = await Promise.all([
    stdoutPromise,
    new Response(child.stderr).text(),
    child.exited,
  ])
  children.delete(child)
  const lines = stdout.trim().split("\n").filter(Boolean)
  return {
    exitCode,
    frames: lines.map((line) => runnerFrameSchema.parse(JSON.parse(line))),
    lines,
    stderr,
  }
}

async function readAndCancelAtSessionStart(child: CancelableOutputProcess): Promise<string> {
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let output = ""
  let pending = ""
  let cancelled = false
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      const text = decoder.decode(value, { stream: true })
      output += text
      pending += text
      for (;;) {
        const newline = pending.indexOf("\n")
        if (newline < 0) {
          break
        }
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (!cancelled && line) {
          const frame = runnerFrameSchema.parse(JSON.parse(line))
          if (frame.type === "session.started") {
            cancelled = true
            child.kill("SIGTERM")
            setTimeout(() => child.kill("SIGTERM"), 25)
          }
        }
      }
    }
    output += decoder.decode()
    return output
  } finally {
    reader.releaseLock()
  }
}

function spec(overrides: Partial<RunnerSpec> = {}): RunnerSpec {
  return {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    runId: "runner-integration",
    runnerSessionId: "runner-session-integration",
    agent: {
      executable: "bun",
      args: [fixturePath],
    },
    prompt: "do the work",
    permissionPolicy: { mode: "deny-all" },
    artifactPaths: ["dist"],
    timeoutBudgetMs: 10_000,
    environment: {},
    secretEnvironmentNames: [],
    ...overrides,
  }
}
