import { describe, expect, test } from "bun:test"
import { cloudflareClaudeHosts } from "../../scripts/agent-toolchains"

describe("Cloudflare agent toolchain policy", () => {
  test("binds one Claude authentication authority to one exact destination", () => {
    expect(cloudflareClaudeHosts({}, { ANTHROPIC_API_KEY: "env://ANTHROPIC_API_KEY" })).toEqual([
      "api.anthropic.com",
    ])
    expect(
      cloudflareClaudeHosts(
        { ANTHROPIC_BASE_URL: "https://gateway.example.com/v1" },
        { ANTHROPIC_AUTH_TOKEN: "env://ANTHROPIC_AUTH_TOKEN" },
      ),
    ).toEqual(["gateway.example.com"])
    expect(
      cloudflareClaudeHosts(
        { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-west-2" },
        { AWS_BEARER_TOKEN_BEDROCK: "env://AWS_BEARER_TOKEN_BEDROCK" },
      ),
    ).toEqual(["bedrock-runtime.us-west-2.amazonaws.com"])
  })

  test("rejects mixed, discovered, and file-backed authorities", () => {
    expect(() =>
      cloudflareClaudeHosts(
        {},
        {
          ANTHROPIC_API_KEY: "env://ANTHROPIC_API_KEY",
          AWS_BEARER_TOKEN_BEDROCK: "env://AWS_BEARER_TOKEN_BEDROCK",
        },
      ),
    ).toThrow(expect.objectContaining({ code: "CLAUDE_AUTH_AMBIGUOUS" }))
    expect(() =>
      cloudflareClaudeHosts(
        { CLAUDE_CODE_USE_VERTEX: "1" },
        { GOOGLE_APPLICATION_CREDENTIALS: "env://GOOGLE_APPLICATION_CREDENTIALS" },
      ),
    ).toThrow(expect.objectContaining({ code: "CLAUDE_AUTH_UNSUPPORTED" }))
    expect(() =>
      cloudflareClaudeHosts(
        {
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_REGION: "us-west-2",
          ANTHROPIC_BASE_URL: "https://gateway.example.com",
        },
        { AWS_BEARER_TOKEN_BEDROCK: "env://AWS_BEARER_TOKEN_BEDROCK" },
      ),
    ).toThrow(expect.objectContaining({ code: "CLAUDE_AUTH_AMBIGUOUS" }))
  })
})
