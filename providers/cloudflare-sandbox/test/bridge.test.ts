import { beforeAll, describe, expect, mock, test } from "bun:test"
import { rm } from "node:fs/promises"

import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeError,
  decodeEventCursor,
  type ExposedEndpoint,
  encodeEventCursor,
  eventPrefixDigest,
  INITIAL_EVENT_CURSOR,
  MAX_PROCESS_OUTPUT_BYTES,
  type ProcessEventsResponse,
  type ProcessInputRequest,
  type ProcessSignal,
  type ProcessSnapshot,
  type RuntimeFileInfo,
  type RuntimeSnapshot,
  type SpawnProcessRequest,
  type WriteFilesRequest,
} from "../src/protocol"
import type {
  BridgeRuntime,
  CloudflareBridgeEnvironment,
  ReadRuntimeFile,
  CloudflareRuntimeSandbox as Sandbox,
} from "../src/sandbox"

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}))

let createBridgeApp: typeof import("../src/worker").createBridgeApp
let InMemoryBridgeRegistry: typeof import("../src/worker").InMemoryBridgeRegistry
let encryptCredentialPayload: typeof import("../src/worker").encryptCredentialPayload
let decryptCredentialPayload: typeof import("../src/worker").decryptCredentialPayload
let redactCredentialResponse: typeof import("../src/worker").redactCredentialResponse
let ContainerProxy: typeof import("../src/worker").ContainerProxy
let SandboxDurableObject: typeof import("../src/worker").Sandbox
let CloudflareBridgeRuntime: typeof import("../src/sandbox").CloudflareBridgeRuntime
let processCompletionMarker: typeof import("../src/sandbox").processCompletionMarker
let shellJoin: typeof import("../src/sandbox").shellJoin

beforeAll(async () => {
  ;({
    createBridgeApp,
    InMemoryBridgeRegistry,
    encryptCredentialPayload,
    decryptCredentialPayload,
    redactCredentialResponse,
    ContainerProxy,
    Sandbox: SandboxDurableObject,
  } = await import("../src/worker"))
  const sandboxModule = await import("../src/sandbox")
  CloudflareBridgeRuntime = sandboxModule.CloudflareBridgeRuntime
  ;({ processCompletionMarker, shellJoin } = sandboxModule)
})

const TOKEN = "test-bridge-token-that-is-at-least-thirty-two-bytes"
const RUNTIME_ID = "mw-3f390eef-460f-4a08-a067-8fa1bb9dcd21"
const PROCESS_ID = "mp-e5549e84-bb1d-4b6d-ad1c-dc5313de61f1"

