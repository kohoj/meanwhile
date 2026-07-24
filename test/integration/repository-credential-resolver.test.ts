import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AuditRecord, ExternalProjectGrant } from "../../src/domain"
import { AesGcmCredentialVault } from "../../src/integrations/credential-vault"
import type { ExternalAuthProviderAdapter } from "../../src/integrations/external-auth"
import { sealGitHubIdentityCredential } from "../../src/integrations/identity-credential"
import type { RepositoryDirectoryEntry } from "../../src/integrations/repository-directory"
import { Store } from "../../src/persistence/store"
import { GitHubRepositoryCredentialResolver } from "../../src/services/repository-credential-resolver"

const ownerId = "95000000-0000-4000-8000-000000000001"
const principalId = "95000000-0000-4000-8000-000000000002"
const projectId = "95000000-0000-4000-8000-000000000003"
const identityId = "95000000-0000-4000-8000-000000000004"
const credentialId = "95000000-0000-4000-8000-000000000005"
const grantId = "95000000-0000-4000-8000-000000000006"
const repositoryUrl = "https://github.com/acme/northstar"
const now = new Date("2026-07-24T08:00:00.000Z")
let temporary: string | null = null
let store: Store | null = null

afterEach(async () => {
  store?.close()
  store = null
  if (temporary !== null) await rm(temporary, { recursive: true, force: true })
  temporary = null
})

