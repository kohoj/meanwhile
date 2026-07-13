import { expect, test } from "bun:test"
import { createRunHarness, runInput } from "../harness"

test("an owner-scoped idempotency key creates exactly one run", async () => {
  const harness = createRunHarness()
  try {
    const input = runInput({ env: { A: "1", B: "2" } })
    const [first, second] = await Promise.all([
      harness.service.create(harness.contextA, input, "run-from-client-42"),
      harness.service.create(
        harness.contextA,
        runInput({ env: { B: "2", A: "1" } }),
        "run-from-client-42",
      ),
    ])

    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(second.run.id).toBe(first.run.id)
    expect(harness.commands.enqueued).toEqual([first.run.id])
    expect(
      (await harness.service.list(harness.contextA.ownerId, { limit: 100 })).items,
    ).toHaveLength(1)

    await expect(
      harness.service.create(
        harness.contextA,
        runInput({ prompt: "A different request" }),
        "run-from-client-42",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 })

    const otherOwner = await harness.service.create(harness.contextB, input, "run-from-client-42")
    expect(otherOwner.run.id).not.toBe(first.run.id)
  } finally {
    harness.close()
  }
})
