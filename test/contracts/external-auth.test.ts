import { describe, expect, test } from "bun:test"
import {
  AesGcmCredentialVault,
  CredentialVaultError,
} from "../../src/integrations/credential-vault"
import { createPkce } from "../../src/integrations/external-auth"
import { GitHubExternalAuth } from "../../src/integrations/github-external-auth"
import {
  GoogleExternalAuth,
  GoogleJwksIdTokenVerifier,
} from "../../src/integrations/google-external-auth"
import { SealedExternalAuthStateCodec } from "../../src/integrations/sealed-external-auth-state"

const OWNER_ID = "00000000-0000-4000-8000-000000000001"
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000002"
const NOW = new Date("2026-07-24T12:00:00.000Z")

describe("external auth credential boundary", () => {
  test("seals values to an exact owner, provider, purpose, resource, and key version", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    const vault = await AesGcmCredentialVault.create({ keyVersion: "local-2026-07", key })
    const context = {
      purpose: "identity_credential" as const,
      ownerId: OWNER_ID,
      provider: "github" as const,
      resourceId: "identity-1",
    }
    const sealed = await vault.seal(new TextEncoder().encode("ghu_never-persist-plain"), context)

    expect(sealed).not.toContain("ghu_never-persist-plain")
    expect(new TextDecoder().decode(await vault.open(sealed, context))).toBe(
      "ghu_never-persist-plain",
    )
    await expect(
      vault.open(sealed, { ...context, resourceId: "identity-2" }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_DECRYPTION_FAILED" })
    await expect(vault.open(`${sealed.slice(0, -1)}A`, context)).rejects.toBeInstanceOf(
      CredentialVaultError,
    )
  })

  test("round-trips a bounded sealed PKCE state without exposing the verifier", async () => {
    const vault = await AesGcmCredentialVault.create({
      keyVersion: "test",
      key: crypto.getRandomValues(new Uint8Array(32)),
    })
    const codec = new SealedExternalAuthStateCodec(OWNER_ID, vault)
    const pkce = await createPkce()
    const state = {
      version: 1 as const,
      provider: "github" as const,
      ownerId: OWNER_ID,
      intent: "link" as const,
      principalId: PRINCIPAL_ID,
      redirectUri: "https://meanwhile.example/auth/github/callback",
      codeVerifier: pkce.codeVerifier,
      nonce: pkce.nonce,
      issuedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    }
    const sealed = await codec.seal(state)

    expect(sealed).not.toContain(pkce.codeVerifier)
    expect(await codec.open("github", sealed)).toEqual(state)
    await expect(codec.open("google", sealed)).rejects.toBeInstanceOf(CredentialVaultError)
    expect(pkce.codeVerifier).toHaveLength(43)
    expect(pkce.codeChallenge).toHaveLength(43)
    expect(pkce.nonce).toHaveLength(43)
  })
})

describe("GitHub App external auth", () => {
  test("uses S256 PKCE, receives expiring tokens, resolves identity, and lists intersection access", async () => {
    const requests: Request[] = []
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      requests.push(request)
      const url = new URL(request.url)
      if (url.pathname === "/login/oauth/access_token") {
        return Response.json({
          access_token: "ghu_access",
          token_type: "bearer",
          expires_in: 28_800,
          refresh_token: "ghr_refresh",
          refresh_token_expires_in: 15_897_600,
        })
      }
      if (url.pathname === "/user") {
        return Response.json({
          id: 42,
          login: "bob",
          name: "Bob Li",
          avatar_url: "https://avatars.example/bob.png",
        })
      }
      return new Response("Not Found", { status: 404 })
    }
    const directoryCalls: string[] = []
    const adapter = new GitHubExternalAuth({
      clientId: "github-client",
      clientSecret: "github-secret",
      redirectUri: "https://meanwhile.example/auth/github/callback",
      authorizationOrigin: "https://github.example/",
      apiOrigin: "https://api.example/",
      fetch,
      directory: {
        provider: "github",
        async list(credential) {
          directoryCalls.push(credential.bearerToken)
          return [
            {
              provider: "github",
              installationId: "7",
              account: { id: "1", login: "northstar", type: "organization", avatarUrl: null },
              repository: {
                id: "9",
                name: "core",
                fullName: "northstar/core",
                private: true,
                defaultBranch: "main",
                webUrl: "https://github.example/northstar/core",
              },
              access: "participate",
            },
          ]
        },
      },
      now: () => NOW,
    })
    const authorizationUrl = adapter.authorizationUrl({
      state: "sealed-state",
      codeChallenge: "challenge",
      nonce: "unused",
    })
    expect(Object.fromEntries(authorizationUrl.searchParams)).toMatchObject({
      client_id: "github-client",
      redirect_uri: "https://meanwhile.example/auth/github/callback",
      state: "sealed-state",
      code_challenge: "challenge",
      code_challenge_method: "S256",
    })

    const result = await adapter.exchange({
      code: "one-time-code",
      codeVerifier: "verifier",
      nonce: "unused",
    })
    expect(result.identity).toEqual({
      subjectId: "42",
      login: "bob",
      displayName: "Bob Li",
      avatarUrl: "https://avatars.example/bob.png",
    })
    expect(result.credential).toEqual({
      accessToken: "ghu_access",
      refreshToken: "ghr_refresh",
      accessExpiresAt: "2026-07-24T20:00:00.000Z",
      refreshExpiresAt: "2027-01-24T12:00:00.000Z",
    })
    expect(result.repositories).toHaveLength(1)
    expect(directoryCalls).toEqual(["ghu_access"])
    expect(await requests[0]?.text()).toContain("code_verifier=verifier")
    expect(requests[1]?.headers.get("Authorization")).toBe("Bearer ghu_access")
  })

  test("rotates both GitHub access and refresh tokens", async () => {
    const requests: Request[] = []
    const adapter = new GitHubExternalAuth({
      clientId: "github-client",
      clientSecret: "github-secret",
      redirectUri: "http://127.0.0.1:7333/auth/github/callback",
      fetch: async (input, init) => {
        requests.push(new Request(input, init))
        return Response.json({
          access_token: "ghu_new",
          token_type: "bearer",
          expires_in: 28_800,
          refresh_token: "ghr_new",
          refresh_token_expires_in: 15_897_600,
        })
      },
      now: () => NOW,
    })
    expect(await adapter.refresh({ refreshToken: "ghr_old" })).toMatchObject({
      accessToken: "ghu_new",
      refreshToken: "ghr_new",
    })
    const body = await requests[0]?.text()
    expect(body).toContain("grant_type=refresh_token")
    expect(body).toContain("refresh_token=ghr_old")
  })
})