describe("Cloudflare Sandbox bridge", () => {
  test("returns one deterministic denial without delegating unauthorized egress", async () => {
    expect(typeof SandboxDurableObject.outbound).toBe("function")
    expect(Object.keys(SandboxDurableObject.outboundHandlers ?? {}).sort()).toEqual([
      "__outbound__",
      "credentialEgress",
    ])

    const defaultResponse = await SandboxDurableObject.outbound?.(
      new Request("https://unauthorized.example/path"),
      {} as CloudflareBridgeEnvironment,
      {} as Parameters<NonNullable<typeof SandboxDurableObject.outbound>>[2],
    )
    const proxy = Object.assign(Object.create(ContainerProxy.prototype), {
      ctx: { props: { containerId: "container", outboundByHostOverrides: {} } },
      env: {},
    }) as InstanceType<typeof ContainerProxy>

    const response = await proxy.fetch(new Request("https://unauthorized.example/path"))

    expect(defaultResponse?.status).toBe(403)
    expect(response.status).toBe(403)
    expect(await response.text()).toBe("Outbound destination is not authorized")
  })

  test("redacts reflected credentials across response stream boundaries", async () => {
    const secret = "credential-that-must-not-return"
    const placeholder = "mwcap_v1_safe-placeholder"
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`before ${secret.slice(0, 11)}`))
        controller.enqueue(new TextEncoder().encode(`${secret.slice(11)} after`))
        controller.close()
      },
    })
    const response = redactCredentialResponse(
      new Response(stream, {
        headers: {
          "content-length": "999",
          "x-reflected-credential": secret,
        },
      }),
      [{ placeholder, value: secret }],
    )

    expect(await response.text()).toBe(`before ${placeholder} after`)
    expect(response.headers.get("x-reflected-credential")).toBe(placeholder)
    expect(response.headers.has("content-length")).toBeFalse()
  })

  test("protects every control-plane endpoint with a constant-shape bearer boundary", async () => {
    const fixture = createFixture({ seedRuntime: false })

    const missing = await fixture.request("/v1/health")
    expect(missing.status).toBe(401)
    expect(await errorCode(missing)).toBe("UNAUTHORIZED")

    const invalid = await fixture.request("/v1/health", {
      headers: { authorization: "Bearer incorrect-token-that-is-long-enough-to-look-valid" },
    })
    expect(invalid.status).toBe(401)
    expect(await errorCode(invalid)).toBe("UNAUTHORIZED")

    const authenticated = await fixture.request("/v1/health", { headers: authorizationHeader() })
    expect(authenticated.status).toBe(200)
    expect(await authenticated.json()).toMatchObject({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sandboxSdkVersion: "0.12.3",
      capabilities: {
        networkPolicy: "exact-host-default-deny",
        credentialMediation: "http-placeholder",
      },
    })

    const incompatible = await fixture.request("/v1/health", {
      headers: {
        ...authorizationHeader(),
        "x-meanwhile-protocol-version": String(BRIDGE_PROTOCOL_VERSION + 1),
      },
    })
    expect(incompatible.status).toBe(409)
    expect(await errorCode(incompatible)).toBe("BRIDGE_PROTOCOL_UNSUPPORTED")
  })

  test("pins the SDK, image, and HTTP transport as one compatibility unit", async () => {
    const packageManifest = JSON.parse(
      await Bun.file(new URL("../package.json", import.meta.url)).text(),
    ) as { dependencies: Record<string, string>; scripts: Record<string, string> }
    const stagingScript = await Bun.file(
      new URL("../../../scripts/stage-cloudflare-runner.ts", import.meta.url),
    ).text()
    const dockerfile = await Bun.file(new URL("../Dockerfile", import.meta.url)).text()
    const wrangler = await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text()
    const wranglerConfig = JSON.parse(wrangler) as {
      containers: Array<{ class_name: string; name: string }>
      migrations: Array<{ new_sqlite_classes: string[]; tag: string }>
    }
    const codexWrapper = await Bun.file(new URL("../image/codex-acp", import.meta.url)).text()
    const piAdapterWrapper = await Bun.file(new URL("../image/pi-acp", import.meta.url)).text()
    const piRuntimeWrapper = await Bun.file(new URL("../image/pi-runtime", import.meta.url)).text()

    expect(packageManifest.dependencies["@cloudflare/sandbox"]).toBe("0.12.3")
    expect(packageManifest.scripts["runner:stage"]).toBe(
      "bun ../../scripts/stage-cloudflare-runner.ts",
    )
    expect(stagingScript).toMatch(/bun-linux-x64-baseline-v\$\{version\}/)
    expect(stagingScript).toContain("meanwhile-demo-agent")
    expect(dockerfile).toContain(
      "FROM docker.io/cloudflare/sandbox:0.12.3@sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042",
    )
    expect(dockerfile).toContain(".runner/meanwhile-runner /opt/meanwhile/bin/meanwhile-runner")
    expect(dockerfile).toContain(
      ".runner/meanwhile-demo-agent /opt/meanwhile/bin/meanwhile-demo-agent",
    )
    expect(dockerfile).toContain(".runner/BUN_VERSION /opt/meanwhile/metadata/BUN_VERSION")
    expect(dockerfile).toContain("bun install --frozen-lockfile --production")
    expect(dockerfile).toContain("image/claude-agent-acp /opt/meanwhile/bin/claude-agent-acp")
    expect(dockerfile).toContain("image/codex-acp /opt/meanwhile/bin/codex-acp")
    expect(dockerfile).toContain("image/pi-acp /opt/meanwhile/bin/pi-acp")
    expect(dockerfile).toContain("image/pi-runtime /opt/meanwhile/bin/pi-runtime")
    expect(codexWrapper).toContain("CODEX_AUTH_ACCESS_TOKEN")
    expect(codexWrapper).toContain('process.once("exit"')
    expect(codexWrapper).not.toContain("CODEX_AUTH_JSON")
    expect(piAdapterWrapper).toContain('"/opt/meanwhile/bin/pi-runtime"')
    expect(piRuntimeWrapper).toStartWith("#!/usr/bin/env bun")
    const runtimeAgentManifest = JSON.parse(
      await Bun.file(new URL("../image/package.json", import.meta.url)).text(),
    ) as { dependencies: Record<string, string> }
    expect(runtimeAgentManifest.dependencies["@agentclientprotocol/claude-agent-acp"]).toBe(
      "0.58.1",
    )
    expect(runtimeAgentManifest.dependencies["@agentclientprotocol/codex-acp"]).toBe("1.1.2")
    expect(runtimeAgentManifest.dependencies["@openai/codex"]).toBe("0.144.3")
    expect(runtimeAgentManifest.dependencies["pi-acp"]).toBe("0.0.31")
    expect(runtimeAgentManifest.dependencies["@earendil-works/pi-coding-agent"]).toBe("0.80.6")
    expect(wrangler).toContain('"SANDBOX_TRANSPORT": "http"')
    expect(wrangler).toContain('"SANDBOX_INSTANCE_TIMEOUT_MS": "5000"')
    expect(wrangler).toContain('"SANDBOX_PORT_TIMEOUT_MS": "10000"')
    expect(wrangler).toContain('"instance_type": "standard-1"')
    expect(wranglerConfig.containers).toMatchObject([
      { class_name: "Sandbox", name: "meanwhile-cloudflare-runtime" },
    ])
    expect(wranglerConfig.migrations).toEqual([
      { new_sqlite_classes: ["Sandbox"], tag: "v1" },
      { new_sqlite_classes: ["RuntimeRegistry"], tag: "v2" },
    ])
  })

  test("uses one SDK-owned deterministic default session for the runtime", async () => {
    let listCalls = 0
    let writeCalls = 0
    const commands: string[] = []
    const lifecycle: string[] = []
    const sandbox = {
      async configure(configuration: {
        keepAlive?: boolean
        sleepAfter?: string
        transport?: string
      }) {
        lifecycle.push("configure")
        expect(configuration).toMatchObject({ sleepAfter: "25h", transport: "http" })
        expect(configuration).not.toHaveProperty("keepAlive")
      },
      async setRuntimeLease(value: boolean) {
        lifecycle.push(`runtime-lease:${value}`)
      },
      async listProcesses() {
        listCalls += 1
        return []
      },
      async exec(command: string) {
        lifecycle.push("exec")
        commands.push(command)
        return { exitCode: 0 }
      },
      async writeFile() {
        writeCalls += 1
      },
    } as unknown as Sandbox
    const runtime = new CloudflareBridgeRuntime(RUNTIME_ID, sandbox)

    await runtime.start()
    await runtime.writeFiles({
      files: [{ path: "probe.txt", contentBase64: "cHJvYmU=", mode: 0o600 }],
    })

    expect(listCalls).toBe(1)
    expect(commands).toHaveLength(5)
    expect(commands[0]).toBe("/bin/true")
    expect(writeCalls).toBe(1)
    expect(lifecycle.slice(0, 3)).toEqual(["configure", "runtime-lease:true", "exec"])
  })

  test("does not query the process API after the container has stopped", async () => {
    const lifecycle: string[] = []
    const sandbox = {
      async getExposedPorts() {
        return []
      },
      async killAllProcesses() {
        lifecycle.push("kill-all")
      },
      async setRuntimeLease(value: boolean) {
        lifecycle.push(`runtime-lease:${value}`)
      },
      async stop() {
        lifecycle.push("stop")
      },
      async listProcesses() {
        throw new Error("process API is unavailable after stop")
      },
    } as unknown as Sandbox

    expect(await new CloudflareBridgeRuntime(RUNTIME_ID, sandbox).stop()).toMatchObject({
      state: "stopped",
      processCount: 0,
      activeProcessCount: 0,
    })
    expect(lifecycle).toEqual(["kill-all", "runtime-lease:false", "stop"])
  })

  test("destroys a replacement container when its physical placement changes", async () => {
    let placementId = "placement-a"
    let destroyed = false
    const sandbox = {
      async setContainerTimeouts() {},
      async exec() {
        return { exitCode: 0 }
      },
      async getContainerPlacementId() {
        return placementId
      },
      async destroy() {
        destroyed = true
      },
    } as unknown as Sandbox
    const runtime = new CloudflareBridgeRuntime(RUNTIME_ID, sandbox)

    await runtime.assertPlacement("placement-a")
    placementId = "placement-b"

    await expect(runtime.assertPlacement("placement-a")).rejects.toMatchObject({
      code: "RUNTIME_LOST",
      details: { replacementDestroyed: true, retryable: false },
    })
    expect(destroyed).toBeTrue()
  })

  test("fails closed when an accepted runtime generation can no longer be proved", async () => {
    let destroyed = false
    const sandbox = {
      async exec() {
        throw new Error("container unavailable")
      },
      async destroy() {
        destroyed = true
      },
    } as unknown as Sandbox
    const runtime = new CloudflareBridgeRuntime(RUNTIME_ID, sandbox)

    await expect(runtime.assertPlacement("placement-a")).rejects.toMatchObject({
      code: "RUNTIME_LOST",
      details: { replacementDestroyed: true, retryable: false },
    })
    expect(destroyed).toBeTrue()
  })

  test("rejects a replaced runtime before admitting a workspace mutation", async () => {
    const runtime = new FakeRuntime()
    runtime.placement = "replacement"
    const registry = new InMemoryBridgeRegistry(() => runtime)
    registry.seed(RUNTIME_ID, "active", "accepted")
    const app = createBridgeApp({
      runtimeFactory: () => runtime,
      registryFactory: () => registry,
    })
    const response = await app.request(
      `https://bridge.test/v1/runtimes/${RUNTIME_ID}/files`,
      {
        method: "PUT",
        headers: { ...authorizationHeader(), "content-type": "application/json" },
        body: JSON.stringify({
          files: [{ path: "result.txt", contentBase64: "cmVzdWx0", mode: 0o600 }],
        }),
      },
      { BRIDGE_TOKEN: TOKEN } as CloudflareBridgeEnvironment,
    )

    expect(response.status).toBe(409)
    expect(await errorCode(response)).toBe("RUNTIME_LOST")
    expect(runtime.calls).not.toContain("writeFiles")
  })

  test("disposes every provider process capability after materializing durable evidence", async () => {
    let disposed = 0
    const process = () => ({
      id: PROCESS_ID,
      command: "runner",
      status: "running" as const,
      startTime: new Date("2026-07-13T00:00:00.000Z"),
      async getStatus() {
        return "running" as const
      },
      [Symbol.dispose]() {
        disposed += 1
      },
    })
    const sandbox = {
      async getProcess() {
        return process()
      },
      async listProcesses() {
        return [process()]
      },
    } as unknown as Sandbox
    const runtime = new CloudflareBridgeRuntime(RUNTIME_ID, sandbox)

    await runtime.inspectProcess(PROCESS_ID)
    await runtime.inspect()

    expect(disposed).toBe(3)
  })

  test("fails closed when the bridge secret is weak or absent", async () => {
    const fixture = createFixture({ token: "short" })
    const response = await fixture.request("/v1/health", {
      headers: { authorization: "Bearer short" },
    })

    expect(response.status).toBe(503)
    expect(await errorCode(response)).toBe("BRIDGE_MISCONFIGURED")
  })

  test("creates deterministic opaque handles for idempotent provider retries", async () => {
    const fixture = createFixture()
    const body = JSON.stringify({ operationId: RUNTIME_ID.slice(3) })

    const first = await fixture.request("/v1/runtimes", {
      method: "POST",
      headers: jsonHeaders(),
      body,
    })
    const second = await fixture.request("/v1/runtimes", {
      method: "POST",
      headers: jsonHeaders(),
      body,
    })

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(await first.json()).toEqual(await second.json())
    expect(fixture.runtime.calls).toEqual([])
  })

  test("binds a revocable credential placeholder to exact runtime, host, and method policy", async () => {
    const fixture = createFixture()
    const leaseId = "98b83669-d7fb-4c7c-98af-3eb6f542fdad"
    const request = {
      leaseId,
      allowedHosts: ["api.example.com"],
      credentials: [
        {
          environmentVariable: "MODEL_API_KEY",
          host: "api.example.com",
          methods: ["POST"],
          value: "real-provider-credential",
        },
      ],
    }
    const attach = () =>
      fixture.request(`/v1/runtimes/${RUNTIME_ID}/credential-leases`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(request),
      })

    const first = await attach()
    const second = await attach()
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    const firstBody = await first.text()
    expect(firstBody).toBe(await second.text())
    expect(firstBody).not.toContain("real-provider-credential")
    expect(JSON.parse(firstBody)).toMatchObject({
      credentialLease: {
        version: BRIDGE_PROTOCOL_VERSION,
        id: leaseId,
        runtimeId: RUNTIME_ID,
        environment: { MODEL_API_KEY: expect.stringMatching(/^mwcap_test_/) },
      },
    })

    const conflict = await fixture.request(`/v1/runtimes/${RUNTIME_ID}/credential-leases`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        ...request,
        credentials: [{ ...request.credentials[0], methods: ["GET"] }],
      }),
    })
    expect(conflict.status).toBe(409)
    expect(await errorCode(conflict)).toBe("CREDENTIAL_LEASE_CONFLICT")

    const revoke = () =>
      fixture.request(`/v1/runtimes/${RUNTIME_ID}/credential-leases/${leaseId}`, {
        method: "DELETE",
        headers: authorizationHeader(),
      })
    expect((await revoke()).status).toBe(200)
    expect((await revoke()).status).toBe(200)
    expect(fixture.runtime.calls).toEqual([
      "configureCredentialLease",
      "configureCredentialLease",
      "clearCredentialLease",
    ])
  })

  test("encrypts credential lease material at rest with lease-bound authenticated data", async () => {
    const leaseId = "98b83669-d7fb-4c7c-98af-3eb6f542fdad"
    const payload = {
      allowedHosts: ["api.example.com"],
      credentials: [
        {
          environmentVariable: "MODEL_API_KEY",
          host: "api.example.com",
          methods: ["POST"],
          placeholder: "mwcap_v1_placeholder",
          value: "real-provider-credential",
        },
      ],
    }
    const encrypted = await encryptCredentialPayload(TOKEN, leaseId, payload)
    expect(JSON.stringify(encrypted)).not.toContain("real-provider-credential")
    expect(
      await decryptCredentialPayload(TOKEN, leaseId, encrypted.iv, encrypted.ciphertext),
    ).toEqual(payload)
    await expect(
      decryptCredentialPayload(
        TOKEN,
        "3c048fb4-6432-4aa6-8df7-f138ff9fd226",
        encrypted.iv,
        encrypted.ciphertext,
      ),
    ).rejects.toBeInstanceOf(Error)
  })

  test("installs outbound handlers before enabling the exact-host allowlist", async () => {
    const calls: string[] = []
    const sandbox = {
      async setOutboundByHosts() {
        calls.push("handlers:set")
      },
      async setAllowedHosts(hosts: readonly string[]) {
        calls.push(`hosts:${hosts.join(",")}`)
      },
    } as unknown as Sandbox
    const runtime = new CloudflareBridgeRuntime(RUNTIME_ID, sandbox)
    const request = {
      leaseId: "3f390eef-460f-4a08-a067-8fa1bb9dcd21",
      allowedHosts: ["api.example.com"],
      credentials: [],
    }

    await runtime.configureCredentialLease(request)
    await runtime.clearCredentialLease()

    expect(calls).toEqual(["handlers:set", "hosts:api.example.com", "hosts:", "handlers:set"])
  })

  test("validates paths before the provider sees them", async () => {
    const fixture = createFixture()
    const response = await fixture.request(`/v1/runtimes/${RUNTIME_ID}/files`, {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify({
        files: [{ path: "../escape", contentBase64: "c2VjcmV0", mode: 0o600 }],
      }),
    })

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe("INVALID_REQUEST")
    expect(fixture.runtime.calls).toEqual([])
  })

  test("passes argv as data and the SDK boundary quotes every shell metacharacter", async () => {
    const fixture = createFixture()
    const argv = ["/usr/bin/printf", "%s", "hello; touch /tmp/escaped", "a'b", "$(uname)"]
    const response = await fixture.request(`/v1/runtimes/${RUNTIME_ID}/processes`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ operationId: PROCESS_ID.slice(3), argv }),
    })

    expect(response.status).toBe(201)
    expect(fixture.runtime.spawnRequest?.argv).toEqual(argv)
    expect(shellJoin(argv)).toBe(
      "'/usr/bin/printf' '%s' 'hello; touch /tmp/escaped' 'a'\"'\"'b' '$(uname)'",
    )

    const child = Bun.spawn(["/bin/sh", "-c", shellJoin(argv)], { stdout: "pipe" })
    const output = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    expect(output).toBe("hello; touch /tmp/escapeda'b$(uname)")

    const adversarialArguments = [
      "",
      " ",
      "line one\nline two",
      "single'quote",
      'double"quote',
      "$HOME",
      "$(uname)",
      "`uname`",
      "; false",
      "&& false",
      "| false",
      "> /tmp/escape",
      "*?[abc]",
      "back\\slash",
      "你好 🌍",
    ]
    for (const argument of adversarialArguments) {
      const probe = Bun.spawn(["/bin/sh", "-c", shellJoin(["/usr/bin/printf", "%s", argument])], {
        stdout: "pipe",
      })
      expect(await new Response(probe.stdout).text()).toBe(argument)
      expect(await probe.exited).toBe(0)
    }
  })

  test("uses stderr as completion authority without terminating the provider shell", async () => {
    const fixture = createSdkFixture()
    const runtime = new CloudflareBridgeRuntime(RUNTIME_ID, fixture.sandbox)
    await runtime.spawn(
      PROCESS_ID,
      {
        operationId: PROCESS_ID.slice(3),
        argv: ["/bin/sh", "-c", "printf stdout; printf stderr >&2; exit 7"],
        input: "closed",
      },
      "initial",
    )

    const process = Bun.spawn(
      [
        "/bin/sh",
        "-c",
        `${fixture.command}; observed_status=$?; /usr/bin/printf manager-alive; (exit "$observed_status")`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    const marker = processCompletionMarker(PROCESS_ID)

    expect(exitCode).toBe(7)
    expect(stdout).toBe(`stdout\n${marker}7__\nmanager-alive`)
    expect(stderr).toBe(`stderr\n${marker}7__\n`)
  })

  test("binds idempotent process identity to the complete secret-safe specification", async () => {
    const fixture = createFixture()
    const request = {
      operationId: PROCESS_ID.slice(3),
      argv: ["meanwhile-runner"],
      env: { AGENT_TOKEN: "secret-value-one" },
      stdin: "private prompt",
      timeoutMs: 1_000,
      terminationGraceMs: 500,
    }
    const spawn = (body: unknown) =>
      fixture.request(`/v1/runtimes/${RUNTIME_ID}/processes`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      })

    expect((await spawn(request)).status).toBe(201)
    const evidenceDeadline = await fixture.registry.getProcessEvidenceDeadline(
      RUNTIME_ID,
      PROCESS_ID,
    )
    expect((await spawn(request)).status).toBe(201)
    expect(await fixture.registry.getProcessEvidenceDeadline(RUNTIME_ID, PROCESS_ID)).toBe(
      evidenceDeadline,
    )
    expect(evidenceDeadline).not.toBeNull()
    const conflict = await spawn({
      ...request,
      env: { AGENT_TOKEN: "secret-value-two" },
    })
    const text = await conflict.text()

    expect(conflict.status).toBe(409)
    expect(JSON.parse(text)).toMatchObject({ error: { code: "PROCESS_CONFLICT" } })
    expect(text).not.toContain("secret-value-one")
    expect(text).not.toContain("secret-value-two")
    expect(fixture.runtime.calls.filter((call) => call === "spawn")).toHaveLength(2)
  })

  test("durably destroys a runtime when failed admission cannot remove staged input", async () => {
    const fixture = createFixture()
    fixture.runtime.spawnError = new BridgeError(
      "STAGING_CLEANUP_FAILED",
      "The staged process input could not be removed.",
      502,
      { retryable: false, runtimeDestroyRequired: true },
    )

    const response = await fixture.request(`/v1/runtimes/${RUNTIME_ID}/processes`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        operationId: PROCESS_ID.slice(3),
        argv: ["meanwhile-runner"],
        stdin: "private prompt",
      }),
    })

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      error: {
        code: "STAGING_CLEANUP_FAILED",
        details: { retryable: false, runtimeDestroyed: true },
      },
    })
    expect(fixture.runtime.calls).toContain("destroy")
    expect(
      (
        await fixture.request(`/v1/runtimes/${RUNTIME_ID}`, {
          headers: authorizationHeader(),
        })
      ).status,
    ).toBe(200)
    expect(await fixture.registry.inspect(RUNTIME_ID)).toMatchObject({ state: "destroyed" })
  })

  test("persists one immutable terminal process result outside the sandbox", async () => {
    const fixture = createFixture()
    const spawn = await fixture.request(`/v1/runtimes/${RUNTIME_ID}/processes`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        operationId: PROCESS_ID.slice(3),
        argv: ["meanwhile-runner"],
      }),
    })
    expect(spawn.status).toBe(201)

    const wait = () =>
      fixture.request(`/v1/runtimes/${RUNTIME_ID}/processes/${PROCESS_ID}/wait?timeoutMs=1000`, {
        headers: authorizationHeader(),
      })
    expect((await wait()).status).toBe(200)
    expect((await wait()).status).toBe(200)
    expect(fixture.runtime.calls.filter((call) => call === "wait")).toHaveLength(1)
  })

  test("binds each process-input sequence before forwarding it to the sandbox", async () => {
    const fixture = createFixture()
    const input = {
      sequence: 1,
      id: "70c78f7e-a915-4a4b-a9cb-e805f534f606",
      data: JSON.stringify({ type: "turn.start", prompt: "private prompt" }),
    }
    const send = (body: unknown) =>
      fixture.request(`/v1/runtimes/${RUNTIME_ID}/processes/${PROCESS_ID}/input`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      })

    expect((await send(input)).status).toBe(200)
    expect((await send(input)).status).toBe(200)
    const conflict = await send({ ...input, data: "different private prompt" })
    const text = await conflict.text()

    expect(conflict.status).toBe(409)
    expect(JSON.parse(text)).toMatchObject({ error: { code: "PROCESS_INPUT_CONFLICT" } })
    expect(text).not.toContain("private prompt")
    expect(fixture.runtime.calls.filter((call) => call === "send")).toHaveLength(2)
  })

  test("uses a self-verifying component-wise replay cursor", async () => {
    const encoded = encodeEventCursor({
      stdoutOffset: 12,
      stderrOffset: 7,
      terminalSeen: true,
      stdoutDigest: await eventPrefixDigest("stdout-data!"),
      stderrDigest: await eventPrefixDigest("stderr!"),
    })
    expect(decodeEventCursor(encoded)).toEqual({
      stdoutOffset: 12,
      stderrOffset: 7,
      terminalSeen: true,
      stdoutDigest: await eventPrefixDigest("stdout-data!"),
      stderrDigest: await eventPrefixDigest("stderr!"),
    })
    expect(() => decodeEventCursor("v1.-1.0.0")).toThrow(BridgeError)
  })

  test("recovers one terminal execution from retained logs after the SDK drops its process row", async () => {
    let startCount = 0
    const sandbox = {
      async setRuntimeLease() {},
      async getProcess() {
        return null
      },
      async getProcessLogs() {
        const frame = completionFrame(PROCESS_ID, 7)
        return {
          stdout: "runner-output",
          stderr: `runner-diagnostic${frame}`,
          processId: PROCESS_ID,
        }
      },
      async exists() {
        return { exists: false }
      },
      async startProcess() {
        startCount += 1
        throw new Error("a recovered execution must never be started again")
      },
    } as unknown as Sandbox
    const runtime = new CloudflareBridgeRuntime(RUNTIME_ID, sandbox, async () => {})
    const known = processSnapshot("running")

    expect(
      await runtime.spawn(PROCESS_ID, spawnRequest("private prompt"), "reconcile", known),
    ).toMatchObject({
      status: "failed",
      exitCode: 7,
      startedAt: known.startedAt,
    })
    expect(await runtime.wait(PROCESS_ID, 1_000, known)).toMatchObject({
      status: "failed",
      exitCode: 7,
    })
    const replay = await runtime.events(PROCESS_ID, INITIAL_EVENT_CURSOR, 1_024, known)
    expect(
      replay.events.map((event) =>
        event.type === "output" ? `${event.stream}:${event.data}` : `exit:${event.exitCode}`,
      ),
    ).toEqual(["stdout:runner-output", "stderr:runner-diagnostic", "exit:7"])
    expect(startCount).toBe(0)
  })

  test("recovers retained terminal evidence when the SDK exit stream loses the process race", async () => {
    const process = {
      id: PROCESS_ID,
      command: "runner",
      status: "running" as const,
      startTime: new Date("2026-07-13T00:00:00.000Z"),
      async getStatus() {
        return "running" as const
      },
      async waitForExit() {
        const error = new Error("provider-private missing process")
        error.name = "ProcessNotFoundError"
        throw error
      },
    }
    const sandbox = {
      async getProcess() {
        return process
      },
      async getProcessLogs() {
        const frame = completionFrame(PROCESS_ID)
        return {
          stdout: "session-closed",
          stderr: frame,
          processId: PROCESS_ID,
        }
      },
    } as unknown as Sandbox

    expect(
      await new CloudflareBridgeRuntime(RUNTIME_ID, sandbox, async () => {}).wait(
        PROCESS_ID,
        1_000,
        processSnapshot("running"),
      ),
    ).toMatchObject({ status: "completed", exitCode: 0 })
  })

  test("recognizes a provider wait timeout after Worker error serialization", async () => {
    const process = {
      id: PROCESS_ID,
      command: "runner",
      status: "running" as const,
      startTime: new Date("2026-07-13T00:00:00.000Z"),
      async getStatus() {
        return "running" as const
      },
      async waitForExit() {
        const error = new Error("provider-private timeout")
        error.name = "ProcessReadyTimeoutError"
        throw error
      },
    }
    const sandbox = {
      async getProcess() {
        return process
      },
    } as unknown as Sandbox

    expect(
      await new CloudflareBridgeRuntime(RUNTIME_ID, sandbox).wait(PROCESS_ID, 5_000),
    ).toMatchObject({ status: "running" })
  })

  test("keeps durable running state while retained-log publication catches up", async () => {
    let logReads = 0
    const sandbox = {
      async getProcess() {
        return null
      },
      async getProcessLogs() {
        logReads += 1
        if (logReads < 4) {
          const error = new Error("provider-private evidence pending")
          error.name = "ProcessNotFoundError"
          throw error
        }
        const frame = completionFrame(PROCESS_ID)
        return { stdout: "complete", stderr: frame, processId: PROCESS_ID }
      },
    } as unknown as Sandbox

    const known = processSnapshot("running")
    expect(
      await new CloudflareBridgeRuntime(RUNTIME_ID, sandbox, async () => {}).inspectProcess(
        PROCESS_ID,
        known,
      ),
    ).toBe(known)
    for (let poll = 0; poll < 2; poll += 1) {
      expect(
        await new CloudflareBridgeRuntime(RUNTIME_ID, sandbox, async () => {}).events(
          PROCESS_ID,
          INITIAL_EVENT_CURSOR,
          1_024,
          known,
        ),
      ).toMatchObject({ events: [], nextCursor: INITIAL_EVENT_CURSOR })
    }
    const replay = await new CloudflareBridgeRuntime(RUNTIME_ID, sandbox, async () => {}).events(
      PROCESS_ID,
      INITIAL_EVENT_CURSOR,
      1_024,
      known,
    )

    expect(
      replay.events.map((event) => (event.type === "output" ? event.data : event.type)),
    ).toEqual(["complete", "exit"])
    expect(logReads).toBe(4)
  })

  test("starts only the initial reservation when retained logs prove no earlier execution exists", async () => {
    let startCount = 0
    let logReadCount = 0
    const sandbox = {
      async setRuntimeLease() {},
      async getProcess() {
        return null
      },
      async getProcessLogs() {
        logReadCount += 1
        const error = new Error("provider-private missing process")
        error.name = "ProcessNotFoundError"
        throw error
      },
      async startProcess() {
        startCount += 1
        return {
          id: PROCESS_ID,
          command: "runner",
          status: "running" as const,
          startTime: new Date("2026-07-13T00:00:00.000Z"),
          async getStatus() {
            return "running" as const
          },
        }
      },
    } as unknown as Sandbox

    expect(
      await new CloudflareBridgeRuntime(RUNTIME_ID, sandbox, async () => {}).spawn(
        PROCESS_ID,
        {
          operationId: PROCESS_ID.slice(3),
          argv: ["meanwhile-runner"],
          input: "closed",
        },
        "initial",
        processSnapshot("starting"),
      ),
    ).toMatchObject({ status: "running" })
    expect(startCount).toBe(1)
    expect(logReadCount).toBe(1)
  })

  test("never repeats an ambiguous process admission without provider evidence", async () => {
    let startCount = 0
    const sandbox = {
      async setRuntimeLease() {},
      async getProcess() {
        return null
      },
      async getProcessLogs() {
        const error = new Error("provider-private missing process")
        error.name = "ProcessNotFoundError"
        throw error
      },
      async startProcess() {
        startCount += 1
        throw new Error("an exact admission retry must not execute again")
      },
    } as unknown as Sandbox

    await expect(
      new CloudflareBridgeRuntime(RUNTIME_ID, sandbox, async () => {}).spawn(
        PROCESS_ID,
        spawnRequest("private prompt"),
        "reconcile",
        processSnapshot("starting"),
        new Date(Date.now() + 60_000).toISOString(),
      ),
    ).rejects.toMatchObject({
      code: "PROCESS_ADMISSION_PENDING",
      details: { retryable: true },
    })
    expect(startCount).toBe(0)
  })

  test("replays stdout and stderr exactly once and emits one terminal marker", async () => {
    let status: "running" | "completed" = "running"
    let stdout = "abc"
    let stderr = "xy"
    const process = {
      id: PROCESS_ID,
      command: "runner",
      status,
      startTime: new Date("2026-07-13T00:00:00.000Z"),
      endTime: new Date("2026-07-13T00:00:01.000Z"),
      exitCode: 0,
      async getStatus() {
        return status
      },
    }
    const sandbox = {
      async getProcess() {
        return process
      },
      async getProcessLogs() {
        const marker = status === "completed" ? completionFrame(PROCESS_ID) : ""
        return { stdout, stderr: `${stderr}${marker}`, processId: PROCESS_ID }
      },
    } as unknown as Sandbox
    const runtime = new CloudflareBridgeRuntime(RUNTIME_ID, sandbox, async () => {})

    const first = await runtime.events(PROCESS_ID, INITIAL_EVENT_CURSOR, 4)
    expect(
      first.events.map((event) => (event.type === "output" ? event.data : event.type)),
    ).toEqual(["abc", "x"])
    expect(decodeEventCursor(first.nextCursor)).toMatchObject({
      stdoutOffset: 3,
      stderrOffset: 1,
      terminalSeen: false,
    })

    stdout = "abcdef"
    stderr = "xyz"
    status = "completed"
    const second = await runtime.events(PROCESS_ID, first.nextCursor, 10)
    expect(
      second.events.map((event) => (event.type === "output" ? event.data : event.type)),
    ).toEqual(["def", "yz", "exit"])
    expect(decodeEventCursor(second.nextCursor)).toMatchObject({
      stdoutOffset: 6,
      stderrOffset: 3,
      terminalSeen: true,
    })

    const third = await runtime.events(PROCESS_ID, second.nextCursor, 10)
    expect(third.events).toEqual([])
    const futureCursor = encodeEventCursor({
      stdoutOffset: 99,
      stderrOffset: 0,
      terminalSeen: false,
      stdoutDigest: await eventPrefixDigest(stdout),
      stderrDigest: await eventPrefixDigest(""),
    })
    await expect(runtime.events(PROCESS_ID, futureCursor, 10)).rejects.toMatchObject({
      code: "EVENT_REPLAY_GAP",
    })
  })

  test("waits for retained-log publication and rejects a rewritten cursor prefix", async () => {
    const process = {
      id: PROCESS_ID,
      command: "runner",
      status: "running" as const,
      startTime: new Date("2026-07-13T00:00:00.000Z"),
      async getStatus() {
        return "running" as const
      },
    }
    const initialSandbox = {
      async getProcess() {
        return process
      },
      async getProcessLogs() {
        return { stdout: "abc", stderr: "", processId: PROCESS_ID }
      },
    } as unknown as Sandbox
    const first = await new CloudflareBridgeRuntime(
      RUNTIME_ID,
      initialSandbox,
      async () => {},
    ).events(PROCESS_ID, INITIAL_EVENT_CURSOR, 3)

    let reads = 0
    const delayedSandbox = {
      async getProcess() {
        return process
      },
      async getProcessLogs() {
        reads += 1
        return {
          stdout: reads < 3 ? "a" : "abcdef",
          stderr: "",
          processId: PROCESS_ID,
        }
      },
    } as unknown as Sandbox
    const resumed = await new CloudflareBridgeRuntime(
      RUNTIME_ID,
      delayedSandbox,
      async () => {},
    ).events(PROCESS_ID, first.nextCursor, 3)

    expect(resumed.events).toContainEqual(expect.objectContaining({ data: "def" }))
    expect(reads).toBe(3)

    const rewrittenSandbox = {
      async getProcess() {
        return process
      },
      async getProcessLogs() {
        return { stdout: "abXdef", stderr: "", processId: PROCESS_ID }
      },
    } as unknown as Sandbox
    await expect(
      new CloudflareBridgeRuntime(RUNTIME_ID, rewrittenSandbox, async () => {}).events(
        PROCESS_ID,
        first.nextCursor,
        3,
      ),
    ).rejects.toMatchObject({ code: "EVENT_REPLAY_GAP", details: { recoverable: false } })
  })

  test("bounds missing-process reconciliation by the admitted evidence deadline", async () => {
    const sandbox = {
      async getProcess() {
        return null
      },
      async getProcessLogs() {
        return { stdout: "", stderr: "", processId: PROCESS_ID }
      },
    } as unknown as Sandbox
    const deadline = "2000-01-01T00:00:00.000Z"
    const known = processSnapshot("running")

    await expect(
      new CloudflareBridgeRuntime(RUNTIME_ID, sandbox, async () => {}).inspectProcess(
        PROCESS_ID,
        known,
        deadline,
      ),
    ).rejects.toMatchObject({ code: "PROCESS_LOST", details: { retryable: false } })
    await expect(
      new CloudflareBridgeRuntime(RUNTIME_ID, sandbox, async () => {}).events(
        PROCESS_ID,
        INITIAL_EVENT_CURSOR,
        1_024,
        known,
        deadline,
      ),
    ).rejects.toMatchObject({ code: "PROCESS_LOST", details: { retryable: false } })
    await expect(
      new CloudflareBridgeRuntime(RUNTIME_ID, sandbox, async () => {}).wait(
        PROCESS_ID,
        1_000,
        known,
        deadline,
      ),
    ).rejects.toMatchObject({ code: "PROCESS_LOST", details: { retryable: false } })
  })

  test("never abandons an admitted provider evidence read when its request budget expires", async () => {
    let now = Date.now()
    let getProcessCalls = 0
    let providerCallSettled = false
    let releaseProviderCall: (() => void) | undefined
    const providerCall = new Promise<void>((resolve) => {
      releaseProviderCall = resolve
    })
    const sandbox = {
      async getProcess() {
        getProcessCalls += 1
        await providerCall
        now += 10_001
        providerCallSettled = true
        return null
      },
    } as unknown as Sandbox
    const runtime = new CloudflareBridgeRuntime(
      RUNTIME_ID,
      sandbox,
      async () => {},
      () => now,
    )
    const known = processSnapshot("running")

    const replay = runtime.events(
      PROCESS_ID,
      INITIAL_EVENT_CURSOR,
      1_024,
      known,
      new Date(now + 60_000).toISOString(),
    )
    await Promise.resolve()
    expect(providerCallSettled).toBeFalse()
    releaseProviderCall?.()
    await expect(replay).rejects.toMatchObject({
      code: "PROCESS_EVIDENCE_PENDING",
      details: { retryable: true },
    })
    expect(providerCallSettled).toBeTrue()

    now = Date.now()
    const expiredSandbox = {
      async getProcess() {
        getProcessCalls += 1
        now += 10_001
        return null
      },
    } as unknown as Sandbox
    await expect(
      new CloudflareBridgeRuntime(
        RUNTIME_ID,
        expiredSandbox,
        async () => {},
        () => now,
      ).events(PROCESS_ID, INITIAL_EVENT_CURSOR, 1_024, known, new Date(now + 5_000).toISOString()),
    ).rejects.toMatchObject({ code: "PROCESS_LOST", details: { retryable: false } })
    expect(getProcessCalls).toBe(2)
  })

  test("reads final process output only after observing terminal state", async () => {
    let terminalObserved = false
    const process = {
      id: PROCESS_ID,
      command: "runner",
      status: "completed",
      startTime: new Date("2026-07-13T00:00:00.000Z"),
      endTime: new Date("2026-07-13T00:00:01.000Z"),
      exitCode: 0,
      async getStatus() {
        await Promise.resolve()
        terminalObserved = true
        return "completed" as const
      },
    }
    const sandbox = {
      async getProcess() {
        return process
      },
      async getProcessLogs() {
        const marker = completionFrame(PROCESS_ID)
        return {
          stdout: terminalObserved ? "final-runner-frame\n" : "stale-prefix\n",
          stderr: terminalObserved ? marker : "",
          processId: PROCESS_ID,
        }
      },
    } as unknown as Sandbox

    const result = await new CloudflareBridgeRuntime(RUNTIME_ID, sandbox).events(
      PROCESS_ID,
      INITIAL_EVENT_CURSOR,
      1_024,
    )

    expect(
      result.events.map((event) => (event.type === "output" ? event.data : event.type)),
    ).toEqual(["final-runner-frame\n", "exit"])
  })

  test("waits for stable output after the stderr completion frame", async () => {
    let status: "running" | "completed" = "running"
    let logReads = 0
    const process = {
      id: PROCESS_ID,
      command: "runner",
      status,
      startTime: new Date("2026-07-13T00:00:00.000Z"),
      endTime: new Date("2026-07-13T00:00:01.000Z"),
      exitCode: 0,
      async getStatus() {
        return status
      },
    }
    const prefix = "runner-started\n"
    const terminal = "runner-terminal\n"
    const sandbox = {
      async getProcess() {
        return process
      },
      async getProcessLogs() {
        logReads += 1
        const complete = status === "completed" && logReads >= 16
        const stdoutComplete = status === "completed" && logReads >= 17
        const marker = complete ? completionFrame(PROCESS_ID) : ""
        return {
          stdout: stdoutComplete ? `${prefix}${terminal}` : prefix,
          stderr: marker,
          processId: PROCESS_ID,
        }
      },
    } as unknown as Sandbox
    const runtime = new CloudflareBridgeRuntime(RUNTIME_ID, sandbox, async () => {})

    const first = await runtime.events(PROCESS_ID, INITIAL_EVENT_CURSOR, 1_024)
    expect(
      first.events.map((event) => (event.type === "output" ? event.data : event.type)),
    ).toEqual([prefix])

    status = "completed"
    const second = await runtime.events(PROCESS_ID, first.nextCursor, 1_024)
    expect(
      second.events.map((event) => (event.type === "output" ? event.data : event.type)),
    ).toEqual([terminal, "exit"])
    expect(logReads).toBeGreaterThanOrEqual(19)
  })

  test("fails retryably instead of publishing an exit for incomplete terminal output", async () => {
    const process = {
      id: PROCESS_ID,
      command: "runner",
      status: "completed" as const,
      startTime: new Date("2026-07-13T00:00:00.000Z"),
      endTime: new Date("2026-07-13T00:00:01.000Z"),
      exitCode: 0,
      async getStatus() {
        return "completed" as const
      },
    }
    const sandbox = {
      async getProcess() {
        return process
      },
      async getProcessLogs() {
        return { stdout: "runner-started\n", stderr: "", processId: PROCESS_ID }
      },
    } as unknown as Sandbox

    await expect(
      new CloudflareBridgeRuntime(RUNTIME_ID, sandbox, async () => {}).events(
        PROCESS_ID,
        INITIAL_EVENT_CURSOR,
        1_024,
      ),
    ).rejects.toMatchObject({
      code: "PROCESS_OUTPUT_INCOMPLETE",
      status: 503,
      details: {
        retryable: true,
        stdoutBytes: 15,
        completion: {
          bytes: 0,
          markerSeen: false,
          precededByLineBreak: false,
          suffixCodeUnits: null,
          suffixContainsOnlyLineBreaks: null,
        },
      },
    })
  })

  test("rejects UTF-8 output beyond the replay budget and detects provider truncation", async () => {
    let status: "running" | "completed" = "running"
    let stdout = "😀".repeat(MAX_PROCESS_OUTPUT_BYTES / 4 + 1)
    const process = {
      id: PROCESS_ID,
      command: "runner",
      status,
      startTime: new Date("2026-07-13T00:00:00.000Z"),
      exitCode: null,
      async getStatus() {
        return status
      },
    }
    const sandbox = {
      async getProcess() {
        return process
      },
      async getProcessLogs() {
        const marker = status === "completed" ? completionFrame(PROCESS_ID) : ""
        return { stdout, stderr: marker, processId: PROCESS_ID }
      },
    } as unknown as Sandbox
    const runtime = new CloudflareBridgeRuntime(RUNTIME_ID, sandbox, async () => {})

    await expect(runtime.events(PROCESS_ID, INITIAL_EVENT_CURSOR, 1)).rejects.toMatchObject({
      code: "PROCESS_OUTPUT_LIMIT_EXCEEDED",
      details: { limitBytes: MAX_PROCESS_OUTPUT_BYTES },
    })

    stdout = "abc"
    const first = await runtime.events(PROCESS_ID, INITIAL_EVENT_CURSOR, 3)
    status = "completed"
    stdout = "ab"
    await expect(runtime.events(PROCESS_ID, first.nextCursor, 3)).rejects.toMatchObject({
      code: "EVENT_REPLAY_GAP",
      details: { recoverable: false },
    })
  })

  test("hands staged stdin through process-owned redirection before admitting the process", async () => {
    const fixture = createSdkFixture()
    const runtime = new CloudflareBridgeRuntime(RUNTIME_ID, fixture.sandbox)

    await runtime.spawn(
      PROCESS_ID,
      {
        ...spawnRequest("private prompt\n"),
        argv: ["/bin/sh", "-c", "IFS= read -r value; /usr/bin/printf '%s' \"$value\""],
      },
      "initial",
    )

    expect(fixture.stdinPath).toBe(`/tmp/meanwhile-runtime/${PROCESS_ID}.stdin`)
    expect(fixture.stdinPath.startsWith("/workspace/")).toBe(false)
    expect(fixture.stdinContent).toBe("private prompt\n")
    expect(fixture.command.match(new RegExp(fixture.stdinPath, "g"))).toHaveLength(2)
    expect(
      fixture.command.match(new RegExp(processCompletionMarker(PROCESS_ID), "g")),
    ).toHaveLength(2)
    expect(fixture.deletedPaths).toEqual([])

    const localStdinPath = `/tmp/meanwhile-staged-input-${crypto.randomUUID()}`
    try {
      await Bun.write(localStdinPath, fixture.stdinContent)
      const child = Bun.spawn(
        ["/bin/sh", "-c", fixture.command.replaceAll(fixture.stdinPath, localStdinPath)],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [stdout, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
        new Response(child.stderr).text(),
      ])
      expect(exitCode).toBe(0)
      expect(stdout).toStartWith("private prompt")
      expect(await Bun.file(localStdinPath).exists()).toBeFalse()
    } finally {
      await rm(localStdinPath, { force: true })
    }
  })

  test("an exact spawn retry leaves the process-owned input handoff untouched", async () => {
    let startCount = 0
    const process = {
      id: PROCESS_ID,
      command: "runner",
      status: "running" as const,
      startTime: new Date("2026-07-13T00:00:00.000Z"),
    }
    const sandbox = {
      async setRuntimeLease() {},
      async getProcess() {
        return process
      },
      async startProcess() {
        startCount += 1
        return process
      },
    } as unknown as Sandbox

    await new CloudflareBridgeRuntime(RUNTIME_ID, sandbox, async () => {}).spawn(
      PROCESS_ID,
      spawnRequest("private prompt\n"),
      "reconcile",
      processSnapshot("running"),
    )

    expect(startCount).toBe(0)
  })

  test("retries an idempotent staged-input deletion after transient platform interruption", async () => {
    const fixture = createSdkFixture({ failWrite: true, transientDeleteFailures: 2 })
    const runtime = new CloudflareBridgeRuntime(RUNTIME_ID, fixture.sandbox, async () => {})

    await expect(
      runtime.spawn(PROCESS_ID, spawnRequest("private prompt\n"), "initial"),
    ).rejects.toThrow("write failed")

    expect(fixture.deletedPaths).toEqual([fixture.stdinPath, fixture.stdinPath, fixture.stdinPath])
    expect(fixture.destroyCount).toBe(0)
  })

  test("attempts staging cleanup after a failed write without stealing runtime lifecycle", async () => {
    const writeFailure = createSdkFixture({ failWrite: true })
    const firstRuntime = new CloudflareBridgeRuntime(RUNTIME_ID, writeFailure.sandbox)
    await expect(firstRuntime.spawn(PROCESS_ID, spawnRequest("input"), "initial")).rejects.toThrow(
      "write failed",
    )
    expect(writeFailure.deletedPaths).toEqual([writeFailure.stdinPath])

    const cleanupFailure = createSdkFixture({ failWrite: true, failDelete: true })
    const secondRuntime = new CloudflareBridgeRuntime(RUNTIME_ID, cleanupFailure.sandbox)
    const result = secondRuntime.spawn(PROCESS_ID, spawnRequest("input"), "initial")
    await expect(result).rejects.toMatchObject({
      code: "STAGING_CLEANUP_FAILED",
      details: { retryable: false, runtimeDestroyRequired: true },
    })
    expect(cleanupFailure.destroyCount).toBe(0)
  })

  test("verifies workspace writes before and after directory creation without command interpolation", async () => {
    const fixture = createWorkspaceSdkFixture([0, 0, 0, 0])
    const runtime = new CloudflareBridgeRuntime(RUNTIME_ID, fixture.sandbox)
    const uniquePath = "safe/unique-user-path.txt"

    await runtime.writeFiles({
      files: [{ path: uniquePath, contentBase64: "c2FmZQ==", mode: 0o700 }],
    })

    expect(fixture.calls.map((call) => call.type)).toEqual([
      "exec",
      "mkdir",
      "exec",
      "write",
      "exec",
      "exec",
    ])
    expect(fixture.execCalls).toHaveLength(4)
    expect(new Set(fixture.execCalls.slice(0, 3).map((call) => call.command)).size).toBe(1)
    for (const call of fixture.execCalls.slice(0, 3)) {
      expect(call.command).not.toContain(uniquePath)
      expect(call.command).toContain('realpath -m -- "$target"')
      expect(call.command).toContain('[ -L "$current" ]')
    }
    expect(fixture.execCalls.map((call) => call.options.env.MEANWHILE_REQUIRE_EXISTING)).toEqual([
      "0",
      "0",
      "1",
      undefined,
    ])
    expect(fixture.execCalls[3]?.command).not.toContain(uniquePath)
    expect(fixture.execCalls[3]?.command).toContain('chmod -- "$mode" "$target"')
    expect(fixture.execCalls[3]?.options).toMatchObject({
      env: {
        MEANWHILE_FILE_MODE: "700",
        MEANWHILE_WORKSPACE_PATH: `/workspace/${uniquePath}`,
      },
      origin: "internal",
      timeout: 5_000,
    })
  })

  test("rejects a symlink introduced while creating a write path", async () => {
    const fixture = createWorkspaceSdkFixture([0, 42])
    const runtime = new CloudflareBridgeRuntime(RUNTIME_ID, fixture.sandbox)

    await expect(
      runtime.writeFiles({
        files: [{ path: "malicious-link/output.txt", contentBase64: "c2FmZQ==", mode: 0o600 }],
      }),
    ).rejects.toMatchObject({
      code: "SYMLINK_NOT_ALLOWED",
      status: 409,
      details: { retryable: false },
    })

    expect(fixture.calls.map((call) => call.type)).toEqual(["exec", "mkdir", "exec"])
    expect(fixture.writeCount).toBe(0)
  })

  test("rejects a symlink introduced after a workspace write", async () => {
    const fixture = createWorkspaceSdkFixture([0, 0, 42])
    const runtime = new CloudflareBridgeRuntime(RUNTIME_ID, fixture.sandbox)

    await expect(
      runtime.writeFiles({
        files: [{ path: "changed/output.txt", contentBase64: "c2FmZQ==", mode: 0o600 }],
      }),
    ).rejects.toMatchObject({ code: "SYMLINK_NOT_ALLOWED", status: 409 })

    expect(fixture.calls.map((call) => call.type)).toEqual([
      "exec",
      "mkdir",
      "exec",
      "write",
      "exec",
    ])
  })

  test("fails closed when an exact workspace file mode cannot be applied", async () => {
    const fixture = createWorkspaceSdkFixture([0, 0, 0, 1])
    const runtime = new CloudflareBridgeRuntime(RUNTIME_ID, fixture.sandbox)

    await expect(
      runtime.writeFiles({
        files: [{ path: "bin/tool", contentBase64: "c2FmZQ==", mode: 0o755 }],
      }),
    ).rejects.toMatchObject({
      code: "FILE_MODE_APPLY_FAILED",
      status: 502,
      details: { retryable: false },
    })
  })

  test("rejects symlink reads and external realpath resolution before file SDK operations", async () => {
    const symlinkFixture = createWorkspaceSdkFixture([42])
    const symlinkRuntime = new CloudflareBridgeRuntime(RUNTIME_ID, symlinkFixture.sandbox)

    await expect(symlinkRuntime.readFile("escape/secret.txt", 1_024)).rejects.toMatchObject({
      code: "SYMLINK_NOT_ALLOWED",
      status: 409,
    })
    expect(symlinkFixture.readCount).toBe(0)
    expect(symlinkFixture.execCalls[0]?.command).not.toContain("escape/secret.txt")
    expect(symlinkFixture.execCalls[0]?.options.env).toMatchObject({
      MEANWHILE_REQUIRE_EXISTING: "1",
      MEANWHILE_WORKSPACE_PATH: "/workspace/escape/secret.txt",
    })

    const externalFixture = createWorkspaceSdkFixture([43])
    const externalRuntime = new CloudflareBridgeRuntime(RUNTIME_ID, externalFixture.sandbox)
    await expect(externalRuntime.listFiles("external-resolution", true, 100)).rejects.toMatchObject(
      {
        code: "PATH_ESCAPE",
        status: 409,
        details: { retryable: false },
      },
    )
    expect(externalFixture.listCount).toBe(0)
  })

  test("maps missing and unverifiable workspace paths to safe structured errors", async () => {
    const missing = createWorkspaceSdkFixture([44])
    await expect(
      new CloudflareBridgeRuntime(RUNTIME_ID, missing.sandbox).readFile("missing.txt", 1_024),
    ).rejects.toMatchObject({ code: "PATH_NOT_FOUND", status: 404 })

    const unavailable = createWorkspaceSdkFixture([46])
    await expect(
      new CloudflareBridgeRuntime(RUNTIME_ID, unavailable.sandbox).readFile("result.txt", 1_024),
    ).rejects.toMatchObject({
      code: "WORKSPACE_PATH_INSPECTION_FAILED",
      status: 502,
      details: { providerCode: "PATH_PROBE_EXIT_46", retryable: false },
    })
  })

  test("streams binary workspace bytes through the provider transport contract", async () => {
    const fixture = createWorkspaceSdkFixture([0, 0])
    const file = await new CloudflareBridgeRuntime(RUNTIME_ID, fixture.sandbox).readFile(
      "result.bin",
      4,
    )

    expect(file.size).toBe(4)
    expect(file.mediaType).toBe("application/octet-stream")
    expect([...new Uint8Array(await new Response(file.body).arrayBuffer())]).toEqual([
      ...new TextEncoder().encode("safe"),
    ])
    expect(fixture.calls.map((call) => call.type)).toEqual(["exec", "exec", "read"])
  })

  test("rejects oversized and non-regular workspace reads before opening a file stream", async () => {
    const oversized = createWorkspaceSdkFixture([0, 0])
    await expect(
      new CloudflareBridgeRuntime(RUNTIME_ID, oversized.sandbox).readFile("result.bin", 3),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE", status: 413 })
    expect(oversized.readCount).toBe(0)

    const directory = createWorkspaceSdkFixture([0, 45])
    await expect(
      new CloudflareBridgeRuntime(RUNTIME_ID, directory.sandbox).readFile("result", 4),
    ).rejects.toMatchObject({ code: "NOT_REGULAR_FILE", status: 409 })
    expect(directory.readCount).toBe(0)
  })

  test("returns binary file streams with defensive response headers", async () => {
    const fixture = createFixture()
    const response = await fixture.request(`/v1/runtimes/${RUNTIME_ID}/file?path=result.bin`, {
      headers: authorizationHeader(),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/octet-stream")
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 255]))
  })

  test("binds custom-domain port exposure to the authenticated Worker origin", async () => {
    const fixture = createFixture()
    const response = await fixture.request(`/v1/runtimes/${RUNTIME_ID}/ports/3001/expose`, {
      method: "POST",
      headers: authorizationHeader(),
    })

    expect(response.status).toBe(201)
    expect(fixture.runtime.exposedHostname).toBe("bridge.test")
    expect(await response.json()).toMatchObject({
      endpoint: { port: 3_001, url: "https://example.test" },
    })
  })

  test("rejects workers.dev exposure before invoking the provider preview API", async () => {
    let exposeCalls = 0
    const sandbox = {
      async exposePort() {
        exposeCalls += 1
        return { port: 3_001, url: "https://unexpected.example", name: undefined }
      },
    } as unknown as Sandbox
    const runtime = new CloudflareBridgeRuntime(RUNTIME_ID, sandbox)

    await expect(runtime.expose(3_001, "bridge.workers.dev")).rejects.toMatchObject({
      code: "PORT_EXPOSURE_REQUIRES_CUSTOM_DOMAIN",
      status: 409,
      details: { retryable: false },
    })
    expect(exposeCalls).toBe(0)
  })

  test("normalizes provider failures without returning the provider message", async () => {
    const fixture = createFixture()
    fixture.runtime.startError = new Error("credential=do-not-return-this")

    const response = await fixture.request(`/v1/runtimes/${RUNTIME_ID}/start`, {
      method: "POST",
      headers: authorizationHeader(),
    })
    const text = await response.text()

    expect(response.status).toBe(502)
    expect(text).not.toContain("do-not-return-this")
    expect(JSON.parse(text).error.code).toBe("PROVIDER_OPERATION_FAILED")
  })

  test("returns a Durable Object interruption to a fresh idempotent provider request", async () => {
    const fixture = createFixture()
    fixture.runtime.startError = Object.assign(new Error("provider-private interruption"), {
      name: "OperationInterruptedError",
    })

    const response = await fixture.request(`/v1/runtimes/${RUNTIME_ID}/start`, {
      method: "POST",
      headers: authorizationHeader(),
    })

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      error: {
        code: "PROVIDER_OPERATION_FAILED",
        details: { retryable: true },
      },
    })
  })

  test("keeps stop and destroy idempotent without repeating provider destruction", async () => {
    const fixture = createFixture()

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const stop = await fixture.request(`/v1/runtimes/${RUNTIME_ID}/stop`, {
        method: "POST",
        headers: authorizationHeader(),
      })
      expect(stop.status).toBe(200)

      const destroy = await fixture.request(`/v1/runtimes/${RUNTIME_ID}`, {
        method: "DELETE",
        headers: authorizationHeader(),
      })
      expect(destroy.status).toBe(200)
    }

    expect(fixture.runtime.calls.filter((call) => call === "stop")).toHaveLength(1)
    expect(fixture.runtime.calls.filter((call) => call === "destroy")).toHaveLength(1)

    const inspect = await fixture.request(`/v1/runtimes/${RUNTIME_ID}`, {
      headers: authorizationHeader(),
    })
    expect(inspect.status).toBe(200)
    expect(await inspect.json()).toMatchObject({ runtime: { state: "destroyed" } })

    const process = await fixture.request(`/v1/runtimes/${RUNTIME_ID}/processes/${PROCESS_ID}`, {
      headers: authorizationHeader(),
    })
    expect(process.status).toBe(404)
    expect(await errorCode(process)).toBe("RUNTIME_NOT_FOUND")
  })
})

