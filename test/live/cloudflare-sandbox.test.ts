import { expect, test } from "bun:test"

import {
  RUNNER_PROTOCOL_VERSION,
  type RunnerFrame,
  type RunnerSpec,
  runnerFrameSchema,
  type SessionRunnerFrame,
  type SessionRunnerSpec,
  sessionRunnerFrameSchema,
} from "../../runner/protocol"
import { CloudflareRuntimeProvider } from "../../src/providers/cloudflare-provider"
import {
  type ProcessEvent,
  type ProcessHandle,
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
const providerReadyTimeoutMs = 120_000
const providerReadyPollMs = 500

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
      await waitForProviderReady(provider)

      runtime = await provider.create({ runtimeId: `live-${crypto.randomUUID()}` })
      await provider.start(runtime)
      expect(await provider.inspect(runtime)).toMatchObject({ status: "running" })

      await provider.writeFiles(runtime, [
        {
          path: relativePath("live/probe.txt"),
          content: new TextEncoder().encode("cloudflare-sandbox-live"),
        },
        {
          path: relativePath("live/executable-probe"),
          content: new TextEncoder().encode("#!/bin/sh\nprintf mode-preserved"),
          mode: 0o700,
        },
      ])
      expect(
        new TextDecoder().decode(
          await provider.readFile(runtime, relativePath("live/probe.txt"), { maxBytes: 1_024 }),
        ),
      ).toBe("cloudflare-sandbox-live")
      expect(
        (await provider.listFiles(runtime, relativePath("live"), { maxEntries: 10 }))
          .map(({ path }) => String(path))
          .sort(),
      ).toEqual(["live/executable-probe", "live/probe.txt"])

      const modeProbe = await provider.spawn(runtime, {
        processId: `live-mode-${crypto.randomUUID()}`,
        argv: ["./live/executable-probe"],
        cwd: relativePath("."),
        timeoutMs: 30_000,
        terminationGraceMs: 5_000,
      })
      expect(
        (await Array.fromAsync(provider.events(modeProbe, null))).map(({ data }) => data).join(""),
      ).toBe("mode-preserved")
      expect(await provider.wait(modeProbe)).toMatchObject({ exitCode: 0, reason: "exited" })

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
        credentialEnvironmentNames: [],
      }
      const runnerProcess = await provider.spawn(runtime, {
        processId: `live-runner-${crypto.randomUUID()}`,
        argv: ["meanwhile-runner"],
        cwd: relativePath("."),
        initialStdin: `${JSON.stringify(runnerSpec)}\n`,
        timeoutMs: 60_000,
        terminationGraceMs: 5_000,
      })
      const runnerEvents = await Array.fromAsync(provider.events(runnerProcess, null))
      const runnerFrames = parseRunnerFrames(runnerEvents)
      if (!runnerFrames.some((frame) => frame.type === "session.started")) {
        throw new Error(
          `Remote runner did not initialize ACP: ${JSON.stringify({
            events: runnerEvents.map(({ stream, data }) => ({
              stream,
              data: data.slice(0, 1_000),
            })),
            exit: await provider.wait(runnerProcess),
          })}`,
        )
      }
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

      const sessionId = `live-session-${crypto.randomUUID()}`
      const sessionProcess = await provider.spawn(runtime, {
        processId: `live-session-runner-${crypto.randomUUID()}`,
        argv: ["meanwhile-runner"],
        cwd: relativePath("."),
        initialStdin: `${JSON.stringify({
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          mode: "session",
          sessionId,
          runnerSessionId: "live-session-runner",
          agent: { executable: "meanwhile-demo-agent", args: [] },
          permissionPolicy: { mode: "deny-all" },
          environment: {},
          credentialEnvironmentNames: [],
          idleTimeoutMs: 60_000,
        } satisfies SessionRunnerSpec)}\n`,
        input: "mailbox",
        timeoutMs: 90_000,
        terminationGraceMs: 5_000,
      })
      const ready = await waitForSessionFrame(
        provider,
        sessionProcess,
        null,
        (frame) => frame.type === "session.ready",
      )
      const turnId = `live-turn-${crypto.randomUUID()}`
      const turnCommandId = crypto.randomUUID()
      await provider.send(sessionProcess, {
        sequence: 1,
        id: turnCommandId,
        data: JSON.stringify({
          version: 1,
          sequence: 1,
          id: turnCommandId,
          type: "turn.start",
          turnId,
          prompt: "prove one live remote session turn",
          timeoutBudgetMs: 30_000,
        }),
      })
      const terminal = await waitForSessionFrame(
        provider,
        sessionProcess,
        ready.cursor,
        (frame) => frame.type === "turn.terminal" && frame.payload.turnId === turnId,
      )
      expect(terminal.frames).toContainEqual(
        expect.objectContaining({
          type: "turn.terminal",
          payload: { turnId, result: { outcome: "succeeded", stopReason: "end_turn" } },
        }),
      )
      const closeCommandId = crypto.randomUUID()
      await provider.send(sessionProcess, {
        sequence: 2,
        id: closeCommandId,
        data: JSON.stringify({
          version: 1,
          sequence: 2,
          id: closeCommandId,
          type: "session.close",
        }),
      })
      const closed = await waitForSessionFrame(
        provider,
        sessionProcess,
        terminal.cursor,
        (frame) => frame.type === "session.closed",
      )
      expect(closed.frames).toContainEqual(
        expect.objectContaining({ type: "session.closed", payload: { reason: "requested" } }),
      )
      expect(await provider.wait(sessionProcess)).toMatchObject({ exitCode: 0, reason: "exited" })

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
          "Bun.serve({port:3001,hostname:'0.0.0.0',fetch(){return new Response('ok')}});console.log('preview-ready')",
        ],
        cwd: relativePath("."),
        timeoutMs: 60_000,
        terminationGraceMs: 5_000,
      })
      await waitForProcessOutput(provider, previewServer, "preview-ready")
      if (new URL(bridgeUrl).hostname.endsWith(".workers.dev")) {
        await expect(provider.expose(runtime, 3_001)).rejects.toMatchObject({
          code: "PORT_EXPOSURE_REQUIRES_CUSTOM_DOMAIN",
          retryable: false,
        })
      } else {
        expect(await provider.expose(runtime, 3_001)).toMatchObject({
          port: 3_001,
          url: expect.stringMatching(/^https:\/\//),
        })
      }
      await provider.signal(previewServer, "SIGKILL")

      const credentialLeaseId = crypto.randomUUID()
      const credentialValue = `live-credential-${crypto.randomUUID()}`
      const credentialLease = await provider.attach({
        leaseId: credentialLeaseId,
        runtime,
        allowedHosts: ["httpbin.org"],
        credentials: [
          {
            environmentVariable: "LIVE_PROVIDER_TOKEN",
            host: "httpbin.org",
            methods: ["POST"],
            value: credentialValue,
          },
        ],
      })
      expect(credentialLease.environment["LIVE_PROVIDER_TOKEN"]).toMatch(/^mwcap_v1_/)
      expect(credentialLease.environment["LIVE_PROVIDER_TOKEN"]).not.toBe(credentialValue)
      const mediated = await provider.spawn(runtime, {
        processId: `live-credential-${crypto.randomUUID()}`,
        argv: [
          "bun",
          "-e",
          "const value=process.env.LIVE_PROVIDER_TOKEN;if(!value?.startsWith('mwcap_v1_'))process.exit(41);const response=await fetch('https://httpbin.org/anything',{method:'POST',headers:{authorization:'Bearer '+value},body:'proof'});console.log(JSON.stringify(await response.json()))",
        ],
        cwd: relativePath("."),
        env: credentialLease.environment,
        timeoutMs: 30_000,
        terminationGraceMs: 5_000,
      })
      const mediatedOutput = (await Array.fromAsync(provider.events(mediated, null)))
        .map(({ data }) => data)
        .join("")
      expect(mediatedOutput).not.toContain(credentialValue)
      expect(mediatedOutput).toContain(credentialLease.environment["LIVE_PROVIDER_TOKEN"] as string)
      expect(await provider.wait(mediated)).toMatchObject({ exitCode: 0, reason: "exited" })

      await provider.revoke({
        leaseId: credentialLeaseId,
        runtime,
        handle: credentialLease.handle,
      })
      const denied = await provider.spawn(runtime, {
        processId: `live-denied-egress-${crypto.randomUUID()}`,
        argv: [
          "bun",
          "-e",
          "const response=await fetch('https://example.com');console.log(response.status)",
        ],
        cwd: relativePath("."),
        timeoutMs: 30_000,
        terminationGraceMs: 5_000,
      })
      const deniedOutput = (await Array.fromAsync(provider.events(denied, null)))
        .map(({ data }) => data)
        .join("")
        .trim()
      expect(deniedOutput).toBe("403")
      expect(await provider.wait(denied)).toMatchObject({ exitCode: 0, reason: "exited" })

      await provider.stop(runtime)
      await provider.stop(runtime)
    } finally {
      if (runtime) {
        await provider.destroy(runtime)
        await provider.destroy(runtime)
      }
    }
  },
  300_000,
)

