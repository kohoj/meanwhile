import { describe, expect, test } from "bun:test"

describe("Project Watch packaging", () => {
  test("ships the Board and its workspace dependencies in the production image", async () => {
    const dockerfile = await Bun.file(new URL("../../Dockerfile", import.meta.url)).text()

    expect(dockerfile).toContain("FROM runner AS board")
    expect(dockerfile).toContain("RUN bun run --cwd board build")
    expect(dockerfile).toContain("COPY --from=dependencies /app/board/node_modules")
    expect(dockerfile).toContain("COPY --from=board /app/board/dist ./board/dist")
    expect(dockerfile).toContain("EXPOSE 7331 7332 7333")
  })

  test("keeps Project Watch stateless and the control plane private in Compose", async () => {
    const compose = await Bun.file(new URL("../../compose.yaml", import.meta.url)).text()
    const projectWatch = compose.slice(compose.indexOf("  project-watch:"))

    expect(projectWatch).toContain('command: ["bun", "board/src/main.ts"]')
    expect(projectWatch).toContain("MEANWHILE_URL: http://meanwhile:7331")
    expect(projectWatch).toContain('"127.0.0.1:7333:7333"')
    expect(projectWatch).not.toContain("MEANWHILE_API_KEY")
    expect(compose).toContain('"127.0.0.1:7331:7331"')
    expect(compose).toContain('"127.0.0.1:7332:7332"')
  })
})
