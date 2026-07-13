import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createApplication } from "../src/app"
import { issueApiKey } from "../src/auth"
import type { AppConfig } from "../src/config"
import { initializeInstrumentation } from "../src/instrumentation"
import { SERVICE_VERSION } from "../src/version"
import { captureWorkspace, type UploadedWorkspaceFile } from "../src/workspace"
import {
  CLAUDE_ADAPTER_NAME,
  CLAUDE_ADAPTER_VERSION,
  CLAUDE_SDK_NAME,
  CLAUDE_SDK_VERSION,
  ClaudeSettingsError,
  loadClaudeRunEnvironment,
  readClaudeSettingsEnvironment,
} from "./claude-settings"

const CODEX_ADAPTER_NAME = "@agentclientprotocol/codex-acp"
const CODEX_ADAPTER_VERSION = "1.1.2"
const CODEX_RUNTIME_NAME = "@openai/codex"
const CODEX_RUNTIME_VERSION = "0.144.3"
const PI_ADAPTER_NAME = "pi-acp"
const PI_ADAPTER_VERSION = "0.0.31"
const PI_RUNTIME_NAME = "@earendil-works/pi-coding-agent"
const PI_RUNTIME_VERSION = "0.80.6"
const PI_PROVIDER = "amazon-bedrock"
const PI_MODEL = "us.anthropic.claude-opus-4-8"

export type DemoAgentType = "demo" | "codex" | "claude-code" | "pi"

export interface LiveAgentProof {
  readonly type: Exclude<DemoAgentType, "demo">
  readonly adapter: string
  readonly loginVerifiedBy: string
  readonly runtimeVersion: string
  readonly environment: Readonly<Record<string, string>>
  readonly secretReferences: Readonly<Record<string, string>>
}

