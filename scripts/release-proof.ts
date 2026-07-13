import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createApplication, type MeanwhileApplication } from "../src/app"
import { issueApiKey } from "../src/auth"
import { Meanwhile, MeanwhileError } from "../src/client"
import type { AppConfig } from "../src/config"
import { backupDataRoot, verifyDataBackup } from "../src/data-root"
import { initializeInstrumentation } from "../src/instrumentation"
import { SERVICE_VERSION } from "../src/version"

type ProofProvider = "local" | "cloudflare"

interface RunningInstance {
  readonly application: MeanwhileApplication
  readonly server: ReturnType<typeof Bun.serve>
  readonly client: Meanwhile
  close(): Promise<void>
}

class ProofError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = "ProofError"
  }
}

const provider = selectedProvider(process.argv.slice(2))
const requireProvenance = process.argv.includes("--require-provenance")
const root = await mkdtemp(join(tmpdir(), "meanwhile-release-proof-"))
const dataDir = join(root, "data")
const backupDir = join(root, "backup")
const runnerPath = resolve("dist/meanwhile-runner")
const catalogPath = resolve("config/agents.json")
const key = await issueApiKey()
const previewPort = await reservePort()
const config = proofConfig({
  provider,
  dataDir,
  runnerPath,
  catalogPath,
  previewPort,
  key: key.key,
})
let running: RunningInstance | null = null

