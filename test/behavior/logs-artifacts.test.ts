import { expect, test } from "bun:test"
import type { Artifact } from "../../src/domain"
import { createRunHarness, runInput } from "../harness"

test("logs are cursor-addressable and artifacts are owner-scoped", async () => {
  const harness = createRunHarness()
  try {
    const { run } = await harness.service.create(harness.contextA, runInput({ secretRefs: {} }))
    const createdAt = harness.clock.now().toISOString()
    for (const [sequence, data] of [
      [1, "starting"],
      [2, "finished"],
    ] as const) {
      expect(
        harness.store.appendRunLog({
          ownerId: run.ownerId,
          runId: run.id,
          sequence,
          stream: "system",
          eventType: "lifecycle",
          data,
          createdAt,
        }),
      ).toBe(true)
    }
    expect(
      harness.store.appendRunLog({
        ownerId: run.ownerId,
        runId: run.id,
        sequence: 2,
        stream: "system",
        eventType: "lifecycle",
        data: "duplicate",
        createdAt,
      }),
    ).toBe(false)

    const firstPage = await harness.service.logs(run.ownerId, run.id, { after: 0, limit: 1 })
    expect(firstPage.items.map((item) => item.sequence)).toEqual([1])
    expect(firstPage.nextCursor).toBe(1)
    const secondPage = await harness.service.logs(run.ownerId, run.id, {
      after: firstPage.nextCursor ?? 0,
      limit: 10,
    })
    expect(secondPage.items.map((item) => item.sequence)).toEqual([2])

    const artifact: Artifact = {
      id: "c".repeat(64),
      ownerId: run.ownerId,
      runId: run.id,
      logicalPath: "dist",
      kind: "directory",
      digest: "a".repeat(64),
      mediaType: "application/vnd.meanwhile.manifest+json",
      byteSize: 128,
      storageKey: "owners/a/blobs/aa/content",
      createdAt,
    }
    harness.store.insertArtifact(artifact)
    expect(await harness.service.artifacts(run.ownerId, run.id)).toEqual([artifact])
    await expect(harness.service.artifacts(harness.contextB.ownerId, run.id)).rejects.toMatchObject(
      {
        code: "NOT_FOUND",
      },
    )
  } finally {
    harness.close()
  }
})

test("follow mode reuses durable sequence and ends for a terminal run", async () => {
  const harness = createRunHarness()
  try {
    const { run } = await harness.service.create(harness.contextA, runInput({ secretRefs: {} }))
    harness.store.appendRunLog({
      ownerId: run.ownerId,
      runId: run.id,
      sequence: 1,
      stream: "stdout",
      eventType: "agent.output",
      data: "one",
      createdAt: harness.clock.now().toISOString(),
    })
    await harness.service.cancel(harness.contextA, run.id)

    const followed = []
    for await (const item of harness.service.followLogs(
      run.ownerId,
      run.id,
      0,
      new AbortController().signal,
    )) {
      followed.push(item)
    }
    expect(followed.map((item) => item?.sequence)).toEqual([1, 2])
    expect(followed.at(-1)).toMatchObject({
      stream: "system",
      eventType: "run.cancelled",
      data: "Run cancelled",
    })
  } finally {
    harness.close()
  }
})

test("follow mode tail-drains evidence persisted immediately after terminal observation", async () => {
  const harness = createRunHarness()
  try {
    const { run } = await harness.service.create(harness.contextA, runInput({ secretRefs: {} }))
    const createdAt = harness.clock.now().toISOString()
    harness.store.appendRunLog({
      ownerId: run.ownerId,
      runId: run.id,
      sequence: 1,
      stream: "stdout",
      eventType: "agent.output",
      data: "before terminal",
      createdAt,
    })
    await harness.service.cancel(harness.contextA, run.id)

    const originalGetRun = harness.store.getRun.bind(harness.store)
    let reads = 0
    Object.defineProperty(harness.store, "getRun", {
      configurable: true,
      value(ownerId: string, runId: string) {
        const observed = originalGetRun(ownerId, runId)
        reads += 1
        if (reads === 2) {
          harness.store.appendRunLog({
            ownerId: run.ownerId,
            runId: run.id,
            sequence: 3,
            stream: "system",
            eventType: "terminal",
            data: "after terminal",
            createdAt,
          })
        }
        return observed
      },
    })

    const followed = []
    for await (const item of harness.service.followLogs(
      run.ownerId,
      run.id,
      0,
      new AbortController().signal,
    )) {
      followed.push(item)
    }
    expect(followed.map((item) => item?.sequence)).toEqual([1, 2, 3])
  } finally {
    harness.close()
  }
})
