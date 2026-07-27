import { Meanwhile, MeanwhileError } from "../src/client"
import { createProofEnvironment, type ProofEnvironment, ProofError } from "./proof-environment"

const arguments_ = process.argv.slice(2)
const proofText = "Meanwhile local fixture"
const servePreview = arguments_.includes("--serve")
const timeoutMs = 30_000

let environment: ProofEnvironment | null = null

try {
  environment = await createProofEnvironment()
  const meanwhile = new Meanwhile(environment.clientOptions)
  const project = await meanwhile.projects.create({
    name: "Local proof",
    slug: `local-proof-${crypto.randomUUID().slice(0, 8)}`,
  })
  const created = await meanwhile.runs.create(
    {
      projectId: project.id,
      workspace: { type: "files", files: [...environment.workspaceFiles] },
      agentType: "fixture",
      provider: "local",
      artifactPaths: ["site"],
      timeoutMs: 20_000,
      env: {},
      secretRefs: {},
      prompt: "Verify the immutable static preview",
    },
    {
      idempotencyKey: "meanwhile-local-fixture-v1",
    },
  )
  const run = await meanwhile.runs.wait(created.id, { timeoutMs, pollIntervalMs: 25 })
  const logs = await meanwhile.runs.logs(run.id, { limit: 1_000 })
  const eventTypes = new Set(logs.items.map((item) => item.eventType))
  if (run.status !== "succeeded") {
    throw new ProofError("PROOF_RUN_FAILED", "The deterministic ACP run did not succeed", {
      runStatus: run.status,
      runErrorCode: run.error?.code ?? null,
      acpInitialized: eventTypes.has("agent.initialized"),
      sessionStarted: eventTypes.has("session.started"),
      terminalRecorded: eventTypes.has("terminal"),
    })
  }

  const artifacts = await meanwhile.artifacts.list(run.id)
  const site = artifacts.find((artifact) => artifact.logicalPath === "site")
  if (site === undefined) {
    throw new ProofError("PROOF_ARTIFACT_MISSING", "The declared site artifact was not captured")
  }
  const downloaded = await meanwhile.artifacts.download(site.id, { path: "index.html" })
  const downloadedBytes = new Uint8Array(await new Response(downloaded.body).arrayBuffer())
  const downloadedText = new TextDecoder().decode(downloadedBytes)
  if (
    downloadedBytes.byteLength !== downloaded.byteSize ||
    new Bun.CryptoHasher("sha256").update(downloadedBytes).digest("hex") !== downloaded.digest ||
    !downloadedText.includes(proofText)
  ) {
    throw new ProofError(
      "PROOF_ARTIFACT_DOWNLOAD_INVALID",
      "The SDK did not return the immutable agent output",
    )
  }

  const queuedDeployment = await meanwhile.deployments.create(
    {
      runId: run.id,
      artifactPath: "site",
      deployTarget: "local-static",
    },
    { idempotencyKey: `fixture-deployment-${run.id}` },
  )
  const deployment = await meanwhile.deployments.wait(queuedDeployment.id, {
    timeoutMs,
    pollIntervalMs: 25,
  })
  if (deployment.status !== "succeeded" || deployment.url === null) {
    throw new ProofError("PROOF_DEPLOYMENT_FAILED", "The local static deployment did not succeed")
  }

  const preview = await fetch(deployment.url)
  const previewBody = await preview.text()
  const expectedPreviewText = proofText
  if (!preview.ok || !previewBody.includes(expectedPreviewText)) {
    throw new ProofError(
      "PROOF_PREVIEW_INVALID",
      "The local preview did not serve immutable output",
    )
  }
  const deploymentLogs = await meanwhile.deployments.logs(deployment.id, { limit: 1_000 })

  await writeStdout({
    fixture: "meanwhile-local",
    status: "succeeded",
    agent: { type: "fixture" },
    run: { id: run.id, status: run.status },
    evidence: {
      runLogCount: logs.items.length,
      acpInitialized: eventTypes.has("agent.initialized"),
      sessionStarted: eventTypes.has("session.started"),
      terminalRecorded: eventTypes.has("terminal"),
    },
    artifact: {
      id: site.id,
      path: site.logicalPath,
      digest: site.digest,
      byteSize: site.byteSize,
      sdkDownloadVerified: true,
    },
    deployment: {
      id: deployment.id,
      status: deployment.status,
      url: deployment.url,
      logCount: deploymentLogs.items.length,
      previewVerified: true,
    },
    note: servePreview
      ? "The verified preview remains available until this process receives SIGINT or SIGTERM."
      : "The preview server is stopped when this proof exits.",
  })
  if (servePreview) await waitForShutdown()
} catch (error) {
  const normalized = normalizeProofError(error)
  await writeStderr({
    error: { code: normalized.code, message: normalized.message, details: normalized.details },
  })
  process.exitCode = 1
} finally {
  await environment?.close()
}

function normalizeProofError(error: unknown): ProofError {
  if (error instanceof ProofError) return error
  if (error instanceof MeanwhileError)
    return new ProofError(error.code, error.message, error.details)
  return new ProofError("PROOF_FAILED", "Local fixture failed")
}

async function writeStdout(value: unknown): Promise<void> {
  const writer = Bun.stdout.writer()
  writer.write(`${JSON.stringify(value, null, 2)}\n`)
  await writer.flush()
}

async function writeStderr(value: unknown): Promise<void> {
  const writer = Bun.stderr.writer()
  writer.write(`${JSON.stringify(value)}\n`)
  await writer.flush()
}

async function waitForShutdown(): Promise<void> {
  const signals = ["SIGINT", "SIGTERM"] as const
  await new Promise<void>((resolveWait) => {
    const stop = () => {
      for (const signal of signals) process.off(signal, stop)
      resolveWait()
    }
    for (const signal of signals) process.once(signal, stop)
  })
}
