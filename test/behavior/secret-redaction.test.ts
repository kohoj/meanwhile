import { afterEach, describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import {
  EnvironmentSecretResolver,
  REDACTED_VALUE,
  SecretRedactor,
  SecretResolutionError,
} from "../../src/secrets"
import {
  type ApplicationHarness,
  createApplicationHarness,
  createDemoRun,
} from "../application-harness"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

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
      { ownerId: "owner-a", purpose: "agent" },
    )

    expect(resolved.environment).toEqual({ OPENAI_API_KEY: "token-value-123" })
    expect(
      resolved.redactor.redactString("agent said token-value-123 twice: token-value-123"),
    ).toBe(`agent said ${REDACTED_VALUE} twice: ${REDACTED_VALUE}`)

    resolved.dispose()
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
      resolver.resolve({ TOKEN: "literal-secret" }, { ownerId: "owner-a", purpose: "agent" }),
    ).toThrow(
      new SecretResolutionError(
        "INVALID_SECRET_REFERENCE",
        "Secret reference for TOKEN must use env://NAME",
      ),
    )
    expect(() =>
      resolver.resolve({ ABSENT: "env://ABSENT" }, { ownerId: "owner-a", purpose: "agent" }),
    ).toThrow("env://ABSENT is not configured")
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
        { ownerId: "owner-b", purpose: "deployment" },
      ),
    ).toThrow("authenticated owner")
    expect(() =>
      resolver.resolve(
        { OPENAI_API_KEY: "env://FLY_API_TOKEN" },
        { ownerId: "owner-a", purpose: "agent" },
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

  test("redacts agent output and rejects a candidate artifact containing the resolved value", async () => {
    const secret = `pipeline-secret-${crypto.randomUUID()}`
    Bun.env[sourceName] = secret
    harness = await createApplicationHarness()
    const created = await createDemoRun(harness, {
      secretRefs: { TEST_RUNNER_SECRET: `env://${sourceName}` },
      files: [{ path: "dist/index.html", content: `<p>${secret}</p>` }],
    })
    const terminal = await harness.waitForRun(created.id)
    expect(terminal.status).toBe("succeeded")

    const logs = harness.application.store.listRunLogs(terminal.ownerId, terminal.id, 0, 1_000)
    expect(JSON.stringify(logs)).not.toContain(secret)
    expect(JSON.stringify(logs)).toContain("[REDACTED]")
    expect(harness.operationalLogs.join("\n")).not.toContain(secret)
    expect(JSON.stringify(harness.application.store.listAudit(terminal.ownerId))).not.toContain(
      secret,
    )
    expect(harness.application.store.listArtifacts(terminal.ownerId, terminal.id)).toHaveLength(0)
    expect(
      harness.application.store
        .listAudit(terminal.ownerId)
        .some((record) => record.action === "artifact.capture_rejected"),
    ).toBeTrue()
  })

  test("keeps process output in owner-visible run logs, never operational telemetry", async () => {
    const secret = `evidence-plane-${crypto.randomUUID()}`
    Bun.env[sourceName] = secret
    harness = await createApplicationHarness({ logLevel: "debug" })
    const created = await createDemoRun(harness, {
      secretRefs: { TEST_RUNNER_SECRET: `env://${sourceName}` },
      artifactPaths: [],
    })
    const terminal = await harness.waitForRun(created.id)
    const logs = harness.application.store.listRunLogs(terminal.ownerId, terminal.id, 0, 1_000)
    expect(
      logs.some(
        (log) =>
          log.stream === "stderr" &&
          log.eventType === "agent.stderr" &&
          log.data.includes("fixture stderr secret=[REDACTED]"),
      ),
    ).toBeTrue()
    const operational = harness.operationalLogs.join("\n")
    expect(operational).not.toContain("fixture stderr secret=")
    expect(operational).not.toContain(secret)
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
