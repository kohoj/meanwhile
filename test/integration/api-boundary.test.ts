import { afterEach, beforeEach, expect, test } from "bun:test"
import {
  MAX_CONTROL_REQUEST_BODY_BYTES,
  MAX_TRANSPORT_REQUEST_BODY_BYTES,
} from "../../src/api/body"
import { type ApplicationHarness, createApplicationHarness } from "../application-harness"

let harness: ApplicationHarness

beforeEach(async () => {
  harness = await createApplicationHarness()
})

afterEach(async () => {
  await harness.close()
})

test("the route inventory is exact and every control operation fails closed", async () => {
  const specificationResponse = await harness.application.app.request("/openapi.json")
  expect(specificationResponse.status).toBe(200)
  const specification = (await specificationResponse.json()) as OpenApiDocument
  const expectedPaths = [
    "/api-keys",
    "/api-keys/{id}",
    "/artifacts/{id}",
    "/artifacts/{id}/content",
    "/audit",
    "/deployments",
    "/deployments/{id}",
    "/deployments/{id}/logs",
    "/healthz",
    "/openapi.json",
    "/providers/test",
    "/readyz",
    "/runs",
    "/runs/{id}",
    "/runs/{id}/artifacts",
    "/runs/{id}/cancel",
    "/runs/{id}/logs",
  ]
  expect(Object.keys(specification.paths).sort()).toEqual(expectedPaths)
  expect(specification.security).toEqual([{ BearerAuth: [] }])

  const publicPaths = new Set(["/healthz", "/readyz", "/openapi.json"])
  for (const path of publicPaths) {
    expect(specification.paths[path]?.get?.security).toEqual([])
    const response = await harness.application.app.request(path)
    expect(response.status).not.toBe(401)
  }

  const resourceId = "00000000-0000-4000-8000-000000000099"
  for (const [path, pathItem] of Object.entries(specification.paths)) {
    if (publicPaths.has(path)) continue
    for (const method of httpMethods) {
      if (pathItem[method] === undefined) continue
      const response = await harness.application.app.request(path.replace("{id}", resourceId), {
        method: method.toUpperCase(),
        headers: { "Content-Type": "application/json" },
      })
      expect(response.status).toBe(401)
      expect(response.headers.get("Cache-Control")).toBe("private, no-store")
      expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } })
    }
  }

  const unknown = await harness.application.app.request("/future-control-route")
  expect(unknown.status).toBe(401)
  expect(await unknown.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } })
})

test("the OpenAPI document represents durable run intent, nullable errors, deployment source XOR, and SSE resume", async () => {
  const specification = (await (
    await harness.application.app.request("/openapi.json")
  ).json()) as OpenApiDocument
  const schemas = specification.components.schemas
  const runSchema = requireSchema(schemas, "Run")
  const agentSpecSchema = requireSchema(schemas, "AgentLaunchSnapshot")
  const deploymentSchema = requireSchema(schemas, "Deployment")

  expect(runSchema.required).toEqual(
    expect.arrayContaining(["agentSpec", "agentCatalogDigest", "resolvedRevision"]),
  )
  expect(runSchema.properties?.["agentSpec"]).toEqual({
    $ref: "#/components/schemas/AgentLaunchSnapshot",
  })
  expect(agentSpecSchema.additionalProperties).toBeFalse()
  expect(agentSpecSchema.required).toEqual(
    expect.arrayContaining([
      "version",
      "catalogVersion",
      "definitionDigest",
      "executable",
      "args",
      "workingDirectory",
      "capabilities",
      "permissionPolicy",
      "envNames",
      "secretEnvNames",
    ]),
  )

  expect(runSchema.properties?.["error"]?.anyOf).toEqual([
    { $ref: "#/components/schemas/StructuredError" },
    { type: "null" },
  ])
  expect(deploymentSchema.properties?.["error"]?.anyOf).toEqual([
    { $ref: "#/components/schemas/StructuredError" },
    { type: "null" },
  ])

  const deploymentRequest = requireSchema(schemas, "CreateDeploymentRequest")
  expect(deploymentRequest.anyOf).toHaveLength(2)
  expect(deploymentRequest.anyOf?.[0]).toMatchObject({
    required: ["runId", "deployTarget", "artifactPath"],
    additionalProperties: false,
  })
  expect(deploymentRequest.anyOf?.[1]).toMatchObject({
    required: ["runId", "deployTarget", "workspacePath"],
    additionalProperties: false,
  })

  const logParameters = specification.paths["/runs/{id}/logs"]?.get?.parameters ?? []
  expect(logParameters).toContainEqual(
    expect.objectContaining({ name: "Last-Event-ID", in: "header", required: false }),
  )
})