class FakeRuntime implements BridgeRuntime {
  readonly calls: string[] = []
  placement: string | null = null
  placementChecks = 0
  spawnRequest?: SpawnProcessRequest
  spawnError?: Error
  startError?: Error
  exposedHostname?: string

  async start(): Promise<RuntimeSnapshot> {
    this.calls.push("start")
    if (this.startError) throw this.startError
    return runtimeSnapshot("active")
  }

  async inspect(): Promise<RuntimeSnapshot> {
    this.calls.push("inspect")
    return runtimeSnapshot("active")
  }

  async stop(): Promise<RuntimeSnapshot> {
    this.calls.push("stop")
    return runtimeSnapshot("stopped")
  }

  async destroy(): Promise<RuntimeSnapshot> {
    this.calls.push("destroy")
    return runtimeSnapshot("destroyed")
  }

  async placementId(): Promise<string | null> {
    return this.placement
  }

  async assertPlacement(expected: string | null): Promise<void> {
    this.placementChecks += 1
    if (this.placement !== expected) {
      throw new BridgeError(
        "RUNTIME_LOST",
        "The provider replaced the physical runtime generation.",
        409,
        { retryable: false },
      )
    }
  }

  async spawn(
    _processId: string,
    request: SpawnProcessRequest,
    _admission: "initial" | "reconcile",
  ): Promise<ProcessSnapshot> {
    this.calls.push("spawn")
    this.spawnRequest = request
    if (this.spawnError) throw this.spawnError
    return processSnapshot("running")
  }