describe("Google OIDC external auth", () => {
  test("keeps sign-in identity-only and validates the code response through the verifier", async () => {
    const requests: Request[] = []
    const verifierCalls: unknown[] = []
    const adapter = new GoogleExternalAuth({
      clientId: "google-client",
      clientSecret: "google-secret",
      redirectUri: "https://meanwhile.example/auth/google/callback",
      authorizationEndpoint: "https://accounts.example/authorize",
      tokenEndpoint: "https://accounts.example/token",
      fetch: async (input, init) => {
        requests.push(new Request(input, init))
        return Response.json({ id_token: "signed.id.token", token_type: "Bearer" })
      },
      verifier: {
        async verify(input) {
          verifierCalls.push(input)
          return {
            iss: "https://accounts.google.com",
            aud: "google-client",
            sub: "google-subject",
            exp: 2_000_000_000,
            iat: 1_700_000_000,
            nonce: "oidc-nonce",
            email: "bob@example.com",
            email_verified: true,
            name: "Bob Li",
            picture: "https://avatars.example/google-bob.png",
          }
        },
      },
    })
    const authorizationUrl = adapter.authorizationUrl({
      state: "sealed-state",
      codeChallenge: "challenge",
      nonce: "oidc-nonce",
    })
    expect(Object.fromEntries(authorizationUrl.searchParams)).toMatchObject({
      response_type: "code",
      scope: "openid profile email",
      state: "sealed-state",
      nonce: "oidc-nonce",
      code_challenge: "challenge",
      code_challenge_method: "S256",
    })
    const result = await adapter.exchange({
      code: "one-time-code",
      codeVerifier: "verifier",
      nonce: "oidc-nonce",
    })
    expect(result).toMatchObject({
      identity: {
        subjectId: "google-subject",
        login: "bob@example.com",
        displayName: "Bob Li",
      },
      credential: null,
      repositories: [],
    })
    expect(verifierCalls).toHaveLength(1)
    expect(await requests[0]?.text()).toContain("code_verifier=verifier")
  })

  test("verifies the Google RS256 signature, audience, nonce, and expiry locally", async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
    const idToken = await signJwt(pair.privateKey, {
      iss: "https://accounts.google.com",
      aud: "google-client",
      sub: "subject-1",
      exp: Math.floor(NOW.getTime() / 1_000) + 600,
      iat: Math.floor(NOW.getTime() / 1_000),
      nonce: "expected-nonce",
    })
    let jwksRequests = 0
    const verifier = new GoogleJwksIdTokenVerifier({
      now: () => NOW,
      jwksUri: "https://keys.example/jwks",
      fetch: async () => {
        jwksRequests += 1
        return Response.json(
          { keys: [{ ...publicJwk, kid: "key-1", alg: "RS256", use: "sig" }] },
          { headers: { "Cache-Control": "public, max-age=3600" } },
        )
      },
    })
    expect(
      await verifier.verify({
        idToken,
        audience: "google-client",
        nonce: "expected-nonce",
      }),
    ).toMatchObject({ sub: "subject-1" })
    expect(jwksRequests).toBe(1)
    await expect(
      verifier.verify({ idToken, audience: "google-client", nonce: "wrong" }),
    ).rejects.toMatchObject({ authorizationRejected: true })
  })
})

const signJwt = async (key: CryptoKey, payload: Record<string, unknown>): Promise<string> => {
  const encode = (value: unknown) =>
    new TextEncoder()
      .encode(JSON.stringify(value))
      .toBase64({ alphabet: "base64url", omitPadding: true })
  const header = encode({ alg: "RS256", kid: "key-1", typ: "JWT" })
  const body = encode(payload)
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${body}`),
  )
  return `${header}.${body}.${new Uint8Array(signature).toBase64({ alphabet: "base64url", omitPadding: true })}`
}
