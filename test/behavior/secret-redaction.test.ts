import { afterEach, describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import {
  EnvironmentSecretResolver,
  REDACTED_VALUE,
  SecretRedactor,
  SecretResolutionError,
} from "../../src/secrets"
import { type ApplicationHarness, createApplicationHarness } from "../application-harness"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const resolutionScope = (ownerId: string, purpose: "agent" | "repository" | "deployment") => ({
  ownerId,
  purpose,
  resourceType: purpose === "deployment" ? ("deployment" as const) : ("run" as const),
  resourceId: "resource-a",
})

describe("secret boundary", () => {
  test("resolves only env references and constructs redaction before output", () => {
    const resolver = new EnvironmentSecretResolver({
      source: {
        get(name) {
          return name === "OPENAI_API_KEY" ? "token-value-123" : undefined
        },
      },
      allowedSourceNames: ["OPENAI_API_KEY"],
      allowedOwnerIds: ["owner-a"],
    })

    const resolved = resolver.resolve(
      { OPENAI_API_KEY: "env://OPENAI_API_KEY" },
      resolutionScope("owner-a", "agent"),
    )

    expect(resolved.environment).toEqual({ OPENAI_API_KEY: "token-value-123" })
    expect(
      resolved.redactor.redactString("agent said token-value-123 twice: token-value-123"),
    ).toBe(`agent said ${REDACTED_VALUE} twice: ${REDACTED_VALUE}`)

    resolved.release()
    resolved.release()
    expect(Object.keys(resolved.environment)).toEqual([])
    expect(() => resolved.redactor.redactString("anything")).toThrow("disposed")
  })

  test("missing and malformed references fail without exposing another value", () => {
    const resolver = new EnvironmentSecretResolver({
      source: { get: () => undefined },
      allowedSourceNames: ["ABSENT"],
      allowedOwnerIds: ["owner-a"],
    })

    expect(() =>
      resolver.resolve({ TOKEN: "literal-secret" }, resolutionScope("owner-a", "agent")),
    ).toThrow(
      new SecretResolutionError(
        "INVALID_SECRET_REFERENCE",
        "Secret reference for TOKEN must use env://NAME",
      ),
    )
    expect(() =>
      resolver.resolve({ ABSENT: "env://ABSENT" }, resolutionScope("owner-a", "agent")),
    ).toThrow("env://ABSENT is not configured")
    expect(() =>
      resolver.resolve(
        { ABSENT: "env://ABSENT" },
        { ...resolutionScope("owner-a", "agent"), resourceId: "" },
      ),
    ).toThrow("durable resource identity")
  })

  test("is deny-all by default and never catalogs reserved control-plane sources", () => {
    const denied = new EnvironmentSecretResolver({
      source: { get: () => "must-not-be-read" },
      allowedOwnerIds: ["owner-a"],
    })
    expect(() =>
      denied.validate(
        { OPENAI_API_KEY: "env://OPENAI_API_KEY" },
        { ownerId: "owner-a", purpose: "agent" },
      ),
    ).toThrow("not in the configured secret catalog")
    expect(
      () =>
        new EnvironmentSecretResolver({
          source: { get: () => "must-not-be-read" },
          allowedSourceNames: ["CLOUDFLARE_BRIDGE_TOKEN"],
          allowedOwnerIds: ["owner-a"],
        }),
    ).toThrow("reserved")
  })

  test("binds process-environment secrets to owner, purpose, and target", () => {
    let reads = 0
    const resolver = new EnvironmentSecretResolver({
      source: {
        get: () => {
          reads += 1
          return "platform-deploy-value"
        },
      },
      allowedSourceNames: ["FLY_API_TOKEN"],
      allowedOwnerIds: ["owner-a"],
    })

    expect(() =>
      resolver.resolve(
        { FLY_API_TOKEN: "env://FLY_API_TOKEN" },
        resolutionScope("owner-b", "deployment"),
      ),
    ).toThrow("authenticated owner")
    expect(() =>
      resolver.resolve(
        { OPENAI_API_KEY: "env://FLY_API_TOKEN" },
        resolutionScope("owner-a", "agent"),
      ),
    ).toThrow("must reference env://OPENAI_API_KEY")
    expect(reads).toBe(0)
  })

  test("redacts strings, bytes, object keys, nested errors, and cycles", () => {
    const redactor = new SecretRedactor(["long-secret", "secret"])
    const cyclic: {
      message: string
      bytes: Uint8Array
      error: Error
      "secret-key": string
      self?: unknown
    } = {
      message: "long-secret",
      bytes: encoder.encode("before secret after"),
      error: new Error("failed with secret"),
      "secret-key": "safe",
    }
    cyclic.self = cyclic

    const result = redactor.redact(cyclic) as {
      message: unknown
      bytes: unknown
      error: unknown
      self: unknown
      [key: string]: unknown
    }

    expect(result.message).toBe(REDACTED_VALUE)
    expect(decoder.decode(result.bytes as Uint8Array)).toBe(`before ${REDACTED_VALUE} after`)
    expect(result[`${REDACTED_VALUE}-key`]).toBe("safe")
    expect(result.error).toEqual({
      name: "Error",
      message: `failed with ${REDACTED_VALUE}`,
    })
    expect(result.self).toBe("[Circular]")
    expect(redactor.contains(cyclic)).toBe(true)
    expect(redactor.contains({ message: "safe" })).toBe(false)
  })

  test("redacts a value split across arbitrary stream chunks", () => {
    const redactor = new SecretRedactor(["top-secret"])
    const stream = redactor.createByteStream()
    const output = [
      stream.push(encoder.encode("before top-")),
      stream.push(encoder.encode("sec")),
      stream.push(encoder.encode("ret after")),
      stream.finish(),
    ]

    expect(decoder.decode(join(output))).toBe(`before ${REDACTED_VALUE} after`)
  })

  test("never emits a configured value that overlaps the redaction marker", () => {
    const redactor = new SecretRedactor(["REDACTED"])
    const stream = redactor.createByteStream()
    const output = join([
      stream.push(encoder.encode("before RED")),
      stream.push(encoder.encode("ACTED after")),
      stream.finish(),
    ])

    expect(redactor.redactString("REDACTED")).not.toContain("REDACTED")
    expect(decoder.decode(output)).not.toContain("REDACTED")
  })

  test("rejects empty patterns rather than redacting every boundary", () => {
    expect(() => new SecretRedactor([""])).toThrow(
      new SecretResolutionError("EMPTY_SECRET", "An empty value cannot be registered as a secret"),
    )
  })
})

describe("end-to-end secret boundary", () => {
  let harness: ApplicationHarness | null = null
  const sourceName = "TEST_RUNNER_SECRET"
  const original = Bun.env[sourceName]

  afterEach(async () => {
    await harness?.close()
    harness = null
    if (original === undefined) delete Bun.env[sourceName]
    else Bun.env[sourceName] = original
  })

  test("rejects agent credentials before durable intent on a runtime without mediation", async () => {
    const secret = `local-runtime-secret-${crypto.randomUUID()}`
    Bun.env[sourceName] = secret
    harness = await createApplicationHarness()
    const ownerId = "00000000-0000-4000-8000-000000000001"
    const auditBefore = harness.application.store.listAudit(ownerId)
    const response = await harness.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        workspace: {
          type: "files",
          files: [
            {
              path: "README.md",
              contentBase64: encoder.encode("credential admission").toBase64(),
            },
          ],
        },
        agentType: "demo",
        prompt: "Attempt local execution with a credential",
        env: {},
        secretRefs: { TEST_RUNNER_SECRET: `env://${sourceName}` },
        provider: "local",
        artifactPaths: [],
        timeoutMs: 5_000,
      }),
    })
    expect(response.status).toBe(422)
    const body = await response.json()
    expect(body).toMatchObject({ error: { code: "PROVIDER_CAPABILITY_UNAVAILABLE" } })
    expect(JSON.stringify(body)).not.toContain(secret)

    expect(harness.application.store.listRuns(ownerId, { limit: 100 }).items).toEqual([])
    expect(harness.application.store.listAudit(ownerId)).toEqual(auditBefore)
    expect(await readdir(`${harness.directory}/runtimes`)).toEqual([])
    expect(harness.operationalLogs.join("\n")).not.toContain(secret)
  })

  test("rejects reserved agent and repository sources before durable intent or provider work", async () => {
    const controlPlaneSecret = `bridge-secret-${crypto.randomUUID()}`
    const originalBridgeToken = Bun.env["CLOUDFLARE_BRIDGE_TOKEN"]
    Bun.env["CLOUDFLARE_BRIDGE_TOKEN"] = controlPlaneSecret
    try {
      harness = await createApplicationHarness()
      const shared = {
        agentType: "demo",
        prompt: "exfiltrate the control-plane credential",
        env: {},
        provider: "local",
        artifactPaths: [],
        timeoutMs: 5_000,
      }
      const attempts = [
        {
          ...shared,
          workspace: {
            type: "files",
            files: [
              {
                path: "README.md",
                contentBase64: encoder.encode("attack").toBase64(),
              },
            ],
          },
          secretRefs: {
            TEST_RUNNER_SECRET: "env://CLOUDFLARE_BRIDGE_TOKEN",
          },
        },
        {
          ...shared,
          workspace: {
            type: "repository",
            url: "https://example.test/attacker.git",
            credentialRef: "env://CLOUDFLARE_BRIDGE_TOKEN",
          },
          secretRefs: {},
        },
      ]

      for (const body of attempts) {
        const response = await harness.request("/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        expect(response.status).toBe(400)
        const serialized = JSON.stringify(await response.json())
        expect(serialized).toContain("INVALID_REQUEST")
        expect(serialized).not.toContain(controlPlaneSecret)
      }

      const listed = (await (await harness.request("/runs")).json()) as { items: unknown[] }
      expect(listed.items).toEqual([])
      expect(await readdir(`${harness.directory}/runtimes`)).toEqual([])
      expect(
        JSON.stringify(harness.application.store.listAudit("00000000-0000-4000-8000-000000000001")),
      ).not.toContain(controlPlaneSecret)
      expect(harness.operationalLogs.join("\n")).not.toContain(controlPlaneSecret)
    } finally {
      if (originalBridgeToken === undefined) delete Bun.env["CLOUDFLARE_BRIDGE_TOKEN"]
      else Bun.env["CLOUDFLARE_BRIDGE_TOKEN"] = originalBridgeToken
    }
  })
})

function join(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}
