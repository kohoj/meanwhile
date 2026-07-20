#!/usr/bin/env bun

import { constants } from "node:fs"
import { access, link, lstat, mkdir, unlink } from "node:fs/promises"
import { delimiter, dirname, join, resolve } from "node:path"
import { AgentCatalog } from "./agents/catalog"
import {
  apiKeyPrefix,
  hashApiKey,
  issueApiKey,
  LOCAL_BOOTSTRAP_API_KEY_ID,
  LOCAL_BOOTSTRAP_OWNER_ID,
} from "./auth"
import { Meanwhile, MeanwhileError, type Wait } from "./client"
import { loadConfig, prepareDataDirectories } from "./config"
import {
  backupDataRoot,
  garbageCollectDataRoot,
  restoreDataRoot,
  verifyDataBackup,
} from "./data-root"
import { AppError } from "./errors"
import { type BootstrapIdentityStatus, Store } from "./persistence/store"
import { CloudflareRuntimeProvider } from "./providers/cloudflare-provider"
import { LocalRuntimeProvider } from "./providers/local-provider"
import { RuntimeProviderRegistry } from "./providers/registry"
import { SERVICE_VERSION } from "./version"
import { captureWorkspace, WorkspaceCaptureError } from "./workspace"

const DEFAULT_URL = "http://127.0.0.1:7331"

interface Environment extends Readonly<Record<string, string | undefined>> {
  readonly MEANWHILE_API_KEY?: string
  readonly MEANWHILE_DEFAULT_PROVIDER?: string
  readonly MEANWHILE_URL?: string
}
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type Write = (text: string) => void | Promise<void>

export interface CliOptions {
  readonly environment?: Environment
  readonly fetch?: Fetch
  readonly cwd?: string
  readonly stdout?: Write
  readonly stderr?: Write
  readonly signal?: AbortSignal
  readonly wait?: Wait
}

interface CliContext {
  readonly environment: Environment
  readonly fetch: Fetch
  readonly cwd: string
  readonly stdout: Write
  readonly stderr: Write
  readonly signal: AbortSignal
  readonly wait: Wait
}

interface CliErrorInput {
  readonly code: string
  readonly message: string
  readonly exitCode?: number
  readonly requestId?: string
  readonly details?: Readonly<Record<string, unknown>>
}

/** A deliberately small, safe error surface for both local and API failures. */
export class CliError extends Error {
  readonly code: string
  readonly exitCode: number
  readonly requestId: string | undefined
  readonly details: Readonly<Record<string, unknown>>

  constructor(input: CliErrorInput, options?: ErrorOptions) {
    super(input.message, options)
    this.name = "CliError"
    this.code = input.code
    this.exitCode = input.exitCode ?? 1
    this.requestId = input.requestId
    this.details = input.details ?? {}
  }
}

/**
 * Runs one CLI invocation. The function never throws and writes exactly one
 * structured error on failure, which makes it usable by humans and agents.
 */
export async function runCli(
  args: readonly string[] = Bun.argv.slice(2),
  options: CliOptions = {},
): Promise<number> {
  const signal = options.signal ?? new AbortController().signal
  const context: CliContext = {
    environment: options.environment ?? Bun.env,
    fetch: options.fetch ?? globalThis.fetch,
    cwd: resolve(options.cwd ?? process.cwd()),
    stdout: options.stdout ?? fileSinkWriter(Bun.stdout),
    stderr: options.stderr ?? fileSinkWriter(Bun.stderr),
    signal,
    wait: options.wait ?? abortableCliDelay,
  }

  try {
    return await dispatch(args, context)
  } catch (error) {
    const normalized = normalizeCliError(error)
    await context.stderr(
      `${JSON.stringify({
        error: {
          code: normalized.code,
          message: normalized.message,
          ...(normalized.requestId === undefined ? {} : { requestId: normalized.requestId }),
          details: normalized.details,
        },
      })}\n`,
    )
    return normalized.exitCode
  }
}

async function dispatch(args: readonly string[], context: CliContext): Promise<number> {
  const [command, ...rest] = args
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    await context.stdout(HELP)
    return 0
  }
  if (command === "--version" || command === "version") {
    await context.stdout(`${SERVICE_VERSION}\n`)
    return 0
  }

  switch (command) {
    case "serve":
      return await serve(rest)
    case "run":
      await createRun(rest, context)
      return 0
    case "list":
      await listRuns(rest, context)
      return 0
    case "get":
      await getRun(rest, context)
      return 0
    case "logs":
      await runLogs(rest, context)
      return 0
    case "watch":
      await watchRun(rest, context)
      return 0
    case "sessions":
      await sessionsCommand(rest, context)
      return 0
    case "cancel":
      await cancelRun(rest, context)
      return 0
    case "artifacts":
      await artifactsCommand(rest, context)
      return 0
    case "briefs":
      await briefsCommand(rest, context)
      return 0
    case "deploy":
      await createDeployment(rest, context)
      return 0
    case "deployments":
      await deploymentsCommand(rest, context)
      return 0
    case "audit":
      await auditCommand(rest, context)
      return 0
    case "api-keys":
      await apiKeysCommand(rest, context)
      return 0
    case "providers":
      await providersCommand(rest, context)
      return 0
    case "doctor":
      return doctor(rest, context)
    case "key":
      await keyCommand(rest, context)
      return 0
    case "data":
      await dataCommand(rest, context)
      return 0
    default:
      throw argumentError("Unknown command", { command })
  }
}

async function serve(args: readonly string[]): Promise<number> {
  parseArguments(args, {}).requireNoPositionals()
  // Dynamically imported so every non-serve command (and the test harness that
  // drives runCli) never loads the server, its telemetry, or Bun.serve.
  const { startServer } = await import("./server")
  const { stop } = await startServer()
  // startServer installs its own SIGINT/SIGTERM handlers that stop the server
  // and set process.exitCode. Hold the command open until that shutdown runs,
  // so `meanwhile serve` behaves as a long-lived foreground process.
  await new Promise<void>((resolveServe) => {
    const onSignal = () => {
      void stop().finally(resolveServe)
    }
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
  })
  return 0
}

