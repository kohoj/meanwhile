import { beforeAll, describe, expect, mock, test } from "bun:test"
import type { Sandbox } from "@cloudflare/sandbox"

import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeError,
  decodeEventCursor,
  type ExposedEndpoint,
  encodeEventCursor,
  INITIAL_EVENT_CURSOR,
  MAX_PROCESS_OUTPUT_BYTES,
  type ProcessEventsResponse,
  type ProcessSignal,
  type ProcessSnapshot,
  type RuntimeFileInfo,
  type RuntimeSnapshot,
  type SpawnProcessRequest,
  type WriteFilesRequest,
} from "../src/protocol"
import type { BridgeRuntime, CloudflareBridgeEnvironment, ReadRuntimeFile } from "../src/sandbox"

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}))

let createBridgeApp: typeof import("../src/worker").createBridgeApp
let InMemoryBridgeRegistry: typeof import("../src/worker").InMemoryBridgeRegistry
let CloudflareBridgeRuntime: typeof import("../src/sandbox").CloudflareBridgeRuntime
let shellJoin: typeof import("../src/sandbox").shellJoin

beforeAll(async () => {
  ;({ createBridgeApp, InMemoryBridgeRegistry } = await import("../src/worker"))
  ;({ CloudflareBridgeRuntime, shellJoin } = await import("../src/sandbox"))
})

const TOKEN = "test-bridge-token-that-is-at-least-thirty-two-bytes"
const RUNTIME_ID = "mw-3f390eef-460f-4a08-a067-8fa1bb9dcd21"
const PROCESS_ID = "mp-e5549e84-bb1d-4b6d-ad1c-dc5313de61f1"

