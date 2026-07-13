import { describe, expect, test } from "bun:test"
import { BRIDGE_PROTOCOL_VERSION } from "../../providers/cloudflare-sandbox/src/protocol"
import { CloudflareRuntimeProvider } from "../../src/providers/cloudflare-provider"
import {
  processHandle,
  RuntimeProviderError,
  relativePath,
} from "../../src/providers/runtime-provider"

const TOKEN = "bridge-test-token-that-is-at-least-thirty-two-bytes"
const NOW = "2026-07-13T00:00:00.000Z"

describe("CloudflareRuntimeProvider", () => {
  test("maps the complete provider contract over the authenticated bridge protocol", async () => {
    const bridge = new BridgeStub(TOKEN)
    const provider = createProvider(bridge)

    const runtime = await provider.create({ runtimeId: "control-plane-runtime" })
    const duplicateRuntime = await provider.create({ runtimeId: "control-plane-runtime" })
    expect(duplicateRuntime).toEqual(runtime)
    expect(runtime).toMatchObject({ kind: "runtime", version: 1, provider: "cloudflare" })
    expect(provider.capabilities).toEqual({
      isolation: "container",
      processRecovery: true,
      eventReplay: true,
      portExposure: true,
      processSignals: ["SIGKILL"],
    })

    await provider.start(runtime)
    expect((await provider.inspect(runtime)).status).toBe("running")
    await provider.writeFiles(runtime, [
      { path: relativePath("src/main.ts"), content: new TextEncoder().encode("export {}") },
    ])
    expect(
      new TextDecoder().decode(
        await provider.readFile(runtime, relativePath("src/main.ts"), { maxBytes: 1_024 }),
      ),
    ).toBe("export {}")
    expect(
      (await provider.listFiles(runtime, relativePath("src"), { maxEntries: 10 })).map(({ path }) =>
        String(path),
      ),
    ).toEqual(["src/main.ts"])

    const process = await provider.spawn(runtime, {
      processId: "runner-session-1",
      argv: ["meanwhile-runner"],
      cwd: relativePath("."),
      initialStdin: '{"version":1}\n',
      timeoutMs: 1_000,
      terminationGraceMs: 500,
    })
    const duplicateProcess = await provider.spawn(runtime, {
      processId: "runner-session-1",
      argv: ["meanwhile-runner"],
      cwd: relativePath("."),
      initialStdin: '{"version":1}\n',
      timeoutMs: 1_000,
      terminationGraceMs: 500,
    })
    expect(duplicateProcess).toEqual(process)
    await expect(provider.signal(process, "SIGTERM")).rejects.toMatchObject({
      code: "PROCESS_SIGNAL_UNSUPPORTED",
    })

    expect(await Array.fromAsync(provider.events(process, null))).toEqual([
      {
        cursor: "v2.13.0.0",
        timestamp: NOW,
        stream: "stdout",
        data: "runner-frame\n",
      },
    ])
    expect(await provider.wait(process)).toMatchObject({ exitCode: 0, reason: "exited" })
    expect(await provider.expose(runtime, 3_001)).toEqual({
      port: 3_001,
      url: "https://preview.example.test/",
    })
    expect(await provider.health()).toMatchObject({ status: "healthy" })

    await provider.stop(runtime)
    await provider.stop(runtime)
    await provider.destroy(runtime)
    await provider.destroy(runtime)
    expect((await provider.inspect(runtime)).status).toBe("missing")

    expect(
      bridge.requests.every(
        (request) => request.headers.get("authorization") === `Bearer ${TOKEN}`,
      ),
    ).toBe(true)
    expect(
      bridge.requests.every(
        (request) =>
          request.headers.get("x-meanwhile-protocol-version") === String(BRIDGE_PROTOCOL_VERSION),
      ),
    ).toBe(true)
    expect(new Set(bridge.runtimeOperationIds).size).toBe(1)
    expect(new Set(bridge.processOperationIds).size).toBe(1)
  })

  test("preserves safe bridge errors and retryability without returning raw bodies", async () => {
    const provider = new CloudflareRuntimeProvider({
      bridgeUrl: "https://bridge.example.test/",
      bridgeToken: TOKEN,
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "PROVIDER_BUSY",
              message: "Cloudflare capacity is temporarily unavailable.",
              requestId: "request-1",
              details: { retryable: true, internalCredential: "must-not-propagate" },
            },
          },
          { status: 503 },
        ),
    })

    let failure: unknown
    try {
      await provider.create({ runtimeId: "failed-runtime" })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(RuntimeProviderError)
    expect(failure).toMatchObject({
      provider: "cloudflare",
      operation: "create",
      code: "PROVIDER_BUSY",
      retryable: true,
      message: "Cloudflare capacity is temporarily unavailable.",
    })
    expect(JSON.stringify(failure)).not.toContain("internalCredential")
  })

  test("fails closed on transport, protocol, URL, and unsupported-mode errors", async () => {
    expect(
      () =>
        new CloudflareRuntimeProvider({
          bridgeUrl: "http://remote.example.test/",
          bridgeToken: TOKEN,
        }),
    ).toThrow(TypeError)

    const malformed = new CloudflareRuntimeProvider({
      bridgeUrl: "https://bridge.example.test/",
      bridgeToken: TOKEN,
      fetch: async () => Response.json({ runtime: { providerSpecific: true } }),
    })
    await expect(malformed.create({ runtimeId: "malformed-runtime" })).rejects.toMatchObject({
      code: "BRIDGE_PROTOCOL_ERROR",
    })

    const bridge = new BridgeStub(TOKEN)
    const provider = createProvider(bridge)
    const runtime = await provider.create({ runtimeId: "file-mode-runtime" })
    await expect(provider.expose(runtime, 3_000)).rejects.toMatchObject({ code: "INVALID_PORT" })
    await expect(
      provider.writeFiles(runtime, [
        { path: relativePath("executable"), content: new Uint8Array(), mode: 0o755 },
      ]),
    ).rejects.toMatchObject({ code: "FILE_MODE_UNSUPPORTED" })
  })

  test("aborts an in-flight bridge observation without a process mutation", async () => {
    let request: Request | undefined
    let entered: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const provider = new CloudflareRuntimeProvider({
      bridgeUrl: "https://bridge.example.test/",
      bridgeToken: TOKEN,
      requestTimeoutMs: 5_000,
      fetch: async (input, init) => {
        request = input instanceof Request ? input : new Request(input, init)
        entered?.()
        return new Promise<Response>((_resolve, reject) => {
          request?.signal.addEventListener("abort", () => reject(request?.signal.reason), {
            once: true,
          })
        })
      },
    })
    const controller = new AbortController()
    const stopped = new Error("stop observing")
    const observation = provider
      .events(
        processHandle(
          "cloudflare",
          "mw-00000000-0000-4000-8000-000000000001.mp-00000000-0000-4000-8000-000000000002",
        ),
        null,
        controller.signal,
      )
      [Symbol.asyncIterator]()
    const pending = observation.next()
    await started

    controller.abort(stopped)

    await expect(pending).rejects.toBe(stopped)
    expect(request?.method).toBe("GET")
    expect(new URL(request?.url ?? "https://invalid/").pathname).toEndWith("/events")
  })
})