async function waitForProviderReady(provider: CloudflareRuntimeProvider): Promise<void> {
  const deadline = performance.now() + providerReadyTimeoutMs
  let lastHealth = await provider.health()

  while (lastHealth.status !== "healthy" && performance.now() < deadline) {
    await Bun.sleep(providerReadyPollMs)
    lastHealth = await provider.health()
  }

  if (lastHealth.status !== "healthy") {
    throw new Error(
      `Cloudflare provider did not become ready: ${JSON.stringify({
        status: lastHealth.status,
        message: lastHealth.message,
      })}`,
    )
  }
}

async function waitForProcessOutput(
  provider: CloudflareRuntimeProvider,
  process: ProcessHandle,
  expected: string,
): Promise<void> {
  let output = ""
  for await (const event of provider.events(process, null, AbortSignal.timeout(30_000))) {
    output += event.data
    if (output.includes(expected)) return
  }
  throw new Error("Cloudflare preview process exited before reporting readiness")
}

function parseRunnerFrames(events: readonly ProcessEvent[]): RunnerFrame[] {
  return events
    .filter((event) => event.stream === "stdout")
    .map((event) => event.data)
    .join("")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => runnerFrameSchema.parse(JSON.parse(line)))
}

async function waitForSessionFrame(
  provider: CloudflareRuntimeProvider,
  process: ProcessHandle,
  cursor: string | null,
  predicate: (frame: SessionRunnerFrame) => boolean,
): Promise<{ readonly cursor: string; readonly frames: readonly SessionRunnerFrame[] }> {
  let buffer = ""
  const frames: SessionRunnerFrame[] = []
  for await (const event of provider.events(process, cursor, AbortSignal.timeout(30_000))) {
    if (event.stream !== "stdout") continue
    buffer += event.data
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.length === 0) continue
      frames.push(sessionRunnerFrameSchema.parse(JSON.parse(line)))
    }
    if (frames.some(predicate)) return { cursor: event.cursor, frames }
  }
  throw new Error("Cloudflare session runner exited before emitting expected evidence")
}
