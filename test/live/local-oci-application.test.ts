import { expect, test } from "bun:test"
import { homedir } from "node:os"
import type { RunEvent } from "../../src/api/contracts"
import { createApplicationHarness, createFixtureRun } from "../application-harness"

const live = process.env["MEANWHILE_LIVE_LOCAL_OCI"] === "1"

test.skipIf(!live)(
  "completes one authoritative Run through the packaged local OCI runner image",
  async () => {
    const harness = await createApplicationHarness({
      runConcurrency: 1,
      defaultProvider: "oci-local",
      ociLocal: {
        imageReference: process.env["MEANWHILE_LOCAL_OCI_IMAGE"] ?? "meanwhile/local-runtime:0.1.3",
        engineExecutable: process.env["MEANWHILE_LOCAL_OCI_ENGINE"] ?? "docker",
      },
      directoryRoot: homedir(),
    })
    try {
      const accepted = await createFixtureRun(harness, {
        provider: "oci-local",
        prompt: "Complete the deterministic task in the local OCI sandbox",
      })
      const run = await harness.waitForRun(accepted.id)
      if (run.status !== "succeeded") {
        throw new Error(`OCI Run failed: ${JSON.stringify(run.error)}`)
      }
      expect(run.provider).toBe("oci-local")
      const events = await json<{ items: Array<{ type: string }> }>(
        await harness.request(`/runs/${run.id}/events?after=0&limit=100&follow=false`),
      )
      if (!events.items.some((event) => event.type === "agent.terminal")) {
        throw new Error(`OCI Run events missed terminal frame: ${JSON.stringify(events.items)}`)
      }
      await waitForRuntimeCleanup(harness.request, run.id)
      expect(harness.application.store.getRuntimeForRun(run.id)?.cleanupStatus).toBe("succeeded")
      expect(harness.operationalLogs.join("\n")).not.toContain("MEANWHILE_CONNECTOR_TOKEN")
    } finally {
      await harness.close()
    }
  },
  30_000,
)

async function json<Value>(response: Response): Promise<Value> {
  if (!response.ok) throw new Error(await response.text())
  return (await response.json()) as Value
}

async function waitForRuntimeCleanup(
  request: (path: string, init?: RequestInit) => Promise<Response>,
  runId: string,
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const events = await json<{ readonly items: readonly RunEvent[] }>(
      await request(`/runs/${runId}/events?limit=1000`),
    )
    if (
      events.items.some(
        (event) => event.type === "runtime.cleanup" && event.payload.status === "succeeded",
      )
    ) {
      return
    }
    await Bun.sleep(20)
  }
  throw new Error("OCI Run did not durably complete runtime cleanup")
}
