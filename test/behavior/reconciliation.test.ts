import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createApplication, type MeanwhileApplication } from "../../src/app"
import { issueApiKey } from "../../src/auth"
import type { AppConfig } from "../../src/config"
import type { Run } from "../../src/domain"
import { initializeInstrumentation } from "../../src/instrumentation"

let directory: string | null = null
let applications: MeanwhileApplication[] = []

afterEach(async () => {
  for (const application of applications.splice(0).reverse()) {
    await application.close().catch(() => undefined)
  }
  if (directory !== null) await rm(directory, { recursive: true, force: true })
  directory = null
})

describe("control-plane restart reconciliation", () => {
  test("reconnects a live runner by persisted handle and deduplicates replay", async () => {
    directory = await mkdtemp(join(tmpdir(), "meanwhile-reconcile-"))
    const key = await issueApiKey()
    const config = applicationConfig(directory, key.key)
    const first = await application(config)
    applications.push(first)
    const request = authorized(first, key.key)

    const create = await request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace: {
          type: "files",
          files: [{ path: "README.md", contentBase64: Buffer.from("restart").toString("base64") }],
        },
        agentType: "demo",
        prompt: "survive restart",
        env: { FIXTURE_DELAY_MS: "1200" },
        secretRefs: {},
        provider: "local",
        artifactPaths: [],
        timeoutMs: 5_000,
      }),
    })
    expect(create.status).toBe(201)
    const created = ((await create.json()) as { run: Run }).run
    await waitForStatus(request, created.id, ["running"])

    await first.close()
    applications = []

    const second = await application(config)
    applications.push(second)
    const secondRequest = authorized(second, key.key)
    const terminal = await waitForStatus(secondRequest, created.id, ["succeeded", "failed"])
    expect(terminal.status).toBe("succeeded")

    const events = second.store.listRunStatusEvents(terminal.ownerId, terminal.id)
    expect(events.map((event) => event.toStatus)).toEqual([
      "queued",
      "provisioning",
      "running",
      "succeeded",
    ])
    const logs = second.store.listRunLogs(terminal.ownerId, terminal.id, 0, 1_000)
    expect(new Set(logs.map((log) => log.sequence)).size).toBe(logs.length)
    const runnerKeys = logs
      .filter((log) => log.runnerSessionId !== undefined)
      .map((log) => `${log.runnerSessionId}:${log.runnerSequence}`)
    expect(new Set(runnerKeys).size).toBe(runnerKeys.length)
  })
})

const applicationConfig = (root: string, key: string): AppConfig => ({
  host: "127.0.0.1",
  port: 0,
  previewHost: "127.0.0.1",
  previewPort: 0,
  dataDir: root,
  databasePath: join(root, "meanwhile.sqlite"),
  artifactDir: join(root, "artifacts"),
  runtimeDir: join(root, "runtimes"),
  deploymentDir: join(root, "deployments"),
  apiKey: key,
  runnerPath: resolve("dist/meanwhile-runner"),
  agentCatalogPath: resolve("config/agents.json"),
  defaultProvider: "local",
  localProvider: { enabled: true, unsafeHostExecution: false },
  secretSourceCatalog: [],
  logLevel: "error",
  telemetry: { enabled: false },
})

const application = async (config: AppConfig): Promise<MeanwhileApplication> => {
  const instrumentation = await initializeInstrumentation({
    serviceName: "meanwhile-reconciliation-test",
    serviceVersion: "0.1.0",
    sink: { write() {} },
  })
  const app = await createApplication({ config, instrumentation })
  await app.start()
  return app
}

const authorized =
  (application: MeanwhileApplication, key: string) =>
  (path: string, init: RequestInit = {}): Promise<Response> =>
    Promise.resolve(
      application.app.request(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${key}`,
          ...Object.fromEntries(new Headers(init.headers).entries()),
        },
      }),
    )

const waitForStatus = async (
  request: ReturnType<typeof authorized>,
  runId: string,
  statuses: readonly Run["status"][],
): Promise<Run> => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const response = await request(`/runs/${runId}`)
    if (response.ok) {
      const run = ((await response.json()) as { run: Run }).run
      if (statuses.includes(run.status)) return run
    }
    await Bun.sleep(20)
  }
  throw new Error(`Run did not reach ${statuses.join(",")}`)
}
