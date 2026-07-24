import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RequestContext } from "../../src/domain"
import { AesGcmCredentialVault } from "../../src/integrations/credential-vault"
import type {
  ExternalAuthExchangeResult,
  ExternalAuthProviderAdapter,
} from "../../src/integrations/external-auth"
import { SealedExternalAuthStateCodec } from "../../src/integrations/sealed-external-auth-state"
import { Store } from "../../src/persistence/store"
import { ExternalAuthService } from "../../src/services/external-auth-service"
import { PrincipalInvitationService } from "../../src/services/principal-invitation-service"

const ownerId = "94000000-0000-4000-8000-000000000001"
const principalId = "94000000-0000-4000-8000-000000000002"
const now = new Date("2026-07-24T08:00:00.000Z")
let temporary: string | null = null
let store: Store | null = null

afterEach(async () => {
  store?.close()
  store = null
  if (temporary !== null) await rm(temporary, { recursive: true, force: true })
  temporary = null
})

describe("external auth service", () => {
  test("links once, then signs in without exposing provider tokens", async () => {
    const { active, service, vault } = await setup(githubResult())
    const startedLink = await service.startLink("github", context())
    const linked = await service.callback({
      provider: "github",
      expectedIntent: "link",
      context: context(),
      state: stateFrom(startedLink.authorizationUrl),
      code: "link-code",
      providerError: null,
      request: { requestId: "request-link", traceId: null },
    })
    expect(linked.intent).toBe("link")
    expect(linked.identity).toMatchObject({
      principalId,
      provider: "github",
      subjectId: "github-subject-1",
    })
    expect(linked.secret).toMatch(/^mws_/)
    expect(linked.grants).toHaveLength(1)
    const stored = active.getActiveIdentityCredential(ownerId, linked.identity.id)
    expect(stored).not.toBeNull()
    expect(stored?.sealedPayload).not.toContain("github-access-token")
    const plaintext = await vault.open(stored?.sealedPayload ?? "", {
      purpose: "identity_credential",
      ownerId,
      provider: "github",
      resourceId: linked.identity.id,
    })
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({
      version: 1,
      accessToken: "github-access-token",
      refreshToken: "github-refresh-token",
    })
    plaintext.fill(0)

    const startedLogin = await service.startLogin("github")
    const loggedIn = await service.callback({
      provider: "github",
      expectedIntent: "login",
      state: stateFrom(startedLogin.authorizationUrl),
      code: "login-code",
      providerError: null,
      request: { requestId: "request-login", traceId: "trace-login" },
    })
    expect(loggedIn.intent).toBe("login")
    expect(loggedIn.identity.id).toBe(linked.identity.id)
    expect(active.listAudit(ownerId).map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "external_identity.link",
        "external_identity.verify",
        "identity_credential.rotate",
        "external_project_grant.observe",
        "browser_session.create",
      ]),
    )
  })

  test("fails closed for an unlinked login and leaves no session or identity", async () => {
    const { active, service } = await setup(githubResult())
    const started = await service.startLogin("github")
    await expect(
      service.callback({
        provider: "github",
        expectedIntent: "login",
        state: stateFrom(started.authorizationUrl),
        code: "unknown-code",
        providerError: null,
        request: { requestId: "request-unknown", traceId: null },
      }),
    ).rejects.toMatchObject({ code: "EXTERNAL_IDENTITY_NOT_LINKED", status: 403 })
    expect(active.getExternalIdentityBySubject(ownerId, "github", "github-subject-1")).toBeNull()
    expect(
      active.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM browser_sessions")
        .get()?.count,
    ).toBe(0)
  })

  test("open registration atomically creates one stable Principal before onboarding", async () => {
    const { active, service } = await setup(githubResult(), undefined, () => new Date(now), "open")
    const started = await service.startLogin("github")
    const registered = await service.callback({
      provider: "github",
      expectedIntent: "login",
      state: stateFrom(started.authorizationUrl),
      code: "registration-code",
      providerError: null,
      request: { requestId: "request-registration", traceId: null },
    })

    expect(registered.identity.principalId).not.toBe(principalId)
    expect(active.getPrincipal(ownerId, registered.identity.principalId)).toMatchObject({
      kind: "person",
      displayName: "Alice Chen",
      ownerRole: "member",
      disabledAt: null,
    })
    expect(registered.grants).toHaveLength(1)
    expect(active.listAudit(ownerId).map((entry) => entry.action)).toContain(
      "principal.external_register",
    )

    const repeated = await service.startLogin("github")
    const signedIn = await service.callback({
      provider: "github",
      expectedIntent: "login",
      state: stateFrom(repeated.authorizationUrl),
      code: "registration-login-code",
      providerError: null,
      request: { requestId: "request-registration-login", traceId: null },
    })
    expect(signedIn.identity.principalId).toBe(registered.identity.principalId)
    expect(
      active.database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM principals").get()
        ?.count,
    ).toBe(2)
  })

  test("rejects an expired sealed transaction before calling the provider", async () => {
    let exchanges = 0
    const result = githubResult()
    const adapter = fakeGitHub(result, () => {
      exchanges += 1
    })
    const { service, stateCodec, vault, active } = await setup(
      result,
      adapter,
      () => new Date(now.getTime()),
    )
    const started = await service.startLink("github", context())
    const expired = new ExternalAuthService(
      ownerId,
      [{ adapter, redirectUri: "http://127.0.0.1:7333/auth/github/callback", label: "GitHub" }],
      stateCodec,
      vault,
      active,
      () => new Date(now.getTime() + 6 * 60 * 1_000),
    )
    await expect(
      expired.callback({
        provider: "github",
        expectedIntent: "link",
        context: context(),
        state: stateFrom(started.authorizationUrl),
        code: "late-code",
        providerError: null,
        request: { requestId: "request-expired", traceId: null },
      }),
    ).rejects.toMatchObject({ code: "EXTERNAL_AUTH_TRANSACTION_INVALID", status: 400 })
    expect(exchanges).toBe(0)
  })

  test("never redeems a link transaction through the public login callback", async () => {
    let exchanges = 0
    const result = githubResult()
    const adapter = fakeGitHub(result, () => {
      exchanges += 1
    })
    const { service } = await setup(result, adapter)
    const started = await service.startLink("github", context())
    const state = stateFrom(started.authorizationUrl)
    await expect(
      service.callback({
        provider: "github",
        expectedIntent: "login",
        state,
        code: "wrong-boundary-code",
        providerError: null,
        request: { requestId: "request-wrong-boundary", traceId: null },
      }),
    ).rejects.toMatchObject({ code: "EXTERNAL_AUTH_TRANSACTION_INVALID", status: 400 })
    await expect(
      service.callback({
        provider: "github",
        expectedIntent: "link",
        state,
        code: "missing-session-code",
        providerError: null,
        request: { requestId: "request-missing-session", traceId: null },
      }),
    ).rejects.toMatchObject({ code: "EXTERNAL_AUTH_TRANSACTION_INVALID", status: 400 })
    expect(exchanges).toBe(0)
  })

  test("atomically redeems one invitation into an identity and browser session", async () => {
    const { active, service } = await setup(githubResult())
    const invitations = new PrincipalInvitationService(active, () => new Date(now))
    const created = await invitations.create(context(), principalId)
    const started = await service.startInvitation("github", created.secret)
    const state = stateFrom(started.authorizationUrl)

    const completed = await service.callback({
      provider: "github",
      expectedIntent: "invite",
      state,
      code: "invitation-code",
      providerError: null,
      request: { requestId: "request-invitation", traceId: null },
    })

    expect(completed.intent).toBe("invite")
    expect(completed.identity.principalId).toBe(principalId)
    expect(active.getPrincipalInvitation(ownerId, created.invitation.id)?.redeemedAt).toBe(
      now.toISOString(),
    )
    expect(active.listAudit(ownerId).map((entry) => entry.action)).toContain(
      "principal_invitation.redeem",
    )
    await expect(
      service.callback({
        provider: "github",
        expectedIntent: "invite",
        state,
        code: "replayed-invitation-code",
        providerError: null,
        request: { requestId: "request-invitation-replay", traceId: null },
      }),
    ).rejects.toMatchObject({ code: "PRINCIPAL_INVITATION_INVALID", status: 401 })
    expect(
      active.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM browser_sessions")
        .get()?.count,
    ).toBe(1)
  })

  test("rejects a revoked invitation before provider authorization starts", async () => {
    const { active, service } = await setup(githubResult())
    const invitations = new PrincipalInvitationService(active, () => new Date(now))
    const created = await invitations.create(context(), principalId)
    invitations.revoke(context(), created.invitation.id)

    await expect(service.startInvitation("github", created.secret)).rejects.toMatchObject({
      code: "PRINCIPAL_INVITATION_INVALID",
      status: 401,
    })
  })
})

