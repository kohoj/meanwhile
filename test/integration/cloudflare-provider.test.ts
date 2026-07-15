import { describe, expect, test } from "bun:test"
import {
  BRIDGE_PROTOCOL_VERSION,
  INITIAL_EVENT_CURSOR,
} from "../../providers/cloudflare-sandbox/src/protocol"
import { CloudflareRuntimeProvider } from "../../src/providers/cloudflare-provider"
import {
  processHandle,
  RuntimeProviderError,
  relativePath,
} from "../../src/providers/runtime-provider"

const TOKEN = "bridge-test-token-that-is-at-least-thirty-two-bytes"
const NOW = "2026-07-13T00:00:00.000Z"
const EMPTY_DIGEST = "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"
const OUTPUT_CURSOR = `v3.13.0.0.${EMPTY_DIGEST}.${EMPTY_DIGEST}`
const TERMINAL_CURSOR = `v3.13.0.1.${EMPTY_DIGEST}.${EMPTY_DIGEST}`
const RETRY_OUTPUT_CURSOR = `v3.6.0.0.${EMPTY_DIGEST}.${EMPTY_DIGEST}`
const RETRY_TERMINAL_CURSOR = `v3.6.0.1.${EMPTY_DIGEST}.${EMPTY_DIGEST}`

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
      processInput: true,
      portExposure: true,
      networkPolicy: true,
      credentialMediation: "http",
      processSignals: ["SIGKILL"],
    })
    expect(provider.provenance).toMatchObject({
      runtimeImageReference: null,
      runtimeImageDigest: null,
    })

    await provider.start(runtime)
    expect((await provider.inspect(runtime)).status).toBe("running")
    const credentialLeaseId = "70c78f7e-a915-4a4b-a9cb-e805f534f607"
    const attached = await provider.attach({
      leaseId: credentialLeaseId,
      runtime,
      allowedHosts: ["api.example.com"],
      credentials: [
        {
          environmentVariable: "MODEL_API_KEY",
          host: "api.example.com",
          methods: ["POST"],
          value: "real-secret-value",
        },
      ],
    })
    expect(attached.environment).toEqual({ MODEL_API_KEY: `mwcap_${credentialLeaseId}` })
    expect(JSON.stringify(attached)).not.toContain("real-secret-value")
    await provider.writeFiles(runtime, [
      {
        path: relativePath("src/main.ts"),
        content: new TextEncoder().encode("export {}"),
        mode: 0o700,
      },
    ])
    expect(bridge.fileModes.get("src/main.ts")).toBe(0o700)
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
    const abortReason = new DOMException("Stop observing files", "AbortError")
    const aborted = AbortSignal.abort(abortReason)
    await expect(provider.inspect(runtime, aborted)).rejects.toBe(abortReason)
    await expect(
      provider.listFiles(runtime, relativePath("src"), { maxEntries: 10 }, aborted),
    ).rejects.toBe(abortReason)
    await expect(
      provider.readFile(runtime, relativePath("src/main.ts"), { maxBytes: 1_024 }, aborted),
    ).rejects.toBe(abortReason)

    const process = await provider.spawn(runtime, {
      processId: "runner-session-1",
      argv: ["meanwhile-runner"],
      cwd: relativePath("."),
      initialStdin: '{"version":1}\n',
      input: "mailbox",
      timeoutMs: 1_000,
      terminationGraceMs: 500,
    })
    const duplicateProcess = await provider.spawn(runtime, {
      processId: "runner-session-1",
      argv: ["meanwhile-runner"],
      cwd: relativePath("."),
      initialStdin: '{"version":1}\n',
      input: "mailbox",
      timeoutMs: 1_000,
      terminationGraceMs: 500,
    })
    expect(duplicateProcess).toEqual(process)
    await provider.send?.(process, {
      sequence: 1,
      id: "70c78f7e-a915-4a4b-a9cb-e805f534f606",
      data: '{"type":"turn.start"}',
    })
    expect(bridge.processInputs).toEqual([
      {
        sequence: 1,
        id: "70c78f7e-a915-4a4b-a9cb-e805f534f606",
        data: '{"type":"turn.start"}',
      },
    ])
    await expect(provider.signal(process, "SIGTERM")).rejects.toMatchObject({
      code: "PROCESS_SIGNAL_UNSUPPORTED",
    })

    expect(await Array.fromAsync(provider.events(process, null))).toEqual([
      {
        cursor: OUTPUT_CURSOR,
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

    await provider.revoke({ leaseId: credentialLeaseId, runtime, handle: attached.handle })
    expect(bridge.revokedCredentialLeases).toEqual([credentialLeaseId])

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

  test("records only explicitly paired custom image provenance", () => {
    const provider = new CloudflareRuntimeProvider({
      bridgeUrl: "https://bridge.example.test/",
      bridgeToken: TOKEN,
      runtimeImageReference: "registry.example.test/meanwhile/runtime@sha256:immutable",
      runtimeImageDigest: `sha256:${"a".repeat(64)}`,
      runnerDigest: "b".repeat(64),
    })

    expect(provider.provenance).toMatchObject({
      runtimeImageReference: "registry.example.test/meanwhile/runtime@sha256:immutable",
      runtimeImageDigest: `sha256:${"a".repeat(64)}`,
      runnerDigest: "b".repeat(64),
    })
  })

  test("preserves safe bridge errors and retryability without returning raw bodies", async () => {
    const provider = new CloudflareRuntimeProvider({
      bridgeUrl: "https://bridge.example.test/",
      bridgeToken: TOKEN,
      retryDelaysMs: [],
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

  test("honors an explicit non-retryable bridge decision on a 5xx response", async () => {
    let attempts = 0
    const provider = new CloudflareRuntimeProvider({
      bridgeUrl: "https://bridge.example.test/",
      bridgeToken: TOKEN,
      retryDelaysMs: [1, 1],
      fetch: async () => {
        attempts += 1
        return errorResponse(502, "STAGING_CLEANUP_FAILED", false)
      },
    })

    await expect(provider.create({ runtimeId: "failed-runtime" })).rejects.toMatchObject({
      code: "STAGING_CLEANUP_FAILED",
      retryable: false,
    })
    expect(attempts).toBe(1)
  })

  test("fails closed on transport, protocol, URL, and invalid-mode errors", async () => {
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
        { path: relativePath("executable"), content: new Uint8Array(), mode: 0o500 },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_FILE_MODE" })
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

  test("retries transient event reads from the same durable cursor", async () => {
    let attempts = 0
    const cursors: string[] = []
    const requestIds: string[] = []
    const provider = new CloudflareRuntimeProvider({
      bridgeUrl: "https://bridge.example.test/",
      bridgeToken: TOKEN,
      retryDelaysMs: [1, 1],
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init)
        const url = new URL(request.url)
        cursors.push(url.searchParams.get("cursor") ?? "")
        requestIds.push(request.headers.get("x-request-id") ?? "")
        attempts += 1
        if (attempts < 3) return errorResponse(503, "PROVIDER_BUSY", true)
        return json({
          events: [
            {
              type: "output",
              cursor: RETRY_OUTPUT_CURSOR,
              timestamp: NOW,
              stream: "stdout",
              data: "frame\n",
            },
            {
              type: "exit",
              cursor: RETRY_TERMINAL_CURSOR,
              timestamp: NOW,
              status: "completed",
              exitCode: 0,
            },
          ],
          nextCursor: RETRY_TERMINAL_CURSOR,
        })
      },
    })

    const process = processHandle(
      "cloudflare",
      "mw-00000000-0000-4000-8000-000000000001.mp-00000000-0000-4000-8000-000000000002",
    )
    expect(
      (await Array.fromAsync(provider.events(process, INITIAL_EVENT_CURSOR))).map(
        ({ data }) => data,
      ),
    ).toEqual(["frame\n"])
    expect(cursors).toEqual([INITIAL_EVENT_CURSOR, INITIAL_EVENT_CURSOR, INITIAL_EVENT_CURSOR])
    expect(new Set(requestIds).size).toBe(1)
  })

  test("drains final process output after terminal state wins the observation race", async () => {
    let eventReads = 0
    const provider = new CloudflareRuntimeProvider({
      bridgeUrl: "https://bridge.example.test/",
      bridgeToken: TOKEN,
      eventPollIntervalMs: 1,
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init)
        const path = new URL(request.url).pathname
        if (path.endsWith("/events")) {
          eventReads += 1
          if (eventReads === 1) {
            return json({ events: [], nextCursor: INITIAL_EVENT_CURSOR })
          }
          return json({
            events: [
              {
                type: "output",
                cursor: OUTPUT_CURSOR,
                timestamp: NOW,
                stream: "stdout",
                data: "final-frame\n",
              },
              {
                type: "exit",
                cursor: TERMINAL_CURSOR,
                timestamp: NOW,
                status: "completed",
                exitCode: 0,
              },
            ],
            nextCursor: TERMINAL_CURSOR,
          })
        }
        return json({
          process: {
            handle: {
              version: BRIDGE_PROTOCOL_VERSION,
              id: "mp-00000000-0000-4000-8000-000000000002",
              runtimeId: "mw-00000000-0000-4000-8000-000000000001",
            },
            status: "completed",
            exitCode: 0,
            startedAt: NOW,
            finishedAt: NOW,
          },
        })
      },
    })
    const process = processHandle(
      "cloudflare",
      "mw-00000000-0000-4000-8000-000000000001.mp-00000000-0000-4000-8000-000000000002",
    )

    expect((await Array.fromAsync(provider.events(process, null))).map(({ data }) => data)).toEqual(
      ["final-frame\n"],
    )
    expect(eventReads).toBe(2)
  })

  test("retries transient lifecycle mutations with one stable request identity", async () => {
    const bridge = new BridgeStub(TOKEN)
    const startRequestIds: string[] = []
    let startAttempts = 0
    const provider = new CloudflareRuntimeProvider({
      bridgeUrl: "https://bridge.example.test/",
      bridgeToken: TOKEN,
      retryDelaysMs: [1, 1, 1, 1, 1, 1],
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init)
        if (request.method === "POST" && new URL(request.url).pathname.endsWith("/start")) {
          startRequestIds.push(request.headers.get("x-request-id") ?? "")
          startAttempts += 1
          if (startAttempts < 7) return errorResponse(503, "PROVIDER_BUSY", true)
        }
        return bridge.fetch(request)
      },
    })

    const runtime = await provider.create({ runtimeId: "rollout-transient-runtime" })
    await provider.start(runtime)

    expect(startAttempts).toBe(7)
    expect(new Set(startRequestIds).size).toBe(1)
    expect(startRequestIds[0]).not.toBe("")
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
  readonly fileModes = new Map<string, number>()
  readonly processInputs: unknown[] = []
  readonly revokedCredentialLeases: string[] = []
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
    if (request.method === "POST" && path.endsWith("/credential-leases")) {
      const body = (await request.json()) as {
        leaseId: string
        credentials: Array<{ environmentVariable: string }>
      }
      return json(
        {
          credentialLease: {
            version: BRIDGE_PROTOCOL_VERSION,
            id: body.leaseId,
            runtimeId: this.runtimeId,
            environment: Object.fromEntries(
              body.credentials.map(({ environmentVariable }) => [
                environmentVariable,
                `mwcap_${body.leaseId}`,
              ]),
            ),
          },
        },
        201,
      )
    }
    if (request.method === "DELETE" && path.includes("/credential-leases/")) {
      this.revokedCredentialLeases.push(path.split("/").at(-1) ?? "")
      return json({ revoked: true })
    }
    if (request.method === "POST" && path.endsWith("/processes")) {
      const body = (await request.json()) as { operationId: string }
      this.processOperationIds.push(body.operationId)
      this.processId = `mp-${body.operationId}`
      return json({ process: this.#processSnapshot("running") }, 201)
    }
    if (this.processId !== null && path.includes(`/processes/${this.processId}`)) {
      if (request.method === "POST" && path.endsWith("/input")) {
        this.processInputs.push(await request.json())
        return json({ accepted: true })
      }
      if (request.method === "GET" && path.endsWith("/events")) {
        return json({
          events: [
            {
              type: "output",
              cursor: OUTPUT_CURSOR,
              timestamp: NOW,
              stream: "stdout",
              data: "runner-frame\n",
            },
            {
              type: "exit",
              cursor: TERMINAL_CURSOR,
              timestamp: NOW,
              status: "completed",
              exitCode: 0,
            },
          ],
          nextCursor: TERMINAL_CURSOR,
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
        files: Array<{ path: string; contentBase64: string; mode: number }>
      }
      for (const file of body.files) {
        this.#files.set(file.path, new Uint8Array(Buffer.from(file.contentBase64, "base64")))
        this.fileModes.set(file.path, file.mode)
      }
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
