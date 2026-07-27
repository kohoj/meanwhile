import { Database } from "bun:sqlite"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { runTranscriptCompanion } from "../../src/connectors"
import type { ApplicationHarness } from "../application-harness"
import { bindTestGitHubRepository, createApplicationHarness } from "../application-harness"

let harness: ApplicationHarness

beforeEach(async () => {
  harness = await createApplicationHarness({ runConcurrency: 1 })
})

afterEach(async () => {
  await harness.close()
})

test("the local companion checkpoints a selected Codex transcript without uploading its identity", async () => {
  const project = await json<{ project: { id: string } }>(
    await harness.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Project Northstar", slug: "northstar-companion" }),
    }),
  )
  const repository = bindTestGitHubRepository(harness, project.project.id, "northstar-companion")
  const created = await json<{ device: { id: string }; secret: string }>(
    await harness.request("/connector-devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Alice Mac", source: "codex" }),
    }),
  )
  expect(
    (
      await harness.request(`/connector-devices/${created.device.id}/grants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.project.id }),
      })
    ).status,
  ).toBe(201)

  const transcriptDirectory = join(harness.directory, "local-transcript")
  await mkdir(transcriptDirectory)
  const transcriptPath = join(transcriptDirectory, "codex.jsonl")
  await copyFile(resolve("test/fixtures/external-transcripts/codex.jsonl"), transcriptPath)
  const statePath = join(harness.directory, "companion", "outbox.sqlite")
  const localSessionIdentity = "codex-session-1"
  const connectorFetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input)
    return Promise.resolve(harness.application.app.request(`${url.pathname}${url.search}`, init))
  }

  const first = await runTranscriptCompanion({
    baseUrl: "http://meanwhile.local/",
    connectorSecret: created.secret,
    projectId: project.project.id,
    source: "codex",
    transcriptPath,
    sourceConversationId: localSessionIdentity,
    statePath,
    once: true,
    fetch: connectorFetch,
    repositoryCommand: gitRepository(repository.repositoryFullName),
  })
  expect(first.acceptedSequence).toBeGreaterThan(0)
  expect(first.issues).toEqual([])
  expect((await stat(statePath)).mode & 0o777).toBe(0o600)

  const replay = await runTranscriptCompanion({
    baseUrl: "http://meanwhile.local/",
    connectorSecret: created.secret,
    projectId: project.project.id,
    source: "codex",
    transcriptPath,
    sourceConversationId: localSessionIdentity,
    statePath,
    once: true,
    fetch: connectorFetch,
    repositoryCommand: gitRepository(repository.repositoryFullName),
  })
  expect(replay.acceptedSequence).toBe(first.acceptedSequence)

  const work = await json<{ items: Array<{ id: string; kind: string }> }>(
    await harness.request(`/projects/${project.project.id}/work`),
  )
  const mirror = work.items.find((item) => item.kind === "mirror")
  expect(mirror).toBeDefined()
  const events = await json<{ items: unknown[] }>(
    await harness.request(`/mirrors/${mirror?.id}/events?after=0&limit=100&follow=false`),
  )
  expect(events.items).toHaveLength(first.acceptedSequence)
  expect(JSON.stringify({ work, events })).not.toContain(localSessionIdentity)
  const local = new Database(statePath, { readonly: true, strict: true })
  try {
    expect(
      local
        .query<{ source_conversation_id: string; transcript_path: string }, []>(`
          SELECT source_conversation_id,transcript_path FROM companion_state WHERE singleton=1
        `)
        .get(),
    ).toEqual({ source_conversation_id: localSessionIdentity, transcript_path: transcriptPath })
    expect(
      local.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM companion_outbox").get()
        ?.count,
    ).toBe(0)
  } finally {
    local.close()
  }
})

test("the local companion redacts secrets and private home paths before network or outbox publication", async () => {
  const project = await json<{ project: { id: string } }>(
    await harness.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Private Project", slug: "companion-redaction" }),
    }),
  )
  const repository = bindTestGitHubRepository(harness, project.project.id, "companion-redaction")
  const created = await json<{ device: { id: string }; secret: string }>(
    await harness.request("/connector-devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Private Mac", source: "codex" }),
    }),
  )
  await json(
    await harness.request(`/connector-devices/${created.device.id}/grants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.project.id }),
    }),
  )

  const sourceConversationId = "codex-private-session"
  const privatePath = "/Users/mac/Projects/private-repository/src/token.ts"
  const transcriptDirectory = join(harness.directory, "private-transcript")
  await mkdir(transcriptDirectory)
  const transcriptPath = join(transcriptDirectory, "codex.jsonl")
  await writeFile(
    transcriptPath,
    `${[
      {
        timestamp: "2026-07-27T01:00:00.000Z",
        type: "session_meta",
        payload: { id: sourceConversationId, cwd: privatePath },
      },
      {
        timestamp: "2026-07-27T01:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          id: "user-private",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Inspect ${privatePath}; connector=${created.secret}`,
            },
          ],
        },
      },
      {
        timestamp: "2026-07-27T01:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-private",
          output: `read ${privatePath} with ${created.secret}`,
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
    { mode: 0o600 },
  )

  const publishedBodies: unknown[] = []
  const connectorFetch = async (input: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body === "string") publishedBodies.push(JSON.parse(init.body))
    const url = input instanceof Request ? new URL(input.url) : new URL(input)
    return harness.application.app.request(`${url.pathname}${url.search}`, init)
  }
  await runTranscriptCompanion({
    baseUrl: "http://meanwhile.local/",
    connectorSecret: created.secret,
    projectId: project.project.id,
    source: "codex",
    transcriptPath,
    sourceConversationId,
    title: `Private ${privatePath} ${created.secret}`,
    statePath: join(harness.directory, "private-companion", "outbox.sqlite"),
    once: true,
    fetch: connectorFetch,
    repositoryCommand: gitRepository(repository.repositoryFullName),
  })

  const published = JSON.stringify(publishedBodies)
  expect(published).not.toContain(created.secret)
  expect(published).not.toContain("/Users/mac")
  expect(published).toContain("[redacted]")
  expect(published).toContain("[local-home]")

  const work = await json<{ items: Array<{ id: string; kind: string; title: string }> }>(
    await harness.request(`/projects/${project.project.id}/work`),
  )
  const mirror = work.items.find((item) => item.kind === "mirror")
  const events = await json<{ items: unknown[] }>(
    await harness.request(`/mirrors/${mirror?.id}/events?after=0&limit=100&follow=false`),
  )
  expect(JSON.stringify({ work, events })).not.toContain(created.secret)
  expect(JSON.stringify({ work, events })).not.toContain("/Users/mac")
})

