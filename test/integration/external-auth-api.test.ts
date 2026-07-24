import { afterEach, describe, expect, test } from "bun:test"
import { LOCAL_BOOTSTRAP_OWNER_ID } from "../../src/auth"
import { type ApplicationHarness, createApplicationHarness } from "../application-harness"

let harness: ApplicationHarness | null = null

afterEach(async () => {
  await harness?.close()
  harness = null
})

describe("external auth API", () => {
  test("publishes configured providers and starts login before browser authentication", async () => {
    harness = await createApplicationHarness({
      externalAuth: {
        ownerId: LOCAL_BOOTSTRAP_OWNER_ID,
        registration: "closed",
        credentialKey: new Uint8Array(32)
          .fill(9)
          .toBase64({ alphabet: "base64url", omitPadding: true }),
        credentialKeyVersion: "v1",
        github: {
          clientId: "github-client",
          clientSecret: "github-secret",
          callbackUrl: "http://127.0.0.1:7333/auth/github/callback",
        },
      },
    })

    const providers = await harness.application.app.request("/external-auth/providers")
    expect(providers.status).toBe(200)
    expect(await providers.json()).toEqual({
      providers: [{ provider: "github", label: "GitHub" }],
      registration: "closed",
    })
    expect(providers.headers.get("Cache-Control")).toBe("no-store")

    const started = await harness.application.app.request("/external-auth/github/login", {
      method: "POST",
    })
    expect(started.status).toBe(200)
    const body = (await started.json()) as { authorizationUrl: string }
    const authorization = new URL(body.authorizationUrl)
    expect(authorization.origin).toBe("https://github.com")
    expect(authorization.searchParams.get("client_id")).toBe("github-client")
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256")
    expect(authorization.searchParams.get("state")).not.toBeNull()

    const absent = await harness.application.app.request("/external-auth/google/login", {
      method: "POST",
    })
    expect(absent.status).toBe(404)
    expect(await absent.json()).toMatchObject({ error: { code: "NOT_FOUND" } })

    const unboundLinkCallback = await harness.application.app.request(
      "/external-auth/github/link-callback",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "sealed", code: "code", error: null }),
      },
    )
    expect(unboundLinkCallback.status).toBe(401)
    expect(await unboundLinkCallback.json()).toMatchObject({
      error: { code: "UNAUTHENTICATED" },
    })
  })
})
