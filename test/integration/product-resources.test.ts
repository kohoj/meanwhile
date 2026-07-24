import { afterEach, describe, expect, test } from "bun:test"
import { apiKeyPrefix, hashApiKey, issueApiKey } from "../../src/auth"
import { Meanwhile } from "../../src/client"
import {
  type ApplicationHarness,
  createApplicationHarness,
  createDemoRun,
} from "../application-harness"

const harnesses: ApplicationHarness[] = []

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()))
})

describe("complete public resource boundary", () => {
  test("retrieves immutable artifact entries and hides them across owners", async () => {
    const harness = await application()
    const client = sdk(harness)
    const run = await createDemoRun(harness)
    await client.runs.wait(run.id, { timeoutMs: 10_000, pollIntervalMs: 10 })
    const [artifact] = await client.artifacts.list(run.id)
    expect(artifact).toBeDefined()
    const detail = await client.artifacts.get(artifact?.id ?? "")
    expect(detail.entries).toHaveLength(1)
    const entry = detail.entries[0]
    if (entry === undefined) throw new Error("Artifact entry is missing")
    const content = await client.artifacts.download(artifact?.id ?? "", { path: entry.path })
    const bytes = new Uint8Array(await new Response(content.body).arrayBuffer())
    expect(new TextDecoder().decode(bytes)).toContain("Meanwhile")
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(content.digest)

    const other = await createOtherOwner(harness)
    const hidden = await harness.application.app.request(`/artifacts/${artifact?.id}`, {
      headers: { Authorization: `Bearer ${other}` },
    })
    expect(hidden.status).toBe(404)
  })

  test("API keys, deployments, and audit evidence close their public lifecycles", async () => {
    const harness = await application()
    const client = sdk(harness)
    const createdKey = await client.apiKeys.create("Automation key")
    expect(createdKey.secret).toStartWith(`${createdKey.key.prefix}_`)
    expect((await client.apiKeys.list()).map(({ id }) => id)).toContain(createdKey.key.id)

    const run = await createDemoRun(harness)
    await client.runs.wait(run.id, { timeoutMs: 10_000, pollIntervalMs: 10 })
    const deployment = await client.deployments.create(
      {
        runId: run.id,
        artifactPath: "dist",
        deployTarget: "local-static",
      },
      { idempotencyKey: "product-resources-deployment" },
    )
    const replayed = await client.deployments.create(
      {
        runId: run.id,
        artifactPath: "dist",
        deployTarget: "local-static",
      },
      { idempotencyKey: "product-resources-deployment" },
    )
    expect(replayed.id).toBe(deployment.id)
    await expect(
      client.deployments.create(
        {
          runId: run.id,
          workspacePath: "dist",
          deployTarget: "local-static",
        },
        { idempotencyKey: "product-resources-deployment" },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 })
    await client.deployments.wait(deployment.id, { timeoutMs: 10_000, pollIntervalMs: 10 })
    expect((await client.deployments.list()).items.map(({ id }) => id)).toContain(deployment.id)
    expect(
      (
        await client.audit.list({ resourceType: "deployment", resourceId: deployment.id })
      ).items.filter(({ action }) => action === "deployment.create"),
    ).toHaveLength(1)

    const revoked = await client.apiKeys.revoke(createdKey.key.id)
    expect(revoked.revokedAt).not.toBeNull()
    const evidence = await client.audit.list({ resourceType: "api_key" })
    expect(evidence.items.map(({ action }) => action)).toEqual(
      expect.arrayContaining(["api_key.create", "api_key.revoke"]),
    )

    const otherClient = sdk(harness, await createOtherOwner(harness))
    expect((await otherClient.apiKeys.list()).map(({ id }) => id)).not.toContain(createdKey.key.id)
    await expect(otherClient.apiKeys.revoke(createdKey.key.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    expect((await otherClient.deployments.list()).items).toHaveLength(0)
    expect((await otherClient.audit.list({ resourceId: createdKey.key.id })).items).toHaveLength(0)
  })

  test("Principal invitations expose plaintext once and remain owner-scoped and revocable", async () => {
    const harness = await application()
    const client = sdk(harness)
    const principal = await client.projects.createPrincipal({
      kind: "person",
      displayName: "Priya Shah",
    })

    const created = await client.invitations.create(principal.id, { expiresInSeconds: 300 })
    expect(created.secret).toStartWith(`${created.invitation.prefix}_`)
    expect(created.invitation.principalId).toBe(principal.id)
    expect((await client.invitations.list()).map(({ id }) => id)).toContain(created.invitation.id)

    const otherClient = sdk(harness, await createOtherOwner(harness))
    expect((await otherClient.invitations.list()).map(({ id }) => id)).not.toContain(
      created.invitation.id,
    )
    await expect(otherClient.invitations.revoke(created.invitation.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    })

    const revoked = await client.invitations.revoke(created.invitation.id)
    expect(revoked.revokedAt).not.toBeNull()
    expect(
      (
        await client.audit.list({
          resourceType: "principal_invitation",
          resourceId: created.invitation.id,
        })
      ).items.map(({ action }) => action),
    ).toEqual(
      expect.arrayContaining(["principal_invitation.create", "principal_invitation.revoke"]),
    )
  })
})

async function application(): Promise<ApplicationHarness> {
  const harness = await createApplicationHarness()
  harnesses.push(harness)
  return harness
}

function sdk(harness: ApplicationHarness, apiKey = harness.token): Meanwhile {
  return new Meanwhile({
    baseUrl: "http://meanwhile.test",
    apiKey,
    fetch: (input, init) => Promise.resolve(harness.application.app.request(input, init)),
  })
}

async function createOtherOwner(harness: ApplicationHarness): Promise<string> {
  const ownerId = crypto.randomUUID()
  const issued = await issueApiKey()
  harness.application.store.createOwner({
    id: ownerId,
    name: "Other owner",
    createdAt: new Date().toISOString(),
  })
  harness.application.store.createApiKey({
    id: crypto.randomUUID(),
    ownerId,
    prefix: apiKeyPrefix(issued.key) as string,
    hash: await hashApiKey(issued.key),
    name: "Other key",
    createdAt: new Date().toISOString(),
  })
  return issued.key
}
