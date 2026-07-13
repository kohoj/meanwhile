import { expect, test } from "bun:test"
import { createRunHarness, runInput } from "../harness"

test("another owner cannot observe or cancel a run", async () => {
  const harness = createRunHarness()
  try {
    const { run } = await harness.service.create(harness.contextB, runInput())

    for (const operation of [
      () => harness.service.get(harness.contextA.ownerId, run.id),
      () => harness.service.logs(harness.contextA.ownerId, run.id, { after: 0, limit: 100 }),
      () => harness.service.artifacts(harness.contextA.ownerId, run.id),
      () => harness.service.cancel(harness.contextA, run.id),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })
    }

    expect(harness.commands.cancellationRequests).toEqual([])
    expect((await harness.service.get(harness.contextB.ownerId, run.id)).status).toBe("queued")
    expect((await harness.service.list(harness.contextA.ownerId, { limit: 100 })).items).toEqual([])
  } finally {
    harness.close()
  }
})
