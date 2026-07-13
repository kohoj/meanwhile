import { mkdir } from "node:fs/promises"
import { isIP } from "node:net"
import { isAbsolute, join, resolve } from "node:path"
import { z } from "zod"
import { parseSecretSourceCatalog } from "./secrets"

const booleanFromEnvironment = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true")

const providerName = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .max(64)

const environmentSchema = z.object({
  MEANWHILE_HOST: z.string().min(1).default("127.0.0.1"),
  MEANWHILE_PORT: z.coerce.number().int().min(1).max(65_535).default(7331),
  MEANWHILE_PREVIEW_HOST: z.string().min(1).default("127.0.0.1"),
  MEANWHILE_PREVIEW_PORT: z.coerce.number().int().min(1).max(65_535).default(7332),
  MEANWHILE_PREVIEW_PUBLIC_URL: z.url().optional(),
  MEANWHILE_DATA_DIR: z.string().min(1).default("./data"),
  MEANWHILE_API_KEY: z.string().min(24).optional(),
  MEANWHILE_RUNNER_PATH: z.string().min(1).default("./dist/meanwhile-runner"),
  MEANWHILE_AGENT_CATALOG: z.string().min(1).default("./config/agents.json"),
  MEANWHILE_DEFAULT_PROVIDER: providerName.default("local"),
  MEANWHILE_LOCAL_PROVIDER: z.enum(["auto", "enabled", "disabled"]).default("auto"),
  MEANWHILE_ALLOW_UNSAFE_LOCAL_PROVIDER: booleanFromEnvironment,
  MEANWHILE_SECRET_ENV_ALLOWLIST: z.string().default(""),
  MEANWHILE_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  MEANWHILE_OTEL_ENABLED: booleanFromEnvironment,
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  CLOUDFLARE_BRIDGE_URL: z.url().optional(),
  CLOUDFLARE_BRIDGE_TOKEN: z.string().min(24).optional(),
})

export interface AppConfig {
  readonly host: string
  readonly port: number
  readonly previewHost: string
  readonly previewPort: number
  readonly previewPublicUrl?: string
  readonly dataDir: string
  readonly databasePath: string
  readonly artifactDir: string
  readonly runtimeDir: string
  readonly deploymentDir: string
  readonly apiKey?: string
  readonly runnerPath: string
  readonly agentCatalogPath: string
  readonly defaultProvider: string
  readonly localProvider: {
    readonly enabled: boolean
    readonly unsafeHostExecution: boolean
  }
  readonly secretSourceCatalog: readonly string[]
  readonly logLevel: "debug" | "info" | "warn" | "error"
  readonly telemetry: {
    readonly enabled: boolean
    readonly endpoint?: string
  }
  readonly cloudflare?: {
    readonly bridgeUrl: string
    readonly token: string
  }
}

const absolute = (path: string): string => (isAbsolute(path) ? path : resolve(path))

