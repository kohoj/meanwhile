import { describe, expect, test } from "bun:test"
import { Meanwhile, MeanwhileError } from "../../src/client"
import { API_DEPLOYMENT_ID, API_RUN_ID, apiDeployment, apiRun, apiRunLog } from "../fixtures/api"

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

  test("promotes immutable output through the deployment namespace", async () => {
    let requestBody: unknown
    const client = new Meanwhile({
      baseUrl: "http://127.0.0.1:7331",
      apiKey: "key",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as unknown
        return Response.json({ deployment: apiDeployment() }, { status: 202 })
      },
    })

    const deployment = await client.deployments.create({
      runId: API_RUN_ID,
      artifactPath: "dist",
      deployTarget: "local-static",
    })

    expect(deployment.id).toBe(API_DEPLOYMENT_ID)
    expect(requestBody).toEqual({
      runId: API_RUN_ID,
      artifactPath: "dist",
      deployTarget: "local-static",
      config: {},
      secretRefs: {},
    })
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