function createProvider(bridge: BridgeStub): CloudflareRuntimeProvider {
  return new CloudflareRuntimeProvider({
    bridgeUrl: "https://bridge.example.test/",
    bridgeToken: TOKEN,
    fetch: bridge.fetch,
    eventPollIntervalMs: 1,
    waitRequestMs: 1,
  })
}

class BridgeStub {
  readonly requests: Request[] = []
  readonly runtimeOperationIds: string[] = []
  readonly processOperationIds: string[] = []
  readonly #token: string
  readonly #files = new Map<string, Uint8Array>()
  runtimeId: string | null = null
  processId: string | null = null
  runtimeState: "created" | "active" | "stopped" | "destroyed" = "created"

  constructor(token: string) {
    this.#token = token
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init)
    this.requests.push(request.clone())
    if (request.headers.get("authorization") !== `Bearer ${this.#token}`) {
      return errorResponse(401, "UNAUTHORIZED", false)
    }

    const url = new URL(request.url)
    const path = url.pathname
    if (request.method === "GET" && path === "/v1/health") {
      return json({
        service: "bridge",
        status: "ok",
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        sandboxSdkVersion: "0.12.3",
      })
    }
    if (request.method === "POST" && path === "/v1/runtimes") {
      const body = (await request.json()) as { operationId: string }
      this.runtimeOperationIds.push(body.operationId)
      this.runtimeId = `mw-${body.operationId}`
      return json({ runtime: this.#runtimeSnapshot("created") }, 201)
    }
    if (this.runtimeId === null || !path.startsWith(`/v1/runtimes/${this.runtimeId}`)) {
      return errorResponse(404, "NOT_FOUND", false)
    }
    if (request.method === "POST" && path.endsWith("/start")) {
      this.runtimeState = "active"
      return json({ runtime: this.#runtimeSnapshot("active") })
    }
    if (request.method === "POST" && path.endsWith("/stop")) {
      this.runtimeState = "stopped"
      return json({ runtime: this.#runtimeSnapshot("stopped") })
    }
    if (request.method === "DELETE" && path === `/v1/runtimes/${this.runtimeId}`) {
      this.runtimeState = "destroyed"
      return json({ runtime: this.#runtimeSnapshot("destroyed") })
    }
    if (request.method === "GET" && path === `/v1/runtimes/${this.runtimeId}`) {
      return json({ runtime: this.#runtimeSnapshot(this.runtimeState) })
    }
    if (request.method === "POST" && path.endsWith("/processes")) {
      const body = (await request.json()) as { operationId: string }
      this.processOperationIds.push(body.operationId)
      this.processId = `mp-${body.operationId}`
      return json({ process: this.#processSnapshot("running") }, 201)
    }
    if (this.processId !== null && path.includes(`/processes/${this.processId}`)) {
      if (request.method === "GET" && path.endsWith("/events")) {
        return json({
          events: [
            {
              type: "output",
              cursor: "v2.13.0.0",
              timestamp: NOW,
              stream: "stdout",
              data: "runner-frame\n",
            },
            { type: "exit", cursor: "v2.13.0.1", timestamp: NOW, status: "completed", exitCode: 0 },
          ],
          nextCursor: "v2.13.0.1",
        })
      }
      if (request.method === "GET" && path.endsWith("/wait")) {
        return json({ process: this.#processSnapshot("completed") })
      }
      if (request.method === "POST" && path.endsWith("/signal")) {
        return json({ process: this.#processSnapshot("killed") })
      }
      if (request.method === "GET") return json({ process: this.#processSnapshot("completed") })
    }
    if (request.method === "PUT" && path.endsWith("/files")) {
      const body = (await request.json()) as {
        files: Array<{ path: string; contentBase64: string }>
      }
      for (const file of body.files)
        this.#files.set(file.path, new Uint8Array(Buffer.from(file.contentBase64, "base64")))
      return json({ written: body.files.map(({ path: filePath }) => filePath) })
    }
    if (request.method === "GET" && path.endsWith("/files")) {
      const directory = url.searchParams.get("path") ?? "."
      return json({
        files: [...this.#files.entries()]
          .filter(([filePath]) => directory === "." || filePath.startsWith(`${directory}/`))
          .map(([filePath, content]) => ({
            path: filePath,
            type: "file",
            size: content.byteLength,
            modifiedAt: NOW,
          })),
      })
    }
    if (request.method === "GET" && path.endsWith("/file")) {
      const content = this.#files.get(url.searchParams.get("path") ?? "")
      return content === undefined
        ? errorResponse(404, "NOT_FOUND", false)
        : new Response(
            content.buffer.slice(
              content.byteOffset,
              content.byteOffset + content.byteLength,
            ) as ArrayBuffer,
            { headers: { "content-length": String(content.byteLength) } },
          )
    }
    if (request.method === "POST" && path.endsWith("/ports/3001/expose")) {
      return json(
        {
          endpoint: {
            port: 3_001,
            url: "https://preview.example.test/",
            expiresOnRuntimeStop: true,
          },
        },
        201,
      )
    }
    return errorResponse(404, "NOT_FOUND", false)
  }

  #runtimeSnapshot(state: BridgeStub["runtimeState"]): unknown {
    return {
      handle: { version: BRIDGE_PROTOCOL_VERSION, id: this.runtimeId },
      state,
      processCount: this.processId === null ? 0 : 1,
      activeProcessCount: state === "active" && this.processId !== null ? 1 : 0,
    }
  }

  #processSnapshot(status: "running" | "completed" | "killed"): unknown {
    return {
      handle: { version: BRIDGE_PROTOCOL_VERSION, runtimeId: this.runtimeId, id: this.processId },
      status,
      startedAt: NOW,
      ...(status === "running" ? {} : { finishedAt: NOW }),
      exitCode: status === "completed" ? 0 : null,
    }
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

function errorResponse(status: number, code: string, retryable: boolean): Response {
  return json(
    {
      error: {
        code,
        message: "Safe bridge error.",
        requestId: "bridge-request",
        details: { retryable },
      },
    },
    status,
  )
}
