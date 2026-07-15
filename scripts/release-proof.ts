import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createApplication, type MeanwhileApplication } from "../src/app"
import { issueApiKey } from "../src/auth"
import { Meanwhile, MeanwhileError } from "../src/client"
import type { AppConfig } from "../src/config"
import { backupDataRoot, restoreDataRoot, verifyDataBackup } from "../src/data-root"
import { initializeInstrumentation } from "../src/instrumentation"
import type { Store } from "../src/persistence/store"
import type { TelemetryHealthSnapshot } from "../src/telemetry"
import { sessionTimelineFromEvents } from "../src/timeline"
import { SERVICE_VERSION } from "../src/version"
import {
  AgentToolchainError,
  agentCatalog,
  prepareCloudflareAgentToolchain,
} from "./agent-toolchains"
import {
  createReleaseProofReceipt,
  type ReleaseProofPayload,
  releaseProofClass,
  writeReleaseProofReceipt,
} from "./release-proof-receipt"

type ProofProvider = "local" | "cloudflare"
type ProofAgent = "demo" | "codex" | "claude-code" | "pi"

interface PreparedProofAgent {
  readonly type: ProofAgent
  readonly adapter: string
  readonly runtime: string
  readonly authenticationEvidence: string
  readonly catalogPath: string
  readonly environment: Readonly<Record<string, string>>
  readonly secretReferences: Readonly<Record<string, string>>
  readonly secretValues: readonly string[]
  readonly workspaceFiles: readonly { readonly path: string; readonly contentBase64: string }[]
  readonly timeoutMs: number
  readonly waitTimeoutMs: number
  prompt(token: string): string
  previewText(token: string, prompt: string): string
  restore(): void
}

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

const providerReadyTimeoutMs = 120_000
const providerReadyPollMs = 500
let root: string | null = null
let dataDir: string | null = null
let proofAgent: PreparedProofAgent | null = null
let telemetryCollector: ProofTelemetryCollector | null = null
let running: RunningInstance | null = null