test("the local outbox reconciles an accepted batch after its HTTP response is lost", async () => {
  const localSessionIdentity = "codex-session-1"
  const project = await json<{ project: { id: string } }>(
    await harness.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Recovery Project", slug: "companion-recovery" }),
    }),
  )
  const repository = bindTestGitHubRepository(harness, project.project.id, "companion-recovery")
  const created = await json<{ device: { id: string }; secret: string }>(
    await harness.request("/connector-devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Recovery Mac", source: "codex" }),
    }),
  )
  await json(
    await harness.request(`/connector-devices/${created.device.id}/grants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.project.id }),
    }),
  )
  const transcriptDirectory = join(harness.directory, "recovery-transcript")
  await mkdir(transcriptDirectory)
  const transcriptPath = join(transcriptDirectory, "codex.jsonl")
  await copyFile(resolve("test/fixtures/external-transcripts/codex.jsonl"), transcriptPath)
  const statePath = join(harness.directory, "recovery-companion", "outbox.sqlite")
  const connectorFetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input)
    return Promise.resolve(harness.application.app.request(`${url.pathname}${url.search}`, init))
  }
  let dropped = false
  const responseDroppingFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input)
    const response = await connectorFetch(input, init)
    if (!dropped && init?.method === "POST" && url.pathname.endsWith("/events")) {
      dropped = true
      throw new Error("simulated response loss")
    }
    return response
  }

  await expect(
    runTranscriptCompanion({
      baseUrl: "http://meanwhile.local/",
      connectorSecret: created.secret,
      projectId: project.project.id,
      source: "codex",
      transcriptPath,
      sourceConversationId: localSessionIdentity,
      statePath,
      once: true,
      fetch: responseDroppingFetch,
      repositoryCommand: gitRepository(repository.repositoryFullName),
    }),
  ).rejects.toThrow("simulated response loss")
  expect(dropped).toBeTrue()
  const afterLoss = new Database(statePath, { readonly: true, strict: true })
  try {
    expect(
      afterLoss.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM companion_outbox").get()
        ?.count,
    ).toBeGreaterThan(0)
    expect(
      afterLoss
        .query<{ acknowledged_sequence: number }, []>(`
          SELECT acknowledged_sequence FROM companion_state WHERE singleton=1
        `)
        .get()?.acknowledged_sequence,
    ).toBe(0)
  } finally {
    afterLoss.close()
  }

  const recovered = await runTranscriptCompanion({
    baseUrl: "http://meanwhile.local/",
    connectorSecret: created.secret,
    projectId: project.project.id,
    source: "codex",
    transcriptPath,
    sourceConversationId: localSessionIdentity,
    statePath,
    once: true,
    fetch: connectorFetch,
    repositoryCommand: gitRepository(repository.repositoryFullName),
  })
  const work = await json<{ items: Array<{ id: string; kind: string }> }>(
    await harness.request(`/projects/${project.project.id}/work`),
  )
  const mirror = work.items.find((item) => item.kind === "mirror")
  const events = await json<{ items: Array<{ sequence: number }> }>(
    await harness.request(`/mirrors/${mirror?.id}/events?after=0&limit=100&follow=false`),
  )
  expect(events.items).toHaveLength(recovered.acceptedSequence)
  expect(events.items.map((event) => event.sequence)).toEqual(
    Array.from({ length: recovered.acceptedSequence }, (_, index) => index + 1),
  )
  const reconciled = new Database(statePath, { readonly: true, strict: true })
  try {
    expect(
      reconciled
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM companion_outbox")
        .get()?.count,
    ).toBe(0)
    expect(
      reconciled
        .query<{ acknowledged_sequence: number }, []>(`
          SELECT acknowledged_sequence FROM companion_state WHERE singleton=1
        `)
        .get()?.acknowledged_sequence,
    ).toBe(recovered.acceptedSequence)
  } finally {
    reconciled.close()
  }
})

async function json<Value>(response: Response): Promise<Value> {
  if (!response.ok) throw new Error(await response.text())
  return (await response.json()) as Value
}

const gitRepository = (repositoryFullName: string) => async (argv: readonly string[]) =>
  argv.includes("--show-toplevel")
    ? { exitCode: 0, stdout: "/private/local/repository\n" }
    : { exitCode: 0, stdout: `git@github.com:${repositoryFullName}.git\n` }
