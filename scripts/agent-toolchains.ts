import { chmod, mkdir } from "node:fs/promises"
import { delimiter, join } from "node:path"
import {
  CLAUDE_ADAPTER_NAME,
  CLAUDE_ADAPTER_VERSION,
  CLAUDE_SDK_NAME,
  CLAUDE_SDK_VERSION,
  ClaudeSettingsError,
  loadClaudeRunEnvironment,
  readClaudeSettingsEnvironment,
} from "./claude-settings"

export const CODEX_ADAPTER_NAME = "@agentclientprotocol/codex-acp"
export const CODEX_ADAPTER_VERSION = "1.1.2"
export const CODEX_RUNTIME_NAME = "@openai/codex"
export const CODEX_RUNTIME_VERSION = "0.144.3"
export const PI_ADAPTER_NAME = "pi-acp"
export const PI_ADAPTER_VERSION = "0.0.31"
export const PI_RUNTIME_NAME = "@earendil-works/pi-coding-agent"
export const PI_RUNTIME_VERSION = "0.80.6"

const PI_PROVIDER = "amazon-bedrock"
const PI_MODEL = "us.anthropic.claude-opus-4-8"
const CODEX_NATIVE_TARGETS = {
  "darwin:arm64": ["@openai/codex-darwin-arm64", "aarch64-apple-darwin"],
  "darwin:x64": ["@openai/codex-darwin-x64", "x86_64-apple-darwin"],
  "linux:arm64": ["@openai/codex-linux-arm64", "aarch64-unknown-linux-musl"],
  "linux:x64": ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl"],
} as const

export type LiveAgentType = "codex" | "claude-code" | "pi"
export type AgentToolchainLocation = "local" | "cloudflare"

export interface PreparedAgentToolchain {
  readonly type: LiveAgentType
  readonly executable: string
  readonly adapter: string
  readonly runtime: string
  readonly authenticationEvidence: string
  readonly environment: Readonly<Record<string, string>>
  readonly secretReferences: Readonly<Record<string, string>>
  readonly secretValues: readonly string[]
  restore(): void
}

export class AgentToolchainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "AgentToolchainError"
  }
}

export async function prepareAgentToolchain(
  type: LiveAgentType,
  location: AgentToolchainLocation,
  directory: string,
): Promise<PreparedAgentToolchain> {
  const environment = new EnvironmentScope()
  try {
    const prepared =
      location === "local"
        ? await prepareLocalToolchain(type, directory, environment)
        : await prepareCloudflareToolchain(type, environment)
    return { ...prepared, restore: () => environment.restore() }
  } catch (error) {
    environment.restore()
    if (error instanceof ClaudeSettingsError) {
      throw new AgentToolchainError(error.code, error.message)
    }
    throw error
  }
}

export function agentCatalog(toolchain: PreparedAgentToolchain): object {
  return {
    version: 1,
    agents: {
      [toolchain.type]: {
        transport: "stdio",
        executable: toolchain.executable,
        args: [],
        workingDirectory: "workspace",
        capabilities: { filesystem: true, terminal: true },
        envNames: Object.keys(toolchain.environment),
        secretEnvNames: Object.keys(toolchain.secretReferences),
      },
    },
  }
}

async function prepareLocalToolchain(
  type: LiveAgentType,
  directory: string,
  environment: EnvironmentScope,
): Promise<Omit<PreparedAgentToolchain, "restore">> {
  switch (type) {
    case "codex":
      return prepareLocalCodex(directory, environment)
    case "claude-code":
      return prepareLocalClaude(directory, environment)
    case "pi":
      return prepareLocalPi(directory, environment)
  }
}

