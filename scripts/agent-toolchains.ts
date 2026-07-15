import { join } from "node:path"
import type { AgentCredentialHttpMethod, AgentCredentialPolicy } from "../src/domain"
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

export type LiveAgentType = "codex" | "claude-code" | "pi"

export interface PreparedAgentToolchain {
  readonly type: LiveAgentType
  readonly executable: string
  readonly adapter: string
  readonly runtime: string
  readonly authenticationEvidence: string
  readonly environment: Readonly<Record<string, string>>
  readonly secretReferences: Readonly<Record<string, string>>
  readonly secretValues: readonly string[]
  readonly allowedHosts: readonly string[]
  readonly credentialPolicies: readonly AgentCredentialPolicy[]
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

export async function prepareCloudflareAgentToolchain(
  type: LiveAgentType,
): Promise<PreparedAgentToolchain> {
  const environment = new EnvironmentScope()
  try {
    const prepared = await prepareCloudflareToolchain(type, environment)
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
        networkPolicy: { allowedHosts: [...toolchain.allowedHosts] },
        credentials: toolchain.credentialPolicies.map((policy) => ({
          ...policy,
          methods: [...policy.methods],
        })),
      },
    },
  }
}

async function prepareCloudflareToolchain(
  type: LiveAgentType,
  environment: EnvironmentScope,
): Promise<Omit<PreparedAgentToolchain, "restore">> {
  switch (type) {
    case "codex": {
      const authentication = await readCodexAuthentication()
      const hosts = ["api.openai.com"] as const
      environment.set("CODEX_AUTH_OPENAI_API_KEY", authentication.apiKey)
      return {
        type,
        executable: "codex-acp",
        adapter: `${CODEX_ADAPTER_NAME}@${CODEX_ADAPTER_VERSION}`,
        runtime: `${CODEX_RUNTIME_NAME}@${CODEX_RUNTIME_VERSION}`,
        authenticationEvidence: "OpenAI API key mediated at the Cloudflare egress boundary",
        environment: {
          INITIAL_AGENT_MODE: "agent",
          NO_BROWSER: "1",
          CODEX_AUTH_METADATA_JSON: JSON.stringify({
            auth_mode: "apikey",
            OPENAI_API_KEY: null,
          }),
        },
        secretReferences: {
          CODEX_AUTH_OPENAI_API_KEY: "env://CODEX_AUTH_OPENAI_API_KEY",
        },
        secretValues: [authentication.apiKey],
        allowedHosts: hosts,
        credentialPolicies: credentialPolicies(["CODEX_AUTH_OPENAI_API_KEY"], hosts, ["POST"]),
      }
    }
    case "claude-code": {
      const configured = await loadClaudeRunEnvironment()
      const hosts = cloudflareClaudeHosts(configured.environment, configured.secretReferences)
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
        allowedHosts: hosts,
        credentialPolicies: credentialPolicies(Object.keys(configured.secretReferences), hosts, [
          "POST",
        ]),
      }
    }
    case "pi": {
      const authentication = await resolvePiBedrockAuthentication()
      const host = bedrockHost(authentication.region)
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
        allowedHosts: [host],
        credentialPolicies: credentialPolicies(["AWS_BEARER_TOKEN_BEDROCK"], [host], ["POST"]),
      }
    }
  }
}

function credentialPolicies(
  environmentVariables: readonly string[],
  hosts: readonly string[],
  methods: readonly AgentCredentialHttpMethod[],
): readonly AgentCredentialPolicy[] {
  return environmentVariables.flatMap((environmentVariable) =>
    hosts.map((host) => ({ environmentVariable, host, methods: [...methods] })),
  )
}

