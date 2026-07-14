import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createApplication, type MeanwhileApplication } from "../../src/app"
import { issueApiKey } from "../../src/auth"
import { Meanwhile } from "../../src/client"
import type { AppConfig } from "../../src/config"
import { initializeInstrumentation } from "../../src/instrumentation"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("application restart", () => {
  test("resumes the persisted local-static origin and all public history", async () => {
    const root = await mkdtemp(join(tmpdir(), "meanwhile-application-restart-"))
    roots.push(root, `${root}.lock`)
    const key = await issueApiKey()
    const config = configuration(root, key.key, await reservePort())
    let application: Awaited<ReturnType<typeof start>> | undefined
    try {
      application = await start(config, key.key)
      const run = await application.client.runs.wait(
        (
          await application.client.runs.create(
            {
              workspace: {
                type: "files",
                files: [
                  {
                    path: "site/index.html",
                    contentBase64: new TextEncoder().encode("<h1>restart proof</h1>").toBase64(),
                  },
                ],
              },
              agentType: "demo",
              provider: "local",
              prompt: "Verify restart persistence",
              artifactPaths: ["site"],
              timeoutMs: 20_000,
            },
            { idempotencyKey: "application-restart" },
          )
        ).id,
        { timeoutMs: 20_000, pollIntervalMs: 25 },
      )
      expect(run.status).toBe("succeeded")
      const deployment = await application.client.deployments.wait(
        (
          await application.client.deployments.create({
            runId: run.id,
            artifactPath: "site",
            deployTarget: "local-static",
          })
        ).id,
        { timeoutMs: 20_000, pollIntervalMs: 25 },
      )
      const url = required(deployment.url)
      expect(await (await fetch(url)).text()).toBe("<h1>restart proof</h1>")
      await application.close()

      application = await start(config, key.key)
      expect(application.application.preview.origin).toBe(new URL(url).origin)
      expect(await (await fetch(url)).text()).toBe("<h1>restart proof</h1>")
      expect((await application.client.runs.get(run.id)).status).toBe("succeeded")
      expect((await application.client.deployments.get(deployment.id)).status).toBe("succeeded")
      expect(await application.client.artifacts.list(run.id)).toHaveLength(1)
    } finally {
      await application?.close()
    }
  }, 30_000)

  test("reconnects a live ACP session and resumes its exact turn journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "meanwhile-session-restart-"))
    roots.push(root, `${root}.lock`)
    const key = await issueApiKey()
    const config = configuration(root, key.key, await reservePort())
    let application: Awaited<ReturnType<typeof start>> | undefined
    try {
      application = await start(config, key.key)
      const session = await application.client.sessions.create(
        {
          workspace: {
            type: "files",
            files: [
              {
                path: "README.md",
                contentBase64: new TextEncoder().encode("session restart proof").toBase64(),
              },
            ],
          },
          agentType: "demo",
          provider: "local",
          env: { FIXTURE_DELAY_MS: "1200" },
          idleTimeoutMs: 10_000,
        },
        { idempotencyKey: "session-restart" },
      )
      await waitForSession(application.client, session.id, "idle")
      const turn = await application.client.sessions.send(session.id, "survive restart", {
        timeoutMs: 5_000,
        idempotencyKey: "session-restart-turn",
      })
      const before = await waitForSession(application.client, session.id, "running")
      const agentSessionId = required(before.agentSessionId)
      await application.close()

      application = await start(config, key.key)
      expect(
        (
          await application.client.sessions.waitForTurn(session.id, turn.id, {
            timeoutMs: 10_000,
            pollIntervalMs: 25,
          })
        ).status,
      ).toBe("succeeded")
      const recovered = await waitForSession(application.client, session.id, "idle")
      expect(recovered.agentSessionId).toBe(agentSessionId)
      const events = (await application.client.sessions.events(session.id, { limit: 1_000 })).items
      expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1))
      expect(
        events.filter((event) => event.type === "turn.started" && event.turnId === turn.id),
      ).toHaveLength(1)

      await application.client.sessions.close(session.id)
      await waitForSession(application.client, session.id, "closed")
      await waitForSessionCleanup(application.application, session.id)
    } finally {
      await application?.close()
    }
  }, 30_000)
})

async function start(config: AppConfig, apiKey: string) {
  const instrumentation = await initializeInstrumentation({
    serviceName: "meanwhile-application-restart-test",
    serviceVersion: "test",
    logLevel: "error",
    sink: { write() {} },
  })
  let application: MeanwhileApplication | null = null
  try {
    application = await createApplication({ config, instrumentation })
    await application.start()
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: application.app.fetch })
    let closed = false
    return {
      application,
      client: new Meanwhile({ baseUrl: server.url.origin, apiKey }),
      async close() {
        if (closed) return
        closed = true
        await server.stop(true)
        await application?.close()
      },
    }
  } catch (error) {
    if (application === null) await instrumentation.shutdown().catch(() => undefined)
    else await application.close().catch(() => undefined)
    throw error
  }
}

function configuration(root: string, apiKey: string, previewPort: number): AppConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    previewHost: "127.0.0.1",
    previewPort,
    dataDir: root,
    databasePath: join(root, "meanwhile.sqlite"),
    artifactDir: join(root, "artifacts"),
    runtimeDir: join(root, "runtimes"),
    deploymentDir: join(root, "deployments"),
    apiKey,
    runnerPath: resolve("dist/meanwhile-runner"),
    agentCatalogPath: resolve("config/agents.json"),
    defaultProvider: "local",
    runConcurrency: 2,
    sessionConcurrency: 2,
    localProvider: { enabled: true, unsafeHostExecution: false },
    secretSourceCatalog: [],
    logLevel: "error",
    telemetry: { enabled: false },
  }
}

async function reservePort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 503 }),
  })
  const port = server.port
  await server.stop(true)
  if (port === undefined) throw new Error("Ephemeral port is unavailable")
  return port
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required value is missing")
  return value
}

async function waitForSession(
  client: Meanwhile,
  sessionId: string,
  status: "idle" | "running" | "closed",
) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const session = await client.sessions.get(sessionId)
    if (session.status === status) return session
    if (session.status === "failed" || session.status === "continuity_lost") {
      throw new Error(`Session reached ${session.status}: ${JSON.stringify(session.error)}`)
    }
    await Bun.sleep(25)
  }
  throw new Error(`Session did not reach ${status}`)
}

async function waitForSessionCleanup(
  application: MeanwhileApplication,
  sessionId: string,
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (application.store.getSessionRuntimeLease(sessionId)?.cleanupStatus === "succeeded") return
    await Bun.sleep(25)
  }
  throw new Error("Session runtime cleanup did not succeed")
}
