import { describe, expect, test } from "bun:test"
import { Store } from "../../src/persistence/store"
import {
  assertProviderProvenance,
  ExecutionProvenanceCatalog,
  parseExecutionProvenance,
} from "../../src/provenance"
import { RuntimeProviderRegistry } from "../../src/providers/registry"
import { TEST_AGENT_CATALOG_DIGEST, testAgentSpec } from "../fixtures/agent-intent"
import { MockRuntimeProvider } from "../fixtures/mock-provider"

describe("execution provenance", () => {
  test("captures one self-verifying provider-neutral execution identity", () => {
    const provider = new MockRuntimeProvider()
    const provenance = new ExecutionProvenanceCatalog(
      new RuntimeProviderRegistry([provider]),
    ).capture({
      provider: provider.name,
      agentSpec: testAgentSpec(),
      agentCatalogDigest: TEST_AGENT_CATALOG_DIGEST,
    })

    expect(parseExecutionProvenance(JSON.parse(JSON.stringify(provenance)))).toEqual(provenance)
    expect(provenance).toMatchObject({
      version: 1,
      agentDefinitionDigest: "1".repeat(64),
      agentCatalogDigest: TEST_AGENT_CATALOG_DIGEST,
      runnerDigest: provider.provenance.runnerDigest,
      provider: {
        name: "mock",
        adapterVersion: "test",
        runtimeImageReference: null,
        runtimeImageDigest: null,
        bridgeProtocolVersion: null,
      },
    })
    expect(provenance.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(provenance.provider.capabilitiesDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  test("refuses execution after adapter or capability drift", () => {
    const provider = new MockRuntimeProvider()
    const provenance = new ExecutionProvenanceCatalog(
      new RuntimeProviderRegistry([provider]),
    ).capture({
      provider: provider.name,
      agentSpec: testAgentSpec(),
      agentCatalogDigest: TEST_AGENT_CATALOG_DIGEST,
    })
    const drifted = Object.create(provider) as MockRuntimeProvider
    Object.defineProperty(drifted, "provenance", {
      value: { ...provider.provenance, adapterVersion: "changed-after-acceptance" },
    })

    expect(() => assertProviderProvenance(provenance, drifted)).toThrow(
      expect.objectContaining({ code: "EXECUTION_PROVENANCE_MISMATCH" }),
    )
    expect(provider.operations).toEqual([])
  })

  test("round-trips through the durable store representation without reinterpretation", () => {
    const provider = new MockRuntimeProvider()
    const provenance = new ExecutionProvenanceCatalog(
      new RuntimeProviderRegistry([provider]),
    ).capture({
      provider: provider.name,
      agentSpec: testAgentSpec(),
      agentCatalogDigest: TEST_AGENT_CATALOG_DIGEST,
    })
    const store = new Store(":memory:")
    store.createOwner({ id: "owner", name: "Owner", createdAt: now() })
    store.createRun({
      id: "run",
      ownerId: "owner",
      workspace: { type: "bundle", artifactId: "a".repeat(64) },
      agentType: "demo",
      agentSpec: testAgentSpec(),
      agentCatalogDigest: TEST_AGENT_CATALOG_DIGEST,
      executionProvenance: provenance,
      prompt: "prove provenance",
      env: {},
      secretRefs: {},
      provider: provider.name,
      artifactPaths: [],
      timeoutMs: 60_000,
      createdAt: now(),
      audit: {
        actorApiKeyId: null,
        requestId: "provenance-test",
        traceId: null,
        metadata: {},
      },
    })

    expect(store.getRun("owner", "run")?.executionProvenance).toEqual(provenance)
    store.close()
  })
})

const now = (): string => "2026-07-13T00:00:00.000Z"
