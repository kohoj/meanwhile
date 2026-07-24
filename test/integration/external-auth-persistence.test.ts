import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { issueBrowserSession } from "../../src/auth"
import type {
  AuditRecord,
  BrowserSession,
  ExternalIdentity,
  ExternalProjectGrant,
  IdentityCredential,
} from "../../src/domain"
import { Store } from "../../src/persistence/store"

const ownerId = "92000000-0000-4000-8000-000000000001"
const principalId = "92000000-0000-4000-8000-000000000002"
const otherPrincipalId = "92000000-0000-4000-8000-000000000003"
const projectId = "92000000-0000-4000-8000-000000000004"
const identityId = "92000000-0000-4000-8000-000000000005"
const at = "2026-07-24T08:00:00.000Z"
let temporary: string | null = null
let store: Store | null = null

afterEach(async () => {
  store?.close()
  store = null
  if (temporary !== null) await rm(temporary, { recursive: true, force: true })
  temporary = null
})

describe("external auth persistence", () => {
  test("atomically rotates sealed credentials, refreshes grants, and revokes stale bindings", async () => {
    const active = await setup()
    const first = await completion(1, ["repo-a", "repo-b"])
    const completed = active.completeExternalAuthentication(first)
    expect(completed.identity.id).toBe(identityId)
    expect(completed.credential).toMatchObject({
      id: credentialId(1),
      externalIdentityId: identityId,
      sealedPayload: "sealed-credential-1",
    })
    expect(completed.grants.map((grant) => grant.repositoryName)).toEqual(["repo-a", "repo-b"])
    expect(active.getActiveIdentityCredential(ownerId, identityId)?.id).toBe(credentialId(1))

    const staleGrant = completed.grants[1]
    if (staleGrant === undefined) throw new Error("Expected the second repository grant")
    active.bindProjectRepositoryWithAudit({
      binding: {
        id: "92000000-0000-4000-8000-000000000090",
        ownerId,
        projectId,
        grantId: staleGrant.id,
        provider: "github",
        accountId: staleGrant.accountId,
        accountName: staleGrant.accountName,
        installationId: staleGrant.installationId,
        repositoryId: staleGrant.repositoryId,
        repositoryName: staleGrant.repositoryName,
        repositoryFullName: staleGrant.repositoryFullName,
        repositoryUrl: staleGrant.repositoryUrl,
        private: staleGrant.private,
        boundByPrincipalId: principalId,
        createdAt: at,
        revokedAt: null,
      },
      audit: audit(
        "project_repository_binding.bind",
        "project_repository_binding",
        "92000000-0000-4000-8000-000000000090",
      ),
    })
    expect(active.listProjectRepositoryBindingsForPrincipal(ownerId, principalId)).toHaveLength(1)

    const second = await completion(2, ["repo-a"])
    const refreshed = active.completeExternalAuthentication(second)
    expect(refreshed.identity.id).toBe(identityId)
    expect(active.getActiveIdentityCredential(ownerId, identityId)?.id).toBe(credentialId(2))
    expect(active.listExternalProjectGrants(ownerId, principalId, at)).toHaveLength(1)
    expect(active.listProjectRepositoryBindingsForPrincipal(ownerId, principalId)).toEqual([])
    expect(
      active.database
        .query<{ revoked_at: string | null }, [string]>(
          "SELECT revoked_at FROM identity_credentials WHERE id=?",
        )
        .get(credentialId(1))?.revoked_at,
    ).toBe(at)
    expect(
      active.listAudit(ownerId).filter((entry) => entry.action === "browser_session.create"),
    ).toHaveLength(2)
  })

  test("never silently moves an external subject to another Principal", async () => {
    const active = await setup()
    active.completeExternalAuthentication(await completion(1, []))
    expect(() =>
      active.upsertExternalIdentityWithAudit({
        identity: { ...identity(otherPrincipalId), id: crypto.randomUUID() },
        audit: audit("external_identity.link", "external_identity", crypto.randomUUID()),
      }),
    ).toThrow("External identity is already linked")
    expect(
      active.getExternalIdentityBySubject(ownerId, "github", "github-subject-44")?.principalId,
    ).toBe(principalId)
  })

  test("records the audit when an API key creates a browser session", async () => {
    const active = await setup()
    const issued = await issueBrowserSession()
    const session = browserSession(99, issued)
    active.createBrowserSessionWithAudit({
      session,
      audit: audit("browser_session.create", "browser_session", session.id),
    })
    expect(active.listAudit(ownerId).map((entry) => entry.action)).toContain(
      "browser_session.create",
    )
  })
})