async function createRun(args: readonly string[], context: CliContext): Promise<void> {
  const delimiter = args.indexOf("--")
  if (delimiter < 0) {
    throw argumentError("Run prompt must follow a -- delimiter")
  }
  const parsed = parseArguments(args.slice(0, delimiter), {
    values: [
      "repo",
      "files",
      "revision",
      "credential-ref",
      "agent",
      "provider",
      "brief",
      "artifact",
      "env",
      "secret",
      "timeout",
      "idempotency-key",
    ],
  })
  parsed.requireNoPositionals()
  const prompt = args
    .slice(delimiter + 1)
    .join(" ")
    .trim()
  if (prompt.length === 0) throw argumentError("Run prompt must not be empty")

  const agentType = requiredOption(parsed, "agent")
  const provider =
    parsed.one("provider") ?? context.environment.MEANWHILE_DEFAULT_PROVIDER ?? "local"
  const timeoutMs = parseDuration(parsed.one("timeout") ?? "1h")
  const env = parseAssignments(parsed.many("env"), "--env", parseEnvironmentValue)
  const secretRefs = parseAssignments(parsed.many("secret"), "--secret", parseSecretReference)
  assertDisjointEnvironment(env, secretRefs)

  const workspace = await executionWorkspace(parsed, context)
  const body = {
    workspace,
    agentType,
    prompt,
    env,
    secretRefs,
    provider,
    briefIds: [...uniqueValues(parsed.many("brief"), "--brief")],
    artifactPaths: [...uniqueValues(parsed.many("artifact"), "--artifact")],
    timeoutMs,
  }
  const idempotencyKey = parsed.one("idempotency-key")
  const client = apiClient(context)
  const run = await client.runs.create(body, {
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    signal: context.signal,
  })
  await printJson(context, { run })
}

async function listRuns(args: readonly string[], context: CliContext): Promise<void> {
  const parsed = parseArguments(args, { values: ["limit", "before"] })
  parsed.requireNoPositionals()
  const query = new URLSearchParams()
  query.set("limit", String(parseInteger(parsed.one("limit") ?? "50", "--limit", 1, 100)))
  const before = parsed.one("before")
  if (before !== undefined) query.set("before", before)
  await printJson(
    context,
    await apiClient(context).runs.list({
      limit: Number(query.get("limit")),
      ...(before === undefined ? {} : { before }),
      signal: context.signal,
    }),
  )
}

async function getRun(args: readonly string[], context: CliContext): Promise<void> {
  const parsed = parseArguments(args)
  const runId = parsed.onlyPositional()
  await printJson(context, {
    run: await apiClient(context).runs.get(runId, { signal: context.signal }),
  })
}

async function cancelRun(args: readonly string[], context: CliContext): Promise<void> {
  const parsed = parseArguments(args)
  const runId = parsed.onlyPositional()
  await printJson(context, {
    run: await apiClient(context).runs.cancel(runId, { signal: context.signal }),
  })
}

