import { afterEach, describe, expect, test } from "bun:test"
import { type ApplicationHarness, createApplicationHarness } from "../application-harness"

let harness: ApplicationHarness | null = null

afterEach(async () => {
  await harness?.close()
  harness = null
})

describe("structured HTTP errors", () => {
  test("authentication, validation, and missing routes share one safe envelope", async () => {
    harness = await createApplicationHarness()
    const unauthenticated = await Promise.resolve(harness.application.app.request("/runs"))
    expect(unauthenticated.status).toBe(401)
    await expectEnvelope(unauthenticated, "UNAUTHENTICATED")

    const invalid = await harness.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerId: crypto.randomUUID(), prompt: "invalid" }),
    })
    expect(invalid.status).toBe(400)
    const invalidBody = await expectEnvelope(invalid, "INVALID_REQUEST")
    expect(JSON.stringify(invalidBody)).not.toContain("stack")
    expect(JSON.stringify(invalidBody)).not.toContain(harness.directory)

    const malformed = await harness.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"prompt":"Bearer malformed-body-secret",',
    })
    expect(malformed.status).toBe(400)
    const malformedBody = await expectEnvelope(malformed, "INVALID_REQUEST")
    expect(malformedBody.error.message).toBe("Request body is malformed")
    expect(JSON.stringify(malformedBody)).not.toContain("malformed-body-secret")
    expect(JSON.stringify(malformedBody)).not.toContain("stack")

    const missing = await harness.request("/does-not-exist")
    expect(missing.status).toBe(404)
    await expectEnvelope(missing, "NOT_FOUND")
  })
})

const expectEnvelope = async (response: Response, code: string) => {
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string; details: Record<string, unknown> }
  }
  expect(body.error.code).toBe(code)
  expect(body.error.message.length).toBeGreaterThan(0)
  expect(body.error.requestId.length).toBeGreaterThan(0)
  expect(body.error.details).toBeObject()
  return body
}
