import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256 } from "../../src/artifacts/artifact-store"
import {
  type DeployAdapter,
  DeployAdapterError,
  type DeployInput,
  type DeploymentAdapterEvent,
  type ImmutableDeploymentSource,
} from "../../src/deployments/deploy-adapter"
import { LocalStaticAdapter } from "../../src/deployments/local-static-adapter"
import { LocalStaticServer } from "../../src/deployments/local-static-server"
import { DeployAdapterRegistry, DeployRegistryError } from "../../src/deployments/registry"

interface AdapterHarness {
  adapter: DeployAdapter
  input: DeployInput
}

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()))
})

export function deployAdapterContract(name: string, create: () => Promise<AdapterHarness>): void {
  describe(`${name} deploy adapter contract`, () => {
    test("publishes immutable source and reports ordered evidence", async () => {
      const { adapter, input } = await create()
      const events: DeploymentAdapterEvent[] = []
      const result = await adapter.deploy(input, {
        signal: new AbortController().signal,
        async emit(event) {
          events.push(event)
        },
      })

      expect(result.url.startsWith("http://127.0.0.1:")).toBe(true)
      expect(result.previewUrl).toBe(result.url)
      expect(events.map((event) => event.event)).toEqual([
        "deployment.local_static.materializing",
        "deployment.local_static.published",
      ])
      expect(await (await fetch(result.url)).text()).toBe("<h1>Meanwhile</h1>")
    })

    test("is idempotent for the same deployment and immutable source", async () => {
      const { adapter, input } = await create()
      const first = await adapter.deploy(input, silentContext())
      const events: DeploymentAdapterEvent[] = []
      const second = await adapter.deploy(input, {
        signal: new AbortController().signal,
        async emit(event) {
          events.push(event)
        },
      })

      expect(second).toEqual(first)
      expect(events.map((event) => event.event)).toEqual(["deployment.local_static.reused"])
    })

    test("honors cancellation before materialization", async () => {
      const { adapter, input } = await create()
      const controller = new AbortController()
      controller.abort()

      await expect(
        adapter.deploy(input, {
          signal: controller.signal,
          async emit() {},
        }),
      ).rejects.toMatchObject({ code: "DEPLOYMENT_ABORTED" })
    })
  })
}

deployAdapterContract("local-static", createLocalHarness)

describe("local-static source validation", () => {
  test("rejects all target configuration before persistence", async () => {
    const { adapter } = await createLocalHarness()
    expect(() => adapter.validate({ token: "must-be-a-secret-ref" })).toThrow(DeployAdapterError)
  })

  test("rejects traversal-shaped paths", async () => {
    const { adapter, input } = await createLocalHarness()
    const source = sourceFrom({ "../outside.txt": "escape" })

    await expect(adapter.deploy({ ...input, source }, silentContext())).rejects.toMatchObject({
      code: "DEPLOYMENT_SOURCE_INVALID",
    })
  })

  test("rejects bytes that do not match immutable metadata", async () => {
    const { adapter, input } = await createLocalHarness()
    const source = sourceFrom({ "index.html": "trusted" })
    const mismatched: ImmutableDeploymentSource = {
      ...source,
      async read() {
        return new TextEncoder().encode("changed")
      },
    }

    await expect(
      adapter.deploy({ ...input, source: mismatched }, silentContext()),
    ).rejects.toMatchObject({ code: "DEPLOYMENT_SOURCE_INVALID" })
  })

  test("rejects paths that collide on common local filesystems", async () => {
    const { adapter, input } = await createLocalHarness()
    const source = sourceFrom({ "Index.html": "one", "index.html": "two" })

    await expect(adapter.deploy({ ...input, source }, silentContext())).rejects.toMatchObject({
      code: "DEPLOYMENT_SOURCE_INVALID",
    })
  })

  test("does not allow a deployment identity to be rebound", async () => {
    const { adapter, input } = await createLocalHarness()
    await adapter.deploy(input, silentContext())

    await expect(
      adapter.deploy({ ...input, source: sourceFrom({ "index.html": "other" }) }, silentContext()),
    ).rejects.toBeInstanceOf(DeployAdapterError)
  })
})

describe("deploy adapter registry", () => {
  test("resolves explicitly registered targets", async () => {
    const { adapter } = await createLocalHarness()
    const registry = new DeployAdapterRegistry([adapter])
    expect(registry.names()).toEqual(["local-static"])
    expect(registry.get("local-static")).toBe(adapter)
  })

  test("rejects duplicate and absent targets", async () => {
    const { adapter } = await createLocalHarness()
    expect(() => new DeployAdapterRegistry([adapter, adapter])).toThrow(DeployRegistryError)
    expect(() => new DeployAdapterRegistry([]).get("missing")).toThrow(DeployRegistryError)
  })
})

async function createLocalHarness(): Promise<AdapterHarness> {
  const root = await mkdtemp(join(tmpdir(), "meanwhile-preview-"))
  const server = new LocalStaticServer({ root })
  const adapter = new LocalStaticAdapter(server)
  cleanup.push(async () => {
    await server.stop()
    await rm(root, { recursive: true, force: true })
  })
  return {
    adapter,
    input: {
      deploymentId: "deployment_0123456789abcdef",
      source: sourceFrom({ "index.html": "<h1>Meanwhile</h1>" }),
      target: { name: "local-static", config: {} },
      secrets: {},
    },
  }
}

function sourceFrom(files: Readonly<Record<string, string>>): ImmutableDeploymentSource {
  const encoder = new TextEncoder()
  const values = new Map<string, Uint8Array>()
  const entries = Object.entries(files)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, value]) => {
      const bytes = encoder.encode(value)
      values.set(path, bytes)
      return {
        path,
        mediaType: path.endsWith(".html")
          ? "text/html; charset=utf-8"
          : "text/plain; charset=utf-8",
        blob: {
          storageKey: `fixture/${sha256(bytes)}`,
          digest: sha256(bytes),
          size: bytes.byteLength,
        },
      }
    })
  const manifestDigest = sha256(
    encoder.encode(JSON.stringify(entries.map(({ path, blob }) => ({ path, ...blob })))),
  )
  return {
    artifactId: manifestDigest,
    manifestDigest,
    logicalPath: "dist",
    entries,
    async read(entry) {
      const bytes = values.get(entry.path)
      if (bytes === undefined) throw new Error("Missing fixture bytes.")
      return bytes
    },
  }
}

function silentContext() {
  return {
    signal: new AbortController().signal,
    async emit() {},
  }
}
