import { expect, test } from "bun:test"
import type { RunEvent } from "../../src/api/contracts"
import { timelineFromEvents } from "../../src/timeline"
import { createApplicationHarness, createDemoRun } from "../application-harness"

test("one durable run journal explains status, agent work, output, and cleanup", async () => {
  const harness = await createApplicationHarness()
  try {
    const run = await createDemoRun(harness)
    expect((await harness.waitForRun(run.id)).status).toBe("succeeded")

    const events = await waitForCompleteJournal(harness.request, run.id)
    expect(events.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    )
    expect(
      events.filter((event) => event.type === "run.status").map((event) => event.payload.toStatus),
    ).toEqual(["queued", "provisioning", "running", "succeeded"])
    expect(events.some(({ type }) => type === "agent.update")).toBeTrue()
    expect(events.some(({ type }) => type === "artifact.captured")).toBeTrue()
    expect(
      events.some(
        (event) => event.type === "runtime.cleanup" && event.payload.status === "succeeded",
      ),
    ).toBeTrue()

    const timeline = timelineFromEvents(events)
    expect(timeline).toMatchObject({ runId: run.id, status: "succeeded" })
    expect(timeline.cursor).toBe(events.length)
    expect(timeline.messages.length).toBeGreaterThan(0)
  } finally {
    await harness.close()
  }
})

async function waitForCompleteJournal(
  request: (path: string, init?: RequestInit) => Promise<Response>,
  runId: string,
): Promise<readonly RunEvent[]> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const response = await request(`/runs/${runId}/events?limit=1000`)
    if (!response.ok) throw new Error(await response.text())
    const events = ((await response.json()) as { readonly items: readonly RunEvent[] }).items
    if (
      events.some(
        (event) => event.type === "runtime.cleanup" && event.payload.status === "succeeded",
      )
    ) {
      return events
    }
    await Bun.sleep(20)
  }
  throw new Error("Run event journal did not record successful runtime cleanup")
}
