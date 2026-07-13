import type { AgentLaunchSnapshot } from "../../src/domain"
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
