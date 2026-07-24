import { describe, expect, test } from "bun:test"
import { Meanwhile, MeanwhileError } from "../../src/client"
import {
  API_DEPLOYMENT_ID,
  API_OWNER_ID,
  API_RUN_ID,
  API_SESSION_ID,
  API_TIMESTAMP,
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
        briefIds: ["f".repeat(64)],
        artifactPaths: ["dist"],
      },
      { idempotencyKey: "client-create-1" },
    )

    expect(run).toEqual(apiRun())
    expect(observed.authorization).toBe("Bearer top-secret-key")
    expect(observed.idempotencyKey).toBe("client-create-1")
    expect(observed.body).toMatchObject({
      env: {},
      secretRefs: {},
      briefIds: ["f".repeat(64)],
      timeoutMs: 3_600_000,
    })
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

  test("curates and discovers immutable artifact evidence through briefs", async () => {
    const brief = {
      id: "1".repeat(64),
      ownerId: API_OWNER_ID,
      title: "Authentication findings",
      artifactId: "f".repeat(64),
      sourceRunId: API_RUN_ID,
      sourceWorkspace: { type: "bundle" as const, artifactId: "a".repeat(64) },
      path: "findings.md",
      digest: "e".repeat(64),
      mediaType: "text/markdown; charset=utf-8",
      byteSize: 42,
      createdAt: API_TIMESTAMP,
    }
    const requests: { method: string; path: string }[] = []
    const client = new Meanwhile({
      baseUrl: "http://127.0.0.1:7331",
      apiKey: "key",
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input)
        const method = init?.method ?? (input instanceof Request ? input.method : "GET")
        requests.push({ method, path: `${url.pathname}${url.search}` })
        if (url.search) return Response.json({ items: [brief], nextCursor: null })
        return Response.json({ brief }, { status: method === "POST" ? 201 : 200 })
      },
    })

    expect(
      await client.briefs.create({
        title: brief.title,
        artifactId: brief.artifactId,
        path: brief.path,
      }),
    ).toEqual(brief)
    expect((await client.briefs.list({ limit: 10 })).items).toEqual([brief])
    expect(await client.briefs.get(brief.id)).toEqual(brief)
    expect(requests).toEqual([
      { method: "POST", path: "/briefs" },
      { method: "GET", path: "/briefs?limit=10" },
      { method: "GET", path: `/briefs/${brief.id}` },
    ])
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
      briefIds: ["f".repeat(64)],
      idempotencyKey: "turn-once",
    })
    const terminal = await client.sessions.waitForTurn(API_SESSION_ID, created.id, {
      timeoutMs: 1_000,
      pollIntervalMs: 1,
    })

    expect(requestBody).toEqual({
      prompt: "inspect the failure",
      briefIds: ["f".repeat(64)],
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

  test("creates, lists, and resolves source-anchored Project annotations", async () => {
    const projectId = "00000000-0000-4000-8000-000000000021"
    const annotationId = "00000000-0000-4000-8000-000000000022"
    const anchor = {
      sequence: 4,
      blockId: "event.4.reasoning",
      startOffset: 0,
      endOffset: 5,
      quote: "token",
      prefix: "",
      suffix: " exchange",
      contentDigest: "a".repeat(64),
    }
    const annotation = {
      id: annotationId,
      ownerId: API_OWNER_ID,
      projectId,
      task: { kind: "run" as const, id: API_RUN_ID },
      anchor,
      author: { id: API_OWNER_ID, kind: "person" as const, displayName: "Alice" },
      body: "Keep the single-exchange invariant visible.",
      createdAt: API_TIMESTAMP,
      resolvedAt: null,
      resolvedBy: null,
    }
    const requests: Array<{ method: string; path: string; body: unknown }> = []
    const client = new Meanwhile({
      baseUrl: "http://127.0.0.1:7331",
      apiKey: "key",
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input)
        const method = init?.method ?? (input instanceof Request ? input.method : "GET")
        requests.push({
          method,
          path: `${url.pathname}${url.search}`,
          body: init?.body === undefined ? null : JSON.parse(String(init.body)),
        })
        if (method === "GET") return Response.json({ items: [annotation] })
        if (url.pathname.endsWith("/resolve")) {
          return Response.json({
            annotation: { ...annotation, resolvedAt: API_TIMESTAMP, resolvedBy: annotation.author },
          })
        }
        return Response.json({ annotation }, { status: 201 })
      },
    })

    expect(
      await client.taskAnnotations.create(projectId, {
        task: annotation.task,
        anchor,
        body: annotation.body,
      }),
    ).toEqual(annotation)
    expect(await client.taskAnnotations.list(projectId, annotation.task)).toEqual([annotation])
    expect(await client.taskAnnotations.resolve(projectId, annotationId)).toMatchObject({
      resolvedAt: API_TIMESTAMP,
      resolvedBy: annotation.author,
    })
    expect(requests).toEqual([
      {
        method: "POST",
        path: `/projects/${projectId}/annotations`,
        body: { task: annotation.task, anchor, body: annotation.body },
      },
      {
        method: "GET",
        path: `/projects/${projectId}/annotations?taskKind=run&taskId=${API_RUN_ID}`,
        body: null,
      },
      {
        method: "POST",
        path: `/projects/${projectId}/annotations/${annotationId}/resolve`,
        body: null,
      },
    ])
  })

  test("drives connected onboarding through typed provider-neutral resources", async () => {
    const projectId = "00000000-0000-4000-8000-000000000021"
    const connectionId = "00000000-0000-4000-8000-000000000071"
    const grantId = "00000000-0000-4000-8000-000000000072"
    const principal = {
      id: API_OWNER_ID,
      ownerId: API_OWNER_ID,
      kind: "person" as const,
      displayName: "Alice",
      ownerRole: "admin" as const,
      createdAt: API_TIMESTAMP,
      disabledAt: null,
    }
    const project = {
      id: projectId,
      ownerId: API_OWNER_ID,
      name: "Northstar",
      slug: "northstar",
      createdAt: API_TIMESTAMP,
      archivedAt: null,
    }
    const connection = {
      id: connectionId,
      ownerId: API_OWNER_ID,
      principalId: principal.id,
      agentType: "codex",
      label: "Codex",
      capabilities: {
        oneShotRuns: true,
        durableSessions: true,
        runtimeProviders: ["local"],
      },
      createdAt: API_TIMESTAMP,
      lastVerifiedAt: API_TIMESTAMP,
      revokedAt: null,
    }
    const binding = {
      id: "00000000-0000-4000-8000-000000000073",
      projectId,
      ownerId: API_OWNER_ID,
      grantId,
      provider: "github" as const,
      accountId: "42",
      accountName: "kohoz",
      installationId: "84",
      repositoryId: "126",
      repositoryName: "meanwhile",
      repositoryFullName: "kohoz/meanwhile",
      repositoryUrl: "https://github.com/kohoz/meanwhile",
      private: true,
      boundByPrincipalId: principal.id,
      createdAt: API_TIMESTAMP,
      revokedAt: null,
    }
    const selection = {
      ownerId: API_OWNER_ID,
      principalId: principal.id,
      projectId,
      selectedAt: API_TIMESTAMP,
      hiddenAt: null,
    }
    const requests: Array<{ method: string; path: string; body: unknown }> = []
    const client = new Meanwhile({
      baseUrl: "http://127.0.0.1:7331",
      apiKey: "key",
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input)
        const method = init?.method ?? (input instanceof Request ? input.method : "GET")
        requests.push({
          method,
          path: url.pathname,
          body: init?.body === undefined ? null : JSON.parse(String(init.body)),
        })
        if (method === "GET") {
          return Response.json({
            principal,
            identities: [],
            repositoryGrants: [],
            repositoryBindings: [binding],
            agentConnections: [connection],
            availableAgents: [
              {
                agentType: connection.agentType,
                label: connection.label,
                capabilities: connection.capabilities,
              },
            ],
            projects: [{ project, access: "administer", source: "membership", selected: true }],
          })
        }
        if (url.pathname.endsWith("/selection")) return Response.json({ selection })
        if (url.pathname.endsWith("/repository")) return Response.json({ binding })
        if (url.pathname === "/onboarding/projects") {
          return Response.json({ project, binding, selection, created: false })
        }
        return Response.json({
          connection:
            method === "DELETE" ? { ...connection, revokedAt: API_TIMESTAMP } : connection,
        })
      },
    })

    expect((await client.onboarding.get()).projects).toEqual([
      { project, access: "administer", source: "membership", selected: true },
    ])
    expect(await client.onboarding.connectAgent("codex")).toEqual(connection)
    expect(await client.onboarding.selectProject(projectId, true)).toEqual(selection)
    expect(await client.onboarding.bindRepository(projectId, grantId)).toEqual(binding)
    expect(await client.onboarding.importRepository(grantId)).toEqual({
      project,
      binding,
      selection,
      created: false,
    })
    expect(await client.onboarding.revokeAgent(connectionId)).toMatchObject({
      id: connectionId,
      revokedAt: API_TIMESTAMP,
    })
    expect(requests).toEqual([
      { method: "GET", path: "/onboarding", body: null },
      { method: "POST", path: "/onboarding/agent-connections", body: { agentType: "codex" } },
      {
        method: "PUT",
        path: `/onboarding/projects/${projectId}/selection`,
        body: { selected: true },
      },
      { method: "PUT", path: `/onboarding/projects/${projectId}/repository`, body: { grantId } },
      { method: "POST", path: "/onboarding/projects", body: { grantId } },
      { method: "DELETE", path: `/onboarding/agent-connections/${connectionId}`, body: null },
    ])
  })

  test("heartbeats and releases Project presence by explicit browser client identity", async () => {
    const projectId = "00000000-0000-4000-8000-000000000021"
    const clientId = "00000000-0000-4000-8000-000000000024"
    const lease = {
      ownerId: API_OWNER_ID,
      projectId,
      clientId,
      principal: { id: API_OWNER_ID, kind: "person" as const, displayName: "Alice" },
      connectedAt: API_TIMESTAMP,
      lastSeenAt: API_TIMESTAMP,
      expiresAt: "2026-07-13T00:00:45.000Z",
    }
    const requests: Array<{ method: string; path: string }> = []
    const client = new Meanwhile({
      baseUrl: "http://127.0.0.1:7331",
      apiKey: "key",
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input)
        const method = init?.method ?? (input instanceof Request ? input.method : "GET")
        requests.push({ method, path: url.pathname })
        if (method === "DELETE") return new Response(null, { status: 204 })
        return Response.json(method === "PUT" ? { lease } : { items: [lease] })
      },
    })

    expect(await client.projects.presence(projectId)).toEqual([lease])
    expect(await client.projects.heartbeatPresence(projectId, clientId)).toEqual(lease)
    await client.projects.releasePresence(projectId, clientId)
    expect(requests).toEqual([
      { method: "GET", path: `/projects/${projectId}/presence` },
      { method: "PUT", path: `/projects/${projectId}/presence/${clientId}` },
      { method: "DELETE", path: `/projects/${projectId}/presence/${clientId}` },
    ])
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
