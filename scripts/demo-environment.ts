import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createApplication } from "../src/app"
import { issueApiKey } from "../src/auth"
import type { AppConfig } from "../src/config"
import { initializeInstrumentation } from "../src/instrumentation"
import { SERVICE_VERSION } from "../src/version"
import { captureWorkspace, type UploadedWorkspaceFile } from "../src/workspace"

export interface DemoEnvironment {
  readonly clientOptions: {
    readonly baseUrl: string
    readonly apiKey: string
  }
  readonly workspaceFiles: readonly UploadedWorkspaceFile[]
  close(): Promise<void>
}

export class DemoError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = "DemoError"
  }
}

export async function createDemoEnvironment(): Promise<DemoEnvironment> {
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)))
  const temporary = await mkdtemp(join(tmpdir(), "meanwhile-demo-"))
  const dataDir = join(temporary, "data")
  const workspace = join(temporary, "workspace")
  const runnerPath = join(temporary, "meanwhile-runner")
  const catalogPath = join(temporary, "agents.json")
  let server: ReturnType<typeof Bun.serve> | null = null
  let application: Awaited<ReturnType<typeof createApplication>> | null = null
  let closed = false

  const close = async () => {
    if (closed) return
    closed = true
    if (server !== null) await server.stop(true).catch(() => {})
    if (application !== null) await application.close().catch(() => {})
    await rm(temporary, { recursive: true, force: true })
  }

  try {
    await ensureRunner(repositoryRoot, runnerPath)
    await createDemoWorkspace(workspace)
    await Bun.write(
      catalogPath,
      JSON.stringify({
        version: 1,
        agents: {
          demo: {
            transport: "stdio",
            executable: "bun",
            args: ["demo-agent.ts"],
            workingDirectory: "workspace",
            capabilities: { filesystem: true, terminal: false },
            envNames: [],
            networkPolicy: { allowedHosts: [] },
            credentials: [],
          },
        },
      }),
    )

    const instrumentation = await initializeInstrumentation({
      serviceName: "meanwhile-demo",
      serviceVersion: SERVICE_VERSION,
      environment: "demo",
      sink: { write: () => {} },
    })
    const issued = await issueApiKey()
    const config: AppConfig = {
      host: "127.0.0.1",
      port: 0,
      previewHost: "127.0.0.1",
      previewPort: 0,
      dataDir,
      databasePath: join(dataDir, "meanwhile.sqlite"),
      artifactDir: join(dataDir, "artifacts"),
      runtimeDir: join(dataDir, "runtimes"),
      deploymentDir: join(dataDir, "deployments"),
      apiKey: issued.key,
      runnerPath,
      agentCatalogPath: catalogPath,
      defaultProvider: "local",
      runConcurrency: 2,
      sessionConcurrency: 2,
      localProvider: { enabled: true, unsafeHostExecution: false },
      secretSourceCatalog: [],
      logLevel: "error",
      telemetry: { enabled: false },
    }
    application = await createApplication({ config, instrumentation })
    await application.start()
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: application.app.fetch })

    return {
      clientOptions: { baseUrl: server.url.origin, apiKey: issued.key },
      workspaceFiles: await captureWorkspace(workspace),
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

async function ensureRunner(root: string, runnerPath: string): Promise<void> {
  const bun = Bun.which("bun")
  if (bun === null) throw new DemoError("BUN_NOT_FOUND", "Bun executable could not be located")
  const build = Bun.spawn(
    [bun, "build", "runner/main.ts", "--compile", "--minify", "--outfile", runnerPath],
    { cwd: root, stdout: "ignore", stderr: "ignore" },
  )
  if ((await build.exited) !== 0) {
    throw new DemoError("RUNNER_BUILD_FAILED", "The Meanwhile runner could not be built")
  }
}

async function createDemoWorkspace(workspace: string): Promise<void> {
  await mkdir(join(workspace, "site"), { recursive: true })
  await Bun.write(join(workspace, "demo-agent.ts"), demoAgentSource())
  await Bun.write(
    join(workspace, "site", "index.html"),
    "<!doctype html><meta charset=utf-8><title>Meanwhile</title><h1>Meanwhile local demo</h1>\n",
  )
}

/** A dependency-free deterministic ACP server uploaded with the demo workspace. */
function demoAgentSource(): string {
  return `
const writer = Bun.stdout.writer()
let buffer = ""
let nextSession = 1

const send = async (value) => {
  writer.write(JSON.stringify(value) + "\\n")
  await writer.flush()
}

const handle = async (message) => {
  if (message.method === "initialize") {
    await send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false }
      },
      agentInfo: { name: "meanwhile-demo-agent", title: "Meanwhile Demo Agent", version: "1" }
    } })
    return
  }
  if (message.method === "session/new") {
    await send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "demo-" + nextSession++ } })
    return
  }
  if (message.method === "session/prompt") {
    const sessionId = message.params.sessionId
    await send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Deterministic demo completed." }
      }
    } })
    await send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })
  }
}

const reader = Bun.stdin.stream().getReader()
const decoder = new TextDecoder()
for (;;) {
  const { value, done } = await reader.read()
  buffer += decoder.decode(value, { stream: !done })
  let newline = buffer.indexOf("\\n")
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line.length > 0) await handle(JSON.parse(line))
    newline = buffer.indexOf("\\n")
  }
  if (done) break
}
`
}