export interface DemoEnvironment {
  readonly clientOptions: {
    readonly baseUrl: string
    readonly apiKey: string
  }
  readonly workspaceFiles: readonly UploadedWorkspaceFile[]
  readonly agent: LiveAgentProof | null
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

export async function createDemoEnvironment(agentType: DemoAgentType): Promise<DemoEnvironment> {
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)))
  const temporary = await mkdtemp(join(tmpdir(), "meanwhile-demo-"))
  const dataDir = join(temporary, "data")
  const workspace = join(temporary, "workspace")
  const runnerPath = join(temporary, "meanwhile-runner")
  const catalogPath = join(temporary, "agents.json")
  const originalEnvironment = environmentSnapshot(["PATH", "CODEX_HOME", "CODEX_PATH"])
  let server: ReturnType<typeof Bun.serve> | null = null
  let application: Awaited<ReturnType<typeof createApplication>> | null = null
  let closed = false

  const close = async () => {
    if (closed) return
    closed = true
    if (server !== null) await server.stop(true).catch(() => {})
    if (application !== null) await application.close().catch(() => {})
    restoreEnvironment(originalEnvironment)
    await rm(temporary, { recursive: true, force: true })
  }

  try {
    const agent = await prepareLiveAgent(agentType, temporary, originalEnvironment)
    await ensureRunner(repositoryRoot, runnerPath)
    await createDemoWorkspace(workspace, agentType)
    await Bun.write(catalogPath, JSON.stringify(agentCatalog(agent)))

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
      localProvider: { enabled: true, unsafeHostExecution: false },
      secretSourceCatalog: Object.keys(agent?.secretReferences ?? {}),
      logLevel: "error",
      telemetry: { enabled: false },
    }
    application = await createApplication({ config, instrumentation })
    await application.start()
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: application.app.fetch })

    return {
      clientOptions: { baseUrl: server.url.origin, apiKey: issued.key },
      workspaceFiles: await captureWorkspace(workspace),
      agent,
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

async function createDemoWorkspace(workspace: string, agentType: DemoAgentType): Promise<void> {
  await mkdir(join(workspace, "site"), { recursive: true })
  if (agentType !== "demo") {
    await Bun.write(
      join(workspace, "README.md"),
      `This workspace is an isolated Meanwhile local-provider proof for ${agentType} over ACP.\n`,
    )
    await Bun.write(join(workspace, "site", "placeholder.txt"), "Replace with index.html.\n")
    return
  }
  await Bun.write(join(workspace, "demo-agent.ts"), demoAgentSource())
  await Bun.write(
    join(workspace, "site", "index.html"),
    "<!doctype html><meta charset=utf-8><title>Meanwhile</title><h1>Meanwhile local demo</h1>\n",
  )
}

function agentCatalog(agent: LiveAgentProof | null): object {
  if (agent !== null) {
    return {
      version: 1,
      agents: {
        [agent.type]: {
          transport: "stdio",
          executable: liveAgentExecutable(agent.type),
          args: [],
          workingDirectory: "workspace",
          capabilities: { filesystem: true, terminal: true },
          envNames: Object.keys(agent.environment),
          secretEnvNames: Object.keys(agent.secretReferences),
        },
      },
    }
  }
  return {
    version: 1,
    agents: {
      demo: {
        transport: "stdio",
        executable: "bun",
        args: ["demo-agent.ts"],
        workingDirectory: "workspace",
        capabilities: { filesystem: true, terminal: false },
        envNames: [],
        secretEnvNames: [],
      },
    },
  }
}

async function prepareLiveAgent(
  agentType: DemoAgentType,
  temporary: string,
  originalEnvironment: Map<string, string | undefined>,
): Promise<LiveAgentProof | null> {
  switch (agentType) {
    case "demo":
      return null
    case "codex":
      return prepareCodexProof(join(temporary, "codex-tools"))
    case "claude-code":
      return prepareClaudeProof(join(temporary, "claude-tools"), originalEnvironment)
    case "pi":
      return preparePiProof(join(temporary, "pi-tools"), originalEnvironment)
  }
}

function liveAgentExecutable(type: LiveAgentProof["type"]): string {
  switch (type) {
    case "codex":
      return "codex-acp"
    case "claude-code":
      return "claude-agent-acp"
    case "pi":
      return "pi-acp"
  }
}

async function prepareCodexProof(toolsDirectory: string): Promise<LiveAgentProof> {
  const loginCodexPath = Bun.which("codex")
  const home = Bun.env["HOME"]
  const codexHome = Bun.env["CODEX_HOME"] ?? (home === undefined ? null : join(home, ".codex"))
  if (loginCodexPath === null) {
    throw new DemoError("CODEX_NOT_FOUND", "Codex must be installed for the local Codex proof")
  }
  if (codexHome === null) {
    throw new DemoError("CODEX_HOME_MISSING", "CODEX_HOME could not be resolved")
  }

  const login = Bun.spawn([loginCodexPath, "login", "status"], {
    env: { ...Bun.env, CODEX_HOME: codexHome },
    stdout: "ignore",
    stderr: "ignore",
  })
  if ((await login.exited) !== 0) {
    throw new DemoError(
      "CODEX_AUTHENTICATION_REQUIRED",
      "Run 'codex login' before the local Codex proof",
    )
  }

  const loginVersion = await executableVersion(loginCodexPath, "CODEX_VERSION_UNAVAILABLE")
  await mkdir(toolsDirectory, { recursive: true })
  await Bun.write(
    join(toolsDirectory, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: {
        [CODEX_ADAPTER_NAME]: CODEX_ADAPTER_VERSION,
        [CODEX_RUNTIME_NAME]: CODEX_RUNTIME_VERSION,
      },
    }),
  )
  const bun = Bun.which("bun")
  if (bun === null) throw new DemoError("BUN_NOT_FOUND", "Bun executable could not be located")
  const install = Bun.spawn([bun, "install", "--no-progress"], {
    cwd: toolsDirectory,
    stdout: "ignore",
    stderr: "ignore",
  })
  if ((await install.exited) !== 0) {
    throw new DemoError("CODEX_ADAPTER_INSTALL_FAILED", "The pinned Codex ACP toolchain failed")
  }

  const binaryDirectory = join(toolsDirectory, "node_modules", ".bin")
  const adapterPath = join(binaryDirectory, "codex-acp")
  const runtimeCodexPath = join(binaryDirectory, "codex")
  const adapterVersion = await executableVersion(adapterPath, "CODEX_ADAPTER_UNAVAILABLE")
  if (!adapterVersion.includes(CODEX_ADAPTER_VERSION)) {
    throw new DemoError(
      "CODEX_ADAPTER_VERSION_MISMATCH",
      "The installed Codex ACP adapter version is not the pinned version",
    )
  }
  const runtimeVersion = await executableVersion(runtimeCodexPath, "CODEX_VERSION_UNAVAILABLE")
  if (!runtimeVersion.includes(CODEX_RUNTIME_VERSION)) {
    throw new DemoError(
      "CODEX_VERSION_MISMATCH",
      "The Codex runtime version is not the pinned version",
    )
  }

  Bun.env["PATH"] = `${binaryDirectory}${delimiter}${Bun.env["PATH"] ?? ""}`
  Bun.env["CODEX_HOME"] = codexHome
  Bun.env["CODEX_PATH"] = runtimeCodexPath
  return {
    type: "codex",
    adapter: `${CODEX_ADAPTER_NAME}@${CODEX_ADAPTER_VERSION}`,
    loginVerifiedBy: loginVersion,
    runtimeVersion,
    environment: { INITIAL_AGENT_MODE: "agent", NO_BROWSER: "1" },
    secretReferences: { CODEX_HOME: "env://CODEX_HOME", CODEX_PATH: "env://CODEX_PATH" },
  }
}

