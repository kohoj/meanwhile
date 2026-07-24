import { afterEach, beforeEach, expect, test } from "bun:test"
import type { ApplicationHarness } from "../application-harness"
import { createApplicationHarness } from "../application-harness"

let harness: ApplicationHarness

beforeEach(async () => {
  harness = await createApplicationHarness({ runConcurrency: 1 })
})

afterEach(async () => {
  await harness.close()
})

test("a Relay carries one anchored human handoff without granting agent control", async () => {
  const alice = await json<{ principal: { id: string } }>(await harness.request("/me"))
  const bob = await json<{ principal: { id: string } }>(
    await harness.request("/principals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "person", displayName: "Bob Li" }),
    }),
  )
  const carol = await json<{ principal: { id: string } }>(
    await harness.request("/principals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "person", displayName: "Carol Wu" }),
    }),
  )
  const project = await json<{ project: { id: string } }>(
    await harness.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Project Northstar", slug: "northstar" }),
    }),
  )
  await harness.request(`/projects/${project.project.id}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ principalId: bob.principal.id, role: "member" }),
  })
  const run = await json<{ run: { id: string } }>(
    await harness.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        projectId: project.project.id,
        workspace: {
          type: "files",
          files: [{ path: "TASK.md", contentBase64: Buffer.from("relay test").toString("base64") }],
        },
        agentType: "demo",
        prompt: "Audit the migration boundary",
        artifactPaths: [],
        timeoutMs: 5_000,
      }),
    }),
  )
  const created = await json<{
    relay: { id: string; author: { id: string }; recipient: { id: string }; acknowledgedAt: null }
  }>(
    await harness.request(`/projects/${project.project.id}/relays`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: { kind: "run", id: run.run.id },
        anchorSequence: 0,
        recipientPrincipalId: bob.principal.id,
        body: "Please carry the rollback constraint into review.",
      }),
    }),
  )
  expect(created.relay).toMatchObject({
    author: { id: alice.principal.id },
    recipient: { id: bob.principal.id },
    acknowledgedAt: null,
  })

  const bobKey = await json<{ secret: string }>(
    await harness.request("/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bob browser", principalId: bob.principal.id }),
    }),
  )
  const bobBearer = (path: string, init: RequestInit = {}) =>
    harness.application.app.request(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${bobKey.secret}`,
        ...Object.fromEntries(new Headers(init.headers).entries()),
      },
    })
  const session = await json<{ secret: string }>(
    await bobBearer("/browser-sessions", { method: "POST" }),
  )
  const bobBrowser = (path: string, init: RequestInit = {}) =>
    harness.application.app.request(path, {
      ...init,
      headers: {
        Authorization: `Session ${session.secret}`,
        ...Object.fromEntries(new Headers(init.headers).entries()),
      },
    })

  const inbox = await json<{ items: Array<{ id: string }> }>(
    await bobBrowser(`/projects/${project.project.id}/relay-inbox`),
  )
  expect(inbox.items.map((relay) => relay.id)).toEqual([created.relay.id])
  expect((await bobBrowser(`/runs/${run.run.id}/cancel`, { method: "POST" })).status).toBe(404)

  const acknowledged = await json<{ relay: { acknowledgedAt: string } }>(
    await bobBrowser(`/projects/${project.project.id}/relays/${created.relay.id}/acknowledge`, {
      method: "POST",
    }),
  )
  expect(Date.parse(acknowledged.relay.acknowledgedAt)).toBeNumber()
  expect(
    (
      await json<{ items: unknown[] }>(
        await bobBrowser(`/projects/${project.project.id}/relay-inbox`),
      )
    ).items,
  ).toEqual([])

  const returned = await json<{ relay: { id: string } }>(
    await bobBrowser(`/projects/${project.project.id}/relays`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: { kind: "run", id: run.run.id },
        anchorSequence: 0,
        recipientPrincipalId: alice.principal.id,
        body: "Rollback constraint received; review is clear.",
      }),
    }),
  )
  const recent = await json<{ items: Array<{ id: string }> }>(
    await bobBrowser(`/projects/${project.project.id}/recent-relays?limit=1`),
  )
  expect(recent.items).toHaveLength(1)
  expect([created.relay.id, returned.relay.id]).toContain(recent.items[0]?.id ?? "")

  const carolKey = await json<{ secret: string }>(
    await harness.request("/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Carol", principalId: carol.principal.id }),
    }),
  )
  expect(
    (
      await harness.application.app.request(
        `/projects/${project.project.id}/relays?taskKind=run&taskId=${run.run.id}`,
        { headers: { Authorization: `Bearer ${carolKey.secret}` } },
      )
    ).status,
  ).toBe(404)
})

test("Relay anchors and recipients must be authoritative Project facts", async () => {
  const project = await json<{ project: { id: string } }>(
    await harness.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Project Anchor", slug: "anchor" }),
    }),
  )
  const bob = await json<{ principal: { id: string } }>(
    await harness.request("/principals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "person", displayName: "Bob Li" }),
    }),
  )
  await harness.request(`/projects/${project.project.id}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ principalId: bob.principal.id, role: "member" }),
  })
  const response = await harness.request(`/projects/${project.project.id}/relays`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task: { kind: "run", id: crypto.randomUUID() },
      anchorSequence: 41,
      recipientPrincipalId: bob.principal.id,
      body: "This must not materialize.",
    }),
  })
  expect(response.status).toBe(404)
})

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await response.text())
  return (await response.json()) as T
}