try {
  if (requireProvenance && provider === "cloudflare") assertRemoteProvenance(config)
  const revision = await repositoryRevision()
  const previewText = `Meanwhile ${provider} release proof`
  running = await startInstance(config, key.key)
  const providerDiagnostics = await running.client.providers.test(provider)
  if (providerDiagnostics.health.status !== "healthy") {
    throw new ProofError("PROVIDER_UNHEALTHY", "The selected provider is not healthy")
  }

  const created = await running.client.runs.create(
    {
      workspace: {
        type: "files",
        files: [
          {
            path: "site/index.html",
            contentBase64: new TextEncoder()
              .encode(`<!doctype html><title>Meanwhile</title><h1>${previewText}</h1>`)
              .toBase64(),
          },
        ],
      },
      agentType: "demo",
      provider,
      prompt: "Verify the immutable release-proof workspace and finish successfully.",
      artifactPaths: ["site"],
      timeoutMs: 60_000,
    },
    { idempotencyKey: `release-proof:${provider}:${revision.commit}` },
  )
  const run = await running.client.runs.wait(created.id, {
    timeoutMs: provider === "cloudflare" ? 120_000 : 30_000,
    pollIntervalMs: 50,
  })
  if (run.status !== "succeeded" || run.executionProvenance === null) {
    throw new ProofError("RUN_PROOF_FAILED", "The release-proof run did not succeed", {
      status: run.status,
      error: run.error,
    })
  }
  const logs = await running.client.runs.logs(run.id, { limit: 1_000 })
  const eventTypes = new Set(logs.items.map(({ eventType }) => eventType))
  for (const event of ["agent.initialized", "session.started", "terminal"]) {
    if (!eventTypes.has(event)) {
      throw new ProofError("RUN_EVIDENCE_INCOMPLETE", "Durable ACP evidence is incomplete", {
        event,
      })
    }
  }

  const artifact = (await running.client.artifacts.list(run.id)).find(
    ({ logicalPath }) => logicalPath === "site",
  )
  if (artifact === undefined) {
    throw new ProofError("ARTIFACT_MISSING", "The declared release artifact was not captured")
  }
  const artifactDetail = await running.client.artifacts.get(artifact.id)
  const downloaded = await running.client.artifacts.download(artifact.id, { path: "index.html" })
  const downloadedBytes = new Uint8Array(await new Response(downloaded.body).arrayBuffer())
  if (
    downloadedBytes.byteLength !== downloaded.byteSize ||
    sha256(downloadedBytes) !== downloaded.digest ||
    !new TextDecoder().decode(downloadedBytes).includes(previewText) ||
    artifactDetail.entries.length !== 1
  ) {
    throw new ProofError("ARTIFACT_INTEGRITY_FAILED", "Downloaded artifact bytes are invalid")
  }

  const deployment = await running.client.deployments.wait(
    (
      await running.client.deployments.create({
        runId: run.id,
        artifactPath: "site",
        deployTarget: "local-static",
      })
    ).id,
    { timeoutMs: 30_000, pollIntervalMs: 50 },
  )
  if (deployment.status !== "succeeded" || deployment.url === null) {
    throw new ProofError("DEPLOYMENT_PROOF_FAILED", "Immutable deployment did not succeed")
  }
  await assertPreview(deployment.url, previewText)
  const cleanupAudit = await waitForAudit(running.client, run.id, "runtime.destroy", 30_000)

  const runId = run.id
  const deploymentId = deployment.id
  const deploymentUrl = deployment.url
  const provenanceDigest = run.executionProvenance.digest
  await running.close()
  running = null

  running = await startInstance(config, key.key)
  const recoveredRun = await running.client.runs.get(runId)
  const recoveredDeployment = await running.client.deployments.get(deploymentId)
  const recoveredArtifact = await running.client.artifacts.get(artifact.id)
  const recoveredAudit = await running.client.audit.list({ resourceId: runId, limit: 100 })
  await assertPreview(deploymentUrl, previewText)
  if (
    recoveredRun.status !== "succeeded" ||
    recoveredRun.executionProvenance?.digest !== provenanceDigest ||
    recoveredDeployment.status !== "succeeded" ||
    recoveredArtifact.artifact.digest !== artifact.digest ||
    recoveredAudit.items.length === 0
  ) {
    throw new ProofError("RESTART_PROOF_FAILED", "Durable evidence changed after restart")
  }
  await running.close()
  running = null

  const backup = await backupDataRoot(config, backupDir)
  const verifiedBackup = await verifyDataBackup(backupDir)
  const result = {
    proof: "meanwhile-release",
    status: "succeeded",
    provider,
    revision,
    provenance: {
      digest: provenanceDigest,
      runnerDigest: run.executionProvenance.runnerDigest,
      runtimeImageReference: run.executionProvenance.provider.runtimeImageReference,
      runtimeImageDigest: run.executionProvenance.provider.runtimeImageDigest,
      bridgeProtocolVersion: run.executionProvenance.provider.bridgeProtocolVersion,
      configuredIdentityComplete:
        run.executionProvenance.runnerDigest !== null &&
        (provider === "local" || run.executionProvenance.provider.runtimeImageDigest !== null),
      runnerDigestAuthority:
        provider === "local"
          ? "measured-local-file"
          : run.executionProvenance.runnerDigest === null
            ? "unavailable"
            : "operator-asserted",
      runtimeImageDigestAuthority:
        run.executionProvenance.provider.runtimeImageDigest === null
          ? "unavailable"
          : "operator-asserted-platform-evidence",
    },
    run: { id: runId, logs: logs.items.length, cleanupAuditId: cleanupAudit.id },
    artifact: {
      id: artifact.id,
      digest: artifact.digest,
      files: artifactDetail.entries.length,
    },
    deployment: { id: deploymentId, url: deploymentUrl, previewVerifiedAfterRestart: true },
    persistence: { restartVerified: true, auditRecords: recoveredAudit.items.length },
    backup: {
      digest: verifiedBackup.database.digest,
      artifacts: backup.artifacts.length,
      deployments: backup.deployments.length,
      verified: true,
    },
  }
  await Bun.write(Bun.stdout, `${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  const normalized = normalizeProofError(error)
  await Bun.write(
    Bun.stderr,
    `${JSON.stringify({ error: { code: normalized.code, message: normalized.message, details: normalized.details } })}\n`,
  )
  process.exitCode = 1
} finally {
  await running?.close().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
  await rm(`${dataDir}.lock`, { recursive: true, force: true })
}

function proofConfig(input: {
  provider: ProofProvider
  dataDir: string
  runnerPath: string
  catalogPath: string
  previewPort: number
  key: string
}): AppConfig {
  const bridgeUrl = Bun.env["CLOUDFLARE_BRIDGE_URL"]
  const bridgeToken = Bun.env["CLOUDFLARE_BRIDGE_TOKEN"]
  if (input.provider === "cloudflare" && (bridgeUrl === undefined || bridgeToken === undefined)) {
    throw new ProofError(
      "CLOUDFLARE_CONFIGURATION_REQUIRED",
      "Cloudflare proof requires CLOUDFLARE_BRIDGE_URL and CLOUDFLARE_BRIDGE_TOKEN",
    )
  }
  return {
    host: "127.0.0.1",
    port: 0,
    previewHost: "127.0.0.1",
    previewPort: input.previewPort,
    dataDir: input.dataDir,
    databasePath: join(input.dataDir, "meanwhile.sqlite"),
    artifactDir: join(input.dataDir, "artifacts"),
    runtimeDir: join(input.dataDir, "runtimes"),
    deploymentDir: join(input.dataDir, "deployments"),
    apiKey: input.key,
    runnerPath: input.runnerPath,
    agentCatalogPath: input.catalogPath,
    defaultProvider: input.provider,
    localProvider: { enabled: input.provider === "local", unsafeHostExecution: false },
    secretSourceCatalog: [],
    logLevel: "error",
    telemetry: { enabled: false },
    ...(input.provider === "cloudflare"
      ? {
          cloudflare: {
            bridgeUrl: bridgeUrl as string,
            token: bridgeToken as string,
            ...(Bun.env["CLOUDFLARE_RUNTIME_IMAGE_DIGEST"] === undefined
              ? {}
              : { runtimeImageDigest: Bun.env["CLOUDFLARE_RUNTIME_IMAGE_DIGEST"] as string }),
            ...(Bun.env["CLOUDFLARE_RUNNER_DIGEST"] === undefined
              ? {}
              : { runnerDigest: Bun.env["CLOUDFLARE_RUNNER_DIGEST"] as string }),
          },
        }
      : {}),
  }
}

async function startInstance(config: AppConfig, apiKey: string): Promise<RunningInstance> {
  const instrumentation = await initializeInstrumentation({
    serviceName: "meanwhile-release-proof",
    serviceVersion: SERVICE_VERSION,
    environment: "release-proof",
    logLevel: "error",
    sink: { write() {} },
  })
  let application: MeanwhileApplication | null = null
  try {
    application = await createApplication({ config, instrumentation })
    await application.start()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: application.app.fetch,
    })
    let closed = false
    return {
      application,
      server,
      client: new Meanwhile({ baseUrl: server.url.origin, apiKey }),
      async close() {
        if (closed) return
        closed = true
        await server.stop(true)
        await application?.close()
      },
    }
  } catch (error) {
    if (application !== null) await application.close().catch(() => undefined)
    else await instrumentation.shutdown().catch(() => undefined)
    throw error
  }
}

async function waitForAudit(
  meanwhile: Meanwhile,
  runId: string,
  action: string,
  timeoutMs: number,
) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const page = await meanwhile.audit.list({ action, limit: 100 })
    const record = page.items.find(({ metadata }) => metadata["runId"] === runId)
    if (record !== undefined) return record
    await Bun.sleep(100)
  }
  throw new ProofError("CLEANUP_PROOF_MISSING", "Runtime destruction was not durably audited")
}

async function assertPreview(url: string, text: string): Promise<void> {
  const response = await fetch(url)
  const body = await response.text()
  if (
    !response.ok ||
    !body.includes(text) ||
    response.headers.get("x-content-type-options") !== "nosniff"
  ) {
    throw new ProofError("PREVIEW_PROOF_FAILED", "Immutable preview response is invalid")
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
  if (port === undefined) throw new ProofError("PORT_UNAVAILABLE", "Preview port is unavailable")
  return port
}

async function repositoryRevision(): Promise<{ commit: string; dirty: boolean }> {
  const commit = await commandOutput(["git", "rev-parse", "HEAD"])
  const status = await commandOutput(["git", "status", "--porcelain"])
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new ProofError("REVISION_UNAVAILABLE", "Repository revision is invalid")
  }
  return { commit, dirty: status.length > 0 }
}

async function commandOutput(argv: readonly [string, ...string[]]): Promise<string> {
  const process = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore" })
  const output = await new Response(process.stdout).text()
  if ((await process.exited) !== 0) {
    throw new ProofError("REVISION_UNAVAILABLE", "Repository revision could not be read")
  }
  return output.trim()
}

function selectedProvider(arguments_: readonly string[]): ProofProvider {
  const option = arguments_.find((argument) => argument.startsWith("--provider="))
  const value = option?.slice("--provider=".length) ?? "local"
  if (value !== "local" && value !== "cloudflare") {
    throw new ProofError("INVALID_ARGUMENT", "Provider must be local or cloudflare")
  }
  return value
}

function assertRemoteProvenance(config: AppConfig): void {
  if (
    config.cloudflare?.runnerDigest === undefined ||
    config.cloudflare.runtimeImageDigest === undefined
  ) {
    throw new ProofError(
      "REMOTE_PROVENANCE_REQUIRED",
      "Cloudflare release proof requires configured runner and runtime-image provenance",
    )
  }
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}

function normalizeProofError(error: unknown): ProofError {
  if (error instanceof ProofError) return error
  if (error instanceof MeanwhileError)
    return new ProofError(error.code, error.message, error.details)
  return new ProofError("RELEASE_PROOF_FAILED", "Release proof failed")
}