async function prepareClaudeProof(
  toolsDirectory: string,
  originalEnvironment: Map<string, string | undefined>,
): Promise<LiveAgentProof> {
  const claudePath = Bun.which("claude")
  if (claudePath === null) {
    throw new DemoError("CLAUDE_NOT_FOUND", "Claude Code must be installed for the local proof")
  }

  const configured = await loadClaudeEnvironmentForDemo()
  for (const [name, value] of Object.entries(configured.secretValues)) {
    setTemporaryEnvironment(originalEnvironment, name, value)
  }

  await mkdir(toolsDirectory, { recursive: true })
  await Bun.write(
    join(toolsDirectory, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { [CLAUDE_ADAPTER_NAME]: CLAUDE_ADAPTER_VERSION },
    }),
  )
  const bun = Bun.which("bun")
  if (bun === null) throw new DemoError("BUN_NOT_FOUND", "Bun executable could not be located")
  const install = Bun.spawn([bun, "install", "--no-progress"], {
    cwd: toolsDirectory,
    stdout: "ignore",
    stderr: "ignore",
  })
  if ((await install.exited) !== 0) {
    throw new DemoError("CLAUDE_ADAPTER_INSTALL_FAILED", "The pinned Claude ACP adapter failed")
  }

  await assertPackageVersion(toolsDirectory, CLAUDE_ADAPTER_NAME, CLAUDE_ADAPTER_VERSION)
  await assertPackageVersion(toolsDirectory, CLAUDE_SDK_NAME, CLAUDE_SDK_VERSION)
  const binaryDirectory = join(toolsDirectory, "node_modules", ".bin")
  if (Bun.which("claude-agent-acp", { PATH: binaryDirectory }) === null) {
    throw new DemoError("CLAUDE_ADAPTER_UNAVAILABLE", "The Claude ACP executable is unavailable")
  }
  Bun.env["PATH"] = `${binaryDirectory}${delimiter}${Bun.env["PATH"] ?? ""}`

  return {
    type: "claude-code",
    adapter: `${CLAUDE_ADAPTER_NAME}@${CLAUDE_ADAPTER_VERSION}`,
    loginVerifiedBy: `${await executableVersion(claudePath, "CLAUDE_VERSION_UNAVAILABLE")} via ~/.claude/settings.json`,
    runtimeVersion: `${CLAUDE_SDK_NAME}@${CLAUDE_SDK_VERSION}`,
    environment: configured.environment,
    secretReferences: configured.secretReferences,
  }
}

