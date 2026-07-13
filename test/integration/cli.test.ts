import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { issueApiKey } from "../../src/auth"
import { type CliOptions, runCli } from "../../src/cli"
import { API_RUN_ID, apiRun, apiRunLog } from "../fixtures/api"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe("Meanwhile CLI", () => {
  test("uploads a bounded link-free workspace and preserves API controls", async () => {
    const root = await temporaryDirectory()
    const workspace = join(root, "workspace")
    await mkdir(join(workspace, "nested"), { recursive: true })
    await Bun.write(join(workspace, "README.md"), "hello\n")
    await Bun.write(join(workspace, "nested", "build.sh"), "#!/bin/sh\n")
    await chmod(join(workspace, "nested", "build.sh"), 0o755)

    const observed: {
      requestBody?: Record<string, unknown>
      authorization?: string | null
      idempotencyKey?: string | null
    } = {}
    let requestCount = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requestCount += 1
        observed.authorization = request.headers.get("authorization")
        observed.idempotencyKey = request.headers.get("idempotency-key")
        observed.requestBody = (await request.json()) as Record<string, unknown>
        return Response.json({ run: apiRun() }, { status: 201 })
      },
    })
    const key = await issueApiKey()
    try {
      const invocation = capture()
      const exitCode = await runCli(
        [
          "run",
          "--files",
          workspace,
          "--agent",
          "demo",
          "--artifact",
          "dist",
          "--idempotency-key",
          "cli-test",
          "--",
          "make",
          "it",
          "work",
        ],
        invocation.options({ MEANWHILE_URL: server.url.origin, MEANWHILE_API_KEY: key.key }),
      )
      expect(exitCode).toBe(0)
      expect(JSON.parse(invocation.stdout)).toEqual({ run: apiRun() })
      expect(observed.authorization).toBe(`Bearer ${key.key}`)
      expect(observed.idempotencyKey).toBe("cli-test")
      expect(observed.requestBody).toMatchObject({
        agentType: "demo",
        prompt: "make it work",
        provider: "local",
        artifactPaths: ["dist"],
        workspace: { type: "files" },
      })
      const body = observed.requestBody
      if (body === undefined) throw new Error("Expected the server to receive a request body")
      const files = (body as { workspace: { files: { path: string; mode: number }[] } }).workspace
        .files
      expect(files.map((file) => file.path)).toEqual(["nested/build.sh", "README.md"])
      expect(files.find((file) => file.path === "nested/build.sh")?.mode).toBe(0o711)

      await symlink("README.md", join(workspace, "linked.md"))
      const unsafe = capture()
      const unsafeExit = await runCli(
        ["run", "--files", workspace, "--agent", "demo", "--", "do not upload links"],
        unsafe.options({ MEANWHILE_URL: server.url.origin, MEANWHILE_API_KEY: key.key }),
      )
      expect(unsafeExit).toBe(2)
      expect(JSON.parse(unsafe.stderr)).toMatchObject({
        error: { code: "INVALID_ARGUMENT", message: expect.stringContaining("symbolic links") },
      })
      expect(requestCount).toBe(1)
    } finally {
      await server.stop(true)
    }
  })

  test("streams durable SSE logs as JSONL and ignores transport heartbeats", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(
          [
            "event: ready",
            "data: {}",
            "",
            "event: log",
            "id: 1",
            `data: ${JSON.stringify(apiRunLog(1, "first"))}`,
            "",
            "event: heartbeat",
            "data: {}",
            "",
            "event: log",
            "id: 2",
            `data: ${JSON.stringify(apiRunLog(2, "second"))}`,
            "",
            "event: end",
            "data: {}",
            "",
            "",
          ].join("\n"),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      },
    })
    const key = await issueApiKey()
    try {
      const invocation = capture()
      const exitCode = await runCli(
        ["logs", API_RUN_ID, "--follow", "--after", "0"],
        invocation.options({ MEANWHILE_URL: server.url.origin, MEANWHILE_API_KEY: key.key }),
      )
      expect(exitCode).toBe(0)
      expect(invocation.stderr).toBe("")
      expect(
        invocation.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([apiRunLog(1, "first"), apiRunLog(2, "second")])
    } finally {
      await server.stop(true)
    }
  })

  test("resumes a dropped log stream from its last durable id without duplicate output", async () => {
    const observedLastEventIds: (string | null)[] = []
    const observedRetryDelays: number[] = []
    let connection = 0
    const fetchImplementation: NonNullable<CliOptions["fetch"]> = async (_input, init) => {
      observedLastEventIds.push(new Headers(init?.headers).get("Last-Event-ID"))
      connection += 1
      if (connection === 1) {
        return droppedEventStream(
          `event: ready\nretry: 100\ndata: {}\n\nevent: log\nid: 1\ndata: ${JSON.stringify(apiRunLog(1, "first"))}\n\n`,
        )
      }
      return eventStream(
        `event: log\nid: 1\ndata: ${JSON.stringify(apiRunLog(1, "first"))}\n\n` +
          `event: log\nid: 2\ndata: ${JSON.stringify(apiRunLog(2, "second"))}\n\n` +
          "event: end\ndata: {}\n\n",
      )
    }
    const invocation = capture()
    const key = await issueApiKey()

    const exitCode = await runCli(["logs", API_RUN_ID, "--follow"], {
      ...invocation.options({ MEANWHILE_API_KEY: key.key }),
      fetch: fetchImplementation,
      wait: async (milliseconds) => {
        observedRetryDelays.push(milliseconds)
      },
    })

    expect(exitCode).toBe(0)
    expect(invocation.stderr).toBe("")
    expect(observedLastEventIds).toEqual(["0", "1"])
    expect(observedRetryDelays).toEqual([100])
    expect(
      invocation.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([apiRunLog(1, "first"), apiRunLog(2, "second")])
  })

  test("rejects and cancels an oversized unterminated SSE line", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1).fill(97))
      },
      cancel() {
        cancelled = true
      },
    })
    const invocation = capture()
    const key = await issueApiKey()
    const exitCode = await runCli(["logs", API_RUN_ID, "--follow"], {
      ...invocation.options({ MEANWHILE_API_KEY: key.key }),
      fetch: async () =>
        new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8" } }),
    })

    expect(exitCode).toBe(1)
    expect(cancelled).toBeTrue()
    expect(JSON.parse(invocation.stderr)).toMatchObject({
      error: { code: "API_PROTOCOL_ERROR", message: expect.stringContaining("too large") },
    })
  })

  test("rejects a successful follow response that is not an event stream", async () => {
    const invocation = capture()
    const key = await issueApiKey()
    const exitCode = await runCli(["logs", API_RUN_ID, "--follow"], {
      ...invocation.options({ MEANWHILE_API_KEY: key.key }),
      fetch: async () => Response.json({ items: [] }),
    })

    expect(exitCode).toBe(1)
    expect(JSON.parse(invocation.stderr)).toMatchObject({
      error: { code: "API_PROTOCOL_ERROR", message: expect.stringContaining("content type") },
    })
  })

  test("caller abort ends a follow without reporting a transport failure", async () => {
    const cancellation = new AbortController()
    let streamCancelled = false
    const invocation = capture()
    const key = await issueApiKey()
    const exitCode = await runCli(["logs", API_RUN_ID, "--follow"], {
      ...invocation.options({ MEANWHILE_API_KEY: key.key }),
      signal: cancellation.signal,
      fetch: async () => {
        queueMicrotask(() => cancellation.abort())
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              streamCancelled = true
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      },
    })

    expect(exitCode).toBe(0)
    expect(invocation.stderr).toBe("")
    expect(streamCancelled).toBeTrue()
  })

  test("preserves structured API errors without printing bearer credentials", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json(
          {
            error: {
              code: "NOT_FOUND",
              message: "Run not found",
              requestId: "request-cli-test",
              details: {},
            },
          },
          { status: 404 },
        )
      },
    })
    const key = await issueApiKey()
    try {
      const invocation = capture()
      const exitCode = await runCli(
        ["get", API_RUN_ID],
        invocation.options({ MEANWHILE_URL: server.url.origin, MEANWHILE_API_KEY: key.key }),
      )
      expect(exitCode).toBe(1)
      expect(JSON.parse(invocation.stderr)).toEqual({
        error: {
          code: "NOT_FOUND",
          message: "Run not found",
          requestId: "request-cli-test",
          details: {},
        },
      })
      expect(invocation.stderr).not.toContain(key.key)
    } finally {
      await server.stop(true)
    }
  })

  test("generates a key locally and marks it as show-once material", async () => {
    const invocation = capture()
    const exitCode = await runCli(["key", "generate"], invocation.options({}))
    expect(exitCode).toBe(0)
    const output = JSON.parse(invocation.stdout) as {
      key: string
      prefix: string
      warning: string
    }
    expect(output.key).toMatch(/^mwk_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/)
    expect(output.prefix).toBe(output.key.slice(0, 16))
    expect(output.warning).toContain("shown once")
  })

  test("doctor rejects an unregistered default provider", async () => {
    const invocation = capture()
    const exitCode = await runCli(
      ["doctor"],
      invocation.options({
        MEANWHILE_DATA_DIR: await temporaryDirectory(),
        MEANWHILE_DEFAULT_PROVIDER: "missing",
      }),
    )

    expect(exitCode).toBe(1)
    const output = JSON.parse(invocation.stdout) as {
      status: string
      checks: {
        name: string
        status: string
        message?: string
        details?: { provider?: string }
      }[]
    }
    expect(output.status).toBe("unavailable")
    expect(output.checks).toContainEqual({
      name: "default-provider",
      status: "unavailable",
      message: "The configured default provider is not registered",
      details: { provider: "missing" },
    })
  })

  test("doctor distinguishes migration incompatibility from filesystem writability", async () => {
    const dataDirectory = await temporaryDirectory()
    const database = new Database(join(dataDirectory, "meanwhile.sqlite"), { create: true })
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `)
    database.close()

    const invocation = capture()
    const exitCode = await runCli(
      ["doctor"],
      invocation.options({ MEANWHILE_DATA_DIR: dataDirectory }),
    )

    expect(exitCode).toBe(1)
    const output = JSON.parse(invocation.stdout) as {
      checks: {
        name: string
        status: string
        message?: string
        details?: { code?: string }
      }[]
    }
    expect(output.checks).toContainEqual({
      name: "persistence",
      status: "unavailable",
      message: "Database migration history is missing or invalid",
      details: { code: "MIGRATION_HISTORY_INVALID" },
    })
  })
})

const capture = () => {
  let stdout = ""
  let stderr = ""
  return {
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
    options(environment: Readonly<Record<string, string>>) {
      return {
        environment,
        stdout: (text: string) => {
          stdout += text
        },
        stderr: (text: string) => {
          stderr += text
        },
      }
    },
  }
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "meanwhile-cli-test-"))
  temporaryDirectories.push(path)
  return path
}

function eventStream(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
}

function droppedEventStream(body: string): Response {
  const bytes = new TextEncoder().encode(body)
  let emitted = false
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!emitted) {
          emitted = true
          controller.enqueue(bytes)
          return
        }
        controller.error(new Error("simulated dropped connection"))
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  )
}
