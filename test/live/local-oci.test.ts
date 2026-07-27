import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { OciLocalRuntimeProvider } from "../../src/providers/oci-local-provider"
import { type RuntimeHandle, relativePath } from "../../src/providers/runtime-provider"

const live = process.env["MEANWHILE_LIVE_LOCAL_OCI"] === "1"

test.skipIf(!live)(
  "executes and replays a real local OCI sandbox through Docker or Colima",
  async () => {
    const root = await mkdtemp(join(homedir(), ".meanwhile-oci-live-"))
    const provider = new OciLocalRuntimeProvider({
      rootDirectory: root,
      imageReference: process.env["MEANWHILE_LOCAL_OCI_IMAGE"] ?? "oven/bun:1.3.13-slim",
      pollIntervalMs: 20,
      stopGraceMs: 250,
    })
    let runtime: RuntimeHandle | null = null
    try {
      runtime = await provider.create({ runtimeId: "live-runtime" })
      await provider.writeFiles(runtime, [
        {
          path: relativePath("input.txt"),
          content: new TextEncoder().encode("workspace-ok"),
        },
      ])
      await provider.start(runtime)
      const process = await provider.spawn(runtime, {
        processId: "live-process",
        argv: [
          "bun",
          "--eval",
          'console.log(await Bun.file("input.txt").text()); console.error("stderr-ok")',
        ],
        cwd: relativePath("."),
      })

      const events = await Array.fromAsync(provider.events(process, null))
      expect(events.map(({ stream, data }) => [stream, data])).toEqual([
        ["stdout", "workspace-ok\n"],
        ["stderr", "stderr-ok\n"],
      ])
      expect(await provider.wait(process)).toMatchObject({ exitCode: 0, reason: "exited" })

      const stdinProcess = await provider.spawn(runtime, {
        processId: "live-stdin-process",
        argv: ["bun", "--eval", 'console.log("stdin:" + (await Bun.stdin.text()))'],
        cwd: relativePath("."),
        initialStdin: "runner-spec",
      })
      expect(
        (await Array.fromAsync(provider.events(stdinProcess, null))).map(({ data }) => data),
      ).toEqual(["stdin:runner-spec\n"])
      expect(await provider.wait(stdinProcess)).toMatchObject({ exitCode: 0, reason: "exited" })
    } finally {
      if (runtime !== null) await provider.destroy(runtime).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)