  async inspectProcess(): Promise<ProcessSnapshot> {
    this.calls.push("inspectProcess")
    return processSnapshot("running")
  }

  async events(): Promise<ProcessEventsResponse> {
    this.calls.push("events")
    return { events: [], nextCursor: INITIAL_EVENT_CURSOR }
  }

  async signal(_processId: string, _signal: ProcessSignal): Promise<ProcessSnapshot> {
    this.calls.push("signal")
    return processSnapshot("killed")
  }

  async send(_processId: string, _input: ProcessInputRequest): Promise<void> {
    this.calls.push("send")
  }

  async wait(): Promise<ProcessSnapshot> {
    this.calls.push("wait")
    return processSnapshot("completed")
  }

  async writeFiles(_request: WriteFilesRequest): Promise<void> {
    this.calls.push("writeFiles")
  }

  async listFiles(): Promise<readonly RuntimeFileInfo[]> {
    this.calls.push("listFiles")
    return [{ path: "result.bin", type: "file", size: 4, modifiedAt: "2026-07-13T00:00:00.000Z" }]
  }

  async readFile(): Promise<ReadRuntimeFile> {
    this.calls.push("readFile")
    return {
      body: new Blob([new Uint8Array([0, 1, 2, 255])]).stream(),
      size: 4,
      mediaType: "application/octet-stream",
    }
  }

