import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createApplication, type MeanwhileApplication } from "../src/app"
import { issueApiKey } from "../src/auth"
import { Meanwhile, MeanwhileError } from "../src/client"
import type { AppConfig } from "../src/config"
import { backupDataRoot, restoreDataRoot, verifyDataBackup } from "../src/data-root"
import { initializeInstrumentation } from "../src/instrumentation"
import type { TelemetryHealthSnapshot } from "../src/telemetry"
import { SERVICE_VERSION } from "../src/version"

type ProofProvider = "local" | "cloudflare"

interface RunningInstance {
  readonly application: MeanwhileApplication
  readonly server: ReturnType<typeof Bun.serve>
  readonly client: Meanwhile
  readonly operationalLogs: readonly string[]
  flushTelemetry(): Promise<TelemetryHealthSnapshot>
  close(): Promise<void>
}

interface TelemetryCapture {
  readonly requests: number
  readonly bytes: number
}

interface ProofTelemetryEvidence {
  readonly health: "healthy"
  readonly traces: TelemetryCapture
  readonly metrics: TelemetryCapture
  readonly structuredLogs: number
}

interface ProofTelemetryCollector {
  readonly endpoint: string
  evidence(
    health: TelemetryHealthSnapshot,
    operationalLogs: readonly string[],
    forbiddenValues: readonly string[],
  ): ProofTelemetryEvidence
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
const telemetryCollector = startProofTelemetryCollector(
  [key.key, Bun.env["CLOUDFLARE_BRIDGE_TOKEN"]].filter(
    (value): value is string => value !== undefined && value.length > 0,
  ),
)
const config = proofConfig({
  provider,
  dataDir,
  runnerPath,
  catalogPath,
  previewPort,
  telemetryEndpoint: telemetryCollector.endpoint,
  key: key.key,
})
let running: RunningInstance | null = null

try {
  if (requireProvenance && provider === "cloudflare") assertRemoteProvenance(config)
  const revision = await repositoryRevision()
  const roundTripToken = sha256(
    new TextEncoder().encode(`meanwhile:${provider}:${revision.commit}:round-trip`),
  )
  const prompt = `Return this exact release token: ${roundTripToken}`
  const expectedAgentResponse = `fixture response: ${prompt}`
  const previewText = expectedAgentResponse
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
              .encode("<!doctype html><title>Unverified input</title>")
              .toBase64(),
          },
        ],
      },
      agentType: "demo",
      provider,
      prompt,
      env: { FIXTURE_OUTPUT_PATH: "site/index.html" },
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
  assertAgentRoundTrip(logs.items, expectedAgentResponse)

  const statusHistory = running.application.store
    .listRunStatusEvents(run.ownerId, run.id)
    .map(({ toStatus }) => toStatus)
  if (
    JSON.stringify(statusHistory) !==
    JSON.stringify(["queued", "provisioning", "running", "succeeded"])
  ) {
    throw new ProofError("RUN_STATUS_HISTORY_INVALID", "Durable run status history is incomplete", {
      statusHistory,
    })
  }
  const runnerSession = running.application.store.getRunnerSession(run.id)
  if (
    runnerSession === null ||
    runnerSession.runnerSequence <= 0 ||
    runnerSession.providerCursor === null ||
    runnerSession.terminalResult === null
  ) {
    throw new ProofError(
      "RUNNER_EVIDENCE_INCOMPLETE",
      "Durable runner replay evidence is incomplete",
    )
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
  const deploymentLogs = await running.client.deployments.logs(deployment.id, { limit: 1_000 })
  const deploymentEvents = new Set(deploymentLogs.items.map(({ event }) => event))
  for (const event of [
    "deployment.local_static.materializing",
    "deployment.local_static.published",
  ]) {
    if (!deploymentEvents.has(event)) {
      throw new ProofError(
        "DEPLOYMENT_EVIDENCE_INCOMPLETE",
        "Durable deployment evidence is incomplete",
        { event },
      )
    }
  }
  await assertPreview(deployment.url, previewText)
  const cleanupAudit = await waitForAudit(running.client, run.id, "runtime.destroy", 30_000)
  const runtimeEvidence = running.application.store.getRuntimeForRun(run.id)
  if (
    runtimeEvidence === null ||
    runtimeEvidence.cleanupStatus !== "succeeded" ||
    runtimeEvidence.destroyedAt === null
  ) {
    throw new ProofError("CLEANUP_EVIDENCE_INCOMPLETE", "Runtime cleanup state is incomplete")
  }
  await assertExpectedNotFound(running.client)
  const telemetryHealth = await running.flushTelemetry()
  const telemetry = telemetryCollector.evidence(telemetryHealth, running.operationalLogs, [
    prompt,
    expectedAgentResponse,
  ])

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
  const restoredDataDir = join(root, "restored")
  const restoredConfig = proofConfig({
    provider,
    dataDir: restoredDataDir,
    runnerPath,
    catalogPath,
    previewPort,
    telemetryEndpoint: telemetryCollector.endpoint,
    key: key.key,
  })
  await restoreDataRoot(backupDir, restoredConfig)
  running = await startInstance(restoredConfig, key.key)
  const restoredRun = await running.client.runs.get(runId)
  const restoredDeployment = await running.client.deployments.get(deploymentId)
  const restoredArtifact = await running.client.artifacts.get(artifact.id)
  const restoredAudit = await running.client.audit.list({ resourceId: runId, limit: 100 })
  await assertPreview(deploymentUrl, previewText)
  if (
    restoredRun.status !== "succeeded" ||
    restoredRun.executionProvenance?.digest !== provenanceDigest ||
    restoredDeployment.status !== "succeeded" ||
    restoredArtifact.artifact.digest !== artifact.digest ||
    restoredAudit.items.length !== recoveredAudit.items.length
  ) {
    throw new ProofError("RESTORE_PROOF_FAILED", "Restored durable evidence is incomplete")
  }
  await running.close()
  running = null

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
    roundTrip: {
      promptDigest: sha256(new TextEncoder().encode(prompt)),
      responseDigest: sha256(new TextEncoder().encode(expectedAgentResponse)),
      durableResponse: true,
      agentProducedArtifact: true,
    },
    telemetry,
    run: {
      id: runId,
      statusHistory,
      runnerSequence: runnerSession.runnerSequence,
      logs: logs.items.length,
      cleanupAuditId: cleanupAudit.id,
    },
    artifact: {
      id: artifact.id,
      digest: artifact.digest,
      files: artifactDetail.entries.length,
    },
    deployment: { id: deploymentId, url: deploymentUrl, previewVerifiedAfterRestart: true },
    persistence: {
      restartVerified: true,
      restoreVerified: true,
      deploymentLogs: deploymentLogs.items.length,
      auditRecords: recoveredAudit.items.length,
    },
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
  await telemetryCollector.close().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
  await rm(`${dataDir}.lock`, { recursive: true, force: true })
}

