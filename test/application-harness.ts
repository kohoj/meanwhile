import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createApplication, type MeanwhileApplication } from "../src/app"
import { issueApiKey } from "../src/auth"
import type { AppConfig } from "../src/config"
import type { Run } from "../src/domain"
import { initializeInstrumentation } from "../src/instrumentation"

export interface ApplicationHarness {
  readonly application: MeanwhileApplication
  readonly token: string
  readonly directory: string
  readonly operationalLogs: readonly string[]
  request(path: string, init?: RequestInit): Promise<Response>
  waitForRun(runId: string, statuses?: readonly Run["status"][]): Promise<Run>
  close(): Promise<void>
}

export const createApplicationHarness = async (
  options: { readonly logLevel?: AppConfig["logLevel"] } = {},
): Promise<ApplicationHarness> => {
  const directory = await mkdtemp(join(tmpdir(), "meanwhile-app-"))
  const key = await issueApiKey()
  const operationalLogs: string[] = []
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    previewHost: "127.0.0.1",
    previewPort: 0,
    dataDir: directory,
    databasePath: join(directory, "meanwhile.sqlite"),
    artifactDir: join(directory, "artifacts"),
    runtimeDir: join(directory, "runtimes"),
    deploymentDir: join(directory, "deployments"),
    apiKey: key.key,
    runnerPath: resolve("dist/meanwhile-runner"),
    agentCatalogPath: resolve("config/agents.json"),
    defaultProvider: "local",
    localProvider: { enabled: true, unsafeHostExecution: false },
    secretSourceCatalog: ["TEST_RUNNER_SECRET"],
    logLevel: options.logLevel ?? "error",
    telemetry: { enabled: false },
  }
  const instrumentation = await initializeInstrumentation({
    serviceName: "meanwhile-test",
    serviceVersion: "0.1.0",
    logLevel: config.logLevel,
    sink: { write: (line) => operationalLogs.push(line) },
  })
  const application = await createApplication({ config, instrumentation })
  await application.start()
  const request = (path: string, init: RequestInit = {}): Promise<Response> =>
    Promise.resolve(
      application.app.request(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${key.key}`,
          ...Object.fromEntries(new Headers(init.headers).entries()),
        },
      }),
    )

  return {
    application,
    token: key.key,
    directory,
    operationalLogs,
    request,
    async waitForRun(runId, statuses = ["succeeded", "failed", "cancelled", "timed_out"]) {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const response = await request(`/runs/${runId}`)
        if (response.ok) {
          const body = (await response.json()) as { run: Run }
          if (statuses.includes(body.run.status)) return body.run
        }
        await Bun.sleep(20)
      }
      throw new Error(`Run ${runId} did not reach ${statuses.join(", ")}`)
    },
    async close() {
      await application.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

export const createDemoRun = async (
  harness: ApplicationHarness,
  options: {
    prompt?: string
    timeoutMs?: number
    artifactPaths?: readonly string[]
    files?: readonly { path: string; content: string }[]
    secretRefs?: Readonly<Record<string, string>>
    env?: Readonly<Record<string, string>>
  } = {},
): Promise<Run> => {
  const files = options.files ?? [
    { path: "README.md", content: "demo" },
    { path: "dist/index.html", content: "<h1>Meanwhile</h1>" },
  ]
  const response = await harness.request("/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      workspace: {
        type: "files",
        files: files.map((file) => ({
          path: file.path,
          contentBase64: Buffer.from(file.content).toString("base64"),
        })),
      },
      agentType: "demo",
      prompt: options.prompt ?? "Complete the deterministic task",
      env: options.env ?? {},
      secretRefs: options.secretRefs ?? {},
      provider: "local",
      artifactPaths: options.artifactPaths ?? ["dist"],
      timeoutMs: options.timeoutMs ?? 5_000,
    }),
  })
  if (!response.ok) throw new Error(await response.text())
  return ((await response.json()) as { run: Run }).run
}
