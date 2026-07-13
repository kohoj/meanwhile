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

describe("running cancellation", () => {
  test("persists intent, signals the runner, claims cancelled once, and schedules cleanup", async () => {
    harness = await createApplicationHarness()
    const created = await createDemoRun(harness, { env: { FIXTURE_DELAY_MS: "10000" } })
    await harness.waitForRun(created.id, ["running"])

    const response = await harness.request(`/runs/${created.id}/cancel`, { method: "POST" })
    expect(response.status).toBe(202)
    const cancelled = await harness.waitForRun(created.id)
    expect(cancelled.status).toBe("cancelled")

    await waitForRuntimeStop(harness, cancelled.ownerId, cancelled.id)
    const afterLateRunnerExit = await harness.waitForRun(created.id)
    expect(afterLateRunnerExit.status).toBe("cancelled")
    const statuses = harness.application.store
      .listRunStatusEvents(cancelled.ownerId, cancelled.id)
      .map((event) => event.toStatus)
    expect(statuses).toEqual(["queued", "provisioning", "running", "cancelled"])
    const actions = harness.application.store
      .listAudit(cancelled.ownerId, cancelled.id)
      .map((record) => record.action)
    expect(actions).toContain("run.cancel_request")
    expect(actions.filter((action) => action === "run.cancelled")).toHaveLength(1)
  })
})

async function waitForRuntimeStop(
  applicationHarness: ApplicationHarness,
  ownerId: string,
  runId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const stopped = applicationHarness.application.store
      .listAudit(ownerId)
      .some((record) => record.action === "runtime.stop" && record.metadata["runId"] === runId)
    if (stopped) return
    await Bun.sleep(10)
  }
  throw new Error(`Runtime for cancelled run ${runId} was not stopped`)
}