async function preparePiProof(
  toolsDirectory: string,
  originalEnvironment: Map<string, string | undefined>,
): Promise<LiveAgentProof> {
  const authentication = await resolvePiBedrockAuthentication()

  await mkdir(toolsDirectory, { recursive: true })
  await Bun.write(
    join(toolsDirectory, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: {
        [PI_ADAPTER_NAME]: PI_ADAPTER_VERSION,
        [PI_RUNTIME_NAME]: PI_RUNTIME_VERSION,
      },
    }),
  )
  const bun = Bun.which("bun")
  if (bun === null) throw new DemoError("BUN_NOT_FOUND", "Bun executable could not be located")
  const install = Bun.spawn([bun, "install", "--no-progress"], {
    cwd: toolsDirectory,
    stdout: "ignore",
    stderr: "ignore",
  })
  if ((await install.exited) !== 0) {
    throw new DemoError("PI_ADAPTER_INSTALL_FAILED", "The pinned Pi ACP toolchain failed")
  }

  await assertPackageVersion(toolsDirectory, PI_ADAPTER_NAME, PI_ADAPTER_VERSION)
  await assertPackageVersion(toolsDirectory, PI_RUNTIME_NAME, PI_RUNTIME_VERSION)
  const binaryDirectory = join(toolsDirectory, "node_modules", ".bin")
  const adapterPath = Bun.which("pi-acp", { PATH: binaryDirectory })
  const piPath = Bun.which("pi", { PATH: binaryDirectory })
  if (adapterPath === null || piPath === null) {
    throw new DemoError("PI_ADAPTER_UNAVAILABLE", "The Pi ACP toolchain is unavailable")
  }

  const piConfigDirectory = join(toolsDirectory, "config")
  await mkdir(piConfigDirectory, { recursive: true })
  await Bun.write(
    join(piConfigDirectory, "settings.json"),
    JSON.stringify({ defaultProvider: PI_PROVIDER, defaultModel: PI_MODEL }),
  )
  setTemporaryEnvironment(
    originalEnvironment,
    "AWS_BEARER_TOKEN_BEDROCK",
    authentication.bearerToken,
  )
  setTemporaryEnvironment(originalEnvironment, "PI_ACP_PI_COMMAND", piPath)
  setTemporaryEnvironment(originalEnvironment, "PI_CODING_AGENT_DIR", piConfigDirectory)
  Bun.env["PATH"] = `${binaryDirectory}${delimiter}${Bun.env["PATH"] ?? ""}`

  return {
    type: "pi",
    adapter: `${PI_ADAPTER_NAME}@${PI_ADAPTER_VERSION}`,
    loginVerifiedBy: `Amazon Bedrock ${authentication.region} via ${authentication.source}`,
    runtimeVersion: await executableVersion(piPath, "PI_VERSION_UNAVAILABLE"),
    environment: { AWS_REGION: authentication.region, PI_TELEMETRY: "0" },
    secretReferences: {
      AWS_BEARER_TOKEN_BEDROCK: "env://AWS_BEARER_TOKEN_BEDROCK",
      PI_ACP_PI_COMMAND: "env://PI_ACP_PI_COMMAND",
      PI_CODING_AGENT_DIR: "env://PI_CODING_AGENT_DIR",
    },
  }
}

async function resolvePiBedrockAuthentication(): Promise<{
  readonly bearerToken: string
  readonly region: string
  readonly source: "process environment" | "Claude Code settings"
}> {
  const directToken = Bun.env["AWS_BEARER_TOKEN_BEDROCK"]
  const directRegion = Bun.env["AWS_REGION"]
  if (directToken !== undefined && directToken.length > 0 && directRegion !== undefined) {
    return { bearerToken: directToken, region: directRegion, source: "process environment" }
  }

  try {
    const configuredEnvironment = await readClaudeSettingsEnvironment()
    const bearerToken = configuredEnvironment["AWS_BEARER_TOKEN_BEDROCK"]
    const region = configuredEnvironment["AWS_REGION"]
    if (bearerToken !== undefined && region !== undefined) {
      return { bearerToken, region, source: "Claude Code settings" }
    }
  } catch {
    // The Pi-specific error below remains the public proof boundary.
  }
  throw new DemoError(
    "PI_AUTHENTICATION_REQUIRED",
    "The Pi proof requires an Amazon Bedrock bearer token and region",
  )
}

async function loadClaudeEnvironmentForDemo() {
  try {
    return await loadClaudeRunEnvironment()
  } catch (error) {
    if (error instanceof ClaudeSettingsError) throw new DemoError(error.code, error.message)
    throw error
  }
}

async function assertPackageVersion(
  toolsDirectory: string,
  packageName: string,
  expectedVersion: string,
): Promise<void> {
  const packageJson = await Bun.file(
    join(toolsDirectory, "node_modules", ...packageName.split("/"), "package.json"),
  ).json()
  if (Reflect.get(packageJson, "version") !== expectedVersion) {
    throw new DemoError(
      "AGENT_TOOLCHAIN_VERSION_MISMATCH",
      "The installed agent toolchain does not match its pinned version",
    )
  }
}

async function executableVersion(path: string, errorCode: string): Promise<string> {
  const versionProcess = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore" })
  const version = (await new Response(versionProcess.stdout).text()).trim()
  if ((await versionProcess.exited) !== 0 || version.length === 0) {
    throw new DemoError(errorCode, "A required agent tool version could not be determined")
  }
  return version
}

function environmentSnapshot(names: readonly string[]): Map<string, string | undefined> {
  return new Map(names.map((name) => [name, Bun.env[name]]))
}

function setTemporaryEnvironment(
  snapshot: Map<string, string | undefined>,
  name: string,
  value: string,
): void {
  if (!snapshot.has(name)) snapshot.set(name, Bun.env[name])
  Bun.env[name] = value
}

function restoreEnvironment(snapshot: ReadonlyMap<string, string | undefined>): void {
  for (const [name, value] of snapshot) {
    if (value === undefined) delete Bun.env[name]
    else Bun.env[name] = value
  }
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
