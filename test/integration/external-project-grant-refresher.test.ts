import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AuditRecord, RequestContext } from "../../src/domain"
import { AesGcmCredentialVault } from "../../src/integrations/credential-vault"
import {
  type ExternalAuthProviderAdapter,
  ExternalAuthProviderError,
} from "../../src/integrations/external-auth"
import { sealGitHubIdentityCredential } from "../../src/integrations/identity-credential"
import type { RepositoryDirectoryEntry } from "../../src/integrations/repository-directory"
import { Store } from "../../src/persistence/store"
import { GitHubExternalProjectGrantRefresher } from "../../src/services/external-project-grant-refresher"

const ownerId = "95100000-0000-4000-8000-000000000001"
const principalId = "95100000-0000-4000-8000-000000000002"
const identityId = "95100000-0000-4000-8000-000000000003"
const observedAt = new Date("2026-07-24T08:00:00.000Z")
const refreshAt = new Date("2026-07-24T08:11:00.000Z")
let temporary: string | null = null
let store: Store | null = null

afterEach(async () => {
  store?.close()
  store = null
  if (temporary !== null) await rm(temporary, { recursive: true, force: true })
  temporary = null
})

describe("GitHub external Project grant refresher", () => {
  test("synchronizes the Principal name from GitHub even while repository grants are fresh", async () => {
    const { active, vault } = await setup()
    let calls = 0
    const refresher = new GitHubExternalProjectGrantRefresher(
      active,
      vault,
      provider(async () => {
        calls += 1
        return [directoryEntry()]
      }),
      () => new Date("2026-07-24T08:01:00.000Z"),
    )

    expect(await refresher.refresh(context())).toMatchObject({ status: "connected" })
    expect(calls).toBe(0)
    expect(active.getPrincipal(ownerId, principalId)?.displayName).toBe("Alice Chen")
    expect(active.listAudit(ownerId).map((entry) => entry.action)).toContain(
      "principal.github_profile.sync",
    )
  })

  test("refreshes an expired repository directory without another OAuth ceremony", async () => {
    const { active, vault } = await setup()
    let calls = 0
    const refresher = new GitHubExternalProjectGrantRefresher(
      active,
      vault,
      provider(async (accessToken) => {
        calls += 1
        expect(accessToken).toBe("github-access-token")
        return [directoryEntry()]
      }),
      () => new Date(refreshAt),
    )

    expect(await refresher.refresh(context())).toEqual({
      provider: "github",
      status: "connected",
      lastVerifiedAt: refreshAt.toISOString(),
    })
    expect(calls).toBe(1)
    expect(active.listExternalProjectGrants(ownerId, principalId, refreshAt.toISOString())).toEqual(
      [
        expect.objectContaining({
          id: "95100000-0000-4000-8000-000000000005",
          repositoryFullName: "acme/northstar",
          observedAt: refreshAt.toISOString(),
          revokedAt: null,
        }),
      ],
    )
    expect(await refresher.refresh(context())).toMatchObject({ status: "connected" })
    expect(calls).toBe(1)
    expect(active.listAudit(ownerId).map((entry) => entry.action)).toContain(
      "external_project_grants.refresh",
    )
  })

  test("coalesces concurrent stale reads into one provider refresh", async () => {
    const { active, vault } = await setup()
    let calls = 0
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const refresher = new GitHubExternalProjectGrantRefresher(
      active,
      vault,
      provider(async () => {
        calls += 1
        await pending
        return [directoryEntry()]
      }),
      () => new Date(refreshAt),
    )

    const first = refresher.refresh(context())
    const second = refresher.refresh(context())
    for (let attempts = 0; calls === 0 && attempts < 100; attempts += 1) {
      await Bun.sleep(1)
    }
    expect(calls).toBe(1)
    release?.()

    expect((await first).status).toBe("connected")
    expect((await second).status).toBe("connected")
    expect(calls).toBe(1)
  })

  test("distinguishes a valid empty repository directory from a missing authorization", async () => {
    const { active, vault } = await setup()
    const refresher = new GitHubExternalProjectGrantRefresher(
      active,
      vault,
      provider(async () => []),
      () => new Date(refreshAt),
    )

    expect(await refresher.refresh(context())).toMatchObject({ status: "connected" })
    expect(active.listExternalProjectGrants(ownerId, principalId, refreshAt.toISOString())).toEqual(
      [],
    )
    expect(active.listExternalIdentities(ownerId, principalId)[0]?.lastVerifiedAt).toBe(
      refreshAt.toISOString(),
    )
  })

  test("revokes rejected credentials and asks for reconnection", async () => {
    const { active, vault } = await setup()
    const refresher = new GitHubExternalProjectGrantRefresher(
      active,
      vault,
      provider(async () => {
        throw new ExternalAuthProviderError({
          provider: "github",
          operation: "repositories",
          status: 401,
          authorizationRejected: true,
          message: "Rejected",
        })
      }),
      () => new Date(refreshAt),
    )

    expect(await refresher.refresh(context())).toMatchObject({ status: "reconnect_required" })
    expect(active.getActiveIdentityCredential(ownerId, identityId)).toBeNull()
    expect(active.listExternalProjectGrants(ownerId, principalId, refreshAt.toISOString())).toEqual(
      [],
    )
    expect(active.listAudit(ownerId).map((entry) => entry.action)).toContain(
      "github_authorization.revoke",
    )
  })
})

