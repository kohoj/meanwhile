import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RequestContext } from "../../src/domain"
import { Store } from "../../src/persistence/store"
import { PRESENCE_LEASE_TTL_MS, PresenceService } from "../../src/services/presence-service"

const ownerId = "92000000-0000-4000-8000-000000000001"
const aliceId = "92000000-0000-4000-8000-000000000002"
const bobId = "92000000-0000-4000-8000-000000000003"
const projectId = "92000000-0000-4000-8000-000000000004"
const aliceLaptop = "92000000-0000-4000-8000-000000000005"
const aliceDesktop = "92000000-0000-4000-8000-000000000006"
const bobLaptop = "92000000-0000-4000-8000-000000000007"
let temporary: string | null = null
let store: Store | null = null

afterEach(async () => {
  store?.close()
  store = null
  if (temporary !== null) await rm(temporary, { recursive: true, force: true })
  temporary = null
})

describe("Project room presence", () => {
  test("tracks clients independently, refreshes idempotently, and expires without fabricating membership", async () => {
    temporary = await mkdtemp(join(tmpdir(), "meanwhile-presence-"))
    store = new Store(join(temporary, "meanwhile.sqlite"))
    const startedAt = new Date("2026-07-24T08:00:00.000Z")
    let now = startedAt
    store.createOwner({ id: ownerId, name: "Acme", createdAt: startedAt.toISOString() })
    for (const [id, displayName] of [
      [aliceId, "Alice Chen"],
      [bobId, "Bob Li"],
    ] as const) {
      store.createPrincipal({
        id,
        ownerId,
        kind: "person",
        displayName,
        ownerRole: id === aliceId ? "admin" : "member",
        createdAt: startedAt.toISOString(),
      })
    }
    store.createProject({
      id: projectId,
      ownerId,
      name: "Northstar",
      slug: "northstar",
      createdAt: startedAt.toISOString(),
      createdByPrincipalId: aliceId,
    })
    store.addProjectMember({
      ownerId,
      projectId,
      principalId: bobId,
      role: "member",
      joinedAt: startedAt.toISOString(),
    })
    const service = new PresenceService(store, () => now)
    const alice = context(aliceId)
    const bob = context(bobId)

    const first = service.heartbeat(alice, projectId, aliceLaptop)
    service.heartbeat(alice, projectId, aliceDesktop)
    service.heartbeat(bob, projectId, bobLaptop)
    expect(service.list(alice, projectId)).toHaveLength(3)
    expect(new Set(service.list(alice, projectId).map((lease) => lease.principal.id))).toEqual(
      new Set([aliceId, bobId]),
    )

    now = new Date(startedAt.getTime() + 20_000)
    const refreshed = service.heartbeat(alice, projectId, aliceLaptop)
    expect(refreshed.connectedAt).toBe(first.connectedAt)
    expect(Date.parse(refreshed.expiresAt) - now.getTime()).toBe(PRESENCE_LEASE_TTL_MS)

    service.release(alice, projectId, aliceDesktop)
    now = new Date(startedAt.getTime() + 46_000)
    expect(service.list(alice, projectId).map((lease) => lease.clientId)).toEqual([aliceLaptop])

    now = new Date(startedAt.getTime() + 66_000)
    expect(service.list(alice, projectId)).toEqual([])
  })
})

function context(principalId: string): RequestContext {
  return {
    requestId: `presence-${principalId}`,
    traceId: null,
    ownerId,
    principalId,
    ownerRole: principalId === aliceId ? "admin" : "member",
    apiKeyId: null,
    browserSessionId: crypto.randomUUID(),
  }
}