describe("Cloudflare Sandbox bridge", () => {
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

  test("pins the SDK, image, and RPC transport as one compatibility unit", async () => {
    const packageManifest = JSON.parse(
      await Bun.file(new URL("../package.json", import.meta.url)).text(),
    ) as { dependencies: Record<string, string>; scripts: Record<string, string> }
    const dockerfile = await Bun.file(new URL("../Dockerfile", import.meta.url)).text()
    const wrangler = await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text()

    expect(packageManifest.dependencies["@cloudflare/sandbox"]).toBe("0.12.3")
    expect(packageManifest.scripts["runner:stage"]).toContain("--target=bun-linux-x64-baseline")
    expect(packageManifest.scripts["runner:stage"]).toContain("meanwhile-demo-agent")
    expect(dockerfile).toContain("FROM docker.io/cloudflare/sandbox:0.12.3")
    expect(dockerfile).toContain(".runner/meanwhile-runner /opt/meanwhile/bin/meanwhile-runner")
    expect(dockerfile).toContain(
      ".runner/meanwhile-demo-agent /opt/meanwhile/bin/meanwhile-demo-agent",
    )
    expect(dockerfile).toContain("bun install --frozen-lockfile --production")
    expect(dockerfile).toContain("image/claude-agent-acp /opt/meanwhile/bin/claude-agent-acp")
    const runtimeAgentManifest = JSON.parse(
      await Bun.file(new URL("../image/package.json", import.meta.url)).text(),
    ) as { dependencies: Record<string, string> }
    expect(runtimeAgentManifest.dependencies["@agentclientprotocol/claude-agent-acp"]).toBe(
      "0.58.1",
    )
    expect(wrangler).toContain('"SANDBOX_TRANSPORT": "rpc"')
    expect(wrangler).toContain('"instance_type": "standard-1"')
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
    expect((await spawn(request)).status).toBe(201)
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

  test("uses a component-wise replay cursor without duplicating stream data", () => {
    const encoded = encodeEventCursor({ stdoutOffset: 12, stderrOffset: 7, terminalSeen: true })
    expect(decodeEventCursor(encoded)).toEqual({
      stdoutOffset: 12,
      stderrOffset: 7,
      terminalSeen: true,
    })
    expect(() => decodeEventCursor("v1.-1.0.0")).toThrow(BridgeError)
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
        return { stdout, stderr, processId: PROCESS_ID }
      },
    } as unknown as Sandbox
    const runtime = new CloudflareBridgeRuntime(RUNTIME_ID, sandbox, async () => {})

    const first = await runtime.events(PROCESS_ID, INITIAL_EVENT_CURSOR, 4)
    expect(
      first.events.map((event) => (event.type === "output" ? event.data : event.type)),
    ).toEqual(["abc", "x"])
    expect(first.nextCursor).toBe("v2.3.1.0")

    stdout = "abcdef"
    stderr = "xyz"
    status = "completed"
    const second = await runtime.events(PROCESS_ID, first.nextCursor, 10)
    expect(
      second.events.map((event) => (event.type === "output" ? event.data : event.type)),
    ).toEqual(["def", "yz", "exit"])
    expect(second.nextCursor).toBe("v2.6.3.1")

    const third = await runtime.events(PROCESS_ID, second.nextCursor, 10)
    expect(third.events).toEqual([])
    await expect(runtime.events(PROCESS_ID, "v2.99.0.0", 10)).rejects.toMatchObject({
      code: "EVENT_REPLAY_GAP",
    })
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
        return {
          stdout: terminalObserved ? "final-runner-frame\n" : "stale-prefix\n",
          stderr: "",
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

  test("waits for terminal accumulated logs to become quiescent before publishing exit", async () => {
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
        return {
          stdout: status === "completed" && logReads >= 4 ? `${prefix}${terminal}` : prefix,
          stderr: "",
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
    expect(logReads).toBeGreaterThanOrEqual(9)
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
        return { stdout, stderr: "", processId: PROCESS_ID }
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

  test("stages initial stdin outside the workspace and always deletes it", async () => {
    const fixture = createSdkFixture()
    const runtime = new CloudflareBridgeRuntime(RUNTIME_ID, fixture.sandbox)

    await runtime.spawn(PROCESS_ID, spawnRequest("private prompt\n"))

    expect(fixture.stdinPath).toMatch(/^\/tmp\/meanwhile-bridge\/[0-9a-f-]{36}\.stdin$/)
    expect(fixture.stdinPath.startsWith("/workspace/")).toBe(false)
    expect(fixture.stdinContent).toBe("private prompt\n")
    expect(fixture.command.endsWith(` < '${fixture.stdinPath}'`)).toBe(true)
    expect(fixture.deletedPaths).toEqual([fixture.stdinPath])
  })

  test("attempts staging cleanup after a failed write and destroys on cleanup failure", async () => {
    const writeFailure = createSdkFixture({ failWrite: true })
    const firstRuntime = new CloudflareBridgeRuntime(RUNTIME_ID, writeFailure.sandbox)
    await expect(firstRuntime.spawn(PROCESS_ID, spawnRequest("input"))).rejects.toThrow(
      "write failed",
    )
    expect(writeFailure.deletedPaths).toEqual([writeFailure.stdinPath])

    const cleanupFailure = createSdkFixture({ failDelete: true })
    const secondRuntime = new CloudflareBridgeRuntime(RUNTIME_ID, cleanupFailure.sandbox)
    const result = secondRuntime.spawn(PROCESS_ID, spawnRequest("input"))
    await expect(result).rejects.toMatchObject({ code: "STAGING_CLEANUP_FAILED" })
    expect(cleanupFailure.destroyCount).toBe(1)
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
  spawnRequest?: SpawnProcessRequest
  startError?: Error

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

  async spawn(_processId: string, request: SpawnProcessRequest): Promise<ProcessSnapshot> {
    this.calls.push("spawn")
    this.spawnRequest = request
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

  async expose(port: number): Promise<ExposedEndpoint> {
    this.calls.push("expose")
    return { port, url: "https://example.trycloudflare.com", expiresOnRuntimeStop: true }
  }

  async unexpose(): Promise<void> {
    this.calls.push("unexpose")
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
  }
}

function createSdkFixture(options: { failWrite?: boolean; failDelete?: boolean } = {}) {
  let stdinPath = ""
  let stdinContent = ""
  let command = ""
  let staged = false
  let destroyCount = 0
  const deletedPaths: string[] = []

  const sandbox = {
    async setKeepAlive() {},
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
        stdout: "",
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
    async readFile() {
      calls.push({ type: "read" })
      readCount += 1
      return {
        content: new Blob(["safe"]).stream(),
        size: 4,
        mimeType: "text/plain",
      }
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
