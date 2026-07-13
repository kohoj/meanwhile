import { afterEach, describe, expect, test } from "bun:test"
import {
  type ApplicationHarness,
  createApplicationHarness,
  createDemoRun,
} from "../application-harness"

let harness: ApplicationHarness | null = null

afterEach(async () => {
  await harness?.close()
  harness = null
})

describe("complete run lifecycle", () => {
  test("uploaded files traverse ACP and produce durable logs, artifacts, status, and audit", async () => {
    harness = await createApplicationHarness()
    const created = await createDemoRun(harness)
    expect(created.status).toBe("queued")

    const terminal = await harness.waitForRun(created.id)
    expect(terminal.status).toBe("succeeded")
    expect(terminal.startedAt).not.toBeNull()
    expect(terminal.finishedAt).not.toBeNull()

    const events = harness.application.store.listRunStatusEvents(terminal.ownerId, terminal.id)
    expect(events.map((event) => event.toStatus)).toEqual([
      "queued",
      "provisioning",
      "running",
      "succeeded",
    ])

    const logsResponse = await harness.request(`/runs/${terminal.id}/logs`)
    expect(logsResponse.status).toBe(200)
    const logs = (await logsResponse.json()) as { items: { eventType: string }[] }
    expect(logs.items.some((item) => item.eventType === "session.started")).toBeTrue()
    expect(logs.items.some((item) => item.eventType === "terminal")).toBeTrue()

    const artifactsResponse = await harness.request(`/runs/${terminal.id}/artifacts`)
    expect(artifactsResponse.status).toBe(200)
    const artifacts = (await artifactsResponse.json()) as { items: { logicalPath: string }[] }
    expect(artifacts.items.map((artifact) => artifact.logicalPath)).toEqual(["dist"])

    const actions = harness.application.store
      .listAudit(terminal.ownerId)
      .map((record) => record.action)
    expect(actions).toContain("run.create")
    expect(actions).toContain("runtime.create")
    expect(actions).toContain("runtime.start")
    expect(actions).toContain("agent.start")

    const deployResponse = await harness.request("/deployments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: terminal.id,
        artifactPath: "dist",
        deployTarget: "local-static",
        config: {},
        secretRefs: {},
      }),
    })
    expect(deployResponse.status).toBe(202)
    const queuedDeployment = (await deployResponse.json()) as {
      deployment: { id: string; status: string }
    }
    const deploymentDeadline = Date.now() + 5_000
    type DeploymentView = { status: string; url: string | null }
    let deployment: DeploymentView | null = null
    while (Date.now() < deploymentDeadline) {
      const response = await harness.request(`/deployments/${queuedDeployment.deployment.id}`)
      deployment = ((await response.json()) as { deployment: DeploymentView }).deployment
      if (deployment?.status === "succeeded") break
      await Bun.sleep(20)
    }
    expect(deployment?.status).toBe("succeeded")
    expect(deployment?.url).not.toBeNull()
    const preview = await fetch(deployment?.url as string)
    expect(preview.status).toBe(200)
    expect(await preview.text()).toContain("Meanwhile")
  })
})