export function cloudflareClaudeHosts(
  environment: Readonly<Record<string, string>>,
  secretReferences: Readonly<Record<string, string>>,
): readonly string[] {
  const anthropicCredentials = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ].filter((name) => secretReferences[name] !== undefined)
  if (anthropicCredentials.length > 1) {
    throw new AgentToolchainError(
      "CLAUDE_AUTH_AMBIGUOUS",
      "The Cloudflare proof requires exactly one Claude authentication authority",
    )
  }

  const usesVertex =
    secretReferences["GOOGLE_APPLICATION_CREDENTIALS"] !== undefined ||
    environment["CLAUDE_CODE_USE_VERTEX"] === "1"
  const usesFoundry = environment["CLAUDE_CODE_USE_FOUNDRY"] === "1"
  const usesBedrock =
    secretReferences["AWS_BEARER_TOKEN_BEDROCK"] !== undefined ||
    environment["CLAUDE_CODE_USE_BEDROCK"] === "1"
  const usesAnthropic = anthropicCredentials.length === 1
  const authorityCount = [usesAnthropic, usesBedrock, usesVertex, usesFoundry].filter(
    Boolean,
  ).length
  if (authorityCount !== 1) {
    throw new AgentToolchainError(
      "CLAUDE_AUTH_AMBIGUOUS",
      "The Cloudflare proof requires exactly one Claude authentication authority",
    )
  }

  if (usesVertex) {
    throw new AgentToolchainError(
      "CLAUDE_AUTH_UNSUPPORTED",
      "The Cloudflare proof does not pass file credentials or metadata-service authority to the agent runtime",
    )
  }
  if (usesFoundry) {
    throw new AgentToolchainError(
      "CLAUDE_AUTH_UNSUPPORTED",
      "The Cloudflare proof requires an exact destination policy and does not accept Foundry discovery",
    )
  }
  if (usesBedrock) {
    if (environment["ANTHROPIC_BASE_URL"] !== undefined) {
      throw new AgentToolchainError(
        "CLAUDE_AUTH_AMBIGUOUS",
        "ANTHROPIC_BASE_URL cannot be combined with Bedrock authentication",
      )
    }
    const region = environment["AWS_REGION"]
    if (region === undefined) {
      throw new AgentToolchainError(
        "CLAUDE_AUTH_UNSUPPORTED",
        "Bedrock authentication requires an explicit AWS_REGION",
      )
    }
    return [bedrockHost(region)]
  }
  const baseUrl = environment["ANTHROPIC_BASE_URL"]
  return [baseUrl === undefined ? "api.anthropic.com" : exactHttpsHost(baseUrl)]
}

function bedrockHost(region: string): string {
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) {
    throw new AgentToolchainError("BEDROCK_REGION_INVALID", "AWS_REGION is not a valid region")
  }
  return `bedrock-runtime.${region}.amazonaws.com`
}

function exactHttpsHost(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AgentToolchainError("CLAUDE_BASE_URL_INVALID", "ANTHROPIC_BASE_URL is invalid")
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.hostname !== url.hostname.toLowerCase()
  ) {
    throw new AgentToolchainError(
      "CLAUDE_BASE_URL_INVALID",
      "ANTHROPIC_BASE_URL must be a credential-free HTTPS URL with an exact lowercase host",
    )
  }
  return url.hostname
}

async function readCodexAuthentication(): Promise<{
  readonly apiKey: string
}> {
  const directApiKey = Bun.env["OPENAI_API_KEY"]
  if (directApiKey !== undefined && directApiKey.length > 0) return { apiKey: directApiKey }
  const home =
    Bun.env["CODEX_HOME"] ??
    (Bun.env["HOME"] === undefined ? undefined : join(Bun.env["HOME"] as string, ".codex"))
  if (home === undefined) {
    throw new AgentToolchainError("CODEX_HOME_MISSING", "CODEX_HOME could not be resolved")
  }
  const file = Bun.file(join(home, "auth.json"))
  if (!(await file.exists())) {
    throw new AgentToolchainError(
      "CODEX_API_KEY_REQUIRED",
      "The brokered Cloudflare proof requires OPENAI_API_KEY authentication",
    )
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
  const openAiApiKey = Reflect.get(parsed, "OPENAI_API_KEY")
  if (typeof openAiApiKey !== "string" || openAiApiKey.length === 0) {
    throw new AgentToolchainError(
      "CODEX_API_KEY_REQUIRED",
      "The brokered Cloudflare proof requires OPENAI_API_KEY authentication; ChatGPT session tokens are intentionally not injected into the runtime",
    )
  }
  return { apiKey: openAiApiKey }
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

  restore(): void {
    for (const [name, value] of this.#original) {
      if (value === undefined) delete Bun.env[name]
      else Bun.env[name] = value
    }
    this.#original.clear()
  }
}