  async expose(port: number, hostname: string): Promise<ExposedEndpoint> {
    this.calls.push("expose")
    this.exposedHostname = hostname
    return { port, url: "https://example.test", expiresOnRuntimeStop: true }
  }

  async unexpose(): Promise<void> {
    this.calls.push("unexpose")
  }

  async configureCredentialLease(): Promise<void> {
    this.calls.push("configureCredentialLease")
  }

  async clearCredentialLease(): Promise<void> {
    this.calls.push("clearCredentialLease")
  }
}

function createFixture(options: { token?: string; seedRuntime?: boolean } = {}) {
  const runtime = new FakeRuntime()
  const registry = new InMemoryBridgeRegistry(() => runtime)
  if (options.seedRuntime !== false) registry.seed(RUNTIME_ID)
  const app = createBridgeApp({
    runtimeFactory: () => runtime,
    registryFactory: () => registry,
  })
  const environment = {
    BRIDGE_TOKEN: options.token ?? TOKEN,
  } as CloudflareBridgeEnvironment

  return {
    runtime,
    registry,
    request: (path: string, init?: RequestInit) =>
      app.request(`https://bridge.test${path}`, init, environment),
  }
}

function runtimeSnapshot(state: RuntimeSnapshot["state"]): RuntimeSnapshot {
  return {
    handle: { version: BRIDGE_PROTOCOL_VERSION, id: RUNTIME_ID },
    state,
    processCount: 0,
    activeProcessCount: 0,
  }
}

