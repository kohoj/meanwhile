import { describe, expect, test } from "bun:test"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { AgentCatalog } from "../../src/agents/catalog"

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const markdownFiles = [
  "AGENTS.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "README.md",
  "SECURITY.md",
  "docs/architecture.md",
  "docs/operations.md",
  "docs/project-collaboration.md",
  "docs/provider-contract.md",
  "docs/threat-model.md",
] as const

describe("living documentation", () => {
  test("keeps local links resolvable and JSON examples executable", async () => {
    for (const relativePath of markdownFiles) {
      const absolutePath = join(root, relativePath)
      const markdown = await Bun.file(absolutePath).text()

      for (const match of markdown.matchAll(/```json\n([\s\S]*?)\n```/g)) {
        expect(() => JSON.parse(requiredCapture(match[1], relativePath))).not.toThrow()
      }

      for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = requiredCapture(match[1], relativePath).trim()
        if (/^(?:[a-z]+:|#)/i.test(target)) continue
        const path = decodeURIComponent(target.split("#", 1)[0] ?? "")
        expect(await Bun.file(resolve(dirname(absolutePath), path)).exists()).toBeTrue()
      }
    }
  })

  test("keeps the documented agent catalog loadable by the production parser", async () => {
    const catalog = await AgentCatalog.load(join(root, "docs/agents.example.json"))
    expect(catalog.list()).toEqual(["claude-code", "codex", "hermes", "pi"])
  })

  test("keeps the packaged data root beneath its writable ownership volume", async () => {
    const dockerfile = await Bun.file(join(root, "Dockerfile")).text()
    const compose = await Bun.file(join(root, "compose.yaml")).text()

    expect(dockerfile).toContain("MEANWHILE_DATA_DIR=/data/state")
    expect(dockerfile).toContain('VOLUME ["/data"]')
    expect(compose).toContain("MEANWHILE_DATA_DIR: /data/state")
    expect(compose).toContain("- meanwhile-data:/data")
  })
})

function requiredCapture(value: string | undefined, source: string): string {
  if (value === undefined) throw new Error(`Documentation parser failed for ${source}`)
  return value
}
