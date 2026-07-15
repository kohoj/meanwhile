import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runtimeCredentialBroker } from "../../src/credentials"
import { LocalRuntimeProvider } from "../../src/providers/local-provider"
import { RuntimeProviderRegistry } from "../../src/providers/registry"
import {
  processHandle,
  processHardTimeoutMs,
  processSpecFingerprint,
  type RuntimeProvider,
  relativePath,
  restoreProcessHandle,
  restoreRuntimeHandle,
  runtimeHandle,
} from "../../src/providers/runtime-provider"
import { MockRuntimeProvider } from "../fixtures/mock-provider"

const contractRoots: string[] = []

afterAll(async () => {
  await Promise.all(contractRoots.map((root) => rm(root, { recursive: true, force: true })))
})

function sharedProviderContract(
  name: string,
  factory: () => RuntimeProvider | Promise<RuntimeProvider>,
): void {
  describe(`${name} shared provider contract`, () => {
    test("lifecycle is explicit and cleanup is idempotent", async () => {
      const provider = await factory()
      const runtime = await provider.create({ runtimeId: "contract-lifecycle" })
      expect(await provider.create({ runtimeId: "contract-lifecycle" })).toEqual(runtime)

      expect((await provider.inspect(runtime)).status).toBe("created")
      await provider.start(runtime)
      expect((await provider.inspect(runtime)).status).toBe("running")
      await provider.stop(runtime)
      await provider.stop(runtime)
      expect((await provider.inspect(runtime)).status).toBe("stopped")
      await provider.destroy(runtime)
      await provider.destroy(runtime)
      expect((await provider.inspect(runtime)).status).toBe("missing")
    })

    test("files are copied, workspace-scoped, and listed deterministically", async () => {
      const provider = await factory()
      const runtime = await provider.create({ runtimeId: "contract-files" })
      const content = new TextEncoder().encode("immutable input")
      await provider.writeFiles(runtime, [
        { path: relativePath("src/main.ts"), content },
        { path: relativePath("README.md"), content: new TextEncoder().encode("read me") },
      ])
      content.fill(0)

      expect(
        new TextDecoder().decode(
          await provider.readFile(runtime, relativePath("src/main.ts"), { maxBytes: 1_024 }),
        ),
      ).toBe("immutable input")
      expect(
        (await provider.listFiles(runtime, relativePath("."), { maxEntries: 10 })).map(
          (entry) => `${entry.path}:${entry.type}`,
        ),
      ).toEqual(["README.md:file", "src:directory"])
      await expect(
        provider.readFile(runtime, relativePath("src/main.ts"), { maxBytes: 1 }),
      ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" })
      await expect(
        provider.listFiles(runtime, relativePath("."), { maxEntries: 1 }),
      ).rejects.toMatchObject({ code: "ENTRY_LIMIT_EXCEEDED" })
      const abortReason = new DOMException("Stop observing files", "AbortError")
      const aborted = AbortSignal.abort(abortReason)
      await expect(provider.inspect(runtime, aborted)).rejects.toBe(abortReason)
      await expect(
        provider.listFiles(runtime, relativePath("."), { maxEntries: 10 }, aborted),
      ).rejects.toBe(abortReason)
      await expect(
        provider.readFile(runtime, relativePath("src/main.ts"), { maxBytes: 1_024 }, aborted),
      ).rejects.toBe(abortReason)
      await provider.destroy(runtime)
    })

    test("spawn idempotency is bound to the complete process specification", async () => {
      const provider = await factory()
      const runtime = await provider.create({ runtimeId: "contract-process-idempotency" })
      await provider.start(runtime)
      const spec = {
        processId: "contract-process",
        argv: ["true"] as const,
        cwd: relativePath("."),
        env: { CONTRACT_VALUE: "one" },
      }
      const process = await provider.spawn(runtime, spec)
      expect(await provider.spawn(runtime, { ...spec, env: { CONTRACT_VALUE: "one" } })).toEqual(
        process,
      )
      await expect(
        provider.spawn(runtime, { ...spec, env: { CONTRACT_VALUE: "two" } }),
      ).rejects.toMatchObject({ code: "PROCESS_CONFLICT" })
      await provider.destroy(runtime)
    })
  })
}

sharedProviderContract("mock", () => new MockRuntimeProvider())
sharedProviderContract("local", async () => {
  const root = await mkdtemp(join(tmpdir(), "meanwhile-provider-contract-"))
  contractRoots.push(root)
  return new LocalRuntimeProvider({ rootDirectory: root, pollIntervalMs: 5, stopGraceMs: 100 })
})

describe("RuntimeProvider contract", () => {
  test("credential mediation is a separate exact-id revocable contract", async () => {
    const provider = new MockRuntimeProvider()
    const runtime = await provider.create({ runtimeId: "runtime-credentials" })
    await provider.start(runtime)
    const broker = runtimeCredentialBroker(provider)
    if (broker === null) throw new Error("Mock credential broker is unavailable")
    const credential = {
      environmentVariable: "MODEL_TOKEN",
      host: "api.example.com",
      methods: ["POST" as const],
      value: "source-credential",
    }
    const input = {
      leaseId: "a4a6b83c-551b-4c43-89f1-c2a995334b46",
      runtime,
      allowedHosts: ["api.example.com"],
      credentials: [credential],
    }

    const attached = await broker.attach(input)
    expect(await broker.attach(input)).toEqual(attached)
    expect(attached.environment["MODEL_TOKEN"]).not.toBe("source-credential")
    await expect(
      broker.attach({
        ...input,
        credentials: [{ ...credential, value: "conflicting-credential" }],
      }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_LEASE_CONFLICT" })

    await broker.revoke({ leaseId: input.leaseId, runtime, handle: attached.handle })
    await broker.revoke({ leaseId: input.leaseId, runtime, handle: attached.handle })
    await expect(broker.attach(input)).rejects.toMatchObject({ code: "CREDENTIAL_LEASE_REVOKED" })
  })

  test("handles are versioned, persistable, and provider-bound", async () => {
    const provider = new MockRuntimeProvider()
    const runtime = await provider.create({ runtimeId: "runtime-1" })

    expect(JSON.parse(JSON.stringify(runtime))).toEqual({
      kind: "runtime",
      version: 1,
      provider: "mock",
      opaque: "runtime-1",
    })
    expect(restoreRuntimeHandle(JSON.parse(JSON.stringify(runtime)))).toEqual(runtime)
    expect(() => restoreRuntimeHandle({ ...runtime, version: 2 })).toThrow(TypeError)
    expect(() =>
      restoreProcessHandle({ kind: "process", version: 1, provider: "INVALID", opaque: "p" }),
    ).toThrow(TypeError)
    await expect(provider.inspect(runtimeHandle("other", "runtime-1"))).rejects.toMatchObject({
      code: "INVALID_RUNTIME_HANDLE",
      provider: "mock",
      operation: "inspect",
    })
    await expect(
      provider.inspectProcess(processHandle("other", "runtime-1.p1")),
    ).rejects.toMatchObject({
      code: "INVALID_PROCESS_HANDLE",
    })
  })

  test("portable relative paths reject aliases and traversal", () => {
    expect(() => relativePath("../escape")).toThrow(TypeError)
    expect(() => relativePath("/absolute")).toThrow(TypeError)
    expect(() => relativePath("src\\native")).toThrow(TypeError)
  })

  test("process events replay from an opaque cursor without duplication", async () => {
    const provider = new MockRuntimeProvider()
    const runtime = await provider.create({ runtimeId: "runtime-events" })
    await provider.start(runtime)
    const process = await provider.spawn(runtime, {
      processId: "process-events",
      argv: ["fixture-agent"],
      cwd: relativePath("."),
    })

    const first = provider.emit(process, "stdout", "one\n")
    provider.emit(process, "stderr", "two\n")
    provider.complete(process, 0)

    const all = await Array.fromAsync(provider.events(process, null))
    const resumed = await Array.fromAsync(provider.events(process, first.cursor))
    expect(all.map((event) => event.data)).toEqual(["one\n", "two\n"])
    expect(resumed.map((event) => event.data)).toEqual(["two\n"])
    expect(await provider.wait(process)).toMatchObject({ exitCode: 0, reason: "exited" })
  })

  test("aborting event observation never signals the process", async () => {
    const provider = new MockRuntimeProvider()
    const runtime = await provider.create({ runtimeId: "runtime-observation-abort" })
    await provider.start(runtime)
    const process = await provider.spawn(runtime, {
      processId: "process-observation-abort",
      argv: ["fixture-agent"],
      cwd: relativePath("."),
    })
    const controller = new AbortController()
    const stopped = new Error("stop observing")
    const observation = provider.events(process, null, controller.signal)[Symbol.asyncIterator]()
    const pending = observation.next()

    controller.abort(stopped)

    await expect(pending).rejects.toBe(stopped)
    expect((await provider.inspectProcess(process)).status).toBe("running")
    expect(provider.operations.filter(({ operation }) => operation === "signal")).toEqual([])
    provider.complete(process)
  })

  test("signals terminate a process exactly once", async () => {
    const provider = new MockRuntimeProvider()
    const runtime = await provider.create({ runtimeId: "runtime-signal" })
    await provider.start(runtime)
    const process = await provider.spawn(runtime, {
      processId: "process-signal",
      argv: ["fixture-agent"],
      cwd: relativePath("."),
    })

    await provider.signal(process, "SIGTERM")
    await provider.signal(process, "SIGTERM")
    expect(await provider.wait(process)).toMatchObject({
      exitCode: null,
      signal: "SIGTERM",
      reason: "signaled",
    })
  })

  test("process identity is canonical, secret-safe, and timing is explicit", async () => {
    const secret = "provider-fingerprint-secret"
    const left = {
      processId: "process-fingerprint",
      argv: ["fixture-agent", "--task"] as const,
      cwd: relativePath("."),
      env: { SECOND: "two", SECRET: secret },
      initialStdin: "private input",
      timeoutMs: 1,
      terminationGraceMs: 1,
    }
    const reordered = { ...left, env: { SECRET: secret, SECOND: "two" } }

    const fingerprint = await processSpecFingerprint(left)
    expect(fingerprint).toBe(await processSpecFingerprint(reordered))
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(fingerprint).not.toContain(secret)
    expect(await processSpecFingerprint({ ...left, initialStdin: "other" })).not.toBe(fingerprint)
    expect(processHardTimeoutMs(left)).toBe(2)
    const { terminationGraceMs: _omitted, ...withoutGrace } = left
    expect(() => processHardTimeoutMs(withoutGrace)).toThrow(TypeError)
  })
})

describe("RuntimeProviderRegistry", () => {
  test("resolves explicitly and exposes bounded capability metadata", () => {
    const provider = new MockRuntimeProvider("z-provider")
    const second = new MockRuntimeProvider("a-provider")
    const registry = new RuntimeProviderRegistry([provider, second])

    expect(registry.get("z-provider")).toBe(provider)
    expect(registry.credentialBroker("z-provider")).toBe(provider)
    expect(registry.supportsCredentialMediation("z-provider")).toBeTrue()
    expect(registry.list().map(({ name }) => name)).toEqual(["a-provider", "z-provider"])
    expect(() => registry.get("missing")).toThrow(
      expect.objectContaining({ code: "PROVIDER_NOT_FOUND" }),
    )
    expect(() => new RuntimeProviderRegistry([provider, provider])).toThrow(
      expect.objectContaining({ code: "DUPLICATE_PROVIDER" }),
    )
  })
})