async function artifactsCommand(args: readonly string[], context: CliContext): Promise<void> {
  const [subcommand, ...rest] = args
  const client = apiClient(context)
  if (subcommand === "list") {
    const runId = parseArguments(rest).onlyPositional()
    await printJson(context, {
      items: await client.artifacts.list(runId, { signal: context.signal }),
    })
    return
  }
  if (subcommand === "get") {
    const artifactId = parseArguments(rest).onlyPositional()
    await printJson(context, await client.artifacts.get(artifactId, { signal: context.signal }))
    return
  }
  if (subcommand !== "download") {
    throw argumentError("Expected: artifacts list|get|download")
  }
  const parsed = parseArguments(rest, { values: ["path", "output"] })
  const artifactId = parsed.onlyPositional()
  const output = requiredOption(parsed, "output")
  const path = parsed.one("path")
  const content = await client.artifacts.download(artifactId, {
    ...(path === undefined ? {} : { path }),
    signal: context.signal,
  })
  const destination = resolve(context.cwd, output)
  if (await Bun.file(destination).exists()) {
    throw argumentError("Artifact output path already exists", { output: destination })
  }
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`
  const sink = Bun.file(temporary).writer()
  const digest = new Bun.CryptoHasher("sha256")
  let bytes = 0
  try {
    for await (const chunk of content.body) {
      digest.update(chunk)
      bytes += chunk.byteLength
      await sink.write(chunk)
    }
    await sink.end()
    if (bytes !== content.byteSize || digest.digest("hex") !== content.digest) {
      throw new CliError({
        code: "ARTIFACT_INTEGRITY_FAILED",
        message: "Downloaded artifact content does not match its immutable metadata",
      })
    }
    try {
      // A hard-link commit is atomic and refuses an output path created after
      // the preflight check; rename would silently overwrite it on POSIX.
      await link(temporary, destination)
    } catch (cause) {
      if (isFilesystemCode(cause, "EEXIST")) {
        throw argumentError("Artifact output path already exists", { output: destination })
      }
      throw cause
    }
    await unlink(temporary).catch(() => undefined)
  } catch (error) {
    try {
      await sink.end()
    } catch {}
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  await printJson(context, {
    artifactId,
    output: destination,
    digest: content.digest,
    byteSize: content.byteSize,
    mediaType: content.mediaType,
  })
}

async function briefsCommand(args: readonly string[], context: CliContext): Promise<void> {
  const [subcommand, ...rest] = args
  const client = apiClient(context)
  if (subcommand === "create") {
    const parsed = parseArguments(rest, { values: ["title", "path"] })
    const artifactId = parsed.onlyPositional()
    const path = parsed.one("path")
    const brief = await client.briefs.create(
      {
        artifactId,
        title: requiredOption(parsed, "title"),
        ...(path === undefined ? {} : { path }),
      },
      { signal: context.signal },
    )
    await printJson(context, { brief })
    return
  }
  if (subcommand === "list") {
    const parsed = parseArguments(rest, { values: ["limit", "before"] })
    parsed.requireNoPositionals()
    const before = parsed.one("before")
    await printJson(
      context,
      await client.briefs.list({
        limit: parseInteger(parsed.one("limit") ?? "50", "--limit", 1, 100),
        ...(before === undefined ? {} : { before }),
        signal: context.signal,
      }),
    )
    return
  }
  if (subcommand === "get") {
    const briefId = parseArguments(rest).onlyPositional()
    await printJson(context, {
      brief: await client.briefs.get(briefId, { signal: context.signal }),
    })
    return
  }
  throw argumentError("Expected: briefs create|list|get")
}

async function runLogs(args: readonly string[], context: CliContext): Promise<void> {
  const parsed = parseArguments(args, { values: ["after", "limit"], flags: ["follow"] })
  const runId = parsed.onlyPositional()
  const after = parseInteger(parsed.one("after") ?? "0", "--after", 0, Number.MAX_SAFE_INTEGER)
  const limit = parseInteger(parsed.one("limit") ?? "100", "--limit", 1, 1_000)
  if (!parsed.flag("follow")) {
    await printJson(
      context,
      await apiClient(context).runs.logs(runId, { after, limit, signal: context.signal }),
    )
    return
  }

  const client = apiClient(context)
  for await (const log of client.runs.followLogs(runId, {
    after,
    limit,
    signal: context.signal,
  })) {
    await context.stdout(`${JSON.stringify(log)}\n`)
  }
}

async function watchRun(args: readonly string[], context: CliContext): Promise<void> {
  const parsed = parseArguments(args, { values: ["after", "limit"], flags: ["json"] })
  const runId = parsed.onlyPositional()
  if (!parsed.flag("json")) {
    throw argumentError("watch currently requires --json so its output remains stable for agents")
  }
  const after = parseInteger(parsed.one("after") ?? "0", "--after", 0, Number.MAX_SAFE_INTEGER)
  const limit = parseInteger(parsed.one("limit") ?? "100", "--limit", 1, 1_000)
  for await (const event of apiClient(context).runs.followEvents(runId, {
    after,
    limit,
    signal: context.signal,
  })) {
    await context.stdout(`${JSON.stringify(event)}\n`)
  }
}

async function sessionsCommand(args: readonly string[], context: CliContext): Promise<void> {
  const [command, ...rest] = args
  switch (command) {
    case "create":
      await createSession(rest, context)
      return
    case "list":
      await listSessions(rest, context)
      return
    case "get":
      await getSession(rest, context)
      return
    case "send":
      await sendSessionTurn(rest, context)
      return
    case "turns":
      await listSessionTurns(rest, context)
      return
    case "turn":
      await getSessionTurn(rest, context)
      return
    case "watch":
      await watchSession(rest, context)
      return
    case "interrupt":
      await mutateSession(rest, context, "interrupt")
      return
    case "close":
      await mutateSession(rest, context, "close")
      return
    default:
      throw argumentError("Unknown sessions command", { command })
  }
}

async function createSession(args: readonly string[], context: CliContext): Promise<void> {
  const parsed = parseArguments(args, {
    values: [
      "repo",
      "files",
      "revision",
      "credential-ref",
      "agent",
      "provider",
      "env",
      "secret",
      "idle-timeout",
      "idempotency-key",
    ],
  })
  parsed.requireNoPositionals()
  const env = parseAssignments(parsed.many("env"), "--env", parseEnvironmentValue)
  const secretRefs = parseAssignments(parsed.many("secret"), "--secret", parseSecretReference)
  assertDisjointEnvironment(env, secretRefs)
  const idempotencyKey = parsed.one("idempotency-key")
  const session = await apiClient(context).sessions.create(
    {
      workspace: await executionWorkspace(parsed, context),
      agentType: requiredOption(parsed, "agent"),
      provider: parsed.one("provider") ?? context.environment.MEANWHILE_DEFAULT_PROVIDER ?? "local",
      env,
      secretRefs,
      idleTimeoutMs: parseDurationOption(parsed.one("idle-timeout") ?? "30m", "--idle-timeout"),
    },
    {
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      signal: context.signal,
    },
  )
  await printJson(context, { session })
}

async function listSessions(args: readonly string[], context: CliContext): Promise<void> {
  const parsed = parseArguments(args, { values: ["limit", "before"] })
  parsed.requireNoPositionals()
  const before = parsed.one("before")
  await printJson(
    context,
    await apiClient(context).sessions.list({
      limit: parseInteger(parsed.one("limit") ?? "50", "--limit", 1, 100),
      ...(before === undefined ? {} : { before }),
      signal: context.signal,
    }),
  )
}

async function getSession(args: readonly string[], context: CliContext): Promise<void> {
  const parsed = parseArguments(args)
  await printJson(context, {
    session: await apiClient(context).sessions.get(parsed.onlyPositional(), {
      signal: context.signal,
    }),
  })
}

async function sendSessionTurn(args: readonly string[], context: CliContext): Promise<void> {
  const delimiter = args.indexOf("--")
  if (delimiter < 0) throw argumentError("Turn prompt must follow a -- delimiter")
  const parsed = parseArguments(args.slice(0, delimiter), {
    values: ["brief", "conflict", "timeout", "idempotency-key"],
  })
  const sessionId = parsed.onlyPositional()
  const prompt = args
    .slice(delimiter + 1)
    .join(" ")
    .trim()
  if (prompt.length === 0) throw argumentError("Turn prompt must not be empty")
  const conflictPolicy = parsed.one("conflict") ?? "reject"
  if (!["reject", "enqueue", "interrupt_and_send"].includes(conflictPolicy)) {
    throw argumentError("--conflict must be reject, enqueue, or interrupt_and_send")
  }
  const idempotencyKey = parsed.one("idempotency-key")
  const turn = await apiClient(context).sessions.send(
    sessionId,
    {
      prompt,
      briefIds: [...uniqueValues(parsed.many("brief"), "--brief")],
      timeoutMs: parseDurationOption(parsed.one("timeout") ?? "1h", "--timeout"),
      conflictPolicy: conflictPolicy as "reject" | "enqueue" | "interrupt_and_send",
    },
    {
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      signal: context.signal,
    },
  )
  await printJson(context, { turn })
}

async function listSessionTurns(args: readonly string[], context: CliContext): Promise<void> {
  const parsed = parseArguments(args, { values: ["after", "limit"] })
  await printJson(
    context,
    await apiClient(context).sessions.turns(parsed.onlyPositional(), {
      after: parseInteger(parsed.one("after") ?? "0", "--after", 0, Number.MAX_SAFE_INTEGER),
      limit: parseInteger(parsed.one("limit") ?? "100", "--limit", 1, 1_000),
      signal: context.signal,
    }),
  )
}

async function getSessionTurn(args: readonly string[], context: CliContext): Promise<void> {
  const [sessionId, turnId] = parseArguments(args).requirePositionals(2)
  await printJson(context, {
    turn: await apiClient(context).sessions.getTurn(sessionId as string, turnId as string, {
      signal: context.signal,
    }),
  })
}

async function watchSession(args: readonly string[], context: CliContext): Promise<void> {
  const parsed = parseArguments(args, { values: ["after", "limit"], flags: ["json"] })
  const sessionId = parsed.onlyPositional()
  if (!parsed.flag("json")) {
    throw argumentError("sessions watch requires --json so its output remains stable for agents")
  }
  const after = parseInteger(parsed.one("after") ?? "0", "--after", 0, Number.MAX_SAFE_INTEGER)
  const limit = parseInteger(parsed.one("limit") ?? "100", "--limit", 1, 1_000)
  for await (const event of apiClient(context).sessions.followEvents(sessionId, {
    after,
    limit,
    signal: context.signal,
  })) {
    await context.stdout(`${JSON.stringify(event)}\n`)
  }
}

async function mutateSession(
  args: readonly string[],
  context: CliContext,
  operation: "interrupt" | "close",
): Promise<void> {
  const parsed = parseArguments(args)
  const sessionId = parsed.onlyPositional()
  const session = await apiClient(context).sessions[operation](sessionId, {
    signal: context.signal,
  })
  await printJson(context, { session })
}

async function executionWorkspace(parsed: ParsedArguments, context: CliContext) {
  const repository = parsed.one("repo")
  const directory = parsed.one("files")
  if ((repository === undefined) === (directory === undefined)) {
    throw argumentError("Exactly one of --repo or --files is required")
  }
  const revision = parsed.one("revision")
  const credentialRef = parsed.one("credential-ref")
  if (directory !== undefined && (revision !== undefined || credentialRef !== undefined)) {
    throw argumentError("--revision and --credential-ref require --repo")
  }
  return repository === undefined
    ? {
        type: "files" as const,
        files: await captureWorkspace(directory as string, context.cwd),
      }
    : {
        type: "repository" as const,
        url: repository,
        ...(revision === undefined ? {} : { revision }),
        ...(credentialRef === undefined
          ? {}
          : { credentialRef: parseSecretReference(credentialRef) }),
      }
}

function assertDisjointEnvironment(
  env: Readonly<Record<string, string>>,
  secretRefs: Readonly<Record<string, string>>,
): void {
  for (const name of Object.keys(secretRefs)) {
    if (Object.hasOwn(env, name)) {
      throw argumentError("A name cannot appear in both --env and --secret", { name })
    }
  }
}

async function createDeployment(args: readonly string[], context: CliContext): Promise<void> {
  const parsed = parseArguments(args, {
    values: ["artifact", "workspace", "target", "config", "secret", "idempotency-key"],
  })
  const runId = parsed.onlyPositional()
  const artifactPath = parsed.one("artifact")
  const workspacePath = parsed.one("workspace")
  const source = deploymentSource(artifactPath, workspacePath)
  const config = parseAssignments(
    parsed.many("config"),
    "--config",
    (value) => {
      try {
        return JSON.parse(value) as unknown
      } catch {
        throw argumentError("--config values must be JSON")
      }
    },
    parseConfigName,
  )
  const body = {
    runId,
    ...source,
    deployTarget: requiredOption(parsed, "target"),
    config,
    secretRefs: parseAssignments(parsed.many("secret"), "--secret", parseSecretReference),
  }
  const deployment = await apiClient(context).deployments.create(body, {
    idempotencyKey: requiredOption(parsed, "idempotency-key"),
    signal: context.signal,
  })
  await printJson(context, { deployment })
}

function deploymentSource(
  artifactPath: string | undefined,
  workspacePath: string | undefined,
): { readonly artifactPath: string } | { readonly workspacePath: string } {
  if (artifactPath !== undefined && workspacePath === undefined) return { artifactPath }
  if (workspacePath !== undefined && artifactPath === undefined) return { workspacePath }
  throw argumentError("Exactly one of --artifact or --workspace is required")
}

async function deploymentsCommand(args: readonly string[], context: CliContext): Promise<void> {
  const [subcommand, ...rest] = args
  if (subcommand === "list") {
    const parsed = parseArguments(rest, { values: ["limit", "before"] })
    parsed.requireNoPositionals()
    const before = parsed.one("before")
    await printJson(
      context,
      await apiClient(context).deployments.list({
        limit: parseInteger(parsed.one("limit") ?? "50", "--limit", 1, 100),
        ...(before === undefined ? {} : { before }),
        signal: context.signal,
      }),
    )
    return
  }
  if (subcommand === "logs") {
    const parsed = parseArguments(rest, { values: ["after", "limit"] })
    const deploymentId = parsed.onlyPositional()
    const query = new URLSearchParams({
      after: String(
        parseInteger(parsed.one("after") ?? "0", "--after", 0, Number.MAX_SAFE_INTEGER),
      ),
      limit: String(parseInteger(parsed.one("limit") ?? "100", "--limit", 1, 1_000)),
    })
    await printJson(
      context,
      await apiClient(context).deployments.logs(deploymentId, {
        after: Number(query.get("after")),
        limit: Number(query.get("limit")),
        signal: context.signal,
      }),
    )
    return
  }
  if (subcommand !== "get") throw argumentError("Expected: deployments list|get|logs")
  const parsed = parseArguments(rest)
  const deploymentId = parsed.onlyPositional()
  await printJson(context, {
    deployment: await apiClient(context).deployments.get(deploymentId, {
      signal: context.signal,
    }),
  })
}

async function auditCommand(args: readonly string[], context: CliContext): Promise<void> {
  const [subcommand, ...rest] = args
  if (subcommand !== "list") throw argumentError("Expected: audit list")
  const parsed = parseArguments(rest, {
    values: ["limit", "before", "resource-type", "resource-id", "action"],
  })
  parsed.requireNoPositionals()
  const before = parsed.one("before")
  const resourceType = parsed.one("resource-type")
  const allowed = [
    "owner",
    "api_key",
    "run",
    "session",
    "turn",
    "runtime",
    "artifact",
    "deployment",
  ] as const
  if (resourceType !== undefined && !allowed.includes(resourceType as (typeof allowed)[number])) {
    throw argumentError("--resource-type is invalid", { resourceType })
  }
  const resourceId = parsed.one("resource-id")
  const action = parsed.one("action")
  await printJson(
    context,
    await apiClient(context).audit.list({
      limit: parseInteger(parsed.one("limit") ?? "50", "--limit", 1, 100),
      ...(before === undefined ? {} : { before }),
      ...(resourceType === undefined
        ? {}
        : { resourceType: resourceType as (typeof allowed)[number] }),
      ...(resourceId === undefined ? {} : { resourceId }),
      ...(action === undefined ? {} : { action }),
      signal: context.signal,
    }),
  )
}

async function apiKeysCommand(args: readonly string[], context: CliContext): Promise<void> {
  const [subcommand, ...rest] = args
  const client = apiClient(context)
  if (subcommand === "create") {
    const parsed = parseArguments(rest, { values: ["name"] })
    parsed.requireNoPositionals()
    await printJson(
      context,
      await client.apiKeys.create(requiredOption(parsed, "name"), { signal: context.signal }),
    )
    return
  }
  if (subcommand === "list") {
    parseArguments(rest).requireNoPositionals()
    await printJson(context, { items: await client.apiKeys.list({ signal: context.signal }) })
    return
  }
  if (subcommand === "revoke") {
    const id = parseArguments(rest).onlyPositional()
    await printJson(context, { key: await client.apiKeys.revoke(id, { signal: context.signal }) })
    return
  }
  throw argumentError("Expected: api-keys create|list|revoke")
}

async function providersCommand(args: readonly string[], context: CliContext): Promise<void> {
  const [subcommand, ...rest] = args
  if (subcommand !== "test") throw argumentError("Expected: providers test <provider>")
  const parsed = parseArguments(rest)
  const provider = parsed.onlyPositional()
  await printJson(
    context,
    await apiClient(context).providers.test(provider, { signal: context.signal }),
  )
}

async function keyCommand(args: readonly string[], context: CliContext): Promise<void> {
  const parsed = parseArguments(args)
  const [subcommand] = parsed.requirePositionals(1)
  if (subcommand !== "generate") throw argumentError("Expected: key generate")
  const issued = await issueApiKey()
  await printJson(context, {
    key: issued.key,
    prefix: issued.prefix,
    warning:
      "This key is shown once, generated locally, and not registered or persisted; use it only for initial local bootstrap.",
  })
}

async function dataCommand(args: readonly string[], context: CliContext): Promise<void> {
  const [subcommand, ...rest] = args
  if (subcommand === "verify") {
    const backup = parseArguments(rest).onlyPositional()
    await printJson(context, { manifest: await verifyDataBackup(resolve(context.cwd, backup)) })
    return
  }
  const paths = localDataRootPaths(context)
  if (subcommand === "backup") {
    const parsed = parseArguments(rest, { values: ["output"] })
    parsed.requireNoPositionals()
    const output = resolve(context.cwd, requiredOption(parsed, "output"))
    await printJson(context, { output, manifest: await backupDataRoot(paths, output) })
    return
  }
  if (subcommand === "restore") {
    const backup = parseArguments(rest).onlyPositional()
    await printJson(context, {
      dataDir: paths.dataDir,
      manifest: await restoreDataRoot(resolve(context.cwd, backup), paths),
    })
    return
  }
  if (subcommand === "gc") {
    const parsed = parseArguments(rest, { flags: ["dry-run", "apply"] })
    parsed.requireNoPositionals()
    if (parsed.flag("dry-run") === parsed.flag("apply")) {
      throw argumentError("Exactly one of --dry-run or --apply is required")
    }
    await printJson(context, await garbageCollectDataRoot(paths, parsed.flag("dry-run")))
    return
  }
  throw argumentError("Expected: data backup|verify|restore|gc")
}

function localDataRootPaths(context: CliContext) {
  const configured = context.environment["MEANWHILE_DATA_DIR"] ?? "./data"
  const dataDir = resolve(context.cwd, configured)
  return {
    dataDir,
    databasePath: join(dataDir, "meanwhile.sqlite"),
    artifactDir: join(dataDir, "artifacts"),
    runtimeDir: join(dataDir, "runtimes"),
    deploymentDir: join(dataDir, "deployments"),
  }
}

interface DoctorCheck {
  readonly name: string
  readonly status: "healthy" | "degraded" | "unavailable"
  readonly message?: string
  readonly details?: Readonly<Record<string, unknown>>
}

async function doctor(args: readonly string[], context: CliContext): Promise<number> {
  parseArguments(args).requireNoPositionals()
  const checks: DoctorCheck[] = []
  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig({ ...context.environment })
    checks.push({ name: "configuration", status: "healthy" })
  } catch {
    checks.push({
      name: "configuration",
      status: "unavailable",
      message: "Environment configuration is invalid",
    })
    await printDoctor(context, checks)
    return 1
  }

  checks.push({
    name: "secret-source-catalog",
    status: "healthy",
    message:
      config.secretSourceCatalog.length === 0
        ? "Public secret references are deny-all"
        : "Public secret references are restricted to the configured catalog",
    details: { sourceCount: config.secretSourceCatalog.length },
  })
  checks.push({
    name: "local-provider-policy",
    status: "healthy",
    details: {
      enabled: config.localProvider.enabled,
      unsafeHostExecution: config.localProvider.unsafeHostExecution,
    },
  })

  try {
    await prepareDataDirectories(config)
    const store = new Store(config.databasePath)
    try {
      store.assertHealthyWriter()
      const prefix = config.apiKey === undefined ? null : apiKeyPrefix(config.apiKey)
      let bootstrapStatus: BootstrapIdentityStatus
      if (config.apiKey === undefined) {
        bootstrapStatus = store.inspectBootstrapIdentity()
      } else if (prefix === null) {
        bootstrapStatus = "conflict" as const
      } else {
        bootstrapStatus = store.inspectBootstrapIdentity({
          ownerId: LOCAL_BOOTSTRAP_OWNER_ID,
          ownerName: "Local owner",
          apiKeyId: LOCAL_BOOTSTRAP_API_KEY_ID,
          apiKeyPrefix: prefix,
          apiKeyHash: await hashApiKey(config.apiKey),
          apiKeyName: "Local bootstrap key",
          createdAt: new Date().toISOString(),
        })
      }
      checks.push(
        bootstrapStatus === "required" || bootstrapStatus === "conflict"
          ? {
              name: "bootstrap-identity",
              status: "unavailable",
              message:
                bootstrapStatus === "required"
                  ? "MEANWHILE_API_KEY is required to initialize the empty database"
                  : "Configured bootstrap key conflicts with the initialized database",
            }
          : {
              name: "bootstrap-identity",
              status: "healthy",
              details: { state: bootstrapStatus },
            },
      )
    } finally {
      store.close()
    }
    checks.push({ name: "persistence", status: "healthy" })
  } catch (error) {
    checks.push(
      error instanceof AppError
        ? {
            name: "persistence",
            status: "unavailable",
            message: error.message,
            details: { code: error.code },
          }
        : {
            name: "persistence",
            status: "unavailable",
            message: "SQLite could not be opened or written",
          },
    )
  }

  let catalog: AgentCatalog | undefined
  try {
    catalog = await AgentCatalog.load(config.agentCatalogPath)
    checks.push({
      name: "agent-catalog",
      status: "healthy",
      details: { agents: catalog.list() },
    })
  } catch {
    checks.push({
      name: "agent-catalog",
      status: "unavailable",
      message: "Agent catalog is invalid or unreadable",
    })
  }

  if (catalog !== undefined && config.localProvider.enabled) {
    const unavailable: string[] = []
    const executablePath = `${dirname(config.runnerPath)}${delimiter}${context.environment["PATH"] ?? ""}`
    for (const name of catalog.list()) {
      const executable = catalog.resolve(name).executable
      if (!(await executableExists(executable, false, executablePath))) unavailable.push(name)
    }
    checks.push(
      unavailable.length === 0
        ? { name: "agent-executables", status: "healthy" }
        : {
            name: "agent-executables",
            status: "degraded",
            message: "Some configured agents are not installed",
            details: { unavailable },
          },
    )
  }

  checks.push(
    (await executableExists(config.runnerPath, true))
      ? { name: "runner", status: "healthy" }
      : {
          name: "runner",
          status: "unavailable",
          message: "Runner executable is missing or not executable",
        },
  )

  const providers = [
    ...(config.localProvider.enabled
      ? [
          new LocalRuntimeProvider({
            rootDirectory: config.runtimeDir,
            runnerExecutable: config.runnerPath,
          }),
        ]
      : []),
    ...(config.cloudflare === undefined
      ? []
      : [
          new CloudflareRuntimeProvider({
            bridgeUrl: config.cloudflare.bridgeUrl,
            bridgeToken: config.cloudflare.token,
            requestTimeoutMs: 3_000,
          }),
        ]),
  ]
  const providerRegistry = new RuntimeProviderRegistry(providers)
  checks.push(
    providerRegistry.has(config.defaultProvider)
      ? {
          name: "default-provider",
          status: "healthy",
          details: { provider: config.defaultProvider },
        }
      : {
          name: "default-provider",
          status: "unavailable",
          message: "The configured default provider is not registered",
          details: { provider: config.defaultProvider },
        },
  )
  for (const provider of providers) {
    const health = await provider.health()
    checks.push({
      name: `provider:${provider.name}`,
      status: health.status,
      ...(health.message === undefined ? {} : { message: health.message }),
    })
  }

  checks.push({ name: "deployment:local-static", status: "healthy" })
  if (context.environment.MEANWHILE_URL !== undefined) {
    try {
      const url = parseBaseUrl(context.environment.MEANWHILE_URL)
      const response = await context.fetch(new URL("readyz", url), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(2_000),
      })
      checks.push(
        response.ok
          ? { name: "control-plane", status: "healthy" }
          : {
              name: "control-plane",
              status: "degraded",
              message: "Control-plane readiness check failed",
            },
      )
    } catch {
      checks.push({
        name: "control-plane",
        status: "degraded",
        message: "Configured control plane is unreachable",
      })
    }
  }

  await printDoctor(context, checks)
  return checks.some((check) => check.status === "unavailable") ? 1 : 0
}

async function printDoctor(context: CliContext, checks: readonly DoctorCheck[]): Promise<void> {
  const status = checks.some((check) => check.status === "unavailable")
    ? "unavailable"
    : checks.some((check) => check.status === "degraded")
      ? "degraded"
      : "healthy"
  await printJson(context, { status, checks })
}

function apiClient(context: CliContext): Meanwhile {
  const key = context.environment.MEANWHILE_API_KEY
  if (key === undefined || apiKeyPrefix(key) === null) {
    throw new CliError({
      code: "AUTHENTICATION_REQUIRED",
      message: "MEANWHILE_API_KEY must contain a valid Meanwhile API key",
      exitCode: 2,
    })
  }
  return new Meanwhile({
    baseUrl: parseBaseUrl(context.environment.MEANWHILE_URL ?? DEFAULT_URL),
    apiKey: key,
    fetch: context.fetch,
    wait: context.wait,
  })
}

function parseBaseUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw argumentError("MEANWHILE_URL must be an absolute HTTP URL")
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw argumentError("MEANWHILE_URL must be an origin without credentials, query, or path")
  }
  url.pathname = "/"
  return url
}

function abortableCliDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || milliseconds <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timeout = setTimeout(finish, milliseconds)
    signal.addEventListener("abort", finish, { once: true })
  })
}

class ParsedArguments {
  constructor(
    readonly positionals: readonly string[],
    private readonly options: ReadonlyMap<string, readonly string[]>,
    private readonly flags: ReadonlySet<string>,
  ) {}

  one(name: string): string | undefined {
    const values = this.options.get(name) ?? []
    if (values.length > 1) throw argumentError(`--${name} may be provided only once`)
    return values[0]
  }

  many(name: string): readonly string[] {
    return this.options.get(name) ?? []
  }

  flag(name: string): boolean {
    return this.flags.has(name)
  }

  requirePositionals(count: number): string[] {
    if (this.positionals.length !== count) {
      throw argumentError(`Expected ${count} positional argument${count === 1 ? "" : "s"}`)
    }
    return [...this.positionals]
  }

  requireNoPositionals(): void {
    this.requirePositionals(0)
  }

  onlyPositional(): string {
    this.requirePositionals(1)
    return this.positionals[0] as string
  }
}

function parseArguments(
  args: readonly string[],
  specification: { readonly values?: readonly string[]; readonly flags?: readonly string[] } = {},
): ParsedArguments {
  const valueNames = new Set(specification.values ?? [])
  const flagNames = new Set(specification.flags ?? [])
  const values = new Map<string, string[]>()
  const flags = new Set<string>()
  const positionals: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string
    if (!token.startsWith("--") || token === "--") {
      positionals.push(token)
      continue
    }
    const assignment = token.indexOf("=")
    const name = token.slice(2, assignment < 0 ? undefined : assignment)
    if (flagNames.has(name)) {
      if (assignment >= 0) throw argumentError(`--${name} does not accept a value`)
      if (flags.has(name)) throw argumentError(`--${name} may be provided only once`)
      flags.add(name)
      continue
    }
    if (!valueNames.has(name)) throw argumentError("Unknown option", { option: `--${name}` })
    const value = assignment < 0 ? args[++index] : token.slice(assignment + 1)
    if (value === undefined || value.startsWith("--")) {
      throw argumentError(`--${name} requires a value`)
    }
    const existing = values.get(name) ?? []
    existing.push(value)
    values.set(name, existing)
  }
  return new ParsedArguments(positionals, values, flags)
}

function requiredOption(parsed: ParsedArguments, name: string): string {
  const value = parsed.one(name)
  if (value === undefined || value.length === 0) throw argumentError(`--${name} is required`)
  return value
}

function parseAssignments<Value>(
  inputs: readonly string[],
  option: string,
  parseValue: (value: string) => Value,
  parseName: (value: string) => string = parseEnvironmentName,
): Record<string, Value> {
  const result: Record<string, Value> = {}
  for (const input of inputs) {
    const separator = input.indexOf("=")
    if (separator < 1) throw argumentError(`${option} requires NAME=VALUE`)
    const name = parseName(input.slice(0, separator))
    if (Object.hasOwn(result, name))
      throw argumentError(`${option} contains a duplicate name`, { name })
    result[name] = parseValue(input.slice(separator + 1))
  }
  return result
}

function parseEnvironmentName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw argumentError("Environment variable name is invalid", { name: value })
  }
  return value
}

function parseEnvironmentValue(value: string): string {
  if (value.length > 32_768 || value.includes("\0")) {
    throw argumentError("Environment value is invalid or too large")
  }
  return value
}

function parseConfigName(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw argumentError("Deployment configuration name is invalid", { name: value })
  }
  return value
}

function parseSecretReference(value: string): string {
  if (!/^env:\/\/[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw argumentError("Secret references must use env://NAME")
  }
  return value
}

function uniqueValues(values: readonly string[], option: string): readonly string[] {
  const result = new Set<string>()
  for (const value of values) {
    if (result.has(value)) throw argumentError(`${option} must not contain duplicates`, { value })
    result.add(value)
  }
  return [...result]
}

function parseInteger(value: string, option: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) throw argumentError(`${option} must be an integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw argumentError(`${option} is outside its allowed range`, { minimum, maximum })
  }
  return parsed
}

