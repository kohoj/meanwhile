import { afterEach, beforeEach, expect, test } from "bun:test"
import { normalizedMirrorEventDigest } from "../../src/connectors/external-transcript"
import type { ApplicationHarness } from "../application-harness"
import { bindTestGitHubRepository, createApplicationHarness } from "../application-harness"

let harness: ApplicationHarness

beforeEach(async () => {
  harness = await createApplicationHarness({ runConcurrency: 1 })
})

afterEach(async () => {
  await harness.close()
})

test("a scoped ConnectorDevice mirrors a continuous transcript without gaining task control", async () => {
  const project = await json<{ project: { id: string } }>(
    await harness.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Project Northstar", slug: "northstar-mirror" }),
    }),
  )
  const repository = bindTestGitHubRepository(harness, project.project.id, "northstar-mirror")
  const createdDevice = await json<{
    device: { id: string }
    secret: string
  }>(
    await harness.request("/connector-devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Alice Mac", source: "codex" }),
    }),
  )
  const connector = (path: string, init: RequestInit = {}) =>
    harness.application.app.request(path, {
      ...init,
      headers: {
        Authorization: `Connector ${createdDevice.secret}`,
        ...Object.fromEntries(new Headers(init.headers).entries()),
      },
    })
  const sourceConversationKey = sha256("codex\0local-source-session")
  const mirrorInput = {
    projectId: project.project.id,
    repositoryId: repository.repositoryId,
    sourceConversationKey,
    title: "Investigate the OAuth callback race",
    status: "active",
  }

  expect(
    (
      await connector("/connector/v1/mirrors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mirrorInput),
      })
    ).status,
  ).toBe(403)
  const granted = await json<{ grant: { id: string } }>(
    await harness.request(`/connector-devices/${createdDevice.device.id}/grants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.project.id }),
    }),
  )
  const wrongRepository = await connector("/connector/v1/mirrors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...mirrorInput, repositoryId: "another-repository" }),
  })
  expect(wrongRepository.status).toBe(409)
  expect(await wrongRepository.json()).toMatchObject({
    error: { code: "PROJECT_REPOSITORY_MISMATCH" },
  })
  const mirror = await json<{ mirror: { id: string; sourceConversationKey: string } }>(
    await connector("/connector/v1/mirrors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mirrorInput),
    }),
  )
  expect(mirror.mirror.sourceConversationKey).toBe(sourceConversationKey)
  expect(JSON.stringify(mirror)).not.toContain("local-source-session")

  const content = {
    version: 1 as const,
    source: "codex" as const,
    sourceTimestamp: "2026-07-27T08:00:00.000Z",
    type: "message" as const,
    payload: {
      role: "user" as const,
      markdown: "Find the callback race.",
      sourceMessageId: "user-1",
      truncated: false,
    },
  }
  const first = {
    ...content,
    sequence: 1,
    sourceCursor: "jsonl:v1:opaque:100:0",
    digest: normalizedMirrorEventDigest(content),
  }
  const append = () =>
    connector(`/connector/v1/mirrors/${mirror.mirror.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [first] }),
    })
  expect((await append()).status).toBe(200)
  expect((await append()).status).toBe(200)

  const gapContent = {
    version: 1 as const,
    source: "codex" as const,
    sourceTimestamp: null,
    type: "source_status" as const,
    payload: { status: "idle" as const, reason: null },
  }
  const gap = await connector(`/connector/v1/mirrors/${mirror.mirror.id}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      events: [
        {
          ...gapContent,
          sequence: 3,
          sourceCursor: "jsonl:v1:opaque:200:0",
          digest: normalizedMirrorEventDigest(gapContent),
        },
      ],
    }),
  })
  expect(gap.status).toBe(409)

  const events = await json<{ items: Array<{ sequence: number; type: string }> }>(
    await harness.request(`/mirrors/${mirror.mirror.id}/events?after=0&limit=100&follow=false`),
  )
  expect(events.items).toEqual([expect.objectContaining({ sequence: 1, type: "message" })])
  const work = await json<{
    items: Array<{
      kind: string
      id: string
      sourceObservation?: { syncStatus: string; source: string; lastSeenAt: string | null }
    }>
  }>(await harness.request(`/projects/${project.project.id}/work`))
  expect(work.items).toContainEqual(
    expect.objectContaining({
      kind: "mirror",
      id: mirror.mirror.id,
      sourceObservation: {
        source: "codex",
        syncStatus: "connected",
        lastSeenAt: expect.any(String),
      },
    }),
  )
  expect((await connector("/connector/v1/heartbeat", { method: "POST" })).status).toBe(200)
  const connectedWork = await json<{
    items: Array<{ kind: string; sourceObservation?: { syncStatus: string } }>
  }>(await harness.request(`/projects/${project.project.id}/work`))
  expect(
    connectedWork.items.find((item) => item.kind === "mirror")?.sourceObservation,
  ).toMatchObject({ syncStatus: "connected" })

  const quote = "callback race"
  const annotation = await harness.request(`/projects/${project.project.id}/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task: { kind: "mirror", id: mirror.mirror.id },
      anchor: {
        sequence: 1,
        blockId: "message.user-1",
        startOffset: 9,
        endOffset: 9 + quote.length,
        quote,
        prefix: "Find the ",
        suffix: ".",
        contentDigest: sha256("Find the callback race."),
      },
      body: "Bob should verify this assumption.",
    }),
  })
  expect(annotation.status).toBe(201)

  expect(
    (
      await harness.request(`/conversation-share-grants/${granted.grant.id}`, {
        method: "DELETE",
      })
    ).status,
  ).toBe(200)
  expect((await connector("/connector/v1/heartbeat", { method: "POST" })).status).toBe(200)
  expect((await append()).status).toBe(403)
  expect((await connector("/me")).status).toBe(401)
  const disconnected = await json<{ items: Array<{ id: string; status: string }> }>(
    await harness.request(`/projects/${project.project.id}/work`),
  )
  expect(disconnected.items.find((item) => item.id === mirror.mirror.id)?.status).toBe(
    "disconnected",
  )
})

async function json<Value>(response: Response): Promise<Value> {
  if (!response.ok) throw new Error(await response.text())
  return (await response.json()) as Value
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}
