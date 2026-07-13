import { afterEach, describe, expect, test } from "bun:test"
import { type ApplicationHarness, createApplicationHarness } from "../application-harness"

let harness: ApplicationHarness | null = null

afterEach(async () => {
  await harness?.close()
  harness = null
})

describe("uploaded workspace boundary", () => {
  test.each([
    "../escape.txt",
    "/absolute.txt",
    "a/./b.txt",
    "a\\b.txt",
  ])("rejects non-portable path %s before persistence", async (path) => {
    harness = await createApplicationHarness()
    const response = await harness.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace: {
          type: "files",
          files: [{ path, contentBase64: Buffer.from("unsafe").toString("base64") }],
        },
        agentType: "demo",
        prompt: "unsafe",
        env: {},
        secretRefs: {},
        provider: "local",
        artifactPaths: [],
        timeoutMs: 5_000,
      }),
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("INVALID_REQUEST")
    expect(harness.application.store.listClaimableRuns(10)).toHaveLength(0)
    await harness.close()
    harness = null
  })

  test("rejects duplicate paths and malformed base64", async () => {
    harness = await createApplicationHarness()
    const duplicate = await harness.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace: {
          type: "files",
          files: [
            { path: "same.txt", contentBase64: "YQ==" },
            { path: "same.txt", contentBase64: "Yg==" },
          ],
        },
        agentType: "demo",
        prompt: "duplicate",
        provider: "local",
        timeoutMs: 5_000,
      }),
    })
    expect(duplicate.status).toBe(400)

    const malformed = await harness.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace: {
          type: "files",
          files: [{ path: "file.txt", contentBase64: "not base64!" }],
        },
        agentType: "demo",
        prompt: "malformed",
        provider: "local",
        timeoutMs: 5_000,
      }),
    })
    expect(malformed.status).toBe(400)
  })
})
