import { afterEach, describe, expect, test } from "bun:test"
import type { AgentSession, SessionTurn } from "../../src/api/contracts"
import { issueApiKey } from "../../src/auth"
import { type ApplicationHarness, createApplicationHarness } from "../application-harness"

let harness: ApplicationHarness | null = null

afterEach(async () => {
  await harness?.close()
  harness = null
})

describe("durable interactive agent sessions", () => {
  test("preserves one ACP session across interrupt, queued follow-up, replay, and cleanup", async () => {
    harness = await createApplicationHarness()
    const created = await createSession(harness, { FIXTURE_DELAY_MS: "300" }, "session-once")
    expect(created.status).toBe("queued")

    const first = await sendTurn(harness, created.id, "first", "reject", "turn-one")
    expect(first.status).toBe("queued")
    await waitForTurn(harness, created.id, first.id, "running")

    const second = await sendTurn(harness, created.id, "second", "interrupt_and_send", "turn-two")
    const replay = await sendTurn(harness, created.id, "second", "interrupt_and_send", "turn-two")
    expect(replay.id).toBe(second.id)

    const turns = await waitForTurns(harness, created.id, ["interrupted", "succeeded"])
    expect(turns.map((turn) => turn.status)).toEqual(["interrupted", "succeeded"])
    const idle = await waitForSession(harness, created.id, "idle")
    expect(idle.agentSessionId).not.toBeNull()
    await Bun.sleep(300)
    expect(harness.application.store.getSessionRuntimeLease(created.id)).toMatchObject({
      cleanupStatus: "pending",
      cleanupAttempts: 0,
      cleanupNextAttemptAt: null,
      destroyedAt: null,
    })
    expect(() => harness?.application.store.assertQuiescent()).toThrow(
      expect.objectContaining({ code: "DATA_ROOT_BUSY" }),
    )

    const eventResponse = await harness.request(`/sessions/${created.id}/events?after=0&limit=1000`)
    expect(eventResponse.status).toBe(200)
    const events = (await eventResponse.json()) as {
      items: { type: string; sequence: number; turnId: string | null }[]
    }
    expect(events.items.map((event) => event.sequence)).toEqual(
      events.items.map((_, index) => index + 1),
    )
    expect(
      events.items.some((event) => event.type === "turn.update" && event.turnId === second.id),
    ).toBeTrue()

    const closedResponse = await harness.request(`/sessions/${created.id}/close`, {
      method: "POST",
    })
    expect(closedResponse.status).toBe(202)
    await waitForSession(harness, created.id, "closed")
    const cleanupDeadline = Date.now() + 5_000
    while (Date.now() < cleanupDeadline) {
      if (
        harness.application.store.getSessionRuntimeLease(created.id)?.cleanupStatus === "succeeded"
      )
        break
      await Bun.sleep(20)
    }
    expect(harness.application.store.getSessionRuntimeLease(created.id)?.cleanupStatus).toBe(
      "succeeded",
    )
    expect(() => harness?.application.store.assertQuiescent()).not.toThrow()

    const actions = harness.application.store
      .listAudit(created.ownerId)
      .map((record) => record.action)
    expect(actions).toContain("session.create")
    expect(actions).toContain("turn.create")
    expect(actions).toContain("session.interrupt")
    expect(actions).toContain("session.close")
    expect(actions).toContain("runtime.destroy")
  })

  test("enforces owner isolation across every session command and evidence surface", async () => {
    harness = await createApplicationHarness()
    const created = await createSession(harness, {}, "owner-a-session")
    await waitForSession(harness, created.id, "idle")
    const ownerB = crypto.randomUUID()
    const keyB = await issueApiKey()
    const createdAt = new Date().toISOString()
    harness.application.store.createOwner({ id: ownerB, name: "Owner B", createdAt })
    harness.application.store.createApiKey({
      id: crypto.randomUUID(),
      ownerId: ownerB,
      prefix: keyB.prefix,
      hash: keyB.hash,
      name: "Owner B session key",
      createdAt,
    })
    const asOwnerB = (path: string, init: RequestInit = {}) =>
      Promise.resolve(
        harness?.application.app.request(path, {
          ...init,
          headers: {
            Authorization: `Bearer ${keyB.key}`,
            ...Object.fromEntries(new Headers(init.headers).entries()),
          },
        }) as Response,
      )

    for (const [path, init] of [
      [`/sessions/${created.id}`, {}],
      [`/sessions/${created.id}/turns`, {}],
      [`/sessions/${created.id}/events`, {}],
      [`/sessions/${created.id}/interrupt`, { method: "POST" }],
      [`/sessions/${created.id}/close`, { method: "POST" }],
      [
        `/sessions/${created.id}/turns`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "probe", timeoutMs: 3_000 }),
        },
      ],
    ] satisfies readonly (readonly [string, RequestInit])[]) {
      const response = await asOwnerB(path, init)
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } })
    }
    expect(await (await asOwnerB("/sessions")).json()).toEqual({ items: [] })

    await closeSession(harness, created.id)
  })

  test("makes session and turn retries exact while keeping conflict policy explicit", async () => {
    harness = await createApplicationHarness()
    const created = await createSession(harness, { FIXTURE_DELAY_MS: "250" }, "session-exact")
    const replayed = await createSession(harness, { FIXTURE_DELAY_MS: "250" }, "session-exact")
    expect(replayed.id).toBe(created.id)
    const sessionConflict = await createSessionResponse(
      harness,
      { FIXTURE_DELAY_MS: "251" },
      "session-exact",
    )
    expect(sessionConflict.status).toBe(409)
    expect(await sessionConflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } })

    await waitForSession(harness, created.id, "idle")
    const first = await sendTurn(harness, created.id, "first", "reject", "turn-exact")
    await waitForTurn(harness, created.id, first.id, "running")
    const same = await sendTurn(harness, created.id, "first", "reject", "turn-exact")
    expect(same.id).toBe(first.id)
    const turnConflict = await sendTurnResponse(
      harness,
      created.id,
      "changed",
      "reject",
      "turn-exact",
    )
    expect(turnConflict.status).toBe(409)
    expect(await turnConflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } })
    const busy = await sendTurnResponse(harness, created.id, "rejected", "reject", "turn-reject")
    expect(busy.status).toBe(409)
    expect(await busy.json()).toMatchObject({ error: { code: "SESSION_BUSY" } })
    const queued = await sendTurn(harness, created.id, "queued", "enqueue", "turn-enqueue")
    expect(queued.status).toBe("queued")
    expect(
      (await waitForTurns(harness, created.id, ["succeeded", "succeeded"])).map((turn) => turn.id),
    ).toEqual([first.id, queued.id])

    await closeSession(harness, created.id)
  })

  test("times out one turn without destroying continuity for the next", async () => {
    harness = await createApplicationHarness()
    const created = await createSession(harness, { FIXTURE_DELAY_MS: "1500" }, "session-timeout")
    await waitForSession(harness, created.id, "idle")
    const timedOut = await sendTurn(harness, created.id, "slow", "reject", "turn-timeout", 1_000)
    await waitForTurn(harness, created.id, timedOut.id, "timed_out")
    const followUp = await sendTurn(
      harness,
      created.id,
      "continue",
      "reject",
      "turn-after-timeout",
      3_000,
    )
    expect((await waitForTurn(harness, created.id, followUp.id, "succeeded")).status).toBe(
      "succeeded",
    )
    expect(
      harness.application.store
        .listAudit(created.ownerId)
        .some((record) => record.action === "turn.timeout" && record.resourceId === timedOut.id),
    ).toBeTrue()

    await closeSession(harness, created.id)
  })

  test("redacts resolved agent credentials from the durable session journal", async () => {
    const source = "TEST_RUNNER_SECRET"
    const original = Bun.env[source]
    const secret = `session-secret-${crypto.randomUUID()}`
    Bun.env[source] = secret
    try {
      harness = await createApplicationHarness()
      const response = await createSessionResponse(harness, {}, "session-secret", {
        TEST_RUNNER_SECRET: `env://${source}`,
      })
      expect(response.status).toBe(201)
      const created = ((await response.json()) as { session: AgentSession }).session
      await waitForSession(harness, created.id, "idle")
      const turn = await sendTurn(harness, created.id, "secret proof", "reject", "secret-turn")
      await waitForTurn(harness, created.id, turn.id, "succeeded")
      const events = await (
        await harness.request(`/sessions/${created.id}/events?after=0&limit=1000`)
      ).text()
      expect(events).not.toContain(secret)
      expect(events).toContain("[REDACTED]")
      expect(harness.operationalLogs.join("\n")).not.toContain(secret)
      expect(JSON.stringify(harness.application.store.listAudit(created.ownerId))).not.toContain(
        secret,
      )
      await closeSession(harness, created.id)
    } finally {
      if (original === undefined) delete Bun.env[source]
      else Bun.env[source] = original
    }
  })
})