async function prepareCloudflareToolchain(
  type: LiveAgentType,
  environment: EnvironmentScope,
): Promise<Omit<PreparedAgentToolchain, "restore">> {
  switch (type) {
    case "codex": {
      const authentication = await readCodexAuthentication()
      for (const [name, value] of Object.entries(authentication.environment)) {
        environment.set(name, value)
      }
      return {
        type,
        executable: "codex-acp",
        adapter: `${CODEX_ADAPTER_NAME}@${CODEX_ADAPTER_VERSION}`,
        runtime: `${CODEX_RUNTIME_NAME}@${CODEX_RUNTIME_VERSION}`,
        authenticationEvidence: "Codex ChatGPT login materialized into a process-private home",
        environment: { INITIAL_AGENT_MODE: "agent", NO_BROWSER: "1" },
        secretReferences: Object.fromEntries(
          Object.keys(authentication.environment).map((name) => [name, `env://${name}`]),
        ),
        secretValues: Object.values(authentication.environment),
      }
    }
    case "claude-code": {
      const configured = await loadClaudeRunEnvironment()
      for (const [name, value] of Object.entries(configured.secretValues)) {
        environment.set(name, value)
      }
      return {
        type,
        executable: "claude-agent-acp",
        adapter: `${CLAUDE_ADAPTER_NAME}@${CLAUDE_ADAPTER_VERSION}`,
        runtime: `${CLAUDE_SDK_NAME}@${CLAUDE_SDK_VERSION}`,
        authenticationEvidence: "Claude Code non-interactive settings",
        environment: configured.environment,
        secretReferences: configured.secretReferences,
        secretValues: Object.values(configured.secretValues),
      }
    }
    case "pi": {
      const authentication = await resolvePiBedrockAuthentication()
      environment.set("AWS_BEARER_TOKEN_BEDROCK", authentication.bearerToken)
      return {
        type,
        executable: "pi-acp",
        adapter: `${PI_ADAPTER_NAME}@${PI_ADAPTER_VERSION}`,
        runtime: `${PI_RUNTIME_NAME}@${PI_RUNTIME_VERSION}`,
        authenticationEvidence: `Amazon Bedrock ${authentication.region} via ${authentication.source}`,
        environment: { AWS_REGION: authentication.region, PI_TELEMETRY: "0" },
        secretReferences: {
          AWS_BEARER_TOKEN_BEDROCK: "env://AWS_BEARER_TOKEN_BEDROCK",
        },
        secretValues: [authentication.bearerToken],
      }
    }
  }
}

async function prepareLocalCodex(
  directory: string,
  environment: EnvironmentScope,
): Promise<Omit<PreparedAgentToolchain, "restore">> {
  const loginCodexPath = Bun.which("codex")
  const home = Bun.env["HOME"]
  const codexHome = Bun.env["CODEX_HOME"] ?? (home === undefined ? null : join(home, ".codex"))
  if (loginCodexPath === null) {
    throw new AgentToolchainError("CODEX_NOT_FOUND", "Codex must be installed for this proof")
  }
  if (codexHome === null) {
    throw new AgentToolchainError("CODEX_HOME_MISSING", "CODEX_HOME could not be resolved")
  }

  const login = Bun.spawn([loginCodexPath, "login", "status"], {
    env: { ...Bun.env, CODEX_HOME: codexHome },
    stdout: "ignore",
    stderr: "ignore",
  })
  if ((await login.exited) !== 0) {
    throw new AgentToolchainError(
      "CODEX_AUTHENTICATION_REQUIRED",
      "Run 'codex login' before this proof",
    )
  }

  const loginVersion = await executableVersion(loginCodexPath, "CODEX_VERSION_UNAVAILABLE")
  await installToolchain(directory, {
    [CODEX_ADAPTER_NAME]: CODEX_ADAPTER_VERSION,
    [CODEX_RUNTIME_NAME]: CODEX_RUNTIME_VERSION,
  })
  const adapterPath = await createBunModuleExecutable(
    directory,
    "codex-acp",
    join(directory, "node_modules", "@agentclientprotocol", "codex-acp", "dist", "index.js"),
  )
  const runtimePath = await codexNativeExecutable(directory)
  await assertExecutableVersion(adapterPath, CODEX_ADAPTER_VERSION, "CODEX_ADAPTER_UNAVAILABLE")
  await assertExecutableVersion(runtimePath, CODEX_RUNTIME_VERSION, "CODEX_VERSION_UNAVAILABLE")
  environment.prependPath(join(directory, "bin"))
  environment.set("CODEX_HOME", codexHome)
  environment.set("CODEX_PATH", runtimePath)
  return {
    type: "codex",
    executable: "codex-acp",
    adapter: `${CODEX_ADAPTER_NAME}@${CODEX_ADAPTER_VERSION}`,
    runtime: `${CODEX_RUNTIME_NAME}@${CODEX_RUNTIME_VERSION}`,
    authenticationEvidence: loginVersion,
    environment: { INITIAL_AGENT_MODE: "agent", NO_BROWSER: "1" },
    secretReferences: { CODEX_HOME: "env://CODEX_HOME", CODEX_PATH: "env://CODEX_PATH" },
    secretValues: [],
  }
}

