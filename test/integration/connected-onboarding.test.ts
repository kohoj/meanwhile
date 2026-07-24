import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AuditRecord, RequestContext } from "../../src/domain"
import { Store } from "../../src/persistence/store"
import { ConnectedOnboardingService } from "../../src/services/connected-onboarding-service"

const ownerId = "91000000-0000-4000-8000-000000000001"
const principalId = "91000000-0000-4000-8000-000000000002"
const projectId = "91000000-0000-4000-8000-000000000003"
const identityId = "91000000-0000-4000-8000-000000000004"
const grantId = "91000000-0000-4000-8000-000000000005"
const timestamp = "2026-07-24T08:00:00.000Z"
let temporary: string | null = null
let store: Store | null = null

afterEach(async () => {
  store?.close()
  store = null
  if (temporary !== null) await rm(temporary, { recursive: true, force: true })
  temporary = null
})

describe("connected onboarding", () => {
  test("keeps identity, repository, agent, and Lobby selection as separate durable grants", async () => {
    temporary = await mkdtemp(join(tmpdir(), "meanwhile-connected-onboarding-"))
    store = new Store(join(temporary, "meanwhile.sqlite"))
    store.createOwner({ id: ownerId, name: "Acme", createdAt: timestamp })
    store.createPrincipal({
      id: principalId,
      ownerId,
      kind: "person",
      displayName: "Bob Li",
      ownerRole: "admin",
      createdAt: timestamp,
    })
    store.createProject({
      id: projectId,
      ownerId,
      name: "Northstar",
      slug: "northstar",
      createdAt: timestamp,
      createdByPrincipalId: principalId,
    })
    store.upsertExternalIdentityWithAudit({
      identity: {
        id: identityId,
        ownerId,
        principalId,
        provider: "github",
        subjectId: "12345",
        login: "bob",
        displayName: "Bob Li",
        avatarUrl: "https://avatars.githubusercontent.com/u/12345",
        createdAt: timestamp,
        lastVerifiedAt: timestamp,
        revokedAt: null,
      },
      audit: audit("external_identity.link", "external_identity", identityId),
    })
    store.upsertExternalProjectGrantWithAudit({
      grant: {
        id: grantId,
        ownerId,
        principalId,
        externalIdentityId: identityId,
        provider: "github",
        accountId: "44",
        accountName: "acme",
        installationId: "55",
        repositoryId: "66",
        repositoryName: "northstar",
        repositoryFullName: "acme/northstar",
        repositoryUrl: "https://github.com/acme/northstar",
        private: true,
        access: "administer",
        observedAt: timestamp,
        expiresAt: "2026-07-25T08:00:00.000Z",
        revokedAt: null,
      },
      audit: audit("external_project_grant.observe", "external_project_grant", grantId),
    })

    let idSequence = 10
    const service = new ConnectedOnboardingService(
      store,
      () => [
        {
          agentType: "codex",
          label: "Codex",
          capabilities: {
            oneShotRuns: true,
            durableSessions: true,
            runtimeProviders: ["local", "cloudflare"],
          },
        },
      ],
      () => new Date(timestamp),
      () => `91000000-0000-4000-8000-${String(idSequence++).padStart(12, "0")}`,
    )
    const context: RequestContext = {
      requestId: "request-onboarding",
      traceId: null,
      ownerId,
      principalId,
      ownerRole: "admin",
      apiKeyId: null,
      browserSessionId: "91000000-0000-4000-8000-000000000009",
    }

    const initial = service.snapshot(context)
    expect(initial.identities).toHaveLength(1)
    expect(initial.repositoryGrants).toHaveLength(1)
    expect(initial.repositoryBindings).toEqual([])
    expect(initial.agentConnections).toEqual([])
    expect(initial.projects).toEqual([
      {
        project: expect.objectContaining({ id: projectId, name: "Northstar" }),
        access: "administer",
        source: "membership",
        selected: false,
      },
    ])

    const connection = service.connectAgent(context, "codex")
    const selection = service.selectProject(context, projectId, true)
    const binding = service.bindRepository(context, projectId, grantId)
    expect(connection).toMatchObject({ agentType: "codex", principalId, revokedAt: null })
    expect(selection).toMatchObject({ projectId, hiddenAt: null })
    expect(binding).toMatchObject({ projectId, repositoryFullName: "acme/northstar" })

    const completed = service.snapshot(context)
    expect(completed.agentConnections).toHaveLength(1)
    expect(completed.repositoryBindings).toHaveLength(1)
    expect(completed.projects[0]?.selected).toBe(true)
    expect(store.listAudit(ownerId).map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "external_identity.link",
        "external_project_grant.observe",
        "agent_connection.authorize",
        "project_selection.show",
        "project_repository_binding.bind",
      ]),
    )
  })

  test("imports one GitHub-administered repository into the Lobby without fabricating membership", async () => {
    temporary = await mkdtemp(join(tmpdir(), "meanwhile-connected-import-"))
    store = new Store(join(temporary, "meanwhile.sqlite"))
    store.createOwner({ id: ownerId, name: "Acme", createdAt: timestamp })
    store.createPrincipal({
      id: principalId,
      ownerId,
      kind: "person",
      displayName: "Bob Li",
      ownerRole: "member",
      createdAt: timestamp,
    })
    store.upsertExternalIdentityWithAudit({
      identity: {
        id: identityId,
        ownerId,
        principalId,
        provider: "github",
        subjectId: "12345",
        login: "bob",
        displayName: "Bob Li",
        avatarUrl: null,
        createdAt: timestamp,
        lastVerifiedAt: timestamp,
        revokedAt: null,
      },
      audit: audit("external_identity.link", "external_identity", identityId),
    })
    store.upsertExternalProjectGrantWithAudit({
      grant: {
        id: grantId,
        ownerId,
        principalId,
        externalIdentityId: identityId,
        provider: "github",
        accountId: "44",
        accountName: "acme",
        installationId: "55",
        repositoryId: "66",
        repositoryName: "northstar",
        repositoryFullName: "acme/northstar",
        repositoryUrl: "https://github.com/acme/northstar",
        private: true,
        access: "administer",
        observedAt: timestamp,
        expiresAt: "2026-07-25T08:00:00.000Z",
        revokedAt: null,
      },
      audit: audit("external_project_grant.observe", "external_project_grant", grantId),
    })

    let idSequence = 20
    const service = new ConnectedOnboardingService(
      store,
      () => [],
      () => new Date(timestamp),
      () => `91000000-0000-4000-8000-${String(idSequence++).padStart(12, "0")}`,
    )
    const context: RequestContext = {
      requestId: "request-import",
      traceId: null,
      ownerId,
      principalId,
      ownerRole: "member",
      apiKeyId: null,
    }

    const first = service.importRepository(context, grantId)
    const replay = service.importRepository(context, grantId)
    expect(first).toMatchObject({
      created: true,
      project: { name: "northstar" },
      binding: { repositoryFullName: "acme/northstar" },
      selection: { hiddenAt: null },
    })
    expect(replay).toMatchObject({
      created: false,
      project: { id: first.project.id },
      binding: { id: first.binding.id },
    })
    expect(store.getProjectMember(ownerId, first.project.id, principalId)).toBeNull()
    expect(service.snapshot(context).projects).toEqual([
      {
        project: first.project,
        access: "administer",
        source: "github",
        selected: true,
      },
    ])
    const actions = store.listAudit(ownerId).map((entry) => entry.action)
    expect(actions.filter((action) => action === "project.import")).toHaveLength(1)
    expect(actions.filter((action) => action === "project_repository_binding.bind")).toHaveLength(1)
    expect(actions.filter((action) => action === "project_selection.show")).toHaveLength(2)
  })
})

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
    createdAt: timestamp,
  }
}