async function createSession(
  application: ApplicationHarness,
  env: Readonly<Record<string, string>>,
  idempotencyKey: string,
): Promise<AgentSession> {
  const response = await createSessionResponse(application, env, idempotencyKey)
  if (!response.ok) throw new Error(await response.text())
  return ((await response.json()) as { session: AgentSession }).session
}

async function createSessionResponse(
  application: ApplicationHarness,
  env: Readonly<Record<string, string>>,
  idempotencyKey: string,
  secretRefs: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return application.request("/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({
      workspace: {
        type: "files",
        files: [
          {
            path: "README.md",
            contentBase64: Buffer.from("session fixture").toString("base64"),
          },
        ],
      },
      agentType: "demo",
      env,
      secretRefs,
      provider: "local",
      idleTimeoutMs: 5_000,
    }),
  })
}

async function sendTurn(
  application: ApplicationHarness,
  sessionId: string,
  prompt: string,
  conflictPolicy: "reject" | "enqueue" | "interrupt_and_send",
  idempotencyKey: string,
  timeoutMs = 3_000,
): Promise<SessionTurn> {
  const response = await sendTurnResponse(
    application,
    sessionId,
    prompt,
    conflictPolicy,
    idempotencyKey,
    timeoutMs,
  )
  if (!response.ok) throw new Error(await response.text())
  return ((await response.json()) as { turn: SessionTurn }).turn
}

