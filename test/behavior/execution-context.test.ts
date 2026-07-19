import { afterEach, beforeEach, expect, test } from "bun:test"
import {
  type ApplicationHarness,
  createApplicationHarness,
  createDemoRun,
} from "../application-harness"

let harness: ApplicationHarness

beforeEach(async () => {
  harness = await createApplicationHarness()
})

afterEach(async () => {
  await harness.close()
})

test("a run can reuse selected immutable output from an earlier run", async () => {
  const source = await createDemoRun(harness, {
    prompt: "Record that FEATURE_FLAG_X=true is required",
    files: [{ path: "README.md", content: "source workspace" }],
    env: { FIXTURE_OUTPUT_PATH: "findings.md" },
    artifactPaths: ["findings.md"],
  })
  expect((await harness.waitForRun(source.id)).status).toBe("succeeded")

  const artifactResponse = await harness.request(`/runs/${source.id}/artifacts`)
  expect(artifactResponse.status).toBe(200)
  const artifact = (
    (await artifactResponse.json()) as { items: readonly { id: string; runId: string }[] }
  ).items[0]
  expect(artifact?.runId).toBe(source.id)

  const brief = await promoteBrief(artifact?.id as string, "Feature flag requirement")

  const consumer = await createDemoRun(harness, {
    prompt: "Use the earlier finding in this checkout",
    files: [{ path: "README.md", content: "consumer workspace" }],
    artifactPaths: [],
    briefIds: [brief.id],
  })
  expect(consumer.contextArtifacts).toEqual([
    expect.objectContaining({
      artifactId: artifact?.id,
      sourceRunId: source.id,
      path: "findings.md",
      mediaType: "text/markdown; charset=utf-8",
    }),
  ])
  expect((await harness.waitForRun(consumer.id)).status).toBe("succeeded")

  const eventsResponse = await harness.request(`/runs/${consumer.id}/events?limit=1000`)
  expect(eventsResponse.status).toBe(200)
  const events = (await eventsResponse.json()) as { items: readonly unknown[] }
  const evidence = JSON.stringify(events.items)
  expect(evidence).toContain("FEATURE_FLAG_X=true")
  expect(evidence).toContain("untrusted historical observation")
  expect(evidence).toContain("Use the earlier finding in this checkout")
})

test("brief admission remains owner scoped", async () => {
  const response = await harness.request("/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspace: {
        type: "files",
        files: [
          {
            path: "README.md",
            contentBase64: Buffer.from("demo").toString("base64"),
          },
        ],
      },
      agentType: "demo",
      prompt: "Do not start",
      provider: "local",
      briefIds: ["f".repeat(64)],
      artifactPaths: [],
      timeoutMs: 5_000,
    }),
  })

  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } })
})

test("resolved context evidence participates canonically in run idempotency", async () => {
  const source = await createDemoRun(harness, {
    prompt: "Record the canonical finding",
    files: [{ path: "README.md", content: "source" }],
    env: { FIXTURE_OUTPUT_PATH: "finding.md" },
    artifactPaths: ["finding.md"],
  })
  await harness.waitForRun(source.id)
  const artifacts = (await (await harness.request(`/runs/${source.id}/artifacts`)).json()) as {
    items: readonly { id: string }[]
  }
  const artifactId = artifacts.items[0]?.id as string
  const firstPromotion = await harness.request("/briefs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Canonical finding", artifactId }),
  })
  expect(firstPromotion.status).toBe(201)
  const briefId = ((await firstPromotion.json()) as { brief: { id: string } }).brief.id
  const replayedPromotion = await harness.request("/briefs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Canonical finding", artifactId, path: "finding.md" }),
  })
  expect(replayedPromotion.status).toBe(200)
  expect(((await replayedPromotion.json()) as { brief: { id: string } }).brief.id).toBe(briefId)

  const requestBody = (briefIds: readonly string[]) => ({
    workspace: {
      type: "files" as const,
      files: [
        {
          path: "README.md",
          contentBase64: Buffer.from("consumer").toString("base64"),
        },
      ],
    },
    agentType: "demo",
    prompt: "Use the canonical finding",
    provider: "local",
    briefIds,
    artifactPaths: [],
    timeoutMs: 5_000,
  })
  const create = (body: unknown) =>
    harness.request("/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "context-evidence-idempotency",
      },
      body: JSON.stringify(body),
    })

  const first = await create(requestBody([briefId]))
  expect(first.status).toBe(201)
  const firstRun = (await first.json()) as { run: { id: string } }

  const replay = await create(requestBody([briefId]))
  expect(replay.status).toBe(200)
  expect((await replay.json()) as { run: { id: string } }).toMatchObject({
    run: { id: firstRun.run.id },
  })

  const conflict = await create(requestBody([]))
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } })
})

const promoteBrief = async (
  artifactId: string,
  title: string,
): Promise<{ readonly id: string }> => {
  const response = await harness.request("/briefs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artifactId, title }),
  })
  expect(response.status).toBe(201)
  return ((await response.json()) as { brief: { id: string } }).brief
}