async function prepareLocalClaude(
  directory: string,
  environment: EnvironmentScope,
): Promise<Omit<PreparedAgentToolchain, "restore">> {
  const claudePath = Bun.which("claude")
  if (claudePath === null) {
    throw new AgentToolchainError(
      "CLAUDE_NOT_FOUND",
      "Claude Code must be installed for this proof",
    )
  }
  const configured = await loadClaudeRunEnvironment()
  for (const [name, value] of Object.entries(configured.secretValues)) {
    environment.set(name, value)
  }
  await installToolchain(directory, { [CLAUDE_ADAPTER_NAME]: CLAUDE_ADAPTER_VERSION })
  await assertPackageVersion(directory, CLAUDE_ADAPTER_NAME, CLAUDE_ADAPTER_VERSION)
  await assertPackageVersion(directory, CLAUDE_SDK_NAME, CLAUDE_SDK_VERSION)
  const adapterPath = await createBunModuleExecutable(
    directory,
    "claude-agent-acp",
    join(directory, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js"),
  )
  await assertExecutableVersion(adapterPath, CLAUDE_ADAPTER_VERSION, "CLAUDE_ADAPTER_UNAVAILABLE")
  environment.prependPath(join(directory, "bin"))
  return {
    type: "claude-code",
    executable: "claude-agent-acp",
    adapter: `${CLAUDE_ADAPTER_NAME}@${CLAUDE_ADAPTER_VERSION}`,
    runtime: `${CLAUDE_SDK_NAME}@${CLAUDE_SDK_VERSION}`,
    authenticationEvidence: `${await executableVersion(claudePath, "CLAUDE_VERSION_UNAVAILABLE")} via ~/.claude/settings.json`,
    environment: configured.environment,
    secretReferences: configured.secretReferences,
    secretValues: Object.values(configured.secretValues),
  }
}

async function prepareLocalPi(
  directory: string,
  environment: EnvironmentScope,
): Promise<Omit<PreparedAgentToolchain, "restore">> {
  const authentication = await resolvePiBedrockAuthentication()
  await installToolchain(directory, {
    [PI_ADAPTER_NAME]: PI_ADAPTER_VERSION,
    [PI_RUNTIME_NAME]: PI_RUNTIME_VERSION,
  })
  await assertPackageVersion(directory, PI_ADAPTER_NAME, PI_ADAPTER_VERSION)
  await assertPackageVersion(directory, PI_RUNTIME_NAME, PI_RUNTIME_VERSION)
  await createBunModuleExecutable(
    directory,
    "pi-acp",
    join(directory, "node_modules", "pi-acp", "dist", "index.js"),
  )
  const piPath = await createBunModuleExecutable(
    directory,
    "pi-runtime",
    join(directory, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
  )
  await assertExecutableVersion(piPath, PI_RUNTIME_VERSION, "PI_VERSION_UNAVAILABLE")
  const configDirectory = join(directory, "config")
  await mkdir(configDirectory, { recursive: true })
  await Bun.write(
    join(configDirectory, "settings.json"),
    JSON.stringify({ defaultProvider: PI_PROVIDER, defaultModel: PI_MODEL }),
  )
  environment.prependPath(join(directory, "bin"))
  environment.set("AWS_BEARER_TOKEN_BEDROCK", authentication.bearerToken)
  environment.set("PI_ACP_PI_COMMAND", piPath)
  environment.set("PI_CODING_AGENT_DIR", configDirectory)
  return {
    type: "pi",
    executable: "pi-acp",
    adapter: `${PI_ADAPTER_NAME}@${PI_ADAPTER_VERSION}`,
    runtime: `${PI_RUNTIME_NAME}@${PI_RUNTIME_VERSION}`,
    authenticationEvidence: `Amazon Bedrock ${authentication.region} via ${authentication.source}`,
    environment: { AWS_REGION: authentication.region, PI_TELEMETRY: "0" },
    secretReferences: {
      AWS_BEARER_TOKEN_BEDROCK: "env://AWS_BEARER_TOKEN_BEDROCK",
      PI_ACP_PI_COMMAND: "env://PI_ACP_PI_COMMAND",
      PI_CODING_AGENT_DIR: "env://PI_CODING_AGENT_DIR",
    },
    secretValues: [authentication.bearerToken],
  }
}

async function installToolchain(
  directory: string,
  dependencies: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(directory, { recursive: true })
  await Bun.write(join(directory, "package.json"), JSON.stringify({ private: true, dependencies }))
  const bun = Bun.which("bun")
  if (bun === null) throw new AgentToolchainError("BUN_NOT_FOUND", "Bun could not be located")
  const install = Bun.spawn([bun, "install", "--no-progress"], {
    cwd: directory,
    stdout: "ignore",
    stderr: "ignore",
  })
  if ((await install.exited) !== 0) {
    throw new AgentToolchainError(
      "AGENT_TOOLCHAIN_INSTALL_FAILED",
      "The pinned ACP toolchain could not be installed",
    )
  }
}

async function createBunModuleExecutable(
  directory: string,
  name: string,
  modulePath: string,
): Promise<string> {
  if (!(await Bun.file(modulePath).exists())) {
    throw new AgentToolchainError(
      "AGENT_TOOLCHAIN_UNAVAILABLE",
      "The pinned agent module is unavailable",
    )
  }
  const binaryDirectory = join(directory, "bin")
  const executable = join(binaryDirectory, name)
  await mkdir(binaryDirectory, { recursive: true })
  await Bun.write(executable, `#!/usr/bin/env bun\nawait import(${JSON.stringify(modulePath)})\n`)
  await chmod(executable, 0o755)
  return executable
}

async function codexNativeExecutable(directory: string): Promise<string> {
  const target = Reflect.get(CODEX_NATIVE_TARGETS, `${process.platform}:${process.arch}`) as
    | readonly [string, string]
    | undefined
  if (target === undefined) {
    throw new AgentToolchainError(
      "CODEX_PLATFORM_UNSUPPORTED",
      "The pinned Codex runtime does not support this platform",
    )
  }
  const [packageName, triple] = target
  const executable = join(
    directory,
    "node_modules",
    ...packageName.split("/"),
    "vendor",
    triple,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  )
  if (!(await Bun.file(executable).exists())) {
    throw new AgentToolchainError(
      "CODEX_VERSION_UNAVAILABLE",
      "The pinned native Codex executable is unavailable",
    )
  }
  return executable
}

async function assertPackageVersion(
  directory: string,
  packageName: string,
  expected: string,
): Promise<void> {
  const manifest = await Bun.file(
    join(directory, "node_modules", ...packageName.split("/"), "package.json"),
  ).json()
  if (Reflect.get(manifest, "version") !== expected) {
    throw new AgentToolchainError(
      "AGENT_TOOLCHAIN_VERSION_MISMATCH",
      "The installed agent toolchain does not match its pinned version",
    )
  }
}

async function assertExecutableVersion(
  executable: string,
  expected: string,
  code: string,
): Promise<void> {
  if (!(await executableVersion(executable, code)).includes(expected)) {
    throw new AgentToolchainError(code, "The installed executable is not the pinned version")
  }
}

async function executableVersion(executable: string, code: string): Promise<string> {
  const process = Bun.spawn([executable, "--version"], { stdout: "pipe", stderr: "ignore" })
  const output = await new Response(process.stdout).text()
  if ((await process.exited) !== 0 || output.trim().length === 0) {
    throw new AgentToolchainError(code, "The agent executable version could not be verified")
  }
  return output.trim()
}

async function readCodexAuthentication(): Promise<{
  readonly environment: Readonly<Record<string, string>>
}> {
  const home =
    Bun.env["CODEX_HOME"] ??
    (Bun.env["HOME"] === undefined ? undefined : join(Bun.env["HOME"] as string, ".codex"))
  if (home === undefined) {
    throw new AgentToolchainError("CODEX_HOME_MISSING", "CODEX_HOME could not be resolved")
  }
  const file = Bun.file(join(home, "auth.json"))
  if (!(await file.exists())) {
    throw new AgentToolchainError("CODEX_AUTHENTICATION_REQUIRED", "Run 'codex login' first")
  }
  const serialized = await file.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw new AgentToolchainError("CODEX_AUTH_INVALID", "Codex authentication is invalid")
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AgentToolchainError("CODEX_AUTH_INVALID", "Codex authentication is invalid")
  }
  const authMode = requiredString(parsed, "auth_mode")
  const lastRefresh = Reflect.get(parsed, "last_refresh")
  if (lastRefresh !== null && lastRefresh !== undefined && typeof lastRefresh !== "string") {
    throw new AgentToolchainError("CODEX_AUTH_INVALID", "Codex authentication is invalid")
  }
  const openAiApiKey = Reflect.get(parsed, "OPENAI_API_KEY")
  if (openAiApiKey !== null && openAiApiKey !== undefined && typeof openAiApiKey !== "string") {
    throw new AgentToolchainError("CODEX_AUTH_INVALID", "Codex authentication is invalid")
  }
  const environment: Record<string, string> = {
    CODEX_AUTH_METADATA_JSON: JSON.stringify({
      auth_mode: authMode,
      OPENAI_API_KEY: null,
      ...(lastRefresh === undefined ? {} : { last_refresh: lastRefresh }),
    }),
  }
  const tokens = Reflect.get(parsed, "tokens")
  if (tokens !== null && tokens !== undefined) {
    const tokenRecord = requiredRecord(parsed, "tokens")
    Object.assign(environment, {
      CODEX_AUTH_ID_TOKEN: requiredString(tokenRecord, "id_token"),
      CODEX_AUTH_ACCESS_TOKEN: requiredString(tokenRecord, "access_token"),
      CODEX_AUTH_REFRESH_TOKEN: requiredString(tokenRecord, "refresh_token"),
      CODEX_AUTH_ACCOUNT_ID: requiredString(tokenRecord, "account_id"),
    })
  }
  if (typeof openAiApiKey === "string" && openAiApiKey.length > 0) {
    environment["CODEX_AUTH_OPENAI_API_KEY"] = openAiApiKey
  }
  if (tokens === null || tokens === undefined) {
    if (environment["CODEX_AUTH_OPENAI_API_KEY"] === undefined) {
      throw new AgentToolchainError("CODEX_AUTH_INVALID", "Codex authentication is invalid")
    }
  }
  return {
    environment,
  }
}

function requiredRecord(value: object, key: string): Record<string, unknown> {
  const selected = Reflect.get(value, key)
  if (typeof selected === "object" && selected !== null && !Array.isArray(selected)) {
    return selected as Record<string, unknown>
  }
  throw new AgentToolchainError("CODEX_AUTH_INVALID", "Codex authentication is invalid")
}

function requiredString(value: object, key: string): string {
  const selected = Reflect.get(value, key)
  if (typeof selected === "string" && selected.length > 0) return selected
  throw new AgentToolchainError("CODEX_AUTH_INVALID", "Codex authentication is invalid")
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
    const configured = await readClaudeSettingsEnvironment()
    const bearerToken = configured["AWS_BEARER_TOKEN_BEDROCK"]
    const region = configured["AWS_REGION"]
    if (bearerToken !== undefined && region !== undefined) {
      return { bearerToken, region, source: "Claude Code settings" }
    }
  } catch {
    // The stable Pi-specific error below is the public proof boundary.
  }
  throw new AgentToolchainError(
    "PI_AUTHENTICATION_REQUIRED",
    "The Pi proof requires an Amazon Bedrock bearer token and region",
  )
}

class EnvironmentScope {
  readonly #original = new Map<string, string | undefined>()

  set(name: string, value: string): void {
    if (!this.#original.has(name)) this.#original.set(name, Bun.env[name])
    Bun.env[name] = value
  }

  prependPath(directory: string): void {
    this.set("PATH", `${directory}${delimiter}${Bun.env["PATH"] ?? ""}`)
  }

  restore(): void {
    for (const [name, value] of this.#original) {
      if (value === undefined) delete Bun.env[name]
      else Bun.env[name] = value
    }
    this.#original.clear()
  }
}
