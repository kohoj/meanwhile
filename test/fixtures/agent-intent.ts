import type { AgentLaunchSnapshot, ExecutionProvenance } from "../../src/domain"
import { digestExecutionProvenance, digestRuntimeCapabilities } from "../../src/provenance"
import type { RuntimeProvider } from "../../src/providers/runtime-provider"
import type { RunAgentIntentResolver } from "../../src/services/run-service"

export const TEST_AGENT_CATALOG_DIGEST = "0".repeat(64)

export const testAgentSpec = (
  overrides: Partial<AgentLaunchSnapshot> = {},
): AgentLaunchSnapshot => ({
  version: 1,
  catalogVersion: 1,
  definitionDigest: "1".repeat(64),
  executable: "meanwhile-demo-agent",
  args: [],
  workingDirectory: "workspace",
  capabilities: { filesystem: true, terminal: false },
  permissionPolicy: {
    mode: "allow-once",
    toolKinds: ["read", "edit", "delete", "move", "search"],
  },
  envNames: [],
  secretEnvNames: [],
  ...overrides,
})

export const permissiveTestAgentIntents: RunAgentIntentResolver = {
  resolveIntent(_agentType, environment, secretReferences) {
    return {
      agentCatalogDigest: TEST_AGENT_CATALOG_DIGEST,
      agentSpec: testAgentSpec({
        envNames: Object.keys(environment).sort(),
        secretEnvNames: Object.keys(secretReferences).sort(),
      }),
    }
  },
}

export const testExecutionProvenance = {
  capture(input: {
    provider: string
    agentSpec: AgentLaunchSnapshot
    agentCatalogDigest: string
  }): ExecutionProvenance {
    const snapshot: Omit<ExecutionProvenance, "digest"> = {
      version: 1,
      agentDefinitionDigest: input.agentSpec.definitionDigest,
      agentCatalogDigest: input.agentCatalogDigest,
      runnerDigest: "2".repeat(64),
      provider: {
        name: input.provider,
        adapterVersion: "test",
        capabilitiesDigest: "3".repeat(64),
        runtimeImageReference: null,
        runtimeImageDigest: null,
        bridgeProtocolVersion: null,
      },
    }
    return { ...snapshot, digest: digestExecutionProvenance(snapshot) }
  },
}

export const testExecutionProvenanceFor = (
  provider: string | Pick<RuntimeProvider, "name" | "capabilities" | "provenance">,
  agentSpec: AgentLaunchSnapshot = testAgentSpec(),
  agentCatalogDigest: string = TEST_AGENT_CATALOG_DIGEST,
): ExecutionProvenance => {
  if (typeof provider === "string") {
    return testExecutionProvenance.capture({ provider, agentSpec, agentCatalogDigest })
  }
  const snapshot: Omit<ExecutionProvenance, "digest"> = {
    version: 1,
    agentDefinitionDigest: agentSpec.definitionDigest,
    agentCatalogDigest,
    runnerDigest: provider.provenance.runnerDigest,
    provider: {
      name: provider.name,
      adapterVersion: provider.provenance.adapterVersion,
      capabilitiesDigest: digestRuntimeCapabilities(provider.capabilities),
      runtimeImageReference: provider.provenance.runtimeImageReference,
      runtimeImageDigest: provider.provenance.runtimeImageDigest,
      bridgeProtocolVersion: provider.provenance.bridgeProtocolVersion,
    },
  }
  return { ...snapshot, digest: digestExecutionProvenance(snapshot) }
}
