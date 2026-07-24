import { describe, expect, test } from "bun:test"
import { createApplication } from "../../src/app"
import { loadConfig } from "../../src/config"
import { initializeInstrumentation } from "../../src/instrumentation"

describe("operational configuration", () => {
  test("makes run and session admission capacity explicit and bounded", () => {
    expect(loadConfig({})).toMatchObject({ runConcurrency: 2, sessionConcurrency: 2 })
    expect(
      loadConfig({ MEANWHILE_RUN_CONCURRENCY: "7", MEANWHILE_SESSION_CONCURRENCY: "11" }),
    ).toMatchObject({ runConcurrency: 7, sessionConcurrency: 11 })
    expect(() => loadConfig({ MEANWHILE_RUN_CONCURRENCY: "0" })).toThrow()
    expect(() => loadConfig({ MEANWHILE_SESSION_CONCURRENCY: "101" })).toThrow()
  })

  test("keeps host execution behind an explicit local-provider policy", () => {
    expect(loadConfig({}).localProvider).toEqual({
      enabled: true,
      unsafeHostExecution: false,
    })
    expect(
      loadConfig({
        MEANWHILE_HOST: "0.0.0.0",
        MEANWHILE_LOCAL_PROVIDER: "auto",
      }).localProvider.enabled,
    ).toBeFalse()
    expect(() =>
      loadConfig({
        MEANWHILE_HOST: "0.0.0.0",
        MEANWHILE_LOCAL_PROVIDER: "enabled",
      }),
    ).toThrow("MEANWHILE_ALLOW_UNSAFE_LOCAL_PROVIDER")
    expect(
      loadConfig({
        MEANWHILE_HOST: "0.0.0.0",
        MEANWHILE_LOCAL_PROVIDER: "enabled",
        MEANWHILE_ALLOW_UNSAFE_LOCAL_PROVIDER: "true",
      }).localProvider,
    ).toEqual({ enabled: true, unsafeHostExecution: true })
    expect(loadConfig({ MEANWHILE_LOCAL_PROVIDER: "disabled" }).localProvider.enabled).toBeFalse()
  })

  test("validates an explicit deny-by-default secret source catalog", () => {
    expect(loadConfig({}).secretSourceCatalog).toEqual([])
    expect(
      loadConfig({
        MEANWHILE_SECRET_ENV_ALLOWLIST: "OPENAI_API_KEY,ANTHROPIC_API_KEY",
      }).secretSourceCatalog,
    ).toEqual(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"])
    expect(() =>
      loadConfig({ MEANWHILE_SECRET_ENV_ALLOWLIST: "OPENAI_API_KEY,OPENAI_API_KEY" }),
    ).toThrow("duplicate")
    expect(() => loadConfig({ MEANWHILE_SECRET_ENV_ALLOWLIST: "CLOUDFLARE_BRIDGE_TOKEN" })).toThrow(
      "reserved",
    )
    expect(() =>
      loadConfig({ MEANWHILE_SECRET_ENV_ALLOWLIST: "OPENAI_API_KEY, ANTHROPIC_API_KEY" }),
    ).toThrow("valid environment name")
  })

  test("keeps Cloudflare image evidence paired with the configured bridge", () => {
    expect(() =>
      loadConfig({
        CLOUDFLARE_RUNTIME_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
      }),
    ).toThrow("Cloudflare execution evidence")

    expect(
      loadConfig({
        CLOUDFLARE_BRIDGE_URL: "https://bridge.example.test",
        CLOUDFLARE_BRIDGE_TOKEN: "bridge-test-token-that-is-at-least-thirty-two-bytes",
        CLOUDFLARE_RUNTIME_IMAGE_REFERENCE:
          "registry.example.test/meanwhile/runtime@sha256:immutable",
        CLOUDFLARE_RUNTIME_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
        CLOUDFLARE_RUNNER_DIGEST: "b".repeat(64),
      }).cloudflare,
    ).toEqual({
      bridgeUrl: "https://bridge.example.test",
      token: "bridge-test-token-that-is-at-least-thirty-two-bytes",
      runtimeImageReference: "registry.example.test/meanwhile/runtime@sha256:immutable",
      runtimeImageDigest: `sha256:${"a".repeat(64)}`,
      runnerDigest: "b".repeat(64),
    })
  })

  test("requires and normalizes a browser-facing origin for wildcard preview binds", () => {
    expect(() => loadConfig({ MEANWHILE_PREVIEW_HOST: "0.0.0.0" })).toThrow(
      "MEANWHILE_PREVIEW_PUBLIC_URL",
    )

    const config = loadConfig({
      MEANWHILE_PREVIEW_HOST: "0.0.0.0",
      MEANWHILE_PREVIEW_PUBLIC_URL: "https://previews.example.test/",
    })
    expect(config.previewPublicUrl).toBe("https://previews.example.test")
  })

  test("requires complete external-auth providers and a separate sealed credential key", () => {
    expect(() => loadConfig({ MEANWHILE_GITHUB_CLIENT_ID: "github-client" })).toThrow(
      "must be configured together",
    )
    expect(() =>
      loadConfig({
        MEANWHILE_EXTERNAL_AUTH_OWNER_ID: "93000000-0000-4000-8000-000000000001",
      }),
    ).toThrow("unused auth keys")
    expect(() => loadConfig({ MEANWHILE_EXTERNAL_REGISTRATION: "open" })).toThrow(
      "unused auth keys",
    )
    expect(() =>
      loadConfig({
        MEANWHILE_EXTERNAL_AUTH_OWNER_ID: "93000000-0000-4000-8000-000000000001",
        MEANWHILE_IDENTITY_CREDENTIAL_KEY: "a".repeat(43),
        MEANWHILE_GITHUB_CLIENT_ID: "github-client",
        MEANWHILE_GITHUB_CLIENT_SECRET: "github-secret",
        MEANWHILE_GITHUB_CALLBACK_URL: "http://example.test/auth/github/callback",
      }),
    ).toThrow("exact HTTPS or loopback")

    expect(
      loadConfig({
        MEANWHILE_EXTERNAL_AUTH_OWNER_ID: "93000000-0000-4000-8000-000000000001",
        MEANWHILE_IDENTITY_CREDENTIAL_KEY: "a".repeat(43),
        MEANWHILE_IDENTITY_CREDENTIAL_KEY_VERSION: "key-2026-07",
        MEANWHILE_EXTERNAL_REGISTRATION: "open",
        MEANWHILE_GITHUB_CLIENT_ID: "github-client",
        MEANWHILE_GITHUB_CLIENT_SECRET: "github-secret",
        MEANWHILE_GITHUB_CALLBACK_URL: "https://meanwhile.example/auth/github/callback",
        MEANWHILE_GOOGLE_CLIENT_ID: "google-client",
        MEANWHILE_GOOGLE_CLIENT_SECRET: "google-secret",
        MEANWHILE_GOOGLE_CALLBACK_URL: "http://127.0.0.1:7333/auth/google/callback",
      }).externalAuth,
    ).toEqual({
      ownerId: "93000000-0000-4000-8000-000000000001",
      registration: "open",
      credentialKey: "a".repeat(43),
      credentialKeyVersion: "key-2026-07",
      github: {
        clientId: "github-client",
        clientSecret: "github-secret",
        callbackUrl: "https://meanwhile.example/auth/github/callback",
      },
      google: {
        clientId: "google-client",
        clientSecret: "google-secret",
        callbackUrl: "http://127.0.0.1:7333/auth/google/callback",
      },
    })
  })

  test("fails application composition when the configured default provider is absent", async () => {
    const instrumentation = await initializeInstrumentation({
      serviceName: "meanwhile-config-test",
      serviceVersion: "0.1.0",
      sink: { write() {} },
    })
    try {
      await expect(
        createApplication({
          config: loadConfig({ MEANWHILE_DEFAULT_PROVIDER: "missing" }),
          instrumentation,
        }),
      ).rejects.toThrow("Default runtime provider 'missing' is not configured")
    } finally {
      await instrumentation.shutdown()
    }
  })

  test("rechecks unsafe local-provider policy at application composition", async () => {
    const instrumentation = await initializeInstrumentation({
      serviceName: "meanwhile-config-policy-test",
      serviceVersion: "0.1.0",
      sink: { write() {} },
    })
    try {
      await expect(
        createApplication({
          config: {
            ...loadConfig({}),
            host: "0.0.0.0",
            localProvider: { enabled: true, unsafeHostExecution: false },
          },
          instrumentation,
        }),
      ).rejects.toThrow("MEANWHILE_ALLOW_UNSAFE_LOCAL_PROVIDER")
    } finally {
      await instrumentation.shutdown()
    }
  })
})