async function setup(
  result: ExternalAuthExchangeResult,
  adapter: ExternalAuthProviderAdapter | undefined = fakeGitHub(result),
  clock: () => Date = () => new Date(now),
  registration: "closed" | "open" = "closed",
) {
  temporary = await mkdtemp(join(tmpdir(), "meanwhile-external-auth-service-"))
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
  const vault = await AesGcmCredentialVault.create({
    keyVersion: "v1",
    key: new Uint8Array(32).fill(7),
  })
  const stateCodec = new SealedExternalAuthStateCodec(ownerId, vault)
  let id = 10
  const service = new ExternalAuthService(
    ownerId,
    [
      {
        adapter: adapter ?? fakeGitHub(result),
        redirectUri: "http://127.0.0.1:7333/auth/github/callback",
        label: "GitHub",
      },
    ],
    stateCodec,
    vault,
    store,
    clock,
    () => `94000000-0000-4000-8000-${String(id++).padStart(12, "0")}`,
    registration,
  )
  return { active: store, service, vault, stateCodec }
}

function fakeGitHub(
  result: ExternalAuthExchangeResult,
  onExchange: () => void = () => undefined,
): ExternalAuthProviderAdapter {
  return {
    provider: "github",
    authorizationUrl(input) {
      const url = new URL("https://github.test/login/oauth/authorize")
      url.searchParams.set("state", input.state)
      url.searchParams.set("code_challenge", input.codeChallenge)
      return url
    },
    async exchange() {
      onExchange()
      return result
    },
  }
}

function githubResult(): ExternalAuthExchangeResult {
  return {
    identity: {
      subjectId: "github-subject-1",
      login: "alice",
      displayName: "Alice Chen",
      avatarUrl: "https://avatars.example/alice",
    },
    credential: {
      accessToken: "github-access-token",
      refreshToken: "github-refresh-token",
      accessExpiresAt: "2026-07-24T16:00:00.000Z",
      refreshExpiresAt: "2027-01-24T08:00:00.000Z",
    },
    repositories: [
      {
        provider: "github",
        installationId: "installation-1",
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
      },
    ],
  }
}

function stateFrom(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state")
  if (state === null) throw new Error("Authorization URL has no state")
  return state
}

function context(): RequestContext {
  return {
    requestId: "request-start",
    traceId: null,
    ownerId,
    principalId,
    ownerRole: "admin",
    apiKeyId: null,
  }
}
