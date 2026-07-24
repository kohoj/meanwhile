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

test("Project members share visibility without sharing lifecycle authority", async () => {
  const aliceMe = await json<{ principal: { id: string } }>(await harness.request("/me"))
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
  expect(
    (
      await harness.request(`/projects/${project.project.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ principalId: bob.principal.id, role: "member" }),
      })
    ).status,
  ).toBe(201)
  const bobKey = await json<{ secret: string }>(
    await harness.request("/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bob browser", principalId: bob.principal.id }),
    }),
  )
  const bobRequest = (path: string, init: RequestInit = {}) =>
    harness.application.app.request(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${bobKey.secret}`,
        ...Object.fromEntries(new Headers(init.headers).entries()),
      },
    })
  const carolKey = await json<{ secret: string }>(
    await harness.request("/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Carol browser", principalId: carol.principal.id }),
    }),
  )
  const carolRequest = (path: string, init: RequestInit = {}) =>
    harness.application.app.request(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${carolKey.secret}`,
        ...Object.fromEntries(new Headers(init.headers).entries()),
      },
    })

  const input = {
    projectId: project.project.id,
    workspace: {
      type: "files",
      files: [{ path: "TASK.md", contentBase64: Buffer.from("project test").toString("base64") }],
    },
    agentType: "demo",
    prompt: "Fix OAuth callback race after app resume",
    artifactPaths: [],
    timeoutMs: 5_000,
  }
  const aliceRun = await json<{ run: { id: string; delegatedBy: { id: string } } }>(
    await harness.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "same-browser-key" },
      body: JSON.stringify(input),
    }),
  )
  expect(aliceRun.run.delegatedBy.id).toBe(aliceMe.principal.id)

  const bobWork = await json<{ items: Array<{ id: string; delegatedBy: { id: string } }> }>(
    await bobRequest(`/projects/${project.project.id}/work`),
  )
  expect(bobWork.items).toContainEqual(
    expect.objectContaining({
      id: aliceRun.run.id,
      delegatedBy: expect.objectContaining({ id: aliceMe.principal.id }),
    }),
  )
  expect((await bobRequest(`/runs/${aliceRun.run.id}`)).status).toBe(200)
  expect((await bobRequest(`/runs/${aliceRun.run.id}/events`)).status).toBe(200)
  expect((await carolRequest(`/projects/${project.project.id}`)).status).toBe(404)
  expect((await carolRequest(`/projects/${project.project.id}/work`)).status).toBe(404)
  expect((await carolRequest(`/runs/${aliceRun.run.id}`)).status).toBe(404)
  expect(
    (
      await bobRequest(`/runs/${aliceRun.run.id}/cancel`, {
        method: "POST",
      })
    ).status,
  ).toBe(404)

  const bobRunResponse = await bobRequest("/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "same-browser-key" },
    body: JSON.stringify({ ...input, prompt: "Audit the v0.1.3 migration plan" }),
  })
  expect(bobRunResponse.status).toBe(201)
  const bobRun = await json<{ run: { id: string; delegatedBy: { id: string } } }>(bobRunResponse)
  expect(bobRun.run.id).not.toBe(aliceRun.run.id)
  expect(bobRun.run.delegatedBy.id).toBe(bob.principal.id)

  expect(
    (
      await harness.request(`/projects/${project.project.id}/members/${bob.principal.id}`, {
        method: "DELETE",
      })
    ).status,
  ).toBe(204)
  expect((await bobRequest(`/runs/${aliceRun.run.id}`)).status).toBe(404)
  expect((await bobRequest(`/projects/${project.project.id}/work`)).status).toBe(404)
})

test("membership removal reauthorizes a live Project stream before reading more events", async () => {
  const bob = await json<{ principal: { id: string } }>(
    await harness.request("/principals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "person", displayName: "Bob Li" }),
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
  const bobKey = await json<{ secret: string }>(
    await harness.request("/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bob stream", principalId: bob.principal.id }),
    }),
  )
  const bobRequest = (path: string, init: RequestInit = {}) =>
    harness.application.app.request(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${bobKey.secret}`,
        ...Object.fromEntries(new Headers(init.headers).entries()),
      },
    })
  const created = await json<{ run: { id: string } }>(
    await harness.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        projectId: project.project.id,
        workspace: {
          type: "files",
          files: [
            { path: "TASK.md", contentBase64: Buffer.from("stream test").toString("base64") },
          ],
        },
        agentType: "demo",
        prompt: "Wait while membership changes",
        env: { FIXTURE_DELAY_MS: "5000" },
        artifactPaths: [],
        timeoutMs: 10_000,
      }),
    }),
  )
  await harness.waitForRun(created.run.id, ["running"])
  const page = await json<{ nextCursor: number | null }>(
    await bobRequest(`/runs/${created.run.id}/events?limit=500`),
  )
  const streamResponse = await bobRequest(
    `/runs/${created.run.id}/events?follow=true&after=${page.nextCursor ?? 0}`,
  )
  expect(streamResponse.status).toBe(200)
  const reader = streamResponse.body?.getReader()
  if (reader === undefined) throw new Error("Project stream returned no body")
  await readUntil(reader, "event: ready")

  expect(
    (
      await harness.request(`/projects/${project.project.id}/members/${bob.principal.id}`, {
        method: "DELETE",
      })
    ).status,
  ).toBe(204)
  expect((await harness.request(`/runs/${created.run.id}/cancel`, { method: "POST" })).status).toBe(
    202,
  )
  const afterRemoval = await readUntil(reader, "event: error")
  expect(afterRemoval).not.toContain('"toStatus":"cancelled"')
  expect(afterRemoval).toContain('"code":"NOT_FOUND"')
  await reader.cancel()
})