function processSnapshot(status: ProcessSnapshot["status"]): ProcessSnapshot {
  return {
    handle: { version: BRIDGE_PROTOCOL_VERSION, runtimeId: RUNTIME_ID, id: PROCESS_ID },
    status,
    startedAt: "2026-07-13T00:00:00.000Z",
    exitCode: status === "completed" ? 0 : null,
  }
}

function completionFrame(processId: string, exitCode = 0): string {
  return `\n${processCompletionMarker(processId)}${exitCode}__\n`
}

function authorizationHeader(): HeadersInit {
  return {
    authorization: `Bearer ${TOKEN}`,
    "x-meanwhile-protocol-version": String(BRIDGE_PROTOCOL_VERSION),
  }
}

function jsonHeaders(): HeadersInit {
  return { ...authorizationHeader(), "content-type": "application/json" }
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } }
  return body.error.code
}

function spawnRequest(stdin: string): SpawnProcessRequest {
  return {
    operationId: PROCESS_ID.slice(3),
    argv: ["/opt/meanwhile/bin/meanwhile-runner"],
    stdin,
    input: "closed",
  }
}

function createSdkFixture(
  options: { failWrite?: boolean; failDelete?: boolean; transientDeleteFailures?: number } = {},
) {
  let stdinPath = ""
  let stdinContent = ""
  let command = ""
  let staged = false
  let destroyCount = 0
  let transientDeleteFailures = options.transientDeleteFailures ?? 0
  const deletedPaths: string[] = []

  const sandbox = {
    async setRuntimeLease() {},
    async getProcess() {
      return null
    },
    async mkdir() {},
    async writeFile(path: string, content: string) {
      stdinPath = path
      stdinContent = content
      staged = true
      if (options.failWrite) throw new Error("write failed")
    },
    async startProcess(value: string) {
      command = value
      return {
        id: PROCESS_ID,
        command: value,
        status: "running" as const,
        startTime: new Date("2026-07-13T00:00:00.000Z"),
        async getStatus() {
          return "running" as const
        },
      }
    },
    async exists() {
      return { exists: staged }
    },
    async deleteFile(path: string) {
      deletedPaths.push(path)
      if (options.failDelete) throw new Error("delete failed")
      if (transientDeleteFailures > 0) {
        transientDeleteFailures -= 1
        throw Object.assign(new Error("platform connection lost"), { retryable: true })
      }
      staged = false
    },
    async destroy() {
      destroyCount += 1
      staged = false
    },
  } as unknown as Sandbox

  return {
    sandbox,
    deletedPaths,
    get command() {
      return command
    },
    get destroyCount() {
      return destroyCount
    },
    get stdinContent() {
      return stdinContent
    },
    get stdinPath() {
      return stdinPath
    },
  }
}

