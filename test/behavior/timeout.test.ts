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

describe("run deadline", () => {
  test("claims timed_out and rejects a late successful exit", async () => {
    harness = await createApplicationHarness()
    const created = await createDemoRun(harness, {
      timeoutMs: 1_000,
      env: { FIXTURE_DELAY_MS: "5000" },
    })
    const terminal = await harness.waitForRun(created.id)
    expect(terminal.status).toBe("timed_out")

    await waitForRuntimeStop(harness, terminal.ownerId, terminal.id)
    const unchanged = await harness.waitForRun(created.id)
    expect(unchanged.status).toBe("timed_out")
    const statuses = harness.application.store
      .listRunStatusEvents(terminal.ownerId, terminal.id)
      .map((event) => event.toStatus)
    expect(statuses.at(-1)).toBe("timed_out")
    expect(statuses.filter((status) => status === "timed_out")).toHaveLength(1)
  }, 20_000)
})

async function waitForRuntimeStop(
  applicationHarness: ApplicationHarness,
  ownerId: string,
  runId: string,
): Promise<void> {
  const deadline = performance.now() + 7_000
  while (performance.now() < deadline) {
    const stopped = applicationHarness.application.store
      .listAudit(ownerId)
      .some((record) => record.action === "runtime.stop" && record.metadata["runId"] === runId)
    if (stopped) return
    await Bun.sleep(10)
  }
  throw new Error(`Runtime for timed-out run ${runId} was not stopped`)
}