async function setup(): Promise<Store> {
  temporary = await mkdtemp(join(tmpdir(), "meanwhile-external-auth-persistence-"))
  store = new Store(join(temporary, "meanwhile.sqlite"))
  store.createOwner({ id: ownerId, name: "Acme", createdAt: at })
  for (const [id, name] of [
    [principalId, "Alice Chen"],
    [otherPrincipalId, "Bob Li"],
  ] as const) {
    store.createPrincipal({
      id,
      ownerId,
      kind: "person",
      displayName: name,
      ownerRole: "admin",
      createdAt: at,
    })
  }
  store.createProject({
    id: projectId,
    ownerId,
    name: "Northstar",
    slug: "northstar",
    createdAt: at,
    createdByPrincipalId: principalId,
  })
  return store
}

async function completion(sequence: number, repositories: readonly string[]) {
  const issued = await issueBrowserSession()
  const identityValue = identity(principalId)
  const credential: IdentityCredential = {
    id: credentialId(sequence),
    ownerId,
    principalId,
    externalIdentityId: identityId,
    provider: "github",
    sealedPayload: `sealed-credential-${sequence}`,
    keyVersion: "v1",
    accessExpiresAt: "2026-07-24T16:00:00.000Z",
    refreshExpiresAt: "2027-01-24T08:00:00.000Z",
    createdAt: at,
    updatedAt: at,
    revokedAt: null,
  }
  const grants = repositories.map(
    (repository, index): ExternalProjectGrant => ({
      id: `92000000-0000-4000-8000-${String(sequence * 100 + index).padStart(12, "0")}`,
      ownerId,
      principalId,
      externalIdentityId: identityId,
      provider: "github",
      accountId: "account-1",
      accountName: "acme",
      installationId: "installation-1",
      repositoryId: `repository-${repository}`,
      repositoryName: repository,
      repositoryFullName: `acme/${repository}`,
      repositoryUrl: `https://github.com/acme/${repository}`,
      private: true,
      access: "administer",
      observedAt: at,
      expiresAt: "2026-07-25T08:00:00.000Z",
      revokedAt: null,
    }),
  )
  const session = browserSession(sequence, issued)
  return {
    principal: null,
    identity: identityValue,
    credential,
    grants,
    session,
    invitationId: null,
    at,
    audits: {
      principal: null,
      identity: audit("external_identity.verify", "external_identity", identityId),
      credential: audit("identity_credential.rotate", "identity_credential", credential.id),
      grants: grants.map((grant) =>
        audit("external_project_grant.observe", "external_project_grant", grant.id),
      ),
      session: audit("browser_session.create", "browser_session", session.id),
      invitation: null,
    },
  } as const
}

function identity(id: string): ExternalIdentity {
  return {
    id: identityId,
    ownerId,
    principalId: id,
    provider: "github",
    subjectId: "github-subject-44",
    login: "alice",
    displayName: "Alice Chen",
    avatarUrl: "https://avatars.githubusercontent.com/u/44",
    createdAt: at,
    lastVerifiedAt: at,
    revokedAt: null,
  }
}

function browserSession(
  sequence: number,
  issued: Awaited<ReturnType<typeof issueBrowserSession>>,
): BrowserSession & { readonly prefix: string; readonly hash: string } {
  return {
    id: `92000000-0000-4000-8000-${String(800 + sequence).padStart(12, "0")}`,
    ownerId,
    principalId,
    prefix: issued.prefix,
    hash: issued.hash,
    createdAt: at,
    expiresAt: "2026-07-24T20:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
  }
}

function credentialId(sequence: number): string {
  return `92000000-0000-4000-8000-${String(700 + sequence).padStart(12, "0")}`
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
    requestId: "request-external-auth",
    traceId: null,
    metadata: {},
    createdAt: at,
  }
}
