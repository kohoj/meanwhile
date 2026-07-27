import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type OciCommandExecutor,
  OciLocalRuntimeProvider,
} from "../../src/providers/oci-local-provider"
import { relativePath } from "../../src/providers/runtime-provider"

const IMAGE = "example.invalid/meanwhile-runtime:fixed"
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createProvider(engine = new FakeOciExecutor()): Promise<{
  provider: OciLocalRuntimeProvider
  engine: FakeOciExecutor
}> {
  const root = await mkdtemp(join(tmpdir(), "meanwhile-oci-provider-"))
  roots.push(root)
  return {
    provider: new OciLocalRuntimeProvider({
      rootDirectory: root,
      imageReference: IMAGE,
      imageDigest: IMAGE_DIGEST,
      commandExecutor: engine,
      pollIntervalMs: 2,
      stopGraceMs: 5,
    }),
    engine,
  }
}

describe("OciLocalRuntimeProvider", () => {
  test("advertises only the isolation it actually enforces", async () => {
    const { provider } = await createProvider()

    expect(provider.capabilities).toEqual({
      isolation: "container",
      processRecovery: true,
      eventReplay: true,
      processInput: false,
      portExposure: false,
      networkPolicy: false,
      credentialMediation: "none",
      processSignals: ["SIGINT", "SIGTERM", "SIGKILL"],
    })
    expect(provider.provenance).toMatchObject({
      runtimeImageReference: IMAGE,
      runtimeImageDigest: IMAGE_DIGEST,
    })
    expect(await provider.health()).toMatchObject({
      status: "healthy",
      message: expect.stringContaining("credential mediation are unavailable"),
    })
  })

  test("creates one hardened no-network container for an idempotent runtime identity", async () => {
    const { provider, engine } = await createProvider()

    const runtime = await provider.create({ runtimeId: "runtime-one" })
    expect(await provider.create({ runtimeId: "runtime-one" })).toEqual(runtime)
    const create = engine.calls.find((argv) => argv[1] === "container" && argv[2] === "create")
    expect(create).toBeDefined()
    for (const value of [
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "no-new-privileges:true",
    ]) {
      expect(create).toContain(value)
    }
    expect(
      engine.calls.filter((argv) => argv[1] === "container" && argv[2] === "create"),
    ).toHaveLength(1)

    await provider.start(runtime)
    expect((await provider.inspect(runtime)).status).toBe("running")
    await provider.stop(runtime)
    expect((await provider.inspect(runtime)).status).toBe("stopped")
    await provider.destroy(runtime)
    await provider.destroy(runtime)
    expect((await provider.inspect(runtime)).status).toBe("missing")
  })

  test("passes process argv directly, replays both streams, and preserves workspace files", async () => {
    const { provider, engine } = await createProvider()
    const runtime = await provider.create({ runtimeId: "runtime-process" })
    await provider.writeFiles(runtime, [
      {
        path: relativePath("input.txt"),
        content: new TextEncoder().encode("workspace-value"),
      },
    ])
    await provider.start(runtime)
    const source = 'console.log("literal ; && $(never)")'
    const process = await provider.spawn(runtime, {
      processId: "process-one",
      argv: ["bun", "--eval", source, ""],
      cwd: relativePath("."),
    })

    const create = engine.calls.find(
      (argv) =>
        argv[1] === "container" &&
        argv[2] === "create" &&
        argv.some((value) => value.includes("process-id=process-one")),
    )
    expect(create).toBeDefined()
    const imageIndex = create?.indexOf(IMAGE) ?? -1
    expect(create?.slice(imageIndex + 1)).toEqual(["--eval", source, ""])
    expect(create?.slice(0, imageIndex)).toContain("--entrypoint")
    expect(create?.slice(0, imageIndex)).toContain("bun")

    const events = await Array.fromAsync(provider.events(process, null))
    expect(events.map(({ stream, data }) => [stream, data])).toEqual([
      ["stdout", "stdout-frame\n"],
      ["stderr", "stderr-frame\n"],
    ])
    expect(await provider.wait(process)).toMatchObject({ exitCode: 0, reason: "exited" })
    expect(
      new TextDecoder().decode(
        await provider.readFile(runtime, relativePath("input.txt"), { maxBytes: 64 }),
      ),
    ).toBe("workspace-value")
    expect(await Array.fromAsync(provider.events(process, events.at(-1)?.cursor ?? null))).toEqual(
      [],
    )
    await provider.destroy(runtime)
  })

  test("binds a process identifier to the complete specification", async () => {
    const { provider } = await createProvider()
    const runtime = await provider.create({ runtimeId: "runtime-conflict" })
    await provider.start(runtime)
    const spec = {
      processId: "process-conflict",
      argv: ["bun", "--eval", "console.log(1)"] as const,
      cwd: relativePath("."),
      env: { PLACEHOLDER: "opaque-value" },
    }

    const process = await provider.spawn(runtime, spec)
    expect(await provider.spawn(runtime, spec)).toEqual(process)
    await expect(
      provider.spawn(runtime, {
        ...spec,
        argv: ["bun", "--eval", "console.log(2)"],
      }),
    ).rejects.toMatchObject({ code: "PROCESS_CONFLICT", operation: "spawn" })
    await provider.destroy(runtime)
  })

  test("passes the accepted spec environment instead of inheriting a same-named host value", async () => {
    const { provider, engine } = await createProvider()
    const runtime = await provider.create({ runtimeId: "runtime-environment" })
    await provider.start(runtime)
    const name = "MEANWHILE_OCI_ENV_COLLISION"
    const original = process.env[name]
    process.env[name] = "host-value-must-not-cross"
    try {
      await provider.spawn(runtime, {
        processId: "process-environment",
        argv: ["bun", "--eval", "console.log(process.env.MEANWHILE_OCI_ENV_COLLISION)"],
        cwd: relativePath("."),
        env: { [name]: "spec-placeholder-value" },
      })

      const environment = engine.createdEnvironments.at(-1)
      expect(environment?.[name]).toBe("spec-placeholder-value")
      expect(environment?.[name]).not.toBe("host-value-must-not-cross")
      const processCreate = engine.calls.find(
        (argv) =>
          argv[1] === "container" &&
          argv[2] === "create" &&
          argv.includes(`${name}=spec-placeholder-value`),
      )
      expect(processCreate).toBeDefined()
      expect(processCreate).not.toContain(name)
      expect(processCreate).not.toContain(`${name}=host-value-must-not-cross`)
    } finally {
      if (original === undefined) delete process.env[name]
      else process.env[name] = original
      await provider.destroy(runtime)
    }
  })

  test("rejects an oversized environment value before invoking the OCI engine", async () => {
    const { provider, engine } = await createProvider()
    const runtime = await provider.create({ runtimeId: "runtime-environment-limit" })
    await provider.start(runtime)
    const createsBefore = engine.calls.filter(
      (argv) => argv[1] === "container" && argv[2] === "create",
    ).length

    await expect(
      provider.spawn(runtime, {
        processId: "process-environment-limit",
        argv: ["bun", "--eval", "console.log(1)"],
        cwd: relativePath("."),
        env: { TOO_LARGE: "x".repeat(64 * 1024 + 1) },
      }),
    ).rejects.toMatchObject({ code: "INVALID_PROCESS_SPEC", operation: "spawn" })
    expect(
      engine.calls.filter((argv) => argv[1] === "container" && argv[2] === "create"),
    ).toHaveLength(createsBefore)
    await provider.destroy(runtime)
  })

  test("records a provider hard timeout as structured terminal evidence", async () => {
    const engine = new FakeOciExecutor({ keepProcessRunning: true })
    const { provider } = await createProvider(engine)
    const runtime = await provider.create({ runtimeId: "runtime-timeout" })
    await provider.start(runtime)
    const process = await provider.spawn(runtime, {
      processId: "process-timeout",
      argv: ["bun", "--eval", "setInterval(() => {}, 10_000)"],
      cwd: relativePath("."),
      timeoutMs: 5,
      terminationGraceMs: 5,
    })

    expect(await provider.wait(process)).toMatchObject({
      exitCode: null,
      signal: "SIGKILL",
      reason: "timed_out",
    })
    await provider.destroy(runtime)
  })
})