describe("GitHub repository credential resolver", () => {
  test("revalidates the exact Project binding and confines the token to checkout material", async () => {
    const { active, vault } = await setup()
    let observedToken = ""
    const resolver = new GitHubRepositoryCredentialResolver(
      active,
      vault,
      githubProvider(async (token) => {
        observedToken = token
        return [directoryEntry()]
      }),
      () => new Date(now),
    )
    const material = await resolver.resolve({
      ownerId,
      principalId,
      projectId,
      repositoryUrl,
      resourceType: "run",
      resourceId: "95000000-0000-4000-8000-000000000090",
    })
    expect(observedToken).toBe("github-access-token")
    const gitAuthorization = `Basic ${new TextEncoder()
      .encode("x-access-token:github-access-token")
      .toBase64()}`
    expect(material?.environment).toEqual({
      MEANWHILE_REPOSITORY_CREDENTIAL: gitAuthorization,
    })
    expect(material?.redactor.redactString(`Git: ${gitAuthorization}`)).toBe("Git: [REDACTED]")
    material?.release()
    expect(material?.environment).toEqual({})
    expect(
      active.listExternalProjectGrants(ownerId, principalId, now.toISOString())[0],
    ).toMatchObject({ repositoryFullName: "acme/northstar", revokedAt: null })
  })

  test("revokes only the caller grant when GitHub no longer returns its repository", async () => {
    const { active, vault } = await setup()
    const resolver = new GitHubRepositoryCredentialResolver(
      active,
      vault,
      githubProvider(async () => []),
      () => new Date(now),
    )
    await expect(
      resolver.resolve({
        ownerId,
        principalId,
        projectId,
        repositoryUrl,
        resourceType: "session",
        resourceId: "95000000-0000-4000-8000-000000000091",
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_AUTHORIZATION_REVOKED", status: 409 })
    expect(
      active.listProjectRepositoryBindingsForPrincipal(ownerId, principalId, now.toISOString()),
    ).toHaveLength(1)
    expect(active.listExternalProjectGrants(ownerId, principalId, now.toISOString())).toEqual([])
    expect(active.listAudit(ownerId).map((entry) => entry.action)).toContain(
      "external_project_grant.revoke",
    )
  })

  test("does not expose credentials to an unbound repository", async () => {
    const { active, vault } = await setup()
    let calls = 0
    const resolver = new GitHubRepositoryCredentialResolver(
      active,
      vault,
      githubProvider(async () => {
        calls += 1
        return [directoryEntry()]
      }),
      () => new Date(now),
    )
    expect(
      await resolver.resolve({
        ownerId,
        principalId,
        projectId,
        repositoryUrl: "https://github.com/acme/other",
        resourceType: "run",
        resourceId: "95000000-0000-4000-8000-000000000092",
      }),
    ).toBeNull()
    expect(calls).toBe(0)
  })

  test("provider authority remains usable after an independent explicit membership is removed", async () => {
    const { active, vault } = await setup()
    expect(
      active.removeProjectMemberWithAudit({
        ownerId,
        projectId,
        principalId,
        removedAt: now.toISOString(),
        audit: audit("project_member.remove", "project", projectId),
      }),
    ).toBe(true)
    let calls = 0
    const resolver = new GitHubRepositoryCredentialResolver(
      active,
      vault,
      githubProvider(async () => {
        calls += 1
        return [directoryEntry()]
      }),
      () => new Date(now),
    )
    const material = await resolver.resolve({
      ownerId,
      principalId,
      projectId,
      repositoryUrl,
      resourceType: "run",
      resourceId: "95000000-0000-4000-8000-000000000093",
    })
    expect(material).not.toBeNull()
    expect(calls).toBe(1)
    expect(
      active.listProjectRepositoryBindingsForPrincipal(ownerId, principalId, now.toISOString()),
    ).toHaveLength(1)
    material?.release()
  })
})

async function setup() {
  temporary = await mkdtemp(join(tmpdir(), "meanwhile-repository-credential-"))
  store = new Store(join(temporary, "meanwhile.sqlite"))
  store.createOwner({ id: ownerId, name: "Acme", createdAt: now.toISOString() })
  store.createPrincipal({
    id: principalId,
    ownerId,
    kind: "person",
    displayName: "Alice Chen",
    ownerRole: "admin",
    createdAt: now.toISOString(),
  })
  store.createProject({
    id: projectId,
    ownerId,
    name: "Northstar",
    slug: "northstar",
    createdAt: now.toISOString(),
    createdByPrincipalId: principalId,
  })
  store.upsertExternalIdentityWithAudit({
    identity: {
      id: identityId,
      ownerId,
      principalId,
      provider: "github",
      subjectId: "github-subject-1",
      login: "alice",
      displayName: "Alice Chen",
      avatarUrl: null,
      createdAt: now.toISOString(),
      lastVerifiedAt: now.toISOString(),
      revokedAt: null,
    },
    audit: audit("external_identity.link", "external_identity", identityId),
  })
  const vault = await AesGcmCredentialVault.create({
    keyVersion: "v1",
    key: new Uint8Array(32).fill(5),
  })
  const material = {
    accessToken: "github-access-token",
    refreshToken: "github-refresh-token",
    accessExpiresAt: "2026-07-24T16:00:00.000Z",
    refreshExpiresAt: "2027-01-24T08:00:00.000Z",
  }
  store.rotateIdentityCredentialWithAudit({
    credential: {
      id: credentialId,
      ownerId,
      principalId,
      externalIdentityId: identityId,
      provider: "github",
      sealedPayload: await sealGitHubIdentityCredential({
        vault,
        ownerId,
        externalIdentityId: identityId,
        material,
      }),
      keyVersion: "v1",
      accessExpiresAt: material.accessExpiresAt,
      refreshExpiresAt: material.refreshExpiresAt,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      revokedAt: null,
    },
    at: now.toISOString(),
    audit: audit("identity_credential.rotate", "identity_credential", credentialId),
  })
  const grant = repositoryGrant()
  store.upsertExternalProjectGrantWithAudit({
    grant,
    audit: audit("external_project_grant.observe", "external_project_grant", grant.id),
  })
  store.bindProjectRepositoryWithAudit({
    binding: {
      id: "95000000-0000-4000-8000-000000000007",
      ownerId,
      projectId,
      grantId,
      provider: "github",
      accountId: grant.accountId,
      accountName: grant.accountName,
      installationId: grant.installationId,
      repositoryId: grant.repositoryId,
      repositoryName: grant.repositoryName,
      repositoryFullName: grant.repositoryFullName,
      repositoryUrl: grant.repositoryUrl,
      private: true,
      boundByPrincipalId: principalId,
      createdAt: now.toISOString(),
      revokedAt: null,
    },
    audit: audit(
      "project_repository_binding.bind",
      "project_repository_binding",
      "95000000-0000-4000-8000-000000000007",
    ),
  })
  return { active: store, vault }
}

function repositoryGrant(): ExternalProjectGrant {
  return {
    id: grantId,
    ownerId,
    principalId,
    externalIdentityId: identityId,
    provider: "github",
    accountId: "account-1",
    accountName: "acme",
    installationId: "installation-1",
    repositoryId: "repository-1",
    repositoryName: "northstar",
    repositoryFullName: "acme/northstar",
    repositoryUrl,
    private: true,
    access: "administer",
    observedAt: now.toISOString(),
    expiresAt: "2026-07-24T08:10:00.000Z",
    revokedAt: null,
  }
}

function directoryEntry(): RepositoryDirectoryEntry {
  return {
    provider: "github",
    installationId: "installation-1",
    account: { id: "account-1", login: "acme", type: "organization", avatarUrl: null },
    repository: {
      id: "repository-1",
      name: "northstar",
      fullName: "acme/northstar",
      private: true,
      defaultBranch: "main",
      webUrl: repositoryUrl,
    },
    access: "administer",
  }
}

function githubProvider(
  repositories: (accessToken: string) => Promise<readonly RepositoryDirectoryEntry[]>,
): ExternalAuthProviderAdapter {
  return {
    provider: "github",
    authorizationUrl: () => new URL("https://github.com/login/oauth/authorize"),
    exchange: async () => {
      throw new Error("Not used")
    },
    repositories: async ({ accessToken }) => repositories(accessToken),
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
    requestId: "repository-credential-test",
    traceId: null,
    metadata: {},
    createdAt: now.toISOString(),
  }
}
