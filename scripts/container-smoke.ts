import { Meanwhile } from "../src/client"

const apiKey = Bun.env["MEANWHILE_API_KEY"]
if (apiKey === undefined) throw new Error("Packaged smoke requires MEANWHILE_API_KEY")

const meanwhile = new Meanwhile({
  baseUrl: "http://127.0.0.1:7331",
  apiKey,
})
const previewText = "Packaged Meanwhile runtime proof"
const created = await meanwhile.runs.create(
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
    provider: "local",
    artifactPaths: ["site"],
    timeoutMs: 20_000,
    prompt: "Verify the packaged runtime",
  },
  { idempotencyKey: "packaged-runtime-smoke-v1" },
)
const run = await meanwhile.runs.wait(created.id, { timeoutMs: 30_000, pollIntervalMs: 25 })
const logs = await meanwhile.runs.logs(run.id, { limit: 1_000 })
const eventTypes = new Set(logs.items.map((item) => item.eventType))
const artifacts = await meanwhile.artifacts.list(run.id)
const site = artifacts.find((artifact) => artifact.logicalPath === "site")
if (
  run.status !== "succeeded" ||
  site === undefined ||
  !eventTypes.has("agent.initialized") ||
  !eventTypes.has("session.started") ||
  !eventTypes.has("terminal")
) {
  throw new Error("Packaged agent run did not produce complete durable evidence")
}

const queued = await meanwhile.deployments.create({
  runId: run.id,
  artifactPath: "site",
  deployTarget: "local-static",
})
const deployment = await meanwhile.deployments.wait(queued.id, {
  timeoutMs: 30_000,
  pollIntervalMs: 25,
})
if (deployment.status !== "succeeded" || deployment.url === null) {
  throw new Error("Packaged deployment did not succeed")
}
const deploymentLogs = await meanwhile.deployments.logs(deployment.id, { limit: 1_000 })
const preview = await fetch(deployment.url)
const previewBody = await preview.text()
if (
  !preview.ok ||
  !previewBody.includes(previewText) ||
  preview.headers.get("x-content-type-options") !== "nosniff" ||
  new URL(deployment.url).origin === "http://127.0.0.1:7331"
) {
  throw new Error("Packaged preview did not preserve its immutable separate-origin contract")
}

console.log(
  JSON.stringify({
    status: "succeeded",
    run: run.status,
    runLogs: logs.items.length,
    artifacts: artifacts.length,
    deployment: deployment.status,
    deploymentLogs: deploymentLogs.items.length,
    previewVerified: true,
  }),
)
