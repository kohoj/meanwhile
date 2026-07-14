import { describe, expect, test } from "bun:test"
import { Meanwhile, MeanwhileError } from "../../src/client"
import {
  API_DEPLOYMENT_ID,
  API_RUN_ID,
  API_SESSION_ID,
  API_TURN_ID,
  apiDeployment,
  apiRun,
  apiRunEvent,
  apiRunLog,
  apiSession,
  apiSessionEvent,
  apiTurn,
} from "../fixtures/api"

describe("Meanwhile client contract", () => {
  test("creates a typed run with authentication, idempotency, validation, and response evidence", async () => {
    const observed: {
      authorization?: string | null
      idempotencyKey?: string | null
      body?: unknown
      evidence?: unknown
    } = {}
    const client = new Meanwhile({
      baseUrl: "http://127.0.0.1:7331",
      apiKey: "top-secret-key",
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers)
        observed.authorization = headers.get("Authorization")
        observed.idempotencyKey = headers.get("Idempotency-Key")
        observed.body = JSON.parse(String(init?.body)) as unknown
        return Response.json(
          { run: apiRun() },
          { status: 201, headers: { "X-Request-ID": "request-client-create" } },
        )
      },
      onResponse: (evidence) => {
        observed.evidence = evidence
      },
    })

    const run = await client.runs.create(
      {
        workspace: { type: "bundle", artifactId: "a".repeat(64) },
        agentType: "demo",
        prompt: "make it work",
        provider: "local",
        artifactPaths: ["dist"],
      },
      { idempotencyKey: "client-create-1" },
    )

    expect(run).toEqual(apiRun())
    expect(observed.authorization).toBe("Bearer top-secret-key")
    expect(observed.idempotencyKey).toBe("client-create-1")
    expect(observed.body).toMatchObject({ env: {}, secretRefs: {}, timeoutMs: 3_600_000 })
    expect(observed.evidence).toEqual({
      method: "POST",
      path: "runs",
      status: 201,
      requestId: "request-client-create",
    })
  })

  test("waits for terminal state without hiding intermediate reads", async () => {
    const statuses: ("queued" | "running" | "succeeded")[] = ["queued", "running", "succeeded"]
    const delays: number[] = []
    const client = new Meanwhile({
      baseUrl: "http://127.0.0.1:7331",
      apiKey: "key",
      fetch: async () => Response.json({ run: apiRun(statuses.shift() ?? "succeeded") }),
      wait: async (milliseconds) => {
        delays.push(milliseconds)
      },
    })

    const run = await client.runs.wait(API_RUN_ID, { timeoutMs: 1_000, pollIntervalMs: 7 })

    expect(run.status).toBe("succeeded")
    expect(delays).toEqual([7, 7])
  })

  test("replays a dropped log stream from the durable cursor without duplication", async () => {
    const lastEventIds: (string | null)[] = []
    const delays: number[] = []
    let connection = 0
    const client = new Meanwhile({
      baseUrl: "http://127.0.0.1:7331",
      apiKey: "key",
      fetch: async (_input, init) => {
        lastEventIds.push(new Headers(init?.headers).get("Last-Event-ID"))
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
      },
      wait: async (milliseconds) => {
        delays.push(milliseconds)
      },
    })

    const logs = []
    for await (const log of client.runs.followLogs(API_RUN_ID)) logs.push(log)

    expect(logs).toEqual([apiRunLog(1, "first"), apiRunLog(2, "second")])
    expect(lastEventIds).toEqual(["0", "1"])
    expect(delays).toEqual([100])
  })

  test("retries an unreachable follow transport from the same durable cursor", async () => {
    const lastEventIds: (string | null)[] = []
    const delays: number[] = []
    let attempts = 0
    const client = new Meanwhile({
      baseUrl: "http://127.0.0.1:7331",
      apiKey: "key",
      fetch: async (_input, init) => {
        lastEventIds.push(new Headers(init?.headers).get("Last-Event-ID"))
        attempts += 1
        if (attempts === 1) throw new TypeError("transient network failure")
        return eventStream(
          `event: log\nid: 1\ndata: ${JSON.stringify(apiRunLog(1, "recovered"))}\n\n` +
            "event: end\ndata: {}\n\n",
        )
      },
      wait: async (milliseconds) => {
        delays.push(milliseconds)
      },
    })

    expect(await Array.fromAsync(client.runs.followLogs(API_RUN_ID))).toEqual([
      apiRunLog(1, "recovered"),
    ])
    expect(lastEventIds).toEqual(["0", "0"])
    expect(delays).toEqual([1_000])
  })

  test("follows the durable run timeline through the same replay-safe transport", async () => {
    const event = apiRunEvent(1)
    const client = new Meanwhile({
      baseUrl: "http://127.0.0.1:7331",
      apiKey: "key",
      fetch: async () =>
        eventStream(
          `event: event\nid: 1\ndata: ${JSON.stringify(event)}\n\nevent: end\ndata: {}\n\n`,
        ),
    })

    expect(await Array.fromAsync(client.runs.followEvents(API_RUN_ID))).toEqual([event])
  })

  test("promotes immutable output through the deployment namespace", async () => {
    let requestBody: unknown
    let requestHeaders: Headers | undefined
    const client = new Meanwhile({
      baseUrl: "http://127.0.0.1:7331",
      apiKey: "key",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as unknown
        requestHeaders = new Headers(init?.headers)
        return Response.json({ deployment: apiDeployment() }, { status: 202 })
      },
    })

    const deployment = await client.deployments.create(
      {
        runId: API_RUN_ID,
        artifactPath: "dist",
        deployTarget: "local-static",
      },
      { idempotencyKey: "deploy-dist" },
    )

    expect(deployment.id).toBe(API_DEPLOYMENT_ID)
    expect(requestHeaders?.get("Idempotency-Key")).toBe("deploy-dist")
    expect(requestBody).toEqual({
      runId: API_RUN_ID,
      artifactPath: "dist",
      deployTarget: "local-static",
      config: {},
      secretRefs: {},
    })
  })

  test("sends a natural-language session turn and waits through the typed namespace", async () => {
    let requestBody: unknown
    const requestIdempotency: (string | null)[] = []
    const statuses = [apiTurn("queued"), apiTurn("succeeded")]
    const client = new Meanwhile({
      baseUrl: "http://127.0.0.1:7331",
      apiKey: "key",
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname
        if (init?.method === "POST") {
          requestBody = JSON.parse(String(init.body)) as unknown
          requestIdempotency.push(new Headers(init.headers).get("Idempotency-Key"))
          return Response.json({ turn: apiTurn() }, { status: 201 })
        }
        expect(path).toBe(`/sessions/${API_SESSION_ID}/turns/${API_TURN_ID}`)
        return Response.json({ turn: statuses.shift() ?? apiTurn("succeeded") })
      },
      wait: async () => {},
    })

    const created = await client.sessions.send(API_SESSION_ID, "inspect the failure", {
      conflictPolicy: "enqueue",
      timeoutMs: 60_000,
      idempotencyKey: "turn-once",
    })
    const terminal = await client.sessions.waitForTurn(API_SESSION_ID, created.id, {
      timeoutMs: 1_000,
      pollIntervalMs: 1,
    })

    expect(requestBody).toEqual({
      prompt: "inspect the failure",
      conflictPolicy: "enqueue",
      timeoutMs: 60_000,
    })
    expect(requestIdempotency).toEqual(["turn-once"])
    expect(created.id).toBe(API_TURN_ID)
    expect(terminal.status).toBe("succeeded")
  })

  test("waits for session readiness and fails fast on another terminal state", async () => {
    const statuses = [apiSession("queued"), apiSession("provisioning"), apiSession("idle")]
    const client = new Meanwhile({
      baseUrl: "http://127.0.0.1:7331",
      apiKey: "key",
      fetch: async () => Response.json({ session: statuses.shift() ?? apiSession("idle") }),
      wait: async () => {},
    })

    expect(
      await client.sessions.waitForStatus(API_SESSION_ID, "idle", {
        timeoutMs: 1_000,
        pollIntervalMs: 1,
      }),
    ).toMatchObject({ status: "idle" })

    const failed = new Meanwhile({
      baseUrl: "http://127.0.0.1:7331",
      apiKey: "key",
      fetch: async () => Response.json({ session: apiSession("continuity_lost") }),
    })
    const error = await failed.sessions
      .waitForStatus(API_SESSION_ID, "idle", { timeoutMs: 1_000 })
      .catch((value: unknown) => value)
    expect(error).toMatchObject({
      code: "SESSION_TERMINAL",
      details: { requestedStatus: "idle", status: "continuity_lost" },
    })
  })

  test("follows the durable cross-turn session stream from its cursor", async () => {
    const event = apiSessionEvent(1)
    const client = new Meanwhile({
      baseUrl: "http://127.0.0.1:7331",
      apiKey: "key",
      fetch: async () =>
        eventStream(
          `event: event\nid: 1\ndata: ${JSON.stringify(event)}\n\nevent: end\ndata: {}\n\n`,
        ),
    })

    expect(await Array.fromAsync(client.sessions.followEvents(API_SESSION_ID))).toEqual([event])
  })

  test("preserves structured failures and never includes credentials in diagnostics", async () => {
    const apiKey = "never-print-this-key"
    const client = new Meanwhile({
      baseUrl: "http://127.0.0.1:7331",
      apiKey,
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "NOT_FOUND",
              message: "Run not found",
              requestId: "request-client-error",
              details: {},
            },
          },
          { status: 404 },
        ),
    })

    const error = await client.runs.get(API_RUN_ID).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(MeanwhileError)
    expect(error).toMatchObject({
      code: "NOT_FOUND",
      message: "Run not found",
      status: 404,
      requestId: "request-client-error",
      details: {},
    })
    expect(JSON.stringify(error)).not.toContain(apiKey)
  })

  test("fails closed when a successful response violates the public contract", async () => {
    const client = new Meanwhile({
      baseUrl: "http://127.0.0.1:7331",
      apiKey: "key",
      fetch: async () => Response.json({ run: { id: API_RUN_ID, status: "queued" } }),
    })

    const error = await client.runs.get(API_RUN_ID).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(MeanwhileError)
    expect(error).toMatchObject({ code: "API_PROTOCOL_ERROR" })
  })
})

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
        controller.error(new Error("connection dropped"))
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  )
}