test("browser sessions are opaque, expiring, revocable, and narrowly self-controlling", async () => {
  const me = await json<{ principal: { id: string }; projects: Array<{ id: string }> }>(
    await harness.request("/me"),
  )
  const created = await json<{ secret: string }>(
    await harness.request("/browser-sessions", { method: "POST" }),
  )
  expect(created.secret).toMatch(/^mws_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/)
  const sessionRequest = (path: string, init: RequestInit = {}) =>
    harness.application.app.request(path, {
      ...init,
      headers: {
        Authorization: `Session ${created.secret}`,
        ...Object.fromEntries(new Headers(init.headers).entries()),
      },
    })
  expect((await sessionRequest("/me")).status).toBe(200)
  const projectId = me.projects[0]?.id
  if (projectId === undefined) throw new Error("Local bootstrap Project is missing")
  const presenceClientId = crypto.randomUUID()
  expect(
    (
      await sessionRequest(`/projects/${projectId}/presence/${presenceClientId}`, {
        method: "PUT",
      })
    ).status,
  ).toBe(200)
  const presence = await json<{ items: Array<{ clientId: string }> }>(
    await sessionRequest(`/projects/${projectId}/presence`),
  )
  expect(presence.items).toContainEqual(expect.objectContaining({ clientId: presenceClientId }))
  expect(
    (
      await sessionRequest(`/projects/${projectId}/presence/${presenceClientId}`, {
        method: "DELETE",
      })
    ).status,
  ).toBe(204)
  const createdRunResponse = await sessionRequest("/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "browser-first-task" },
    body: JSON.stringify({
      workspace: {
        type: "files",
        files: [{ path: "TASK.md", contentBase64: Buffer.from("browser task").toString("base64") }],
      },
      agentType: "demo",
      prompt: "Verify the first-task journey",
      artifactPaths: [],
      timeoutMs: 5_000,
    }),
  })
  expect(createdRunResponse.status).toBe(201)
  const createdRun = await json<{ run: { id: string; delegatedBy: { id: string } } }>(
    createdRunResponse,
  )
  expect(createdRun.run.delegatedBy.id).toBe(me.principal.id)
  expect((await sessionRequest("/sessions", { method: "POST" })).status).toBe(403)
  expect(
    (await sessionRequest(`/runs/${createdRun.run.id}/cancel`, { method: "POST" })).status,
  ).toBe(202)
  expect((await sessionRequest("/browser-sessions/current", { method: "DELETE" })).status).toBe(200)
  expect((await sessionRequest("/me")).status).toBe(401)
})

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await response.text())
  return (await response.json()) as T
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
): Promise<string> {
  const decoder = new TextDecoder()
  let observed = ""
  const deadline = Date.now() + 3_000
  while (!observed.includes(needle) && Date.now() < deadline) {
    const result = await reader.read()
    if (result.done) break
    observed += decoder.decode(result.value, { stream: true })
  }
  if (!observed.includes(needle)) throw new Error(`Stream did not emit ${needle}`)
  return observed
}