function parseDuration(value: string): number {
  return parseDurationOption(value, "--timeout")
}

function parseDurationOption(value: string, option: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value)
  if (match === null) throw argumentError(`${option} must be an integer with ms, s, m, or h`)
  const number = Number(match[1])
  const multiplier: number = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[
    (match[2] ?? "ms") as "ms" | "s" | "m" | "h"
  ]
  const milliseconds = number * multiplier
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1_000 || milliseconds > 86_400_000) {
    throw argumentError(`${option} must be between 1s and 24h`)
  }
  return milliseconds
}

async function executableExists(
  executable: string,
  requireExecutable = false,
  searchPath?: string,
): Promise<boolean> {
  const path = executable.includes("/")
    ? executable
    : Bun.which(executable, searchPath === undefined ? undefined : { PATH: searchPath })
  if (path === null) return false
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) return false
    if (requireExecutable) await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function normalizeCliError(error: unknown): CliError {
  if (error instanceof CliError) return error
  if (error instanceof AppError) {
    return new CliError({
      code: error.code,
      message: error.message,
      details: error.details ?? {},
      ...(error.status >= 400 && error.status < 500 ? { exitCode: 2 } : {}),
    })
  }
  if (error instanceof MeanwhileError || error instanceof WorkspaceCaptureError) {
    return new CliError({
      code: error.code,
      message: error.message,
      ...(error instanceof MeanwhileError && error.requestId !== undefined
        ? { requestId: error.requestId }
        : {}),
      details: error.details,
      ...(error.code === "INVALID_ARGUMENT" ? { exitCode: 2 } : {}),
    })
  }
  return new CliError(
    { code: "INTERNAL", message: "Command failed unexpectedly" },
    { cause: error },
  )
}

function isFilesystemCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

function argumentError(message: string, details: Readonly<Record<string, unknown>> = {}): CliError {
  return new CliError({ code: "INVALID_ARGUMENT", message, exitCode: 2, details })
}

async function printJson(context: CliContext, value: unknown): Promise<void> {
  await context.stdout(`${JSON.stringify(value, null, 2)}\n`)
}

function fileSinkWriter(file: Bun.BunFile): Write {
  const writer = file.writer()
  return async (text) => {
    writer.write(text)
    await writer.flush()
  }
}

const HELP = `Meanwhile ${SERVICE_VERSION} — run any ACP coding agent in any isolated runtime.

Usage:
  meanwhile serve                       Start the control plane on this host
  meanwhile run (--repo URL | --files DIR) --agent NAME [options] -- TASK
  meanwhile list [--limit N] [--before CURSOR]
  meanwhile get RUN_ID
  meanwhile logs RUN_ID [--follow] [--after N] [--limit N]
  meanwhile watch RUN_ID --json [--after N] [--limit N]
  meanwhile cancel RUN_ID
  meanwhile sessions create (--repo URL | --files DIR) --agent NAME [options]
  meanwhile sessions list [--limit N]
  meanwhile sessions get SESSION_ID
  meanwhile sessions send SESSION_ID [--brief BRIEF_ID] [--conflict POLICY] [--timeout DURATION] -- PROMPT
  meanwhile sessions turns SESSION_ID
  meanwhile sessions watch SESSION_ID --json [--after N] [--limit N]
  meanwhile sessions interrupt SESSION_ID
  meanwhile sessions close SESSION_ID
  meanwhile artifacts list RUN_ID
  meanwhile artifacts get ARTIFACT_ID
  meanwhile artifacts download ARTIFACT_ID [--path PATH] --output FILE
  meanwhile briefs create ARTIFACT_ID --title TITLE [--path PATH]
  meanwhile briefs list [--limit N] [--before CURSOR]
  meanwhile briefs get BRIEF_ID
  meanwhile deploy RUN_ID (--artifact PATH | --workspace PATH) --target NAME --idempotency-key KEY
  meanwhile deployments list [--limit N] [--before CURSOR]
  meanwhile deployments get DEPLOYMENT_ID
  meanwhile deployments logs DEPLOYMENT_ID [--after N] [--limit N]
  meanwhile audit list [--resource-type TYPE] [--resource-id ID] [--action ACTION]
  meanwhile api-keys create --name NAME
  meanwhile api-keys list
  meanwhile api-keys revoke KEY_ID
  meanwhile providers test PROVIDER
  meanwhile doctor
  meanwhile key generate
  meanwhile data backup --output BACKUP_DIR
  meanwhile data verify BACKUP_DIR
  meanwhile data restore BACKUP_DIR
  meanwhile data gc (--dry-run | --apply)

Run options:
  --provider NAME             Runtime provider (default: MEANWHILE_DEFAULT_PROVIDER or local)
  --revision REVISION         Repository revision
  --credential-ref env://VAR  Repository credential reference
  --brief BRIEF_ID            Curated prior evidence to reuse; repeatable
  --artifact PATH             Declared output path; repeatable
  --env NAME=VALUE            Persisted non-secret environment; repeatable
  --secret NAME=env://VAR     Secret reference; repeatable
  --timeout 30s|10m|1h        Provisioning-through-agent deadline
  --idempotency-key KEY       Safe retry identity

Session options:
  --idle-timeout 30s|10m|1h   Close an inactive live session and release compute
  --brief BRIEF_ID            Curated prior evidence for this turn; repeatable
  --conflict POLICY           reject, enqueue, or interrupt_and_send

Deployment options:
  --config NAME=JSON          Target configuration; repeatable
  --secret NAME=env://VAR     Deployment secret reference; repeatable
  --idempotency-key KEY       Required safe retry identity

The 'serve' command starts the control plane on this host, reading MEANWHILE_*
configuration (MEANWHILE_API_KEY is required; generate one with 'meanwhile key
generate'). Every other command is a client that reads MEANWHILE_URL (default
${DEFAULT_URL}) and MEANWHILE_API_KEY to reach a running control plane.
The local provider executes on this host and is not a security sandbox.
`

if (import.meta.main) process.exitCode = await runCli()