function createWorkspaceSdkFixture(exitCodes: readonly number[]) {
  const pendingExitCodes = [...exitCodes]
  const calls: Array<{ readonly type: "exec" | "mkdir" | "write" | "read" | "list" }> = []
  const execCalls: Array<{
    readonly command: string
    readonly options: {
      readonly env: Record<string, string>
      readonly origin: "internal"
      readonly timeout: number
    }
  }> = []
  let writeCount = 0
  let readCount = 0
  let listCount = 0

  const sandbox = {
    async exec(
      command: string,
      options: {
        env: Record<string, string>
        origin: "internal"
        timeout: number
      },
    ) {
      calls.push({ type: "exec" })
      execCalls.push({ command, options })
      const exitCode = pendingExitCodes.shift()
      if (exitCode === undefined) throw new Error("unexpected workspace path probe")
      return {
        success: exitCode === 0,
        exitCode,
        stdout: command.includes("stat -c %s") && exitCode === 0 ? "4\n" : "",
        stderr: "provider-private diagnostic",
        command,
        duration: 1,
        timestamp: "2026-07-13T00:00:00.000Z",
      }
    },
    async mkdir() {
      calls.push({ type: "mkdir" })
    },
    async writeFile() {
      calls.push({ type: "write" })
      writeCount += 1
    },
    async readFileStream() {
      calls.push({ type: "read" })
      readCount += 1
      return fileSseStream(new TextEncoder().encode("safe"), "text/plain")
    },
    async listFiles() {
      calls.push({ type: "list" })
      listCount += 1
      return { files: [] }
    },
  } as unknown as Sandbox

  return {
    sandbox,
    calls,
    execCalls,
    get listCount() {
      return listCount
    },
    get readCount() {
      return readCount
    },
    get writeCount() {
      return writeCount
    },
  }
}

function fileSseStream(bytes: Uint8Array, mimeType: string): ReadableStream<Uint8Array> {
  const binary = String.fromCharCode(...bytes)
  const events = [
    {
      type: "metadata",
      mimeType,
      size: bytes.byteLength,
      isBinary: true,
      encoding: "base64",
    },
    { type: "chunk", data: btoa(binary) },
    { type: "complete", bytesRead: bytes.byteLength },
  ]
  return new Blob(events.map((event) => `data: ${JSON.stringify(event)}\n\n`)).stream()
}