async function setup() {
  temporary = await mkdtemp(join(tmpdir(), "meanwhile-project-grant-refresh-"))
  store = new Store(join(temporary, "meanwhile.sqlite"))
  store.createOwner({ id: ownerId, name: "Acme", createdAt: observedAt.toISOString() })
  store.createPrincipal({
    id: principalId,
    ownerId,
    kind: "person",
    displayName: "Owner",
    ownerRole: "member",
    createdAt: observedAt.toISOString(),
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
      avatarUrl: "https://avatars.githubusercontent.com/u/1",
      createdAt: observedAt.toISOString(),
      lastVerifiedAt: observedAt.toISOString(),
      revokedAt: null,
    },
    audit: audit("external_identity.link", "external_identity", identityId),
  })
  const vault = await AesGcmCredentialVault.create({
    keyVersion: "v1",
    key: new Uint8Array(32).fill(8),
  })
  const material = {
    accessToken: "github-access-token",
    refreshToken: "github-refresh-token",
    accessExpiresAt: "2026-07-24T16:00:00.000Z",
    refreshExpiresAt: "2027-01-24T08:00:00.000Z",
  }
  store.rotateIdentityCredentialWithAudit({
    credential: {
      id: "95100000-0000-4000-8000-000000000004",
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
      createdAt: observedAt.toISOString(),
      updatedAt: observedAt.toISOString(),
      revokedAt: null,
    },
    at: observedAt.toISOString(),
    audit: audit(
      "identity_credential.rotate",
      "identity_credential",
      "95100000-0000-4000-8000-000000000004",
    ),
  })
  store.upsertExternalProjectGrantWithAudit({
    grant: {
      id: "95100000-0000-4000-8000-000000000005",
      ownerId,
      principalId,
      externalIdentityId: identityId,
      provider: "github",
      accountId: "account-1",
      accountName: "acme",
      repositoryId: "repository-1",
      repositoryName: "northstar",
      repositoryFullName: "acme/northstar",
      repositoryUrl: "https://github.com/acme/northstar",
      private: true,
      access: "administer",
      observedAt: observedAt.toISOString(),
      expiresAt: "2026-07-24T08:10:00.000Z",
      revokedAt: null,
    },
    audit: audit(
      "external_project_grant.observe",
      "external_project_grant",
      "95100000-0000-4000-8000-000000000005",
    ),
  })
  return { active: store, vault }
}

function provider(
  repositories: (accessToken: string) => Promise<readonly RepositoryDirectoryEntry[]>,
): ExternalAuthProviderAdapter {
  return {
    provider: "github",
    authorizationUrl: () => new URL("https://github.com/login/oauth/authorize"),
    exchange: async () => {
      throw new Error("Not used")
    },
    refresh: async () => {
      throw new Error("Not used")
    },
    repositories: async ({ accessToken }) => repositories(accessToken),
  }
}

function directoryEntry(): RepositoryDirectoryEntry {
  return {
    provider: "github",
    account: { id: "account-1", login: "acme", type: "organization", avatarUrl: null },
    repository: {
      id: "repository-1",
      name: "northstar",
      fullName: "acme/northstar",
      private: true,
      defaultBranch: "main",
      webUrl: "https://github.com/acme/northstar",
    },
    access: "administer",
  }
}

function context(): RequestContext {
  return {
    requestId: "request-refresh",
    traceId: null,
    ownerId,
    principalId,
    ownerRole: "member",
    apiKeyId: null,
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
    createdAt: observedAt.toISOString(),
  }
}
