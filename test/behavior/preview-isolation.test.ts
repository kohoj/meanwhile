import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256 } from "../../src/artifacts/artifact-store"
import type { ImmutableDeploymentSource } from "../../src/deployments/deploy-adapter"
import { LocalStaticAdapter } from "../../src/deployments/local-static-adapter"
import { LocalStaticServer } from "../../src/deployments/local-static-server"

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

describe("local preview isolation", () => {
  test("publishes a configured browser origin instead of a wildcard bind address", async () => {
    const root = await mkdtemp(join(tmpdir(), "meanwhile-public-preview-"))
    expect(() => new LocalStaticServer({ root, hostname: "0.0.0.0" })).toThrow(
      "public preview origin",
    )

    const server = new LocalStaticServer({
      root,
      hostname: "0.0.0.0",
      publicOrigin: "https://previews.example.test/",
    })
    disposals.push(async () => {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    })

    expect(server.start().origin).toBe("https://previews.example.test")
    expect(server.origin).toBe("https://previews.example.test")
    expect(server.deploymentUrl("deployment_0123456789")).toBe(
      "https://previews.example.test/d/deployment_0123456789/",
    )
  })

  test("serves untrusted output on a separate origin with defensive headers", async () => {
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("authenticated control plane"),
    })
    const { server, result } = await publishPreview()
    disposals.push(async () => {
      await api.stop(true)
    })

    expect(new URL(result.url).origin).not.toBe(api.url.origin)
    const response = await fetch(result.url)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("<!doctype html><h1>Preview</h1>")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(response.headers.get("permissions-policy")).toContain("camera=()")
    expect(response.headers.get("content-security-policy")).toContain("object-src 'none'")
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(server.origin).toBe(new URL(result.url).origin)
  })

  test("exposes no control-plane or internal manifest routes", async () => {
    const { result } = await publishPreview()
    const base = new URL(result.url)

    expect((await fetch(new URL("/healthz", base))).status).toBe(404)
    expect((await fetch(new URL("manifest.json", result.url))).status).toBe(404)
    expect(
      (await fetch(`${base.origin}/d/deployment_0123456789/%2e%2e%2fmanifest.json`)).status,
    ).toBe(404)

    const method = await fetch(result.url, { method: "POST" })
    expect(method.status).toBe(405)
    expect(method.headers.get("allow")).toBe("GET, HEAD")
  })

  test("refuses a symlink introduced after publication", async () => {
    const { root, result } = await publishPreview()
    const outside = join(root, "outside.txt")
    await writeFile(outside, "not public")
    await symlink(outside, join(root, "deployment_0123456789", "public", "leak.txt"))

    expect((await fetch(new URL("leak.txt", result.url))).status).toBe(404)
  })
})

async function publishPreview() {
  const root = await mkdtemp(join(tmpdir(), "meanwhile-isolation-"))
  const server = new LocalStaticServer({ root })
  const adapter = new LocalStaticAdapter(server)
  disposals.push(async () => {
    await server.stop()
    await rm(root, { recursive: true, force: true })
  })
  const result = await adapter.deploy(
    {
      deploymentId: "deployment_0123456789",
      source: sourceFrom({
        "index.html": "<!doctype html><h1>Preview</h1>",
      }),
      target: { name: "local-static", config: {} },
      secrets: {},
    },
    {
      signal: new AbortController().signal,
      async emit() {},
    },
  )
  return { root, server, result }
}

function sourceFrom(files: Readonly<Record<string, string>>): ImmutableDeploymentSource {
  const values = new Map<string, Uint8Array>()
  const entries = Object.entries(files).map(([path, content]) => {
    const bytes = new TextEncoder().encode(content)
    values.set(path, bytes)
    const digest = sha256(bytes)
    return {
      path,
      mediaType: "text/html; charset=utf-8",
      blob: { storageKey: `fixture/${digest}`, digest, size: bytes.byteLength },
    }
  })
  const manifestDigest = sha256(new TextEncoder().encode(JSON.stringify(entries)))
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
