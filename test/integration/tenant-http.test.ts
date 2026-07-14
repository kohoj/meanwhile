import { expect, test } from "bun:test"
import { issueApiKey } from "../../src/auth"
import { createApplicationHarness } from "../application-harness"

test("bearer identity enforces tenant isolation at every run-derived HTTP boundary", async () => {
  const harness = await createApplicationHarness()
  try {
    const ownerB = crypto.randomUUID()
    const keyB = await issueApiKey()
    const createdAt = new Date().toISOString()
    harness.application.store.createOwner({ id: ownerB, name: "Owner B", createdAt })
    harness.application.store.createApiKey({
      id: crypto.randomUUID(),
      ownerId: ownerB,
      prefix: keyB.prefix,
      hash: keyB.hash,
      name: "Owner B integration key",
      createdAt,
    })

    const createdResponse = await harness.request("/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        workspace: {
          type: "files",
          files: [
            { path: "README.md", contentBase64: Buffer.from("tenant proof").toString("base64") },
            {
              path: "dist/index.html",
              contentBase64: Buffer.from("<h1>private</h1>").toString("base64"),
            },
          ],
        },
        agentType: "demo",
        prompt: "Produce deterministic output",
        env: {},
        secretRefs: {},
        provider: "local",
        artifactPaths: ["dist"],
        timeoutMs: 5_000,
      }),
    })
    expect(createdResponse.status).toBe(201)
    const { run } = (await createdResponse.json()) as { run: { id: string } }

    const asOwnerB = (path: string, init: RequestInit = {}) =>
      Promise.resolve(
        harness.application.app.request(path, {
          ...init,
          headers: {
            Authorization: `Bearer ${keyB.key}`,
            ...Object.fromEntries(new Headers(init.headers).entries()),
          },
        }),
      )

    for (const path of [`/runs/${run.id}`, `/runs/${run.id}/logs`, `/runs/${run.id}/artifacts`]) {
      const response = await asOwnerB(path)
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } })
    }

    const cancellation = await asOwnerB(`/runs/${run.id}/cancel`, { method: "POST" })
    expect(cancellation.status).toBe(404)
    expect(await cancellation.json()).toMatchObject({ error: { code: "NOT_FOUND" } })

    const deployment = await asOwnerB("/deployments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: run.id,
        workspacePath: "dist",
        deployTarget: "local-static",
      }),
    })
    expect(deployment.status).toBe(404)
    expect(await deployment.json()).toMatchObject({ error: { code: "NOT_FOUND" } })

    const ownerBList = await asOwnerB("/runs")
    expect(ownerBList.status).toBe(200)
    expect(await ownerBList.json()).toMatchObject({ items: [] })
    expect(harness.application.store.getRunInternal(run.id)?.status).not.toBe("cancelled")
    expect(harness.application.store.listAudit(ownerB, run.id)).toEqual([])

    expect((await harness.request(`/runs/${run.id}`)).status).toBe(200)
  } finally {
    await harness.close()
  }
})
