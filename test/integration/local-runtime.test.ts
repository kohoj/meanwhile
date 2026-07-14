import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalRuntimeProvider } from "../../src/providers/local-provider"
import { RuntimeProviderError, relativePath } from "../../src/providers/runtime-provider"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function localProvider(): Promise<LocalRuntimeProvider> {
  const root = await mkdtemp(join(tmpdir(), "meanwhile-local-provider-"))
  roots.push(root)
  return new LocalRuntimeProvider({
    rootDirectory: root,
    pollIntervalMs: 5,
    stopGraceMs: 100,
    runnerExecutable: globalThis.process.execPath,
  })
}

describe("LocalRuntimeProvider", () => {
  test("executes argv directly and replays stdout and stderr", async () => {
    const provider = await localProvider()
    const runtime = await provider.create({ runtimeId: "run-output" })
    await provider.start(runtime)
    const process = await provider.spawn(runtime, {
      processId: "process-output",
      argv: [
        globalThis.process.execPath,
        "-e",
        'console.log("stdout-frame"); console.error("stderr-diagnostic")',
      ],
      cwd: relativePath("."),
    })

    const events = await Array.fromAsync(provider.events(process, null))
    const exit = await provider.wait(process)
    expect(exit).toMatchObject({ exitCode: 0, signal: null, reason: "exited" })
    expect(events.map(({ stream, data }) => [stream, data]).sort()).toEqual([
      ["stderr", "stderr-diagnostic\n"],
      ["stdout", "stdout-frame\n"],
    ])

    const resumed = await Array.fromAsync(provider.events(process, events[0]?.cursor ?? null))
    expect(resumed.map(({ cursor, stream, data }) => ({ cursor, stream, data }))).toEqual(
      events.slice(1).map(({ cursor, stream, data }) => ({ cursor, stream, data })),
    )
    expect(await Array.fromAsync(provider.events(process, events.at(-1)?.cursor ?? null))).toEqual(
      [],
    )
  })

  test("maps only the provider-neutral runner executable to its host installation", async () => {
    const provider = await localProvider()
    const runtime = await provider.create({ runtimeId: "run-runner-mapping" })
    await provider.start(runtime)
    const process = await provider.spawn(runtime, {
      processId: "process-runner-mapping",
      argv: ["meanwhile-runner", "-e", 'console.log("mapped-runner")'],
      cwd: relativePath("."),
    })

    const events = await Array.fromAsync(provider.events(process, null))
    expect(events.map(({ data }) => data)).toEqual(["mapped-runner\n"])
    expect(await provider.wait(process)).toMatchObject({ exitCode: 0 })
  })

  test("makes packaged companion executables available beside the runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "meanwhile-local-companion-"))
    roots.push(root)
    const bin = join(root, "bin")
    await mkdir(bin)
    await writeFile(join(bin, "meanwhile-companion"), "#!/bin/sh\nprintf companion-path", {
      mode: 0o700,
    })
    const provider = new LocalRuntimeProvider({
      rootDirectory: join(root, "state"),
      runnerExecutable: join(bin, "meanwhile-runner"),
      baseEnvironment: { PATH: "/usr/bin:/bin" },
      pollIntervalMs: 5,
    })
    const runtime = await provider.create({ runtimeId: "run-companion" })
    await provider.start(runtime)
    const process = await provider.spawn(runtime, {
      processId: "process-companion",
      argv: ["meanwhile-companion"],
      cwd: relativePath("."),
    })

    expect((await Array.fromAsync(provider.events(process, null))).map(({ data }) => data)).toEqual(
      ["companion-path"],
    )
    expect(await provider.wait(process)).toMatchObject({ exitCode: 0 })
  })

  test("preserves empty argv values without shell interpretation", async () => {
    const provider = await localProvider()
    const runtime = await provider.create({ runtimeId: "run-empty-argument" })
    await provider.start(runtime)
    const process = await provider.spawn(runtime, {
      processId: "process-empty-argument",
      argv: [
        globalThis.process.execPath,
        "-e",
        'console.log(process.argv.at(-1) === "" ? "empty-preserved" : "changed")',
        "",
      ],
      cwd: relativePath("."),
    })

    expect((await Array.fromAsync(provider.events(process, null))).map(({ data }) => data)).toEqual(
      ["empty-preserved\n"],
    )
  })

  test("writes and reads workspace files without following symlinks", async () => {
    const provider = await localProvider()
    const runtime = await provider.create({ runtimeId: "run-files" })
    await provider.writeFiles(runtime, [
      {
        path: relativePath("dist/index.html"),
        content: new TextEncoder().encode("<h1>Meanwhile</h1>"),
      },
    ])

    expect(
      new TextDecoder().decode(
        await provider.readFile(runtime, relativePath("dist/index.html"), { maxBytes: 1_024 }),
      ),
    ).toBe("<h1>Meanwhile</h1>")
    expect(
      (await provider.listFiles(runtime, relativePath("."), { maxEntries: 100 })).map(
        ({ path, type }) => `${path}:${type}`,
      ),
    ).toEqual(["dist:directory"])

    const root = roots.at(-1)
    if (root === undefined) throw new Error("missing test root")
    await symlink(tmpdir(), join(root, "run-files", "workspace", "escape"))
    await expect(
      provider.readFile(runtime, relativePath("escape/secret"), { maxBytes: 1_024 }),
    ).rejects.toMatchObject({ code: "SYMLINK_NOT_ALLOWED" })
  })

  test("idempotent spawn binds a process identifier to one specification", async () => {
    const provider = await localProvider()
    const runtime = await provider.create({ runtimeId: "run-cancel" })
    await provider.start(runtime)
    const secret = "process-fingerprint-secret"
    const spec = {
      processId: "process-cancel",
      argv: [globalThis.process.execPath, "-e", "setInterval(() => {}, 10_000)"],
      cwd: relativePath("."),
      env: { MODEL_TOKEN: secret },
      initialStdin: `${secret}-stdin`,
    } as const
    const process = await provider.spawn(runtime, spec)
    const duplicate = await provider.spawn(runtime, spec)
    expect(duplicate).toEqual(process)
    await expect(
      provider.spawn(runtime, {
        ...spec,
        argv: [globalThis.process.execPath, "-e", 'throw new Error("must not spawn twice")'],
      }),
    ).rejects.toMatchObject({ code: "PROCESS_CONFLICT", operation: "spawn" })
    const root = roots.at(-1)
    if (root === undefined) throw new Error("missing test root")
    const persisted = await Bun.file(
      join(root, "run-cancel", "processes", "process-cancel", "process.json"),
    ).text()
    expect(persisted).not.toContain(secret)

    await provider.signal(process, "SIGTERM")
    expect(await provider.wait(process)).toMatchObject({ signal: "SIGTERM", reason: "signaled" })
    await provider.destroy(runtime)
    await provider.destroy(runtime)
    expect((await provider.inspect(runtime)).status).toBe("missing")
  })

  test("delivers ordered process input idempotently and binds each sequence once", async () => {
    const provider = await localProvider()
    const runtime = await provider.create({ runtimeId: "session-input" })
    await provider.start(runtime)
    const process = await provider.spawn(runtime, {
      processId: "session-input-process",
      argv: [globalThis.process.execPath, "-e", "setInterval(() => {}, 10_000)"],
      cwd: relativePath("."),
      input: "mailbox",
    })
    const first = {
      sequence: 1,
      id: "70c78f7e-a915-4a4b-a9cb-e805f534f606",
      data: "first",
    }

    await provider.send(process, first)
    await provider.send(process, first)
    await expect(
      provider.send(process, {
        ...first,
        id: "4f9795b2-ac1a-436a-aed8-ef917d2f9566",
        data: "different",
      }),
    ).rejects.toMatchObject({ code: "PROCESS_INPUT_CONFLICT", operation: "send" })

    await provider.signal(process, "SIGTERM")
    await provider.wait(process)
  })

  test("aborting output observation leaves the local process running", async () => {
    const provider = await localProvider()
    const runtime = await provider.create({ runtimeId: "run-observation-abort" })
    await provider.start(runtime)
    const process = await provider.spawn(runtime, {
      processId: "process-observation-abort",
      argv: [
        globalThis.process.execPath,
        "-e",
        'console.log("ready"); setInterval(() => {}, 10_000)',
      ],
      cwd: relativePath("."),
    })
    const controller = new AbortController()
    const stopped = new Error("stop observing")
    const observation = provider.events(process, null, controller.signal)[Symbol.asyncIterator]()

    expect((await observation.next()).value?.data).toBe("ready\n")
    const pending = observation.next()
    controller.abort(stopped)

    await expect(pending).rejects.toBe(stopped)
    expect((await provider.inspectProcess(process)).status).toBe("running")
    await provider.signal(process, "SIGTERM")
    await provider.wait(process)
  })

  test("a new provider instance recovers process identity and replay from disk", async () => {
    const provider = await localProvider()
    const runtime = await provider.create({ runtimeId: "run-recovery" })
    await provider.start(runtime)
    const process = await provider.spawn(runtime, {
      processId: "process-recovery",
      argv: [
        globalThis.process.execPath,
        "-e",
        'console.log("before-reconnect"); setInterval(() => {}, 10_000)',
      ],
      cwd: relativePath("."),
    })
    const eventIterator = provider.events(process, null)[Symbol.asyncIterator]()
    const first = await eventIterator.next()
    expect(first.value?.data).toBe("before-reconnect\n")

    const root = roots.at(-1)
    if (root === undefined) throw new Error("missing test root")
    const recovered = new LocalRuntimeProvider({
      rootDirectory: root,
      pollIntervalMs: 5,
      stopGraceMs: 100,
      runnerExecutable: globalThis.process.execPath,
    })
    expect((await recovered.inspect(runtime)).status).toBe("running")
    expect((await recovered.inspectProcess(process)).status).toBe("running")
    const replayIterator = recovered.events(process, null)[Symbol.asyncIterator]()
    expect((await replayIterator.next()).value?.data).toBe("before-reconnect\n")
    await recovered.signal(process, "SIGTERM")
    expect(await recovered.wait(process)).toMatchObject({ reason: "signaled" })
  })

  test("a process-level timeout has structured terminal evidence", async () => {
    const provider = await localProvider()
    const runtime = await provider.create({ runtimeId: "run-timeout" })
    await provider.start(runtime)
    const process = await provider.spawn(runtime, {
      processId: "process-timeout",
      argv: [globalThis.process.execPath, "-e", "setInterval(() => {}, 10_000)"],
      cwd: relativePath("."),
      timeoutMs: 25,
      terminationGraceMs: 25,
    })

    expect(await provider.wait(process)).toMatchObject({ signal: "SIGKILL", reason: "timed_out" })
  })

  test("stop signals the leader once, then hard-kills its entire process group", async () => {
    const provider = await localProvider()
    const runtime = await provider.create({ runtimeId: "run-process-group-stop" })
    await provider.start(runtime)
    const process = await provider.spawn(runtime, {
      processId: "process-group-stop",
      argv: [globalThis.process.execPath, "-e", processTreeSource()],
      cwd: relativePath("."),
    })

    const iterator = provider.events(process, null)[Symbol.asyncIterator]()
    const grandchildPid = Number((await iterator.next()).value?.data.trim())
    expect(Number.isSafeInteger(grandchildPid)).toBeTrue()

    await provider.stop(runtime)
    expect(await provider.wait(process)).toMatchObject({ signal: "SIGKILL", reason: "signaled" })
    expect(
      new TextDecoder().decode(
        await provider.readFile(runtime, relativePath("term-count"), { maxBytes: 32 }),
      ),
    ).toBe("term\n")
    expect(await processDisappeared(grandchildPid)).toBeTrue()
  })

  test("hard timeout reaps descendants that ignore graceful process lifetime", async () => {
    const provider = await localProvider()
    const runtime = await provider.create({ runtimeId: "run-process-group-timeout" })
    await provider.start(runtime)
    const process = await provider.spawn(runtime, {
      processId: "process-group-timeout",
      argv: [globalThis.process.execPath, "-e", processTreeSource()],
      cwd: relativePath("."),
      timeoutMs: 25,
      terminationGraceMs: 25,
    })

    const grandchildPid = Number(
      (await provider.events(process, null)[Symbol.asyncIterator]().next()).value?.data.trim(),
    )
    expect(await provider.wait(process)).toMatchObject({ signal: "SIGKILL", reason: "timed_out" })
    expect(await processDisappeared(grandchildPid)).toBeTrue()
  })

  test("wrong-provider handles and unsafe paths fail with safe provider errors", async () => {
    const provider = await localProvider()
    const runtime = await provider.create({ runtimeId: "run-boundary" })

    await expect(provider.inspect({ ...runtime, provider: "cloudflare" })).rejects.toBeInstanceOf(
      RuntimeProviderError,
    )
    expect(() => relativePath("../outside")).toThrow(TypeError)
  })

  test("health states plainly that local execution is not isolation", async () => {
    const provider = await localProvider()
    expect(provider.capabilities.isolation).toBe("none")
    expect(await provider.health()).toMatchObject({
      status: "healthy",
      message: expect.stringContaining("no host isolation"),
    })
  })
})

function processTreeSource(): string {
  return `
    const { appendFileSync } = require("node:fs")
    process.on("SIGTERM", () => appendFileSync("term-count", "term\\n"))
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 10_000)"],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore"
    })
    console.log(child.pid)
    setInterval(() => {}, 10_000)
  `
}

async function processDisappeared(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      globalThis.process.kill(pid, 0)
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return true
      throw cause
    }
    await Bun.sleep(5)
  }
  return false
}
