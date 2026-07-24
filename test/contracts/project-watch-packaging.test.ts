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

  test("keeps Project Watch stateless and host ports loopback-only in Compose", async () => {
    const compose = await Bun.file(new URL("../../compose.yaml", import.meta.url)).text()
    const projectWatch = compose.slice(compose.indexOf("  project-watch:"))
    const composeVariable = (name: string, fallback: number) => `\${${name}:-${fallback}}`

    expect(projectWatch).toContain('command: ["bun", "board/src/main.ts"]')
    expect(projectWatch).toContain("MEANWHILE_URL: http://meanwhile:7331")
    expect(projectWatch).toContain(
      `"127.0.0.1:${composeVariable("MEANWHILE_BOARD_HOST_PORT", 7333)}:7333"`,
    )
    expect(projectWatch).not.toContain("MEANWHILE_API_KEY")
    expect(compose).toContain(
      `"127.0.0.1:${composeVariable("MEANWHILE_CONTROL_PLANE_HOST_PORT", 7331)}:7331"`,
    )
    expect(compose).toContain(
      `"127.0.0.1:${composeVariable("MEANWHILE_PREVIEW_HOST_PORT", 7332)}:7332"`,
    )
  })

  test("offers a secret-file Cloudflare Tunnel overlay without publishing preview bytes", async () => {
    const tunnel = await Bun.file(
      new URL("../../compose.cloudflare-tunnel.yaml", import.meta.url),
    ).text()

    expect(tunnel).toContain("cloudflare/cloudflared:2026.3.0@sha256:")
    expect(tunnel).toContain("/run/secrets/cloudflare-tunnel-token")
    expect(tunnel).toContain("CLOUDFLARE_TUNNEL_TOKEN_FILE")
    expect(tunnel).toContain("read_only: true")
    expect(tunnel).toContain("no-new-privileges:true")
    expect(tunnel).not.toContain("7332")
  })
})