function proofConfig(input: {
  provider: ProofProvider
  dataDir: string
  runnerPath: string
  catalogPath: string
  previewPort: number
  telemetryEndpoint: string
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
    telemetry: { enabled: true, endpoint: input.telemetryEndpoint },
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
  const operationalLogs: string[] = []
  const instrumentation = await initializeInstrumentation({
    serviceName: "meanwhile-release-proof",
    serviceVersion: SERVICE_VERSION,
    environment: "release-proof",
    logLevel: "error",
    sink: { write: (line) => operationalLogs.push(line) },
    ...(config.telemetry.enabled && config.telemetry.endpoint !== undefined
      ? {
          otlp: {
            endpoint: config.telemetry.endpoint,
            metricExportIntervalMs: 60_000,
          },
        }
      : {}),
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
      operationalLogs,
      flushTelemetry: () => instrumentation.forceFlush(),
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

function assertAgentRoundTrip(
  logs: readonly { readonly eventType: string; readonly data: string }[],
  expectedResponse: string,
): void {
  for (const log of logs) {
    if (log.eventType !== "session.update") continue
    let payload: unknown
    try {
      payload = JSON.parse(log.data)
    } catch {
      continue
    }
    if (
      isRecord(payload) &&
      payload["truncated"] === false &&
      isRecord(payload["update"]) &&
      payload["update"]["sessionUpdate"] === "agent_message_chunk" &&
      isRecord(payload["update"]["content"]) &&
      payload["update"]["content"]["type"] === "text" &&
      payload["update"]["content"]["text"] === expectedResponse
    ) {
      return
    }
  }
  throw new ProofError(
    "ACP_ROUND_TRIP_FAILED",
    "The durable ACP response did not contain the expected semantic result",
  )
}

async function assertExpectedNotFound(meanwhile: Meanwhile): Promise<void> {
  try {
    await meanwhile.runs.get(crypto.randomUUID())
  } catch (error) {
    if (error instanceof MeanwhileError && error.code === "NOT_FOUND" && error.status === 404) {
      return
    }
    throw error
  }
  throw new ProofError("STRUCTURED_ERROR_MISSING", "The API did not return a structured error")
}

function startProofTelemetryCollector(secretValues: readonly string[]): ProofTelemetryCollector {
  const captures = {
    traces: { requests: 0, bytes: 0, bodies: [] as Uint8Array[] },
    metrics: { requests: 0, bytes: 0, bodies: [] as Uint8Array[] },
  }
  const secretBytes = secretValues.map((value) => new TextEncoder().encode(value))
  let failure: ProofError | null = null
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const signal = path === "/v1/traces" ? "traces" : path === "/v1/metrics" ? "metrics" : null
      if (request.method !== "POST" || signal === null) return new Response(null, { status: 404 })
      const bytes = new Uint8Array(await request.arrayBuffer())
      const contentType = request.headers.get("content-type") ?? ""
      const isOtlpContent =
        contentType.includes("application/x-protobuf") || contentType.includes("application/json")
      if (bytes.byteLength === 0 || !isOtlpContent) {
        failure ??= new ProofError(
          "TELEMETRY_PAYLOAD_INVALID",
          "The OTLP collector received an invalid payload",
          { signal, contentType },
        )
        return new Response(null, { status: 400 })
      }
      if (secretBytes.some((secret) => containsBytes(bytes, secret))) {
        failure ??= new ProofError(
          "TELEMETRY_SECRET_LEAK",
          "A secret reached the OTLP export boundary",
          { signal },
        )
        return new Response(null, { status: 400 })
      }
      captures[signal].requests += 1
      captures[signal].bytes += bytes.byteLength
      captures[signal].bodies.push(bytes)
      return new Response(null, { status: 200 })
    },
  })

  return {
    endpoint: server.url.origin,
    evidence(health, operationalLogs, forbiddenValues) {
      if (failure !== null) throw failure
      if (health.state !== "healthy" || health.exporter !== "healthy") {
        throw new ProofError("TELEMETRY_UNHEALTHY", "Telemetry exporters are not healthy", {
          state: health.state,
          exporter: health.exporter,
        })
      }
      assertTelemetryCapture(captures.traces, ["meanwhile-release-proof", "meanwhile.http.request"])
      assertTelemetryCapture(captures.metrics, [
        "meanwhile-release-proof",
        "meanwhile.run.outcomes",
      ])

      const forbidden = [...secretValues, ...forbiddenValues].filter((value) => value.length > 0)
      const encodedForbidden = forbidden.map((value) => new TextEncoder().encode(value))
      for (const capture of [captures.traces, captures.metrics]) {
        if (
          capture.bodies.some((body) =>
            encodedForbidden.some((value) => containsBytes(body, value)),
          )
        ) {
          throw new ProofError(
            "TELEMETRY_PRIVATE_DATA_LEAK",
            "Private run input reached the OTLP export boundary",
          )
        }
      }
      const serializedLogs = operationalLogs.join("\n")
      if (forbidden.some((value) => serializedLogs.includes(value))) {
        throw new ProofError(
          "OPERATIONAL_LOG_PRIVATE_DATA_LEAK",
          "Private data reached structured operational logs",
        )
      }
      const structuredError = operationalLogs
        .map(parseJsonRecord)
        .find(
          (record) =>
            record["event"] === "http.request_failed" &&
            typeof record["requestId"] === "string" &&
            typeof record["ownerId"] === "string" &&
            isRecord(record["attributes"]) &&
            record["attributes"]["code"] === "NOT_FOUND" &&
            record["attributes"]["status"] === 404,
        )
      if (structuredError === undefined) {
        throw new ProofError(
          "STRUCTURED_TELEMETRY_MISSING",
          "Correlated structured error telemetry was not recorded",
        )
      }
      return {
        health: "healthy",
        traces: { requests: captures.traces.requests, bytes: captures.traces.bytes },
        metrics: { requests: captures.metrics.requests, bytes: captures.metrics.bytes },
        structuredLogs: operationalLogs.length,
      }
    },
    async close() {
      await server.stop(true)
    },
  }
}

function assertTelemetryCapture(
  capture: { readonly requests: number; readonly bytes: number; readonly bodies: Uint8Array[] },
  expectedStrings: readonly string[],
): void {
  if (capture.requests === 0 || capture.bytes === 0) {
    throw new ProofError("TELEMETRY_EXPORT_MISSING", "An OTLP signal was not exported")
  }
  for (const expected of expectedStrings) {
    const bytes = new TextEncoder().encode(expected)
    if (!capture.bodies.some((body) => containsBytes(body, bytes))) {
      throw new ProofError("TELEMETRY_SEMANTICS_MISSING", "Expected OTLP semantics are missing", {
        expected,
      })
    }
  }
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0 || needle.byteLength > haystack.byteLength) return false
  const finalStart = haystack.byteLength - needle.byteLength
  for (let start = 0; start <= finalStart; start += 1) {
    let matches = true
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matches = false
        break
      }
    }
    if (matches) return true
  }
  return false
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
