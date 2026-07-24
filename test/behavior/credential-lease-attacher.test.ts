import { expect, test } from "bun:test"

import {
  type AttachCredentialLeaseInput,
  type CredentialLease,
  credentialLeaseHandle,
  type RuntimeCredentialBroker,
} from "../../src/credentials"
import type { Store } from "../../src/persistence/store"
import type { RuntimeHandle } from "../../src/providers/runtime-provider"
import { SecretRedactor } from "../../src/secrets"
import { attachAgentCredentialLease } from "../../src/services/credential-lease-attacher"
import { testAgentSpec } from "../fixtures/agent-intent"

const runtime: RuntimeHandle = {
  kind: "runtime",
  version: 1,
  provider: "cloudflare",
  opaque: "runtime-1",
}

const lease: CredentialLease = {
  id: "lease-1",
  ownerId: "owner-1",
  resourceType: "run",
  resourceId: "run-1",
  runtimeId: "runtime-1",
  runtimeHandle: {
    kind: "runtime",
    version: 1,
    provider: "cloudflare",
    opaque: "runtime-1",
  },
  provider: "cloudflare",
  policyDigest: "0".repeat(64),
  handle: null,
  status: "attaching",
  attempts: 0,
  lastError: null,
  nextAttemptAt: null,
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
  revokedAt: null,
}

test("repository checkout host joins the durable runtime egress policy", async () => {
  const attached: AttachCredentialLeaseInput[] = []
  const broker: RuntimeCredentialBroker = {
    credentialProvider: "cloudflare",
    async attach(input) {
      attached.push(input)
      return {
        handle: credentialLeaseHandle("cloudflare", "runtime-1:lease-1"),
        environment: { OPENAI_API_KEY: "mwcap_v1_placeholder" },
      }
    },
    async revoke() {},
  }
  const store = {
    ensureCredentialLease: () => lease,
    materializeCredentialLease: () => ({ ...lease, status: "active" as const }),
  } as unknown as Pick<Store, "ensureCredentialLease" | "materializeCredentialLease">
  const secrets = {
    environment: { OPENAI_API_KEY: "source-secret-value" },
    redactor: new SecretRedactor(["source-secret-value"]),
    release() {},
  }

  const result = await attachAgentCredentialLease(store, {
    ownerId: "owner-1",
    resourceType: "run",
    resourceId: "run-1",
    runtimeId: "runtime-1",
    runtime,
    providerName: "cloudflare",
    credentialBroker: broker,
    agentSpec: testAgentSpec({
      networkPolicy: { allowedHosts: ["api.example.com"] },
      credentials: [
        { environmentVariable: "OPENAI_API_KEY", host: "api.openai.com", methods: ["POST"] },
      ],
    }),
    workspace: {
      type: "repository",
      url: "https://GitHub.com/example/project.git",
      revision: "main",
    },
    secrets,
    at: "2026-07-24T00:00:00.000Z",
  })

  expect(attached[0]?.allowedHosts).toEqual(["api.example.com", "api.openai.com", "github.com"])
  expect(attached[0]?.credentials).toEqual([
    {
      environmentVariable: "OPENAI_API_KEY",
      host: "api.openai.com",
      methods: ["POST"],
      value: "source-secret-value",
    },
  ])
  expect(result.environment).toEqual({ OPENAI_API_KEY: "mwcap_v1_placeholder" })
  await result.release()
})

test("repository checkout policy rejects embedded authority", async () => {
  const broker: RuntimeCredentialBroker = {
    credentialProvider: "cloudflare",
    async attach() {
      throw new Error("broker must not be called")
    },
    async revoke() {},
  }
  const store = {
    ensureCredentialLease: () => lease,
    materializeCredentialLease: () => ({ ...lease, status: "active" as const }),
  } as unknown as Pick<Store, "ensureCredentialLease" | "materializeCredentialLease">
  const secrets = {
    environment: {},
    redactor: new SecretRedactor([]),
    release() {},
  }

  await expect(
    attachAgentCredentialLease(store, {
      ownerId: "owner-1",
      resourceType: "run",
      resourceId: "run-1",
      runtimeId: "runtime-1",
      runtime,
      providerName: "cloudflare",
      credentialBroker: broker,
      agentSpec: testAgentSpec(),
      workspace: { type: "repository", url: "https://token@github.com/example/project.git" },
      secrets,
      at: "2026-07-24T00:00:00.000Z",
    }),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
})