async function sendTurnResponse(
  application: ApplicationHarness,
  sessionId: string,
  prompt: string,
  conflictPolicy: "reject" | "enqueue" | "interrupt_and_send",
  idempotencyKey: string,
  timeoutMs = 3_000,
): Promise<Response> {
  return application.request(`/sessions/${sessionId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ prompt, conflictPolicy, timeoutMs }),
  })
}

async function waitForSession(
  application: ApplicationHarness,
  sessionId: string,
  status: AgentSession["status"],
): Promise<AgentSession> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const response = await application.request(`/sessions/${sessionId}`)
    const session = ((await response.json()) as { session: AgentSession }).session
    if (session.status === status) return session
    if (["failed", "continuity_lost"].includes(session.status)) {
      throw new Error(`Session reached ${session.status}: ${JSON.stringify(session.error)}`)
    }
    await Bun.sleep(20)
  }
  throw new Error(`Session did not reach ${status}`)
}

async function waitForTurn(
  application: ApplicationHarness,
  sessionId: string,
  turnId: string,
  status: SessionTurn["status"],
): Promise<SessionTurn> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const turns = await listTurns(application, sessionId)
    const turn = turns.find((candidate) => candidate.id === turnId)
    if (turn?.status === status) return turn
    await Bun.sleep(20)
  }
  throw new Error(`Turn did not reach ${status}`)
}

async function waitForTurns(
  application: ApplicationHarness,
  sessionId: string,
  statuses: readonly SessionTurn["status"][],
): Promise<readonly SessionTurn[]> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const turns = await listTurns(application, sessionId)
    if (
      turns.length === statuses.length &&
      turns.every((turn, index) => turn.status === statuses[index])
    )
      return turns
    await Bun.sleep(20)
  }
  throw new Error("Turns did not reach expected statuses")
}

async function listTurns(
  application: ApplicationHarness,
  sessionId: string,
): Promise<readonly SessionTurn[]> {
  const response = await application.request(`/sessions/${sessionId}/turns`)
  return ((await response.json()) as { items: SessionTurn[] }).items
}

async function closeSession(application: ApplicationHarness, sessionId: string): Promise<void> {
  const response = await application.request(`/sessions/${sessionId}/close`, { method: "POST" })
  if (!response.ok) throw new Error(await response.text())
  await waitForSession(application, sessionId, "closed")
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const lease = application.application.store.getSessionRuntimeLease(sessionId)
    if (lease === null || lease.cleanupStatus === "succeeded") return
    await Bun.sleep(20)
  }
  throw new Error("Session runtime cleanup did not succeed")
}
