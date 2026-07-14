import { Meanwhile, MeanwhileError } from "../src/client"
import {
  createDemoEnvironment,
  type DemoAgentType,
  type DemoEnvironment,
  DemoError,
} from "./demo-environment"

const arguments_ = process.argv.slice(2)
const agentType = selectedAgentType(arguments_)
const proofText =
  agentType === "codex"
    ? "Meanwhile Codex ACP local proof"
    : agentType === "claude-code"
      ? "Meanwhile Claude Code ACP local proof"
      : agentType === "pi"
        ? "Meanwhile Pi ACP local proof"
        : "Meanwhile local demo"
const servePreview = arguments_.includes("--serve")
const timeoutMs = agentType === "demo" ? 30_000 : 5 * 60_000

let environment: DemoEnvironment | null = null

try {
  environment = await createDemoEnvironment(agentType)
  const meanwhile = new Meanwhile(environment.clientOptions)
  const { agent } = environment
  const created = await meanwhile.runs.create(
    {
      workspace: { type: "files", files: [...environment.workspaceFiles] },
      agentType,
      provider: "local",
      artifactPaths: ["site"],
      timeoutMs: agent === null ? 20_000 : 4 * 60_000,
      env: { ...agent?.environment },
      secretRefs: { ...agent?.secretReferences },
      prompt:
        agent === null
          ? "Verify the immutable static preview"
          : `Create site/index.html as a complete HTML document containing the exact visible text '${proofText}'. Do not modify any other file. Finish after saving it.`,
    },
    {
      idempotencyKey: `meanwhile-local-${agentType}-v1`,
    },
  )
  const run = await meanwhile.runs.wait(created.id, { timeoutMs, pollIntervalMs: 25 })
  const logs = await meanwhile.runs.logs(run.id, { limit: 1_000 })
  const eventTypes = new Set(logs.items.map((item) => item.eventType))
  if (run.status !== "succeeded") {
    throw new DemoError(
      agent === null
        ? "DEMO_RUN_FAILED"
        : `${agent.type.toUpperCase().replaceAll("-", "_")}_RUN_FAILED`,
      agent === null ? "The deterministic ACP run did not succeed" : `${agent.type} ACP run failed`,
      {
        runStatus: run.status,
        runErrorCode: run.error?.code ?? null,
        acpInitialized: eventTypes.has("agent.initialized"),
        sessionStarted: eventTypes.has("session.started"),
        terminalRecorded: eventTypes.has("terminal"),
      },
    )
  }

  const artifacts = await meanwhile.artifacts.list(run.id)
  const site = artifacts.find((artifact) => artifact.logicalPath === "site")
  if (site === undefined) {
    throw new DemoError("DEMO_ARTIFACT_MISSING", "The declared site artifact was not captured")
  }
  if (
    agent !== null &&
    (!eventTypes.has("agent.initialized") ||
      !eventTypes.has("session.started") ||
      !eventTypes.has("terminal"))
  ) {
    throw new DemoError(
      "AGENT_PROTOCOL_EVIDENCE_MISSING",
      "The live run did not persist the required ACP lifecycle evidence",
    )
  }

  const downloaded = await meanwhile.artifacts.download(site.id, { path: "index.html" })
  const downloadedBytes = new Uint8Array(await new Response(downloaded.body).arrayBuffer())
  const downloadedText = new TextDecoder().decode(downloadedBytes)
  if (
    downloadedBytes.byteLength !== downloaded.byteSize ||
    new Bun.CryptoHasher("sha256").update(downloadedBytes).digest("hex") !== downloaded.digest ||
    !downloadedText.includes(proofText)
  ) {
    throw new DemoError(
      "DEMO_ARTIFACT_DOWNLOAD_INVALID",
      "The SDK did not return the immutable agent output",
    )
  }

  const queuedDeployment = await meanwhile.deployments.create(
    {
      runId: run.id,
      artifactPath: "site",
      deployTarget: "local-static",
    },
    { idempotencyKey: `demo-deployment-${run.id}` },
  )
  const deployment = await meanwhile.deployments.wait(queuedDeployment.id, {
    timeoutMs,
    pollIntervalMs: 25,
  })
  if (deployment.status !== "succeeded" || deployment.url === null) {
    throw new DemoError("DEMO_DEPLOYMENT_FAILED", "The local static deployment did not succeed")
  }

  const preview = await fetch(deployment.url)
  const previewBody = await preview.text()
  const expectedPreviewText = proofText
  if (!preview.ok || !previewBody.includes(expectedPreviewText)) {
    throw new DemoError("DEMO_PREVIEW_INVALID", "The local preview did not serve immutable output")
  }
  const deploymentLogs = await meanwhile.deployments.logs(deployment.id, { limit: 1_000 })

  await writeStdout({
    demo: agent === null ? "meanwhile-local" : `meanwhile-local-${agent.type}`,
    status: "succeeded",
    agent:
      agent === null
        ? { type: "demo" }
        : {
            type: agent.type,
            version: agent.runtimeVersion,
            adapter: agent.adapter,
            loginVerifiedBy: agent.loginVerifiedBy,
          },
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
      : agent === null
        ? "The preview server is stopped when this demonstration exits."
        : "Existing local agent authentication was referenced ephemerally; the preview server and disposable local runtime are stopped when this proof exits.",
  })
  if (servePreview) await waitForShutdown()
} catch (error) {
  const normalized = normalizeDemoError(error)
  await writeStderr({
    error: { code: normalized.code, message: normalized.message, details: normalized.details },
  })
  process.exitCode = 1
} finally {
  await environment?.close()
}

function selectedAgentType(arguments_: readonly string[]): DemoAgentType {
  const selections = [
    arguments_.includes("--codex") ? "codex" : null,
    arguments_.includes("--claude") ? "claude-code" : null,
    arguments_.includes("--pi") ? "pi" : null,
  ].filter((value): value is Exclude<DemoAgentType, "demo"> => value !== null)
  if (selections.length > 1) {
    throw new DemoError("DEMO_AGENT_CONFLICT", "Select at most one live agent")
  }
  return selections[0] ?? "demo"
}

function normalizeDemoError(error: unknown): DemoError {
  if (error instanceof DemoError) return error
  if (error instanceof MeanwhileError)
    return new DemoError(error.code, error.message, error.details)
  return new DemoError("DEMO_FAILED", "Local demo failed")
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
