import { expect, test } from "bun:test"

import {
  RUNNER_PROTOCOL_VERSION,
  type RunnerFrame,
  type RunnerSpec,
  runnerFrameSchema,
} from "../../runner/protocol"
import { CloudflareRuntimeProvider } from "../../src/providers/cloudflare-provider"
import {
  type ProcessEvent,
  type RuntimeHandle,
  relativePath,
} from "../../src/providers/runtime-provider"

const liveEnvironment = process.env as typeof process.env & {
  CLOUDFLARE_BRIDGE_URL?: string
  CLOUDFLARE_BRIDGE_TOKEN?: string
  MEANWHILE_LIVE_CLOUDFLARE?: string
}
const bridgeUrl = liveEnvironment.CLOUDFLARE_BRIDGE_URL?.replace(/\/$/, "")
const bridgeToken = liveEnvironment.CLOUDFLARE_BRIDGE_TOKEN
const liveTestEnabled = liveEnvironment.MEANWHILE_LIVE_CLOUDFLARE === "1"
const liveCredentialsReady = Boolean(bridgeUrl && bridgeToken)

if (liveTestEnabled && !liveCredentialsReady) {
  test("Cloudflare live proof has explicit credentials", () => {
    throw new Error(
      "Cloudflare live proof requires CLOUDFLARE_BRIDGE_URL and CLOUDFLARE_BRIDGE_TOKEN; " +
        "the dedicated command never skips a requested remote lifecycle.",
    )
  })
}

const liveTest = liveTestEnabled && liveCredentialsReady ? test : test.skip

liveTest(
  "real Cloudflare provider lifecycle",
  async () => {
    if (!bridgeUrl || !bridgeToken) throw new Error("Cloudflare live-test gate is inconsistent")

    const provider = new CloudflareRuntimeProvider({
      bridgeUrl,
      bridgeToken,
      eventPollIntervalMs: 25,
      waitRequestMs: 5_000,
    })
    let runtime: RuntimeHandle | undefined

    try {
      expect(await provider.health()).toMatchObject({ status: "healthy" })

      runtime = await provider.create({ runtimeId: `live-${crypto.randomUUID()}` })
      await provider.start(runtime)
      expect(await provider.inspect(runtime)).toMatchObject({ status: "running" })

      await provider.writeFiles(runtime, [
        {
          path: relativePath("live/probe.txt"),
          content: new TextEncoder().encode("cloudflare-sandbox-live"),
        },
      ])
      expect(
        new TextDecoder().decode(
          await provider.readFile(runtime, relativePath("live/probe.txt"), { maxBytes: 1_024 }),
        ),
      ).toBe("cloudflare-sandbox-live")
      expect(await provider.listFiles(runtime, relativePath("live"), { maxEntries: 10 })).toEqual([
        expect.objectContaining({ path: "live/probe.txt", type: "file" }),
      ])

      const process = await provider.spawn(runtime, {
        processId: `live-process-${crypto.randomUUID()}`,
        argv: ["/bin/sh", "-c", "IFS= read -r value; /usr/bin/printf '%s' \"$value\""],
        cwd: relativePath("."),
        initialStdin: "cloudflare-process-live\n",
        timeoutMs: 30_000,
        terminationGraceMs: 5_000,
      })
      const events = await Array.fromAsync(provider.events(process, null))
      expect(events.map((event) => event.data).join("")).toContain("cloudflare-process-live")
      expect(await provider.wait(process)).toMatchObject({ exitCode: 0, reason: "exited" })

      const runnerSpec: RunnerSpec = {
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        runId: `live-run-${crypto.randomUUID()}`,
        runnerSessionId: `live-runner-session-${crypto.randomUUID()}`,
        agent: {
          executable: "meanwhile-demo-agent",
          args: [],
        },
        prompt: "prove the remote ACP lifecycle",
        permissionPolicy: { mode: "deny-all" },
        artifactPaths: [],
        timeoutBudgetMs: 60_000,
        environment: {},
        secretEnvironmentNames: [],
      }
      const runnerProcess = await provider.spawn(runtime, {
        processId: `live-runner-${crypto.randomUUID()}`,
        argv: ["meanwhile-runner"],
        cwd: relativePath("."),
        initialStdin: `${JSON.stringify(runnerSpec)}\n`,
        timeoutMs: 60_000,
        terminationGraceMs: 5_000,
      })
      const runnerFrames = parseRunnerFrames(
        await Array.fromAsync(provider.events(runnerProcess, null)),
      )
      expect(runnerFrames).toContainEqual(
        expect.objectContaining({
          type: "session.started",
          payload: expect.objectContaining({
            sessionId: expect.stringMatching(/^fixture-session-/),
          }),
        }),
      )
      expect(runnerFrames).toContainEqual(
        expect.objectContaining({
          type: "terminal",
          payload: { outcome: "succeeded", stopReason: "end_turn" },
        }),
      )
      expect(await provider.wait(runnerProcess)).toMatchObject({ exitCode: 0, reason: "exited" })

      const cancellable = await provider.spawn(runtime, {
        processId: `live-cancel-${crypto.randomUUID()}`,
        argv: ["/bin/sh", "-c", "sleep 30 & wait"],
        cwd: relativePath("."),
        timeoutMs: 60_000,
        terminationGraceMs: 5_000,
      })
      await provider.signal(cancellable, "SIGKILL")
      expect(await provider.wait(cancellable)).toMatchObject({ reason: "signaled" })

      const previewServer = await provider.spawn(runtime, {
        processId: `live-preview-${crypto.randomUUID()}`,
        argv: [
          "bun",
          "-e",
          "Bun.serve({port:3001,hostname:'0.0.0.0',fetch(){return new Response('ok')}})",
        ],
        cwd: relativePath("."),
        timeoutMs: 60_000,
        terminationGraceMs: 5_000,
      })
      expect(await provider.expose(runtime, 3_001)).toMatchObject({
        port: 3_001,
        url: expect.stringMatching(/^https:\/\//),
      })
      await provider.signal(previewServer, "SIGKILL")

      await provider.stop(runtime)
      await provider.stop(runtime)
    } finally {
      if (runtime) {
        await provider.destroy(runtime)
        await provider.destroy(runtime)
      }
    }
  },
  120_000,
)

function parseRunnerFrames(events: readonly ProcessEvent[]): RunnerFrame[] {
  return events
    .filter((event) => event.stream === "stdout")
    .map((event) => event.data)
    .join("")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => runnerFrameSchema.parse(JSON.parse(line)))
}
