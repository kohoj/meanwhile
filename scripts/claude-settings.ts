import { join } from "node:path"

export const CLAUDE_ADAPTER_NAME = "@agentclientprotocol/claude-agent-acp"
export const CLAUDE_ADAPTER_VERSION = "0.58.1"
export const CLAUDE_SDK_NAME = "@anthropic-ai/claude-agent-sdk"
export const CLAUDE_SDK_VERSION = "0.3.205"

const secretNames = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
])
const safeNames = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "AWS_REGION",
  "CLAUDE_CODE_ATTRIBUTION_HEADER",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
])
const authenticationNames = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
])

export interface ClaudeRunEnvironment {
  readonly environment: Readonly<Record<string, string>>
  readonly secretReferences: Readonly<Record<string, string>>
  readonly secretValues: Readonly<Record<string, string>>
}

export class ClaudeSettingsError extends Error {
  constructor(
    readonly code:
      | "CLAUDE_CONFIG_MISSING"
      | "CLAUDE_CONFIG_INVALID"
      | "CLAUDE_SETTINGS_AUTH_MISSING",
    message: string,
  ) {
    super(message)
    this.name = "ClaudeSettingsError"
  }
}

/** Reads only explicitly supported Claude Code settings; unknown values never cross this boundary. */
export async function readClaudeSettingsEnvironment(): Promise<Readonly<Record<string, string>>> {
  const home = Bun.env["HOME"]
  if (home === undefined) {
    throw new ClaudeSettingsError(
      "CLAUDE_CONFIG_MISSING",
      "Claude Code configuration could not be located",
    )
  }
  try {
    const parsed = (await Bun.file(join(home, ".claude", "settings.json")).json()) as unknown
    const configuredEnvironment =
      typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "env") : null
    if (typeof configuredEnvironment !== "object" || configuredEnvironment === null) {
      throw new TypeError("Claude settings env is unavailable")
    }
    const result: Record<string, string> = {}
    for (const [name, value] of Object.entries(configuredEnvironment)) {
      if (typeof value !== "string" || value.length === 0) {
        throw new TypeError("Claude settings contain an invalid environment value")
      }
      if (name === "ANTHROPIC_BASE_URL") assertCredentialFreeHttpsUrl(value)
      if (secretNames.has(name) || safeNames.has(name)) result[name] = value
    }
    return result
  } catch (cause) {
    if (cause instanceof ClaudeSettingsError) throw cause
    throw new ClaudeSettingsError(
      "CLAUDE_CONFIG_INVALID",
      "Claude Code settings could not be read safely",
    )
  }
}

function assertCredentialFreeHttpsUrl(value: string): void {
  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError("Claude base URL must be a credential-free HTTPS URL")
  }
}

export async function loadClaudeRunEnvironment(): Promise<ClaudeRunEnvironment> {
  const configured = await readClaudeSettingsEnvironment()
  const environment: Record<string, string> = {
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_AGENT_VIEW: "1",
  }
  const secretReferences: Record<string, string> = {}
  const secretValues: Record<string, string> = {}
  let hasAuthentication = false

  for (const [name, value] of Object.entries(configured)) {
    if (secretNames.has(name)) {
      secretReferences[name] = `env://${name}`
      secretValues[name] = value
    } else if (safeNames.has(name)) {
      environment[name] = value
    }
    if (authenticationNames.has(name)) hasAuthentication = true
  }
  if (!hasAuthentication) {
    throw new ClaudeSettingsError(
      "CLAUDE_SETTINGS_AUTH_MISSING",
      "Claude settings do not contain a supported non-interactive authentication source",
    )
  }

  return { environment, secretReferences, secretValues }
}