interface FakeContainer {
  readonly Config: { readonly Image: string; readonly Labels: Record<string, string> }
  State: {
    Running: boolean
    Status: "created" | "running" | "exited"
    ExitCode: number
    OOMKilled: boolean
    FinishedAt: string
  }
  stdout: string
  stderr: string
}

class FakeOciExecutor implements OciCommandExecutor {
  readonly calls: string[][] = []
  readonly createdEnvironments: Record<string, string>[] = []
  readonly #containers = new Map<string, FakeContainer>()
  readonly #keepProcessRunning: boolean

  constructor(options: { readonly keepProcessRunning?: boolean } = {}) {
    this.#keepProcessRunning = options.keepProcessRunning ?? false
  }

  async run(argv: readonly string[]): Promise<{
    exitCode: number
    stdout: Uint8Array
    stderr: Uint8Array
  }> {
    const call = [...argv]
    this.calls.push(call)
    if (call[1] === "version") return result(0, "29.5.2\n")
    if (call[1] === "image" && call[2] === "inspect") {
      return result(0, JSON.stringify([{ Id: IMAGE_DIGEST }]))
    }
    if (call[1] !== "container") return result(1, "", "unsupported")

    const operation = call[2]
    if (operation === "inspect") {
      const name = call.at(-1) ?? ""
      const container = this.#containers.get(name)
      return container === undefined
        ? result(1, "", `Error: No such container: ${name}`)
        : result(0, JSON.stringify([container]))
    }
    if (operation === "create") {
      const name = argumentAfter(call, "--name")
      if (this.#containers.has(name)) return result(1, "", "name already in use")
      const labels = argumentsAfter(call, "--label").map((label) => label.split("=", 2))
      const environment = Object.fromEntries(
        argumentsAfter(call, "--env").map((entry) => splitEnvironment(entry)),
      )
      this.createdEnvironments.push(environment)
      this.#containers.set(name, {
        Config: { Image: IMAGE, Labels: Object.fromEntries(labels) },
        State: {
          Running: false,
          Status: "created",
          ExitCode: 0,
          OOMKilled: false,
          FinishedAt: "0001-01-01T00:00:00Z",
        },
        stdout: "stdout-frame\n",
        stderr: "stderr-frame\n",
      })
      return result(0, `${name}\n`)
    }
    if (operation === "start") {
      const name = call.at(-1) ?? ""
      this.#start(name)
      return result(0, `${name}\n`)
    }
    if (operation === "stop") {
      const name = call.at(-1) ?? ""
      this.#exit(name, 143)
      return result(0, `${name}\n`)
    }
    if (operation === "kill") {
      const name = call.at(-1) ?? ""
      this.#exit(name, 137)
      return result(0, `${name}\n`)
    }
    if (operation === "rm") {
      this.#containers.delete(call.at(-1) ?? "")
      return result(0)
    }
    if (operation === "logs") {
      const name = call.at(-1) ?? ""
      const container = this.#containers.get(name)
      if (container === undefined) return result(1, "", "No such container")
      return result(0, container.stdout, container.stderr)
    }
    return result(1, "", `unsupported container operation: ${operation}`)
  }

  async startAttached(argv: readonly string[], _initialStdin: string): Promise<void> {
    const call = [...argv]
    this.calls.push(call)
    this.#start(call.at(-1) ?? "")
  }

  #start(name: string): void {
    const container = this.#containers.get(name)
    if (container === undefined) throw new Error("missing fake container")
    const isProcess = container.Config.Labels["dev.meanwhile.oci-local.kind"] === "process"
    if (isProcess && !this.#keepProcessRunning) {
      this.#exit(name, 0)
      return
    }
    container.State = { ...container.State, Running: true, Status: "running" }
  }

  #exit(name: string, exitCode: number): void {
    const container = this.#containers.get(name)
    if (container === undefined) throw new Error("missing fake container")
    container.State = {
      ...container.State,
      Running: false,
      Status: "exited",
      ExitCode: exitCode,
      FinishedAt: new Date().toISOString(),
    }
  }
}

function result(exitCode: number, stdout = "", stderr = "") {
  return {
    exitCode,
    stdout: new TextEncoder().encode(stdout),
    stderr: new TextEncoder().encode(stderr),
  }
}

function argumentAfter(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag)
  const value = argv[index + 1]
  if (index < 0 || value === undefined) throw new Error(`missing ${flag}`)
  return value
}

function argumentsAfter(argv: readonly string[], flag: string): string[] {
  const result: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag && argv[index + 1] !== undefined)
      result.push(argv[index + 1] as string)
  }
  return result
}

function splitEnvironment(value: string): [string, string] {
  const separator = value.indexOf("=")
  return separator < 1 ? [value, ""] : [value.slice(0, separator), value.slice(separator + 1)]
}
