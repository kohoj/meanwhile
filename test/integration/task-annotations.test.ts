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

test("Project members share precise transcript marginalia without sharing agent control", async () => {
  const alice = await json<{ principal: { id: string } }>(await harness.request("/me"))
  const bob = await createPrincipal("person", "Bob Li")
  const carol = await createPrincipal("person", "Carol Wu")
  const outsider = await createPrincipal("person", "Outside Reader")
  const service = await createPrincipal("service", "Release Bot")
  const project = await json<{ project: { id: string } }>(
    await harness.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Project Northstar", slug: "northstar" }),
    }),
  )
  for (const principal of [bob, carol, service]) {
    await harness.request(`/projects/${project.project.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ principalId: principal.id, role: "member" }),
    })
  }
  const run = await createRun(project.project.id, "Fix the OAuth callback race after app resume")
  const bobRequest = await browserRequestFor(bob.id)
  const carolRequest = await bearerRequestFor(carol.id)
  const outsiderRequest = await bearerRequestFor(outsider.id)
  const serviceRequest = await bearerRequestFor(service.id)

  const source = "OAuth callback"
  const anchor = {
    sequence: 0,
    blockId: "ask.prompt",
    startOffset: 8,
    endOffset: 8 + source.length,
    quote: source,
    prefix: "Fix the ",
    suffix: " race after app resume",
    contentDigest: sha256("Fix the OAuth callback race after app resume"),
  }
  const created = await json<{
    annotation: {
      id: string
      author: { id: string }
      body: string
      resolvedAt: null
      resolvedBy: null
    }
  }>(
    await bobRequest(`/projects/${project.project.id}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: { kind: "run", id: run.id },
        anchor,
        body: "Keep this invariant visible during review.",
      }),
    }),
  )
  expect(created.annotation).toMatchObject({
    author: { id: bob.id },
    body: "Keep this invariant visible during review.",
    resolvedAt: null,
    resolvedBy: null,
  })

  const listed = await json<{ items: Array<{ id: string; anchor: typeof anchor }> }>(
    await harness.request(
      `/projects/${project.project.id}/annotations?taskKind=run&taskId=${run.id}`,
    ),
  )
  expect(listed.items).toEqual([
    expect.objectContaining({ id: created.annotation.id, anchor: expect.objectContaining(anchor) }),
  ])
  expect((await bobRequest(`/runs/${run.id}/cancel`, { method: "POST" })).status).toBe(404)
  expect(
    (
      await carolRequest(
        `/projects/${project.project.id}/annotations/${created.annotation.id}/resolve`,
        { method: "POST" },
      )
    ).status,
  ).toBe(403)

  const resolved = await json<{
    annotation: { resolvedAt: string; resolvedBy: { id: string } }
  }>(
    await harness.request(
      `/projects/${project.project.id}/annotations/${created.annotation.id}/resolve`,
      { method: "POST" },
    ),
  )
  expect(Date.parse(resolved.annotation.resolvedAt)).toBeNumber()
  expect(resolved.annotation.resolvedBy.id).toBe(alice.principal.id)
  const repeated = await json<{ annotation: { resolvedAt: string } }>(
    await harness.request(
      `/projects/${project.project.id}/annotations/${created.annotation.id}/resolve`,
      { method: "POST" },
    ),
  )
  expect(repeated.annotation.resolvedAt).toBe(resolved.annotation.resolvedAt)

  expect(
    (
      await outsiderRequest(
        `/projects/${project.project.id}/annotations?taskKind=run&taskId=${run.id}`,
      )
    ).status,
  ).toBe(404)
  expect(
    (
      await serviceRequest(`/projects/${project.project.id}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: { kind: "run", id: run.id },
          anchor,
          body: "Automated annotation must be rejected.",
        }),
      })
    ).status,
  ).toBe(403)

  const audits = await json<{ items: Array<{ action: string; resourceId: string }> }>(
    await harness.request(
      `/audit?resourceType=task_annotation&resourceId=${created.annotation.id}`,
    ),
  )
  expect(audits.items.map((record) => record.action)).toEqual([
    "task_annotation.resolve",
    "task_annotation.create",
  ])
})

test("Annotation anchors must name an existing task event and an exact UTF-16 range", async () => {
  const project = await json<{ project: { id: string } }>(
    await harness.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Project Anchor", slug: "anchor" }),
    }),
  )
  const run = await createRun(project.project.id, "Inspect this transcript")
  const payload = {
    task: { kind: "run", id: run.id },
    anchor: {
      sequence: 999,
      blockId: "event.999",
      startOffset: 0,
      endOffset: 7,
      quote: "missing",
      prefix: "",
      suffix: "",
      contentDigest: sha256("missing"),
    },
    body: "This anchor must not materialize.",
  }
  expect(
    (
      await harness.request(`/projects/${project.project.id}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    ).status,
  ).toBe(404)

  const invalidRange = await harness.request(`/projects/${project.project.id}/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...payload,
      anchor: { ...payload.anchor, sequence: 0, endOffset: 3 },
    }),
  })
  expect(invalidRange.status).toBe(400)
})

async function createPrincipal(kind: "person" | "service", displayName: string) {
  return (
    await json<{ principal: { id: string } }>(
      await harness.request("/principals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, displayName }),
      }),
    )
  ).principal
}

async function createRun(projectId: string, prompt: string): Promise<{ id: string }> {
  return (
    await json<{ run: { id: string } }>(
      await harness.request("/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          projectId,
          workspace: {
            type: "files",
            files: [
              { path: "TASK.md", contentBase64: Buffer.from("annotation test").toString("base64") },
            ],
          },
          agentType: "demo",
          prompt,
          artifactPaths: [],
          timeoutMs: 5_000,
        }),
      }),
    )
  ).run
}

async function bearerRequestFor(principalId: string) {
  const key = await json<{ secret: string }>(
    await harness.request("/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Key ${principalId}`, principalId }),
    }),
  )
  return (path: string, init: RequestInit = {}) =>
    harness.application.app.request(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${key.secret}`,
        ...Object.fromEntries(new Headers(init.headers).entries()),
      },
    })
}

async function browserRequestFor(principalId: string) {
  const bearer = await bearerRequestFor(principalId)
  const session = await json<{ secret: string }>(
    await bearer("/browser-sessions", { method: "POST" }),
  )
  return (path: string, init: RequestInit = {}) =>
    harness.application.app.request(path, {
      ...init,
      headers: {
        Authorization: `Session ${session.secret}`,
        ...Object.fromEntries(new Headers(init.headers).entries()),
      },
    })
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await response.text())
  return (await response.json()) as T
}
