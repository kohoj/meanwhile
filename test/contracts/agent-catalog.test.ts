import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { AgentCatalog } from "../../src/agents/catalog"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("agent launch catalog", () => {
  test("the shipped catalog advertises only its bundled runnable agent", async () => {
    const catalog = await AgentCatalog.load(resolve("config/agents.json"))

    expect(catalog.list()).toEqual(["demo"])
    expect(catalog.resolve("demo").executable).toBe("meanwhile-demo-agent")
  })

  test("rejects unknown fields at every catalog object boundary", async () => {
    for (const mutate of [
      (catalog: CatalogJson) => Object.assign(catalog, { unexpected: true }),
      (catalog: CatalogJson) => Object.assign(catalog.agents.fixture, { unexpected: true }),
      (catalog: CatalogJson) =>
        Object.assign(catalog.agents.fixture.capabilities, { unexpected: true }),
    ]) {
      const catalog = validCatalog()
      mutate(catalog)
      await expect(loadTemporaryCatalog(catalog)).rejects.toThrow("Agent catalog is invalid")
    }
  })

  test("accepts only a bare portable PATH executable", async () => {
    for (const executable of [
      "/opt/bin/agent",
      "./agent",
      "bin/agent",
      "bin\\agent",
      "../agent",
      "agent command",
    ]) {
      const catalog = validCatalog()
      catalog.agents.fixture.executable = executable
      await expect(loadTemporaryCatalog(catalog)).rejects.toMatchObject({
        details: {
          issues: expect.stringContaining("Executable must be a bare, portable PATH name"),
        },
      })
    }
  })

  test("derives least-privilege permission policy from declared capabilities", async () => {
    const catalogJson = validCatalog()
    catalogJson.agents["terminal-only"] = {
      ...catalogJson.agents.fixture,
      capabilities: { filesystem: false, terminal: true },
    }
    catalogJson.agents["no-tools"] = {
      ...catalogJson.agents.fixture,
      capabilities: { filesystem: false, terminal: false },
    }
    const catalog = await loadTemporaryCatalog(catalogJson)

    expect(catalog.resolveIntent("fixture", {}, {}).agentSpec.permissionPolicy).toEqual({
      mode: "allow-once",
      toolKinds: ["read", "edit", "delete", "move", "search"],
    })
    expect(catalog.resolveIntent("terminal-only", {}, {}).agentSpec.permissionPolicy).toEqual({
      mode: "allow-once",
      toolKinds: ["execute"],
    })
    expect(catalog.resolveIntent("no-tools", {}, {}).agentSpec.permissionPolicy).toEqual({
      mode: "deny-all",
    })
    const filesystemPolicy = catalog.resolveIntent("fixture", {}, {}).agentSpec.permissionPolicy
    expect(filesystemPolicy.mode).toBe("allow-once")
    if (filesystemPolicy.mode !== "allow-once") throw new Error("Expected allow-once policy")
    expect(filesystemPolicy.toolKinds).not.toContain("execute")
  })

  test("produces canonical catalog and definition digests", async () => {
    const left = validCatalog()
    const right = {
      agents: {
        fixture: {
          credentials: left.agents.fixture.credentials,
          networkPolicy: left.agents.fixture.networkPolicy,
          envNames: left.agents.fixture.envNames,
          capabilities: {
            terminal: left.agents.fixture.capabilities.terminal,
            filesystem: left.agents.fixture.capabilities.filesystem,
          },
          workingDirectory: left.agents.fixture.workingDirectory,
          args: left.agents.fixture.args,
          executable: left.agents.fixture.executable,
          transport: left.agents.fixture.transport,
        },
      },
      version: 1 as const,
    }

    const leftCatalog = await loadTemporaryCatalog(left)
    const rightCatalog = await loadTemporaryCatalog(right)
    const leftIntent = leftCatalog.resolveIntent("fixture", {}, {})
    const rightIntent = rightCatalog.resolveIntent("fixture", {}, {})

    expect(leftCatalog.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(leftCatalog.digest).toBe(rightCatalog.digest)
    expect(leftIntent.agentSpec.definitionDigest).toBe(rightIntent.agentSpec.definitionDigest)
  })
})

interface CatalogJson {
  version: 1
  agents: { fixture: AgentJson } & Record<string, AgentJson>
}

interface AgentJson {
  transport: "stdio"
  executable: string
  args: string[]
  workingDirectory: "workspace"
  capabilities: { filesystem: boolean; terminal: boolean }
  envNames: string[]
  networkPolicy: { allowedHosts: string[] }
  credentials: Array<{
    environmentVariable: string
    host: string
    methods: Array<"POST">
  }>
}

function validCatalog(): CatalogJson {
  return {
    version: 1,
    agents: {
      fixture: {
        transport: "stdio",
        executable: "fixture-acp",
        args: [],
        workingDirectory: "workspace",
        capabilities: { filesystem: true, terminal: false },
        envNames: [],
        networkPolicy: { allowedHosts: [] },
        credentials: [],
      },
    },
  }
}

async function loadTemporaryCatalog(catalog: unknown): Promise<AgentCatalog> {
  const directory = await mkdtemp(join(tmpdir(), "meanwhile-agent-catalog-"))
  directories.push(directory)
  const path = join(directory, "agents.json")
  await writeFile(path, JSON.stringify(catalog))
  return AgentCatalog.load(path)
}
