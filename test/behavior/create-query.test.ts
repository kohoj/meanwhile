import { expect, test } from "bun:test"
import { createRunHarness, runInput } from "../harness"

test("a created run is immediately durable and owner-queryable", async () => {
  const harness = createRunHarness()
  try {
    const created = await harness.service.create(harness.contextA, runInput())

    expect(created.replayed).toBe(false)
    expect(created.run.status).toBe("queued")
    expect(created.run.statusVersion).toBe(1)
    expect(harness.commands.enqueued).toEqual([created.run.id])

    const queried = await harness.service.get(harness.contextA.ownerId, created.run.id)
    expect(queried).toEqual(created.run)

    const page = await harness.service.list(harness.contextA.ownerId, { limit: 25 })
    expect(page.items).toEqual([created.run])
    expect(page.nextCursor).toBeNull()

    const statusEvents = harness.store.listRunStatusEvents(harness.contextA.ownerId, created.run.id)
    expect(
      statusEvents.map((event) => [event.fromStatus, event.toStatus, event.statusVersion]),
    ).toEqual([[null, "queued", 1]])
    expect(
      harness.store
        .listAudit(harness.contextA.ownerId, created.run.id)
        .map((event) => event.action),
    ).toEqual(["run.create"])
  } finally {
    harness.close()
  }
})

test("run pagination does not skip equal-timestamp records", async () => {
  const harness = createRunHarness()
  try {
    const runs = await Promise.all([
      harness.service.create(harness.contextA, runInput({ prompt: "one" })),
      harness.service.create(harness.contextA, runInput({ prompt: "two" })),
      harness.service.create(harness.contextA, runInput({ prompt: "three" })),
    ])
    expect(new Set(runs.map(({ run }) => run.createdAt)).size).toBe(1)

    const first = await harness.service.list(harness.contextA.ownerId, { limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    if (first.nextCursor === null) throw new Error("Expected a second page")
    const second = await harness.service.list(harness.contextA.ownerId, {
      limit: 2,
      before: first.nextCursor,
    })

    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map((run) => run.id)).size).toBe(3)
  } finally {
    harness.close()
  }
})