export const loadConfig = (
  environment: Record<string, string | undefined> = Bun.env,
): AppConfig => {
  const parsed = environmentSchema.parse(environment)
  const dataDir = absolute(parsed.MEANWHILE_DATA_DIR)
  const previewPublicUrl =
    parsed.MEANWHILE_PREVIEW_PUBLIC_URL === undefined
      ? undefined
      : normalizePublicOrigin(parsed.MEANWHILE_PREVIEW_PUBLIC_URL)
  const cloudflareConfigured =
    parsed.CLOUDFLARE_BRIDGE_URL !== undefined || parsed.CLOUDFLARE_BRIDGE_TOKEN !== undefined
  const localProvider = resolveLocalProviderPolicy(
    parsed.MEANWHILE_LOCAL_PROVIDER,
    parsed.MEANWHILE_HOST,
    parsed.MEANWHILE_ALLOW_UNSAFE_LOCAL_PROVIDER,
  )
  const secretSourceCatalog = parseSecretSourceCatalog(parsed.MEANWHILE_SECRET_ENV_ALLOWLIST)

  if (cloudflareConfigured && !(parsed.CLOUDFLARE_BRIDGE_URL && parsed.CLOUDFLARE_BRIDGE_TOKEN)) {
    throw new Error("CLOUDFLARE_BRIDGE_URL and CLOUDFLARE_BRIDGE_TOKEN must be configured together")
  }
  if (parsed.MEANWHILE_OTEL_ENABLED && parsed.OTEL_EXPORTER_OTLP_ENDPOINT === undefined) {
    throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT is required when MEANWHILE_OTEL_ENABLED=true")
  }
  if (isWildcardHost(parsed.MEANWHILE_PREVIEW_HOST) && previewPublicUrl === undefined) {
    throw new Error(
      "MEANWHILE_PREVIEW_PUBLIC_URL is required when MEANWHILE_PREVIEW_HOST binds all interfaces",
    )
  }

  return {
    host: parsed.MEANWHILE_HOST,
    port: parsed.MEANWHILE_PORT,
    previewHost: parsed.MEANWHILE_PREVIEW_HOST,
    previewPort: parsed.MEANWHILE_PREVIEW_PORT,
    ...(previewPublicUrl === undefined ? {} : { previewPublicUrl }),
    dataDir,
    databasePath: join(dataDir, "meanwhile.sqlite"),
    artifactDir: join(dataDir, "artifacts"),
    runtimeDir: join(dataDir, "runtimes"),
    deploymentDir: join(dataDir, "deployments"),
    ...(parsed.MEANWHILE_API_KEY === undefined ? {} : { apiKey: parsed.MEANWHILE_API_KEY }),
    runnerPath: absolute(parsed.MEANWHILE_RUNNER_PATH),
    agentCatalogPath: absolute(parsed.MEANWHILE_AGENT_CATALOG),
    defaultProvider: parsed.MEANWHILE_DEFAULT_PROVIDER,
    localProvider,
    secretSourceCatalog,
    logLevel: parsed.MEANWHILE_LOG_LEVEL,
    telemetry: {
      enabled: parsed.MEANWHILE_OTEL_ENABLED,
      ...(parsed.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
        ? {}
        : { endpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT }),
    },
    ...(cloudflareConfigured
      ? {
          cloudflare: {
            bridgeUrl: parsed.CLOUDFLARE_BRIDGE_URL as string,
            token: parsed.CLOUDFLARE_BRIDGE_TOKEN as string,
          },
        }
      : {}),
  }
}

export const isLoopbackHost = (hostname: string): boolean => {
  if (hostname.toLowerCase() === "localhost") return true
  const family = isIP(hostname)
  if (family === 4) return hostname.split(".")[0] === "127"
  if (family === 6) return hostname === "::1" || hostname === "0:0:0:0:0:0:0:1"
  return false
}

export const assertLocalProviderPolicy = (
  config: Pick<AppConfig, "host" | "localProvider">,
): void => {
  if (
    config.localProvider.enabled &&
    !isLoopbackHost(config.host) &&
    !config.localProvider.unsafeHostExecution
  ) {
    throw new Error(
      "The local runtime provider on a non-loopback API host requires MEANWHILE_ALLOW_UNSAFE_LOCAL_PROVIDER=true",
    )
  }
}

const resolveLocalProviderPolicy = (
  mode: "auto" | "enabled" | "disabled",
  hostname: string,
  unsafeHostExecution: boolean,
): AppConfig["localProvider"] => {
  const enabled = mode === "enabled" || (mode === "auto" && isLoopbackHost(hostname))
  const policy = { enabled, unsafeHostExecution }
  assertLocalProviderPolicy({ host: hostname, localProvider: policy })
  return policy
}

const normalizePublicOrigin = (value: string): string => {
  const url = new URL(value)
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(
      "MEANWHILE_PREVIEW_PUBLIC_URL must be an HTTP(S) origin without credentials or a path",
    )
  }
  return url.origin
}

const isWildcardHost = (hostname: string): boolean =>
  hostname === "0.0.0.0" || hostname === "::" || hostname === "0:0:0:0:0:0:0:0"

export const prepareDataDirectories = async (config: AppConfig): Promise<void> => {
  await Promise.all(
    [config.dataDir, config.artifactDir, config.runtimeDir, config.deploymentDir].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  )
}