test("unknown-length request bodies are bounded and replayed below the Bun hard ceiling", async () => {
  expect(MAX_TRANSPORT_REQUEST_BODY_BYTES).toBeGreaterThan(MAX_CONTROL_REQUEST_BODY_BYTES)

  const validBody = new TextEncoder().encode('{"provider":"local"}')
  const validRequest = streamingRequest(
    "http://meanwhile.test/providers/test",
    [validBody],
    harness.token,
  )
  expect(validRequest.headers.get("Content-Length")).toBeNull()
  const validResponse = await harness.application.app.fetch(validRequest)
  expect(validResponse.status).toBe(200)
  expect(validResponse.headers.get("Cache-Control")).toBe("private, no-store")
  expect(await validResponse.json()).toMatchObject({ provider: "local" })

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: MAX_TRANSPORT_REQUEST_BODY_BYTES,
    fetch: harness.application.app.fetch,
  })
  try {
    const body = oversizedChunks()
    const response = await fetch(`http://127.0.0.1:${server.port}/runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${harness.token}`,
        "Content-Type": "application/json",
      },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = body.next()
          if (chunk.done) {
            controller.close()
            return
          }
          controller.enqueue(chunk.value)
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" })
    expect(response.status).toBe(413)
    expect(response.headers.get("Content-Type")).toContain("application/json")
    expect(await response.json()).toMatchObject({
      error: {
        code: "INVALID_REQUEST",
        message: "Request body exceeds the control-plane limit",
        details: { maxBytes: MAX_CONTROL_REQUEST_BODY_BYTES },
      },
    })
  } finally {
    await server.stop(true)
  }
})

test("request identity is echoed and correlated without logging request content", async () => {
  const requestId = "request-contract-42"
  const health = await harness.application.app.request("/healthz", {
    headers: { "X-Request-ID": requestId },
  })
  expect(health.headers.get("X-Request-ID")).toBe(requestId)

  const privateValue = "request-body-must-not-reach-operational-telemetry"
  const malformed = await harness.application.app.request("/runs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${harness.token}`,
      "Content-Type": "application/json",
      "X-Request-ID": requestId,
    },
    body: `{${privateValue}`,
  })
  expect(malformed.status).toBe(400)
  expect(malformed.headers.get("X-Request-ID")).toBe(requestId)
  const record = harness.operationalLogs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find(({ event }) => event === "http.request_failed")
  expect(record).toMatchObject({
    requestId,
    event: "http.request_failed",
    attributes: { code: "INVALID_REQUEST", status: 400 },
  })
  expect(harness.operationalLogs.join("\n")).not.toContain(privateValue)
})

const httpMethods = ["get", "post", "put", "patch", "delete"] as const

const streamingRequest = (url: string, chunks: readonly Uint8Array[], token: string): Request => {
  let cursor = 0
  return new Request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[cursor]
        cursor += 1
        if (chunk === undefined) {
          controller.close()
          return
        }
        controller.enqueue(chunk)
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" })
}

function* oversizedChunks(): Generator<Uint8Array> {
  const oneMiB = new Uint8Array(1024 * 1024)
  for (let index = 0; index < 16; index += 1) yield oneMiB
  yield new Uint8Array(1)
}

const requireSchema = (schemas: Record<string, OpenApiSchema>, name: string): OpenApiSchema => {
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`OpenAPI schema '${name}' is missing`)
  return schema
}

interface OpenApiSchema {
  readonly properties?: Record<string, OpenApiSchema>
  readonly anyOf?: readonly OpenApiSchema[]
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean
  readonly $ref?: string
  readonly type?: string
}

interface OpenApiOperation {
  readonly security?: readonly Record<string, readonly string[]>[]
  readonly parameters?: readonly {
    readonly name: string
    readonly in: string
    readonly required?: boolean
  }[]
}

interface OpenApiDocument {
  readonly security: readonly Record<string, readonly string[]>[]
  readonly paths: Record<string, Partial<Record<(typeof httpMethods)[number], OpenApiOperation>>>
  readonly components: {
    readonly schemas: Record<string, OpenApiSchema>
  }
}
