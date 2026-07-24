import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AuditRecord, ExternalProjectGrant } from "../../src/domain"
import { Store } from "../../src/persistence/store"

const ownerId = "97000000-0000-4000-8000-000000000001"
const aliceId = "97000000-0000-4000-8000-000000000002"
const bobId = "97000000-0000-4000-8000-000000000003"
const projectId = "97000000-0000-4000-8000-000000000004"
const aliceIdentityId = "97000000-0000-4000-8000-000000000005"
const bobIdentityId = "97000000-0000-4000-8000-000000000006"
const aliceGrantId = "97000000-0000-4000-8000-000000000007"
const bobGrantId = "97000000-0000-4000-8000-000000000008"
const bindingId = "97000000-0000-4000-8000-000000000009"
const now = "2026-07-24T08:00:00.000Z"
let temporary: string | null = null
let store: Store | null = null

afterEach(async () => {
  store?.close()
  store = null
  if (temporary !== null) await rm(temporary, { recursive: true, force: true })
  temporary = null
})

describe("provider-derived Project access", () => {
  test("unions explicit membership with one current matching GitHub grant", async () => {
    const active = await setup()
    expect(active.getProjectMember(ownerId, projectId, bobId)).toBeNull()

    expect(active.getProjectAccess(ownerId, projectId, bobId, now)).toMatchObject({
      projectId,
      principal: { id: bobId, displayName: "Bob Li" },
      access: "participate",
      source: "github",
    })
    expect(
      active.listProjectsForPrincipal(ownerId, bobId, now).map((project) => project.id),
    ).toEqual([projectId])
    expect(active.listProjectParticipants(ownerId, projectId, now)).toEqual([
      expect.objectContaining({
        principal: { id: aliceId, kind: "person", displayName: "Alice Chen" },
        access: "administer",
        source: "membership",
      }),
      expect.objectContaining({
        principal: { id: bobId, kind: "person", displayName: "Bob Li" },
        access: "participate",
        source: "github",
      }),
    ])

    expect(
      active.getProjectAccess(ownerId, projectId, bobId, "2026-07-25T08:00:00.000Z"),
    ).toBeNull()
    expect(active.listProjectsForPrincipal(ownerId, bobId, "2026-07-25T08:00:00.000Z")).toEqual([])

    active.addProjectMember({
      ownerId,
      projectId,
      principalId: bobId,
      role: "member",
      joinedAt: now,
    })
    expect(
      active.getProjectAccess(ownerId, projectId, bobId, "2026-07-25T08:00:00.000Z"),
    ).toMatchObject({ access: "participate", source: "membership" })
  })

  test("does not confuse a different installation or repository with Project access", async () => {
    const active = await setup({ installationId: "different-installation" })
    expect(active.getProjectAccess(ownerId, projectId, bobId, now)).toBeNull()
    expect(active.listProjectsForPrincipal(ownerId, bobId, now)).toEqual([])
  })

  test("watch grants can observe a room but cannot delegate or write collaboration", async () => {
    const active = await setup({ access: "watch" })
    expect(active.requireProjectAccess(ownerId, projectId, bobId, now)).toMatchObject({
      access: "watch",
    })
    expect(() =>
      active.requireProjectAccess(ownerId, projectId, bobId, now, "participate"),
    ).toThrow("Project not found")
    expect(() => active.resolveProjectForPrincipal(ownerId, bobId, projectId, now)).toThrow(
      "Project not found",
    )
  })
})

async function setup(overrides: Partial<ExternalProjectGrant> = {}): Promise<Store> {
  temporary = await mkdtemp(join(tmpdir(), "meanwhile-provider-project-access-"))
  store = new Store(join(temporary, "meanwhile.sqlite"))
  store.createOwner({ id: ownerId, name: "Acme", createdAt: now })
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
      createdAt: now,
    })
  }
  store.createProject({
    id: projectId,
    ownerId,
    name: "Northstar",
    slug: "northstar",
    createdAt: now,
    createdByPrincipalId: aliceId,
  })
  for (const [id, principalId, subjectId, displayName] of [
    [aliceIdentityId, aliceId, "alice-github", "Alice Chen"],
    [bobIdentityId, bobId, "bob-github", "Bob Li"],
  ] as const) {
    store.upsertExternalIdentityWithAudit({
      identity: {
        id,
        ownerId,
        principalId,
        provider: "github",
        subjectId,
        login: subjectId,
        displayName,
        avatarUrl: null,
        createdAt: now,
        lastVerifiedAt: now,
        revokedAt: null,
      },
      audit: audit("external_identity.link", "external_identity", id),
    })
  }
  const aliceGrant = grant(aliceGrantId, aliceId, aliceIdentityId, "administer")
  const bobGrant = { ...grant(bobGrantId, bobId, bobIdentityId, "participate"), ...overrides }
  for (const value of [aliceGrant, bobGrant]) {
    store.upsertExternalProjectGrantWithAudit({
      grant: value,
      audit: audit("external_project_grant.observe", "external_project_grant", value.id),
    })
  }
  store.bindProjectRepositoryWithAudit({
    binding: {
      id: bindingId,
      ownerId,
      projectId,
      grantId: aliceGrant.id,
      provider: "github",
      accountId: aliceGrant.accountId,
      accountName: aliceGrant.accountName,
      installationId: aliceGrant.installationId,
      repositoryId: aliceGrant.repositoryId,
      repositoryName: aliceGrant.repositoryName,
      repositoryFullName: aliceGrant.repositoryFullName,
      repositoryUrl: aliceGrant.repositoryUrl,
      private: aliceGrant.private,
      boundByPrincipalId: aliceId,
      createdAt: now,
      revokedAt: null,
    },
    audit: audit("project_repository_binding.bind", "project_repository_binding", bindingId),
  })
  return store
}

function grant(
  id: string,
  principalId: string,
  externalIdentityId: string,
  access: ExternalProjectGrant["access"],
): ExternalProjectGrant {
  return {
    id,
    ownerId,
    principalId,
    externalIdentityId,
    provider: "github",
    accountId: "acme-account",
    accountName: "acme",
    installationId: "acme-installation",
    repositoryId: "northstar-repository",
    repositoryName: "northstar",
    repositoryFullName: "acme/northstar",
    repositoryUrl: "https://github.com/acme/northstar",
    private: true,
    access,
    observedAt: now,
    expiresAt: "2026-07-25T08:00:00.000Z",
    revokedAt: null,
  }
}

function audit(
  action: string,
  resourceType: AuditRecord["resourceType"],
  resourceId: string,
): AuditRecord {
  return {
    id: crypto.randomUUID(),
    ownerId,
    actorApiKeyId: null,
    action,
    resourceType,
    resourceId,
    requestId: "fixture",
    traceId: null,
    metadata: {},
    createdAt: now,
  }
}