try {
  const proofArguments = process.argv.slice(2)
  const provider = selectedProvider(proofArguments)
  const proofAgentType = selectedProofAgent(proofArguments)
  const requireProvenance = proofArguments.includes("--require-provenance")
  const requireClean = proofArguments.includes("--require-clean")
  const receiptPath = selectedReceiptPath(proofArguments)
  const proofStartedAt = new Date().toISOString()
  const revision = await repositoryRevision()
  if (requireClean && revision.dirty) {
    throw new ProofError(
      "WORKTREE_NOT_CLEAN",
      "Release proof requires a clean worktree when --require-clean is set",
    )
  }
  root = await mkdtemp(join(tmpdir(), "meanwhile-release-proof-"))
  dataDir = join(root, "data")
  const backupDir = join(root, "backup")
  const runnerPath = resolve("dist/meanwhile-runner")
  proofAgent = await prepareProofAgent(proofAgentType, provider, root)
  assertProofAgentCredentialIntent(proofAgent)
  const catalogPath = proofAgent.catalogPath
  const key = await issueApiKey()
  const previewPort = await reservePort()
  const privateValues = [
    key.key,
    Bun.env["CLOUDFLARE_BRIDGE_TOKEN"],
    ...proofAgent.secretValues,
  ].filter((value): value is string => value !== undefined && value.length > 0)
  telemetryCollector = startProofTelemetryCollector(privateValues)
  const config = proofConfig({
    provider,
    dataDir,
    runnerPath,
    catalogPath,
    previewPort,
    telemetryEndpoint: telemetryCollector.endpoint,
    key: key.key,
    secretSourceCatalog: Object.keys(proofAgent.secretReferences),
  })
  if (requireProvenance && provider === "cloudflare") assertRemoteProvenance(config)
  const roundTripToken = sha256(
    new TextEncoder().encode(
      `meanwhile:${provider}:${proofAgent.type}:${revision.commit}:round-trip`,
    ),
  )
  const prompt = proofAgent.prompt(roundTripToken)
  const previewText = proofAgent.previewText(roundTripToken, prompt)
  running = await startInstance(config, key.key)
  await waitForProviderReady(running.client, provider)

  const created = await running.client.runs.create(
    {
      workspace: {
        type: "files",
        files: [...proofAgent.workspaceFiles],
      },
      agentType: proofAgent.type,
      provider,
      prompt,
      env: { ...proofAgent.environment },
      secretRefs: { ...proofAgent.secretReferences },
      artifactPaths: ["site"],
      timeoutMs: proofAgent.timeoutMs,
    },
    {
      idempotencyKey: `release-proof:${provider}:${proofAgent.type}:${revision.commit}`,
    },
  )
  const run = await running.client.runs.wait(created.id, {
    timeoutMs: proofAgent.waitTimeoutMs,
    pollIntervalMs: 50,
  })
  if (run.status !== "succeeded" || run.executionProvenance === null) {
    const failureLogs = await running.client.runs.logs(run.id, { limit: 1_000 })
    throw new ProofError("RUN_PROOF_FAILED", "The release-proof run did not succeed", {
      status: run.status,
      error: run.error,
      eventTypes: failureLogs.items.map(({ eventType }) => eventType),
      diagnostics: failureLogs.items
        .filter(({ stream }) => stream === "stderr")
        .map(({ eventType, data }) => ({ eventType, data: data.slice(0, 2_000) })),
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
  const agentResponse = agentResponseText(logs.items)
  if (proofAgent.type === "demo" && agentResponse !== `fixture response: ${prompt}`) {
    throw new ProofError(
      "ACP_ROUND_TRIP_FAILED",
      "The durable ACP response did not contain the expected semantic result",
    )
  }
  if (agentResponse.trim().length === 0) {
    throw new ProofError("ACP_ROUND_TRIP_FAILED", "The durable ACP response was empty", {
      eventTypes: logs.items.map(({ eventType }) => eventType),
      updateKinds: logs.items.flatMap((log) => runnerUpdateKind(log.data)),
      updateShapes: logs.items.flatMap((log) => runnerUpdateShape(log.data)),
      diagnostics: logs.items
        .filter(({ stream }) => stream === "stderr")
        .map(({ eventType, data }) => ({ eventType, data: data.slice(0, 2_000) })),
    })
  }

  const statusHistory = running.application.store
    .listRunStatusEvents(run.ownerId, run.id)
    .map(({ toStatus }) => toStatus)
  const expectedStatusHistory: ["queued", "provisioning", "running", "succeeded"] = [
    "queued",
    "provisioning",
    "running",
    "succeeded",
  ]
  if (JSON.stringify(statusHistory) !== JSON.stringify(expectedStatusHistory)) {
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
      await running.client.deployments.create(
        {
          runId: run.id,
          artifactPath: "site",
          deployTarget: "local-static",
        },
        { idempotencyKey: `release-proof-deployment-${run.id}` },
      )
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
  const firstSessionToken = roundTripToken.slice(0, 24)
  const secondSessionToken = roundTripToken.slice(24, 48)
  const session = await running.client.sessions.create(
    {
      workspace: { type: "files", files: [...proofAgent.workspaceFiles] },
      agentType: proofAgent.type,
      provider,
      env: { ...proofAgent.environment },
      secretRefs: { ...proofAgent.secretReferences },
      idleTimeoutMs: 10 * 60_000,
    },
    { idempotencyKey: `release-session:${provider}:${proofAgent.type}:${revision.commit}` },
  )
  const readySession = await running.client.sessions.waitForStatus(session.id, "idle", {
    timeoutMs: proofAgent.waitTimeoutMs,
    pollIntervalMs: 50,
  })
  if (readySession.agentSessionId === null) {
    throw new ProofError("SESSION_READY_EVIDENCE_MISSING", "The ACP session identity is missing")
  }
  const firstSessionPrompt =
    proofAgent.type === "demo"
      ? `Return both session tokens: ${firstSessionToken} ${secondSessionToken}`
      : `This is a two-turn continuity check. Memorize the opaque identifier ${firstSessionToken} for my next message. Do not use tools. Your entire response must be exactly: STORED ${firstSessionToken}`
  const firstTurn = await running.client.sessions.send(session.id, firstSessionPrompt, {
    idempotencyKey: `release-session-first:${provider}:${proofAgent.type}:${revision.commit}`,
    timeoutMs: proofAgent.timeoutMs,
  })
  const completedFirstTurn = await running.client.sessions.waitForTurn(session.id, firstTurn.id, {
    timeoutMs: proofAgent.waitTimeoutMs,
    pollIntervalMs: 50,
  })
  if (completedFirstTurn.status !== "succeeded") {
    throw new ProofError("SESSION_FIRST_TURN_FAILED", "The first durable turn did not succeed", {
      status: completedFirstTurn.status,
      error: completedFirstTurn.error,
    })
  }
  await running.client.sessions.waitForStatus(session.id, "idle", {
    timeoutMs: 30_000,
    pollIntervalMs: 50,
  })
  const firstSessionEvents = await running.client.sessions.events(session.id, { limit: 1_000 })
  const firstTimeline = sessionTimelineFromEvents(firstSessionEvents.items)
  const firstTurnResponse = firstTimeline.messages
    .filter(({ role, turnId }) => role === "agent" && turnId === firstTurn.id)
    .map(({ text }) => text)
    .join("")
  if (
    firstTurnResponse.trim().length === 0 ||
    (proofAgent.type !== "demo" && !firstTurnResponse.includes(firstSessionToken))
  ) {
    throw new ProofError(
      "SESSION_FIRST_TURN_EVIDENCE_MISSING",
      "The first durable turn response is missing",
      {
        eventTypes: firstSessionEvents.items.map(({ type }) => type),
        updateKinds: firstSessionEvents.items.flatMap((event) => {
          if (event.type !== "turn.update") return []
          const update = event.payload["update"]
          if (typeof update !== "object" || update === null || Array.isArray(update)) return []
          const kind = Reflect.get(update, "sessionUpdate")
          return typeof kind === "string" ? [kind] : []
        }),
        messages: firstTimeline.messages.map(({ id, role, turnId, text }) => ({
          id,
          role,
          turnId,
          expectedTurnId: firstTurn.id,
          bytes: new TextEncoder().encode(text).byteLength,
        })),
        agentMessageShapes: firstSessionEvents.items.flatMap((event) => {
          if (event.type !== "turn.update") return []
          const update = event.payload["update"]
          if (typeof update !== "object" || update === null || Array.isArray(update)) return []
          if (Reflect.get(update, "sessionUpdate") !== "agent_message_chunk") return []
          const content = Reflect.get(update, "content")
          return [
            {
              updateKeys: Object.keys(update),
              contentType:
                typeof content === "object" && content !== null && !Array.isArray(content)
                  ? Reflect.get(content, "type")
                  : typeof content,
              contentKeys:
                typeof content === "object" && content !== null && !Array.isArray(content)
                  ? Object.keys(content)
                  : [],
            },
          ]
        }),
      },
    )
  }

  const runId = run.id
  const sessionId = session.id
  const agentSessionId = readySession.agentSessionId
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

  const recoveredSession = await running.client.sessions.waitForStatus(sessionId, "idle", {
    timeoutMs: proofAgent.waitTimeoutMs,
    pollIntervalMs: 50,
  })
  if (recoveredSession.agentSessionId !== agentSessionId) {
    throw new ProofError(
      "SESSION_CONTINUITY_CHANGED",
      "The ACP session identity changed across control-plane restart",
    )
  }
  const secondSessionPrompt =
    proofAgent.type === "demo"
      ? `Return both session tokens again: ${firstSessionToken} ${secondSessionToken}`
      : `Continue the continuity check without using tools. Your entire response must be exactly two whitespace-separated identifiers: first the opaque identifier from my previous message, then ${secondSessionToken}. Do not add labels, punctuation, or explanation.`
  const secondTurn = await running.client.sessions.send(sessionId, secondSessionPrompt, {
    idempotencyKey: `release-session-second:${provider}:${proofAgent.type}:${revision.commit}`,
    timeoutMs: proofAgent.timeoutMs,
  })
  const completedSecondTurn = await running.client.sessions.waitForTurn(sessionId, secondTurn.id, {
    timeoutMs: proofAgent.waitTimeoutMs,
    pollIntervalMs: 50,
  })
  if (completedSecondTurn.status !== "succeeded") {
    throw new ProofError("SESSION_SECOND_TURN_FAILED", "The second durable turn did not succeed", {
      status: completedSecondTurn.status,
      error: completedSecondTurn.error,
    })
  }
  const sessionEvents = await running.client.sessions.events(sessionId, { limit: 1_000 })
  const sessionTimeline = sessionTimelineFromEvents(sessionEvents.items)
  const secondTurnResponse = sessionTimeline.messages
    .filter(({ role, turnId }) => role === "agent" && turnId === secondTurn.id)
    .map(({ text }) => text)
    .join("")
  if (
    !secondTurnResponse.includes(firstSessionToken) ||
    !secondTurnResponse.includes(secondSessionToken)
  ) {
    throw new ProofError(
      "SESSION_CONTINUITY_EVIDENCE_MISSING",
      "The second turn did not preserve the first-turn token across restart",
    )
  }
  await running.client.sessions.close(sessionId)
  await running.client.sessions.waitForStatus(sessionId, "closed", {
    timeoutMs: 30_000,
    pollIntervalMs: 50,
  })
  const sessionCleanupAudit = await waitForCorrelatedAudit(
    running.client,
    "sessionId",
    sessionId,
    "runtime.destroy",
    30_000,
  )
  const sessionRuntimeEvidence = running.application.store.getSessionRuntimeLease(sessionId)
  if (
    sessionRuntimeEvidence === null ||
    sessionRuntimeEvidence.cleanupStatus !== "succeeded" ||
    sessionRuntimeEvidence.destroyedAt === null
  ) {
    throw new ProofError(
      "SESSION_CLEANUP_EVIDENCE_INCOMPLETE",
      "Session runtime cleanup state is incomplete",
    )
  }
  await assertExpectedNotFound(running.client)
  const telemetryHealth = await running.flushTelemetry()
  const telemetry = telemetryCollector.evidence(telemetryHealth, running.operationalLogs, [
    prompt,
    agentResponse,
    previewText,
    firstSessionPrompt,
    firstTurnResponse,
    secondSessionPrompt,
    secondTurnResponse,
  ])
  await assertPrivateValuesAbsent(dataDir, privateValues)
  await running.close()
  running = null

  const backup = await backupDataRoot(config, backupDir)
  const verifiedBackup = await verifyDataBackup(backupDir)
  await assertPrivateValuesAbsent(backupDir, privateValues)
  const restoredDataDir = join(root, "restored")
  const restoredConfig = proofConfig({
    provider,
    dataDir: restoredDataDir,
    runnerPath,
    catalogPath,
    previewPort,
    telemetryEndpoint: telemetryCollector.endpoint,
    key: key.key,
    secretSourceCatalog: Object.keys(proofAgent.secretReferences),
  })
  await restoreDataRoot(backupDir, restoredConfig)
  running = await startInstance(restoredConfig, key.key)
  const restoredRun = await running.client.runs.get(runId)
  const restoredDeployment = await running.client.deployments.get(deploymentId)
  const restoredArtifact = await running.client.artifacts.get(artifact.id)
  const restoredAudit = await running.client.audit.list({ resourceId: runId, limit: 100 })
  const restoredSession = await running.client.sessions.get(sessionId)
  const restoredTurns = await running.client.sessions.turns(sessionId, { limit: 100 })
  const credentialBoundary = credentialBoundaryEvidence(
    proofAgent,
    provider,
    running.application.store,
    runId,
    sessionId,
  )
  await assertPreview(deploymentUrl, previewText)
  if (
    restoredRun.status !== "succeeded" ||
    restoredRun.executionProvenance?.digest !== provenanceDigest ||
    restoredDeployment.status !== "succeeded" ||
    restoredArtifact.artifact.digest !== artifact.digest ||
    restoredAudit.items.length !== recoveredAudit.items.length ||
    restoredSession.status !== "closed" ||
    restoredTurns.items.length !== 2
  ) {
    throw new ProofError("RESTORE_PROOF_FAILED", "Restored durable evidence is incomplete")
  }
  await running.close()
  running = null

  const runnerDigest = run.executionProvenance.runnerDigest
  if (runnerDigest === null) {
    throw new ProofError(
      "RELEASE_PROVENANCE_INCOMPLETE",
      "Release proof requires a measured or operator-asserted runner digest",
    )
  }
  const receipt = createReleaseProofReceipt({
    proofClass: releaseProofClass(provider, proofAgent.type),
    startedAt: proofStartedAt,
    finishedAt: new Date().toISOString(),
    provider,
    agent: {
      type: proofAgent.type,
      adapter: proofAgent.adapter,
      runtime: proofAgent.runtime,
      authenticationEvidence: proofAgent.authenticationEvidence,
      executionEvidence:
        proofAgent.type === "demo" ? "deterministic-fixture" : "credentialed-live-agent",
      modelIdentityEvidence: proofAgent.type === "demo" ? "not-applicable" : "not-attested",
    },
    revision,
    provenance: {
      digest: provenanceDigest,
      runnerDigest,
      runtimeImageReference: run.executionProvenance.provider.runtimeImageReference,
      runtimeImageDigest: run.executionProvenance.provider.runtimeImageDigest,
      bridgeProtocolVersion: run.executionProvenance.provider.bridgeProtocolVersion,
      configuredIdentityComplete:
        run.executionProvenance.runnerDigest !== null &&
        (provider === "local" ||
          (run.executionProvenance.provider.runtimeImageReference !== null &&
            run.executionProvenance.provider.runtimeImageDigest !== null)),
      runnerDigestAuthority: provider === "local" ? "measured-local-file" : "operator-asserted",
      runtimeImageDigestAuthority:
        run.executionProvenance.provider.runtimeImageDigest === null
          ? "unavailable"
          : "operator-asserted-platform-evidence",
    },
    credentialBoundary,
    roundTrip: {
      promptDigest: sha256(new TextEncoder().encode(prompt)),
      responseDigest: sha256(new TextEncoder().encode(agentResponse)),
      durableResponse: true,
      agentProducedArtifact: true,
      sdkArtifactDownloadVerified: true,
      sdkDeploymentVerified: true,
    },
    session: {
      id: sessionId,
      turns: 2,
      events: sessionEvents.items.length,
      agentSessionIdentityPreserved: true,
      controlPlaneRestartBetweenTurns: true,
      continuityTokenVerified: true,
      cleanupAuditId: sessionCleanupAudit.id,
    },
    telemetry,
    run: {
      id: runId,
      statusHistory: expectedStatusHistory,
      runnerSequence: runnerSession.runnerSequence,
      logs: logs.items.length,
      cleanupAuditId: cleanupAudit.id,
    },
    artifact: {
      id: artifact.id,
      digest: artifact.digest,
      files: artifactDetail.entries.length,
    },
    deployment: {
      id: deploymentId,
      target: "local-static",
      previewBoundary: "control-plane-local-static",
      url: deploymentUrl,
      previewVerifiedAfterRestart: true,
    },
    persistence: {
      restartVerified: true,
      restoreVerified: true,
      privateValuesAbsent: true,
      deploymentLogs: deploymentLogs.items.length,
      auditRecords: recoveredAudit.items.length,
    },
    backup: {
      digest: verifiedBackup.database.digest,
      artifacts: backup.artifacts.length,
      deployments: backup.deployments.length,
      verified: true,
    },
  })
  const serializedReceipt = `${JSON.stringify(receipt, null, 2)}\n`
  if (privateValues.some((value) => serializedReceipt.includes(value))) {
    throw new ProofError(
      "PROOF_RECEIPT_PRIVATE_VALUE",
      "Release proof receipt contains private input",
    )
  }
  if (receiptPath !== null) await writeReleaseProofReceipt(receiptPath, receipt)
  await Bun.write(Bun.stdout, serializedReceipt)
} catch (error) {
  const normalized = normalizeProofError(error)
  await Bun.write(
    Bun.stderr,
    `${JSON.stringify({ error: { code: normalized.code, message: normalized.message, details: normalized.details } })}\n`,
  )
  process.exitCode = 1
} finally {
  await running?.close().catch(() => undefined)
  await telemetryCollector?.close().catch(() => undefined)
  proofAgent?.restore()
  if (root !== null) await rm(root, { recursive: true, force: true })
  if (dataDir !== null) await rm(`${dataDir}.lock`, { recursive: true, force: true })
}

async function waitForProviderReady(client: Meanwhile, provider: ProofProvider): Promise<void> {
  const deadline = performance.now() + providerReadyTimeoutMs
  let diagnostics = await client.providers.test(provider)

  while (diagnostics.health.status !== "healthy" && performance.now() < deadline) {
    await Bun.sleep(providerReadyPollMs)
    diagnostics = await client.providers.test(provider)
  }

  if (diagnostics.health.status !== "healthy") {
    throw new ProofError("PROVIDER_UNHEALTHY", "The selected provider did not become ready", {
      health: diagnostics.health,
    })
  }
}

function proofConfig(input: {
  provider: ProofProvider
  dataDir: string
  runnerPath: string
  catalogPath: string
  previewPort: number
  telemetryEndpoint: string
  key: string
  secretSourceCatalog: readonly string[]
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
    runConcurrency: 2,
    sessionConcurrency: 2,
    localProvider: { enabled: input.provider === "local", unsafeHostExecution: false },
    secretSourceCatalog: input.secretSourceCatalog,
    logLevel: "error",
    telemetry: { enabled: true, endpoint: input.telemetryEndpoint },
    ...(input.provider === "cloudflare"
      ? {
          cloudflare: {
            bridgeUrl: bridgeUrl as string,
            token: bridgeToken as string,
            ...(Bun.env["CLOUDFLARE_RUNTIME_IMAGE_REFERENCE"] === undefined
              ? {}
              : {
                  runtimeImageReference: Bun.env["CLOUDFLARE_RUNTIME_IMAGE_REFERENCE"] as string,
                }),
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

function agentResponseText(
  logs: readonly { readonly eventType: string; readonly data: string }[],
): string {
  const chunks: string[] = []
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
      typeof payload["update"]["content"]["text"] === "string"
    ) {
      chunks.push(payload["update"]["content"]["text"])
    }
  }
  return chunks.join("")
}

function runnerUpdateKind(data: string): string[] {
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return []
  }
  if (!isRecord(payload) || !isRecord(payload["update"])) return []
  const kind = payload["update"]["sessionUpdate"]
  return typeof kind === "string" ? [kind] : []
}

function runnerUpdateShape(data: string): object[] {
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return []
  }
  if (!isRecord(payload) || !isRecord(payload["update"])) return []
  const update = payload["update"]
  const content = update["content"]
  return [
    {
      truncated: payload["truncated"],
      updateKeys: Object.keys(update),
      sessionUpdate: update["sessionUpdate"],
      contentType: isRecord(content) ? content["type"] : typeof content,
      contentKeys: isRecord(content) ? Object.keys(content) : [],
      textBytes:
        isRecord(content) && typeof content["text"] === "string"
          ? new TextEncoder().encode(content["text"]).byteLength
          : null,
    },
  ]
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

async function assertPrivateValuesAbsent(
  directory: string,
  privateValues: readonly string[],
): Promise<void> {
  const needles = privateValues.map((value) => new TextEncoder().encode(value))
  const pending = [directory]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
        continue
      }
      if (!entry.isFile()) {
        throw new ProofError(
          "PERSISTENCE_SCAN_UNSAFE",
          "The release-proof data root contains an unsupported entry",
        )
      }
      const bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
      if (needles.some((needle) => containsBytes(bytes, needle))) {
        throw new ProofError(
          "PERSISTENCE_PRIVATE_DATA_LEAK",
          "A private value reached durable release-proof data",
        )
      }
    }
  }
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
  return waitForCorrelatedAudit(meanwhile, "runId", runId, action, timeoutMs)
}

async function waitForCorrelatedAudit(
  meanwhile: Meanwhile,
  correlation: "runId" | "sessionId",
  id: string,
  action: string,
  timeoutMs: number,
) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const page = await meanwhile.audit.list({ action, limit: 100 })
    const record = page.items.find(({ metadata }) => metadata[correlation] === id)
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

function selectedProofAgent(arguments_: readonly string[]): ProofAgent {
  const option = arguments_.find((argument) => argument.startsWith("--agent="))
  const value = option?.slice("--agent=".length) ?? "demo"
  if (value !== "demo" && value !== "codex" && value !== "claude-code" && value !== "pi") {
    throw new ProofError("INVALID_ARGUMENT", "Agent must be demo, codex, claude-code, or pi")
  }
  return value
}

function selectedReceiptPath(arguments_: readonly string[]): string | null {
  const options = arguments_.filter((argument) => argument.startsWith("--output="))
  if (options.length > 1) {
    throw new ProofError("INVALID_ARGUMENT", "Release proof accepts one output path")
  }
  const value = options[0]?.slice("--output=".length)
  if (value === undefined) return null
  if (value.length === 0) {
    throw new ProofError("INVALID_ARGUMENT", "Release proof output path must not be empty")
  }
  return resolve(value)
}

function assertProofAgentCredentialIntent(agent: PreparedProofAgent): void {
  if (agent.type === "demo") return
  const referenceNames = Object.keys(agent.secretReferences)
  if (
    referenceNames.length === 0 ||
    agent.secretValues.length === 0 ||
    referenceNames.length !== agent.secretValues.length
  ) {
    throw new ProofError(
      "LIVE_AGENT_CREDENTIAL_EVIDENCE_MISSING",
      "Live-agent proof requires one resolved value for every credential reference",
    )
  }
}

function credentialBoundaryEvidence(
  agent: PreparedProofAgent,
  provider: ProofProvider,
  store: Pick<Store, "getCredentialLeaseInternal">,
  runId: string,
  sessionId: string,
): ReleaseProofPayload["credentialBoundary"] {
  if (agent.type === "demo") {
    return {
      mode: "not-required",
      runLeaseId: null,
      sessionLeaseId: null,
      runLeaseRevoked: null,
      sessionLeaseRevoked: null,
      sourceValuesAbsent: true,
    }
  }

  const runLease = store.getCredentialLeaseInternal("run", runId)
  const sessionLease = store.getCredentialLeaseInternal("session", sessionId)
  if (
    runLease === null ||
    sessionLease === null ||
    runLease.provider !== provider ||
    sessionLease.provider !== provider ||
    runLease.status !== "revoked" ||
    sessionLease.status !== "revoked" ||
    runLease.revokedAt === null ||
    sessionLease.revokedAt === null
  ) {
    throw new ProofError(
      "LIVE_AGENT_CREDENTIAL_EVIDENCE_MISSING",
      "Live-agent proof requires restored revoked credential leases for the run and session",
    )
  }
  return {
    mode: "brokered",
    runLeaseId: runLease.id,
    sessionLeaseId: sessionLease.id,
    runLeaseRevoked: true,
    sessionLeaseRevoked: true,
    sourceValuesAbsent: true,
  }
}

async function prepareProofAgent(
  type: ProofAgent,
  provider: ProofProvider,
  root: string,
): Promise<PreparedProofAgent> {
  const encode = (value: string) => new TextEncoder().encode(value).toBase64()
  if (type === "demo") {
    return {
      type,
      adapter: "meanwhile-demo-agent",
      runtime: `bun@${Bun.version}`,
      authenticationEvidence: "not-required",
      catalogPath: resolve("config/agents.json"),
      environment: { FIXTURE_OUTPUT_PATH: "site/index.html" },
      secretReferences: {},
      secretValues: [],
      workspaceFiles: [
        {
          path: "site/index.html",
          contentBase64: encode("<!doctype html><title>Unverified input</title>"),
        },
      ],
      // Run timeout includes provisioning. A fresh Cloudflare deployment may
      // need to materialize its container application after the authenticated
      // bridge is already reachable, so the remote proof must budget that
      // owned lifecycle instead of asserting a fictitious 60-second platform
      // startup SLA.
      timeoutMs: provider === "cloudflare" ? 3 * 60_000 : 60_000,
      waitTimeoutMs: provider === "cloudflare" ? 4 * 60_000 : 30_000,
      prompt: (token) => `Return this exact release token: ${token}`,
      previewText: (_token, prompt) => `fixture response: ${prompt}`,
      restore() {},
    }
  }

  if (provider !== "cloudflare") {
    throw new ProofError(
      "PROVIDER_CAPABILITY_UNAVAILABLE",
      "Credential-bearing agent proofs require the Cloudflare mediation boundary",
    )
  }
  const toolchain = await prepareCloudflareAgentToolchain(type)
  const catalogPath = join(root, "agents.json")
  await Bun.write(catalogPath, JSON.stringify(agentCatalog(toolchain)))

  const displayName = type === "codex" ? "Codex" : type === "claude-code" ? "Claude Code" : "Pi"
  const proofText = (token: string) => `Meanwhile ${provider} ${displayName} proof ${token}`

  return {
    type,
    adapter: toolchain.adapter,
    runtime: toolchain.runtime,
    authenticationEvidence: toolchain.authenticationEvidence,
    catalogPath,
    environment: toolchain.environment,
    secretReferences: toolchain.secretReferences,
    secretValues: toolchain.secretValues,
    workspaceFiles: [
      {
        path: "README.md",
        contentBase64: encode(
          `This workspace is a live Meanwhile ${provider} proof for ${displayName} over ACP.\n`,
        ),
      },
    ],
    timeoutMs: 4 * 60_000,
    waitTimeoutMs: provider === "cloudflare" ? 8 * 60_000 : 6 * 60_000,
    prompt: (token) =>
      `Create site/index.html as a complete HTML document containing the exact visible text '${proofText(token)}'. Do not modify any other file. Finish after saving it.`,
    previewText: proofText,
    restore: () => toolchain.restore(),
  }
}

function assertRemoteProvenance(config: AppConfig): void {
  if (
    config.cloudflare?.runnerDigest === undefined ||
    config.cloudflare.runtimeImageReference === undefined ||
    config.cloudflare.runtimeImageDigest === undefined
  ) {
    throw new ProofError(
      "REMOTE_PROVENANCE_REQUIRED",
      "Cloudflare release proof requires configured runner and matching runtime-image provenance",
    )
  }
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}

function normalizeProofError(error: unknown): ProofError {
  if (error instanceof ProofError) return error
  if (error instanceof AgentToolchainError) return new ProofError(error.code, error.message)
  if (error instanceof MeanwhileError)
    return new ProofError(error.code, error.message, error.details)
  return new ProofError("RELEASE_PROOF_FAILED", "Release proof failed", {
    causeType: error instanceof Error ? error.name : typeof error,
    source: proofErrorSource(error),
  })
}

function proofErrorSource(error: unknown): string | null {
  if (!(error instanceof Error) || error.stack === undefined) return null
  for (const frame of error.stack.split("\n").slice(1)) {
    const match = frame.match(/(?:^|[/\\])([^/\\]+\.(?:ts|js)):(\d+):(\d+)/)
    if (match !== null) return `${match[1]}:${match[2]}:${match[3]}`
  }
  return null
}
