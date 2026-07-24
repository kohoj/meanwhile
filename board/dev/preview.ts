import { BoardServer } from "../src/server"
import {
  API_OWNER_ID,
  API_PRINCIPAL_ID,
  API_PROJECT_ID,
  API_RUN_ID,
  API_TIMESTAMP,
  apiRun,
} from "../../test/fixtures/api"

export const PROJECT_WATCH_PREVIEW_ACCESS_KEY = `mwk_${"p".repeat(12)}_${"q".repeat(43)}`
export const PROJECT_WATCH_PREVIEW_RECIPIENT_ACCESS_KEY = `mwk_${"r".repeat(12)}_${"u".repeat(43)}`

const previewOwnerSession = `mws_${"s".repeat(12)}_${"t".repeat(43)}`
const previewRecipientSession = `mws_${"v".repeat(12)}_${"w".repeat(43)}`

const secondPrincipalId = "00000000-0000-4000-8000-000000000077"
const thirdPrincipalId = "00000000-0000-4000-8000-000000000099"
const relayId = "00000000-0000-4000-8000-000000000088"
const annotationId = "00000000-0000-4000-8000-000000000066"
const MINUTE = 60_000
const previewStartedAt = Date.now()
const previewAt = (offsetMs: number) => new Date(previewStartedAt + offsetMs).toISOString()
const taskCreatedAt = previewAt(-10 * MINUTE)
const relayCreatedAt = previewAt(-5 * MINUTE)
const relayAcknowledgedReceiptAt = previewAt(-4 * MINUTE)
const projects = [
  { id: API_PROJECT_ID, ownerId: API_OWNER_ID, name: "Northstar", slug: "northstar", createdAt: API_TIMESTAMP, archivedAt: null },
  { id: "00000000-0000-4000-8000-000000000066", ownerId: API_OWNER_ID, name: "Client SDK", slug: "client-sdk", createdAt: API_TIMESTAMP, archivedAt: null },
  { id: "00000000-0000-4000-8000-000000000055", ownerId: API_OWNER_ID, name: "Runtime Lab", slug: "runtime-lab", createdAt: API_TIMESTAMP, archivedAt: null },
]
const principal = {
  id: API_PRINCIPAL_ID,
  ownerId: API_OWNER_ID,
  kind: "person",
  displayName: "Bob Li",
  ownerRole: "admin",
  createdAt: API_TIMESTAMP,
  disabledAt: null,
}
const recipientPrincipal = {
  id: thirdPrincipalId,
  ownerId: API_OWNER_ID,
  kind: "person",
  displayName: "Priya Shah",
  ownerRole: "member",
  createdAt: API_TIMESTAMP,
  disabledAt: null,
}
const viewerFor = (request: Request) =>
  request.headers.get("Authorization") === `Session ${previewRecipientSession}`
    ? recipientPrincipal
    : principal
const participants = [
  { projectId: API_PROJECT_ID, principal: { id: API_PRINCIPAL_ID, kind: "person", displayName: "Bob Li" }, access: "administer", source: "membership", since: API_TIMESTAMP },
  { projectId: API_PROJECT_ID, principal: { id: secondPrincipalId, kind: "person", displayName: "Alice Chen" }, access: "participate", source: "github", since: API_TIMESTAMP },
  { projectId: API_PROJECT_ID, principal: { id: thirdPrincipalId, kind: "person", displayName: "Priya Shah" }, access: "watch", source: "github", since: API_TIMESTAMP },
]
const presenceExpiry = () => new Date(Date.now() + 45_000).toISOString()
const fixturePresenceExpiry = () => new Date(Date.now() + 24 * 60 * 60_000).toISOString()
const presenceLeases = new Map([
  [
    `${API_PROJECT_ID}:00000000-0000-4000-8000-000000000177`,
    {
      ownerId: API_OWNER_ID,
      projectId: API_PROJECT_ID,
      clientId: "00000000-0000-4000-8000-000000000177",
      principal: participants[1].principal,
      connectedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      expiresAt: fixturePresenceExpiry(),
    },
  ],
  [
    `${API_PROJECT_ID}:00000000-0000-4000-8000-000000000199`,
    {
      ownerId: API_OWNER_ID,
      projectId: API_PROJECT_ID,
      clientId: "00000000-0000-4000-8000-000000000199",
      principal: participants[2].principal,
      connectedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      expiresAt: fixturePresenceExpiry(),
    },
  ],
])
const originalWork = {
  kind: "run",
  id: API_RUN_ID,
  projectId: API_PROJECT_ID,
  delegatedBy: { id: secondPrincipalId, kind: "person", displayName: "Alice Chen" },
  title: "Fix OAuth callback race after app resume\n\nWe’re seeing intermittent `invalid_grant` errors after app resume. Find the race and make the callback safe.",
  agentType: "claude-code",
  status: "running",
  createdAt: taskCreatedAt,
  updatedAt: previewAt(-2 * MINUTE),
}
const createdRunId = "00000000-0000-4000-8000-000000000044"
const importedCreatedRunId = "00000000-0000-4000-8000-000000000045"
interface CreatedRunState {
  prompt: string
  agentType: string
  createdAt: string
}
const createdRunStates = new Map<string, CreatedRunState>()
const workItems = [
  originalWork,
  {
    ...originalWork,
    id: "00000000-0000-4000-8000-000000000111",
    delegatedBy: { id: API_PRINCIPAL_ID, kind: "person", displayName: "Bob Li" },
    title: "Audit v0.1.3 migration plan for data loss\n\nWe need to confirm the migration plan won’t lose user data.",
    agentType: "codex",
    updatedAt: previewAt(-6 * MINUTE),
  },
  {
    ...originalWork,
    kind: "session",
    id: "00000000-0000-4000-8000-000000000122",
    delegatedBy: { id: thirdPrincipalId, kind: "person", displayName: "Priya Shah" },
    title: "Verify Cloudflare credential revocation after restart\n\nAfter restart, we must ensure credentials are fully revoked.",
    agentType: "pi",
    status: "idle",
    createdAt: previewAt(-20 * MINUTE),
    updatedAt: previewAt(-12 * MINUTE),
  },
  {
    ...originalWork,
    id: "00000000-0000-4000-8000-000000000133",
    title: "Prepare release summary\n\nLet’s draft the release summary for v0.1.3.",
    agentType: "codex",
    status: "succeeded",
    createdAt: previewAt(-2 * 60 * MINUTE),
    updatedAt: previewAt(-60 * MINUTE),
  },
]
const onboardingConnectionId = "00000000-0000-4000-8000-000000000211"
const githubIdentityId = "00000000-0000-4000-8000-000000000212"
const githubGrantId = "00000000-0000-4000-8000-000000000213"
const repositoryBindingId = "00000000-0000-4000-8000-000000000214"
const importGrantId = "00000000-0000-4000-8000-000000000215"
const importedProjectId = "00000000-0000-4000-8000-000000000216"
const importedBindingId = "00000000-0000-4000-8000-000000000217"
let onboardingAgentConnected = false
const onboardingProjectSelections = new Set<string>()
let importedRepository = false
const githubIdentity = {
  id: githubIdentityId,
  ownerId: API_OWNER_ID,
  principalId: API_PRINCIPAL_ID,
  provider: "github",
  subjectId: "preview-bob-li",
  login: "bob-li",
  displayName: "Bob Li",
  avatarUrl: null,
  createdAt: API_TIMESTAMP,
  lastVerifiedAt: API_TIMESTAMP,
  revokedAt: null,
}
const githubGrant = {
  id: githubGrantId,
  ownerId: API_OWNER_ID,
  principalId: API_PRINCIPAL_ID,
  externalIdentityId: githubIdentityId,
  provider: "github",
  accountId: "northstar-labs",
  accountName: "Northstar Labs",
  installationId: "preview-installation",
  repositoryId: "northstar",
  repositoryName: "northstar",
  repositoryFullName: "northstar-labs/northstar",
  repositoryUrl: "https://github.com/northstar-labs/northstar",
  private: true,
  access: "participate",
  observedAt: API_TIMESTAMP,
  expiresAt: previewAt(24 * 60 * MINUTE),
  revokedAt: null,
}
const importGrant = {
  ...githubGrant,
  id: importGrantId,
  repositoryId: "design-system",
  repositoryName: "design-system",
  repositoryFullName: "northstar-labs/design-system",
  repositoryUrl: "https://github.com/northstar-labs/design-system",
  access: "administer",
}
const repositoryBinding = {
  id: repositoryBindingId,
  projectId: API_PROJECT_ID,
  ownerId: API_OWNER_ID,
  grantId: githubGrantId,
  provider: "github",
  accountId: githubGrant.accountId,
  accountName: githubGrant.accountName,
  installationId: githubGrant.installationId,
  repositoryId: githubGrant.repositoryId,
  repositoryName: githubGrant.repositoryName,
  repositoryFullName: githubGrant.repositoryFullName,
  repositoryUrl: githubGrant.repositoryUrl,
  private: githubGrant.private,
  boundByPrincipalId: API_PRINCIPAL_ID,
  createdAt: API_TIMESTAMP,
  revokedAt: null,
}
const importedProject = {
  id: importedProjectId,
  ownerId: API_OWNER_ID,
  name: "design-system",
  slug: "northstar-labs-design-system-preview",
  createdAt: API_TIMESTAMP,
  archivedAt: null,
}
const importedBinding = {
  ...repositoryBinding,
  id: importedBindingId,
  projectId: importedProjectId,
  grantId: importGrantId,
  repositoryId: importGrant.repositoryId,
  repositoryName: importGrant.repositoryName,
  repositoryFullName: importGrant.repositoryFullName,
  repositoryUrl: importGrant.repositoryUrl,
}
const onboardingSnapshot = (viewer = principal) => ({
  principal: viewer,
  identities: viewer.id === principal.id ? [githubIdentity] : [],
  repositoryGrants: viewer.id === principal.id ? [githubGrant, importGrant] : [],
  repositoryBindings: [repositoryBinding, ...(importedRepository ? [importedBinding] : [])],
  agentConnections: onboardingAgentConnected || viewer.id === recipientPrincipal.id
    ? [
        {
          id: viewer.id === principal.id
            ? onboardingConnectionId
            : "00000000-0000-4000-8000-000000000299",
          ownerId: API_OWNER_ID,
          principalId: viewer.id,
          agentType: "codex",
          label: "Codex",
          capabilities: {
            oneShotRuns: true,
            durableSessions: true,
            runtimeProviders: ["local", "cloudflare"],
          },
          createdAt: API_TIMESTAMP,
          lastVerifiedAt: API_TIMESTAMP,
          revokedAt: null,
        },
      ]
    : [],
  availableAgents: [
    {
      agentType: "codex",
      label: "Codex",
      capabilities: {
        oneShotRuns: true,
        durableSessions: true,
        runtimeProviders: ["local", "cloudflare"],
      },
    },
    {
      agentType: "claude-code",
      label: "Claude Code",
      capabilities: {
        oneShotRuns: true,
        durableSessions: true,
        runtimeProviders: ["local", "cloudflare"],
      },
    },
  ],
  projects: projects.map((project) => ({
    project,
    access: viewer.id === recipientPrincipal.id && project.id === API_PROJECT_ID
      ? "watch" as const
      : "administer" as const,
    source:
      project.id === API_PROJECT_ID || project.id === importedProjectId
        ? ("github" as const)
        : ("membership" as const),
    selected: viewer.id === recipientPrincipal.id
      ? project.id === API_PROJECT_ID
      : onboardingProjectSelections.has(project.id),
  })),
})
let relayAcknowledgedAt: string | null = null
let relayCreated = false
let annotationResolvedAt: string | null = null
let annotationBody = "Good catch. Confirm idempotency of  \n`exchangeAuthCode()` or guard against  \ndouble-invocation in `resume()`."
let annotationAnchor = {
  sequence: 4,
  blockId: "work:run:4",
  startOffset: 102,
  endOffset: 126,
  quote: "the second reuses a code",
  prefix: "Root cause\nOn app resume, we’re exchanging the authorization code twice.\nThe first exchange succeeds; ",
  suffix: " that’s already been\ninvalidated by the provider, which triggers invalid_grant.\nCode path\nsrc/auth/callback.ts:142 → exchangeAuthCode()\nsrc/auth/session.ts:88 → resume() → maybeRefresh()",
  contentDigest: "b8f99777b27726ddbaf9295f1f4de617fc80faf419784c44894a761db294bb6d",
}
const currentRelay = () => ({
  id: relayId,
  ownerId: API_OWNER_ID,
  projectId: API_PROJECT_ID,
  task: { kind: "run", id: API_RUN_ID },
  anchorSequence: 3,
  author: { id: API_PRINCIPAL_ID, kind: "person", displayName: "Bob Li" },
  recipient: { id: thirdPrincipalId, kind: "person", displayName: "Priya Shah" },
  body: "Can you verify the callback ownership assumption?",
  createdAt: relayCreatedAt,
  acknowledgedAt: relayAcknowledgedAt,
})
const previewRecentRelays = () => [
  {
    id: "00000000-0000-4000-8000-000000000081",
    ownerId: API_OWNER_ID,
    projectId: API_PROJECT_ID,
    task: { kind: "run" as const, id: API_RUN_ID },
    anchorSequence: 5,
    author: participants[1].principal,
    recipient: participants[0].principal,
    body: "Callback race root cause identified",
    createdAt: previewAt(-5.5 * MINUTE),
    acknowledgedAt: previewAt(-5 * MINUTE),
  },
  {
    id: "00000000-0000-4000-8000-000000000082",
    ownerId: API_OWNER_ID,
    projectId: API_PROJECT_ID,
    task: { kind: "run" as const, id: "00000000-0000-4000-8000-000000000111" },
    anchorSequence: 5,
    author: participants[0].principal,
    recipient: participants[1].principal,
    body: "Migration risk found; mitigation drafted",
    createdAt: previewAt(-5.67 * MINUTE),
    acknowledgedAt: previewAt(-5 * MINUTE),
  },
  {
    id: "00000000-0000-4000-8000-000000000083",
    ownerId: API_OWNER_ID,
    projectId: API_PROJECT_ID,
    task: { kind: "session" as const, id: "00000000-0000-4000-8000-000000000122" },
    anchorSequence: 5,
    author: participants[2].principal,
    recipient: participants[0].principal,
    body: "Revocation verified; no residual access",
    createdAt: previewAt(-5.83 * MINUTE),
    acknowledgedAt: previewAt(-5 * MINUTE),
  },
]
const currentAnnotation = () => ({
  id: annotationId,
  ownerId: API_OWNER_ID,
  projectId: API_PROJECT_ID,
  task: { kind: "run", id: API_RUN_ID },
  anchor: annotationAnchor,
  author: { id: API_PRINCIPAL_ID, kind: "person", displayName: "Bob Li" },
  body: annotationBody,
  createdAt: previewAt(-6 * MINUTE),
  resolvedAt: annotationResolvedAt,
  resolvedBy: annotationResolvedAt === null
    ? null
    : { id: API_PRINCIPAL_ID, kind: "person", displayName: "Bob Li" },
})

const eventOccurredAt = (sequence: number) => {
  const offset = sequence <= 3
    ? -9 * MINUTE
    : sequence === 4
      ? -8 * MINUTE
      : sequence <= 6
        ? -6 * MINUTE
        : sequence === 7
          ? -5 * MINUTE
          : -3 * MINUTE
  return previewAt(offset)
}

const agentUpdate = (runId: string, sequence: number, update: Record<string, unknown>) => ({
  version: 1,
  runId,
  ownerId: API_OWNER_ID,
  sequence,
  type: "agent.update",
  source: "runner",
  payload: { update, truncated: false },
  createdAt: eventOccurredAt(sequence),
})

const transcriptEvents = (runId: string) => [
  agentUpdate(runId, 1, {
    sessionUpdate: "agent_message_chunk",
    messageId: "acknowledgement",
    content: {
      type: "text",
      text: "Understood. I’ll trace the OAuth callback flow and token exchange.",
    },
  }),
  agentUpdate(runId, 2, {
    sessionUpdate: "tool_call",
    toolCallId: "read-contracts",
    title: "Read OAuth callback paths",
    kind: "read",
    status: "in_progress",
    rawInput: {
      paths: [
        "src/auth/callback.ts",
        "src/auth/session.ts",
        "src/app/resume.ts",
        "src/auth/exchange.ts",
        "test/auth/callback.test.ts",
        "test/auth/resume.test.ts",
      ],
    },
  }),
  agentUpdate(runId, 3, {
    sessionUpdate: "tool_call_update",
    toolCallId: "read-contracts",
    status: "completed",
    rawOutput: {
      finding: "The callback can exchange the authorization code before the restored session commits.",
    },
  }),
  agentUpdate(runId, 4, {
    sessionUpdate: "agent_thought_chunk",
    messageId: "reasoning",
    content: {
      type: "text",
      text: "### Root cause\n\nOn app resume, we’re exchanging the authorization code twice.  \nThe first exchange succeeds; the second reuses a code that’s already been  \ninvalidated by the provider, which triggers `invalid_grant`.\n\n### Code path\n\n`src/auth/callback.ts:142` → `exchangeAuthCode()`  \n`src/auth/session.ts:88` → `resume()` → `maybeRefresh()`",
    },
  }),
  agentUpdate(runId, 5, {
    sessionUpdate: "tool_call",
    toolCallId: "run-tests",
    title: "Ran tests · 18 passed",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "bun test test/auth" },
  }),
  agentUpdate(runId, 6, {
    sessionUpdate: "tool_call_update",
    toolCallId: "run-tests",
    status: "completed",
    rawOutput: { passed: 18, failed: 0 },
  }),
  agentUpdate(runId, 7, {
    sessionUpdate: "agent_message_chunk",
    messageId: "answer",
    content: {
      type: "text",
      text: "Root cause identified. Preparing a fix and added tests.",
    },
  }),
  agentUpdate(runId, 8, {
    sessionUpdate: "tool_call",
    toolCallId: "proposed-fix",
    title: "Proposed fix",
    kind: "edit",
    status: "in_progress",
    rawInput: { path: "src/auth/callback.ts" },
  }),
  agentUpdate(runId, 9, {
    sessionUpdate: "tool_call_update",
    toolCallId: "proposed-fix",
    status: "completed",
    rawOutput: { change: "Gate callback registration on restored session readiness." },
  }),
]

const migrationTranscriptEvents = (runId: string) => [
  agentUpdate(runId, 1, {
    sessionUpdate: "agent_message_chunk",
    messageId: "migration-acknowledgement",
    content: { type: "text", text: "Reviewing the migration scripts and rollback strategy." },
  }),
  agentUpdate(runId, 2, {
    sessionUpdate: "tool_call",
    toolCallId: "read-migrations",
    title: "Read migration chain",
    kind: "read",
    status: "in_progress",
    rawInput: { paths: ["src/persistence/schema.ts", "scripts/migrate-project-collaboration.ts", "scripts/migrate-task-relays.ts", "scripts/migrate-task-annotations.ts"] },
  }),
  agentUpdate(runId, 3, {
    sessionUpdate: "tool_call_update",
    toolCallId: "read-migrations",
    status: "completed",
    rawOutput: { finding: "One non-null backfill can race an older binary during rolling replacement." },
  }),
  agentUpdate(runId, 4, {
    sessionUpdate: "user_message_chunk",
    messageId: "migration-follow-up",
    content: { type: "text", text: "Check edge cases around null constraints and backfills." },
  }),
  agentUpdate(runId, 5, {
    sessionUpdate: "agent_message_chunk",
    messageId: "migration-progress",
    content: { type: "text", text: "Found one risky path. Drafting mitigation and tests." },
  }),
  agentUpdate(runId, 6, {
    sessionUpdate: "agent_thought_chunk",
    messageId: "migration-reasoning",
    content: { type: "text", text: "### Highest-risk path\n\nThe schema becomes stricter before every writer understands the new column. Split the change into expand, backfill, verify, then contract.\n\n### Rollback boundary\n\nKeep the old writer valid until the backfill receipt is durable." },
  }),
  agentUpdate(runId, 7, {
    sessionUpdate: "tool_call",
    toolCallId: "migration-tests",
    title: "Ran migration tests",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "bun test test/integration/*migration*.test.ts" },
  }),
  agentUpdate(runId, 8, {
    sessionUpdate: "tool_call_update",
    toolCallId: "migration-tests",
    status: "completed",
    rawOutput: { passed: 24, failed: 0 },
  }),
  agentUpdate(runId, 9, {
    sessionUpdate: "agent_message_chunk",
    messageId: "migration-answer",
    content: { type: "text", text: "The plan is safe after separating expansion from contraction and making the backfill receipt the deployment gate." },
  }),
]

const releaseTranscriptEvents = (runId: string) => [
  agentUpdate(runId, 1, {
    sessionUpdate: "agent_message_chunk",
    messageId: "release-acknowledgement",
    content: { type: "text", text: "Gathering notable changes, fixes, and impact." },
  }),
  agentUpdate(runId, 2, {
    sessionUpdate: "tool_call",
    toolCallId: "read-release-evidence",
    title: "Read release evidence",
    kind: "read",
    status: "in_progress",
    rawInput: { paths: ["README.md", "docs/project-collaboration.md", "design-qa.md"] },
  }),
  agentUpdate(runId, 3, {
    sessionUpdate: "tool_call_update",
    toolCallId: "read-release-evidence",
    status: "completed",
    rawOutput: { finding: "The release can claim local collaboration proof, not external human acceptance." },
  }),
  agentUpdate(runId, 4, {
    sessionUpdate: "user_message_chunk",
    messageId: "release-follow-up",
    content: { type: "text", text: "Highlight the OAuth fix and revocation verification." },
  }),
  agentUpdate(runId, 5, {
    sessionUpdate: "agent_message_chunk",
    messageId: "release-progress",
    content: { type: "text", text: "Draft ready for review." },
  }),
  agentUpdate(runId, 6, {
    sessionUpdate: "agent_thought_chunk",
    messageId: "release-reasoning",
    content: { type: "text", text: "### Release framing\n\nLead with Project visibility, live agent conversations, exact-moment notes, and human handoffs. Keep deterministic preview proof separate from deployed acceptance." },
  }),
  agentUpdate(runId, 7, {
    sessionUpdate: "agent_message_chunk",
    messageId: "release-answer",
    content: { type: "text", text: "Draft ready: shared Project rooms are complete locally, with live provider and two-person deployment proof named as the remaining release boundary." },
  }),
]

const runEventsFor = (runId: string) => {
  if (runId === API_RUN_ID) return transcriptEvents(runId)
  if (runId === "00000000-0000-4000-8000-000000000111") return migrationTranscriptEvents(runId)
  if (runId === "00000000-0000-4000-8000-000000000133") return releaseTranscriptEvents(runId)
  if (createdRunStates.has(runId)) return createdTranscriptEvents(runId)
  return null
}

const sessionTurnId = "00000000-0000-4000-8000-000000000144"
const sessionAgentUpdate = (sessionId: string, sequence: number, update: Record<string, unknown>) => ({
  version: 1,
  sessionId,
  ownerId: API_OWNER_ID,
  sequence,
  turnId: sessionTurnId,
  type: "turn.update",
  source: "runner",
  payload: { turnId: sessionTurnId, update, truncated: false },
  createdAt: eventOccurredAt(sequence),
})

const sessionTranscriptEvents = (sessionId: string) => [
  sessionAgentUpdate(sessionId, 1, {
    sessionUpdate: "agent_message_chunk",
    messageId: "revocation-acknowledgement",
    content: { type: "text", text: "Checking revocation flow and token invalidation." },
  }),
  sessionAgentUpdate(sessionId, 2, {
    sessionUpdate: "tool_call",
    toolCallId: "read-revocation",
    title: "Read credential lifecycle",
    kind: "read",
    status: "in_progress",
    rawInput: { paths: ["src/services/credential-lease-reaper.ts", "src/services/runtime-reaper.ts", "test/behavior/cleanup.test.ts"] },
  }),
  sessionAgentUpdate(sessionId, 3, {
    sessionUpdate: "tool_call_update",
    toolCallId: "read-revocation",
    status: "completed",
    rawOutput: { finding: "Runtime destruction remains ineligible until durable revocation succeeds." },
  }),
  sessionAgentUpdate(sessionId, 4, {
    sessionUpdate: "user_message_chunk",
    messageId: "revocation-follow-up",
    content: { type: "text", text: "Also verify no cached tokens remain usable." },
  }),
  sessionAgentUpdate(sessionId, 5, {
    sessionUpdate: "agent_message_chunk",
    messageId: "revocation-progress",
    content: { type: "text", text: "Verification complete. Revocation is effective." },
  }),
  sessionAgentUpdate(sessionId, 6, {
    sessionUpdate: "agent_thought_chunk",
    messageId: "revocation-reasoning",
    content: { type: "text", text: "### Revocation result\n\nRestart recovery reacquires the exact lease identity. Cleanup cannot destroy the runtime before revocation is durably recorded." },
  }),
  sessionAgentUpdate(sessionId, 7, {
    sessionUpdate: "agent_message_chunk",
    messageId: "revocation-answer",
    content: { type: "text", text: "Revocation is effective after restart, and the cleanup invariant prevents residual credential use." },
  }),
]

const createdEventOccurredAt = (runId: string, sequence: number) => {
  const acceptedAt = createdRunStates.get(runId)?.createdAt ?? new Date().toISOString()
  return new Date(Date.parse(acceptedAt) + sequence * 350).toISOString()
}

const createdAgentUpdate = (
  runId: string,
  sequence: number,
  update: Record<string, unknown>,
) => ({
  version: 1,
  runId,
  ownerId: API_OWNER_ID,
  sequence,
  type: "agent.update",
  source: "runner",
  payload: { update, truncated: false },
  createdAt: createdEventOccurredAt(runId, sequence),
})

const createdTranscriptEvents = (runId: string) => [
  createdAgentUpdate(runId, 1, {
    sessionUpdate: "agent_message_chunk",
    messageId: "created-acknowledgement",
    content: {
      type: "text",
      text: "I’ll trace the requested outcome from first entry through task acceptance, then name the highest-risk gap.",
    },
  }),
  createdAgentUpdate(runId, 2, {
    sessionUpdate: "tool_call",
    toolCallId: "review-first-entry",
    title: "Reviewed 6 journey boundaries",
    kind: "read",
    status: "in_progress",
    rawInput: {
      paths: [
        "board/src/ui/app.tsx",
        "board/src/server.ts",
        "src/api/external-auth.ts",
        "src/services/repository-credential-resolver.ts",
        "docs/external-collaboration-acceptance.md",
        "board/dev/preview.ts",
      ],
    },
  }),
  createdAgentUpdate(runId, 3, {
    sessionUpdate: "tool_call_update",
    toolCallId: "review-first-entry",
    status: "completed",
    rawOutput: {
      finding:
        "The local journey closes, while live provider and two-person receipts remain separate release evidence.",
    },
  }),
  createdAgentUpdate(runId, 4, {
    sessionUpdate: "agent_thought_chunk",
    messageId: "created-reasoning",
    content: {
      type: "text",
      text: "### Highest-risk gap\n\nThe first-use chain is locally coherent, but live GitHub or Google authorization, private checkout, and two-person deployed acceptance are still unproved.\n\n### Product risk\n\nA polished deterministic preview can be mistaken for production collaboration unless the release gate keeps those claims separate.",
    },
  }),
  createdAgentUpdate(runId, 5, {
    sessionUpdate: "tool_call",
    toolCallId: "validate-journey",
    title: "Ran complete journey · 26 checks",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "bun run board:journey:check" },
  }),
  createdAgentUpdate(runId, 6, {
    sessionUpdate: "tool_call_update",
    toolCallId: "validate-journey",
    status: "completed",
    rawOutput: { checks: 26, failed: 0 },
  }),
  createdAgentUpdate(runId, 7, {
    sessionUpdate: "agent_message_chunk",
    messageId: "created-answer",
    content: {
      type: "text",
      text: "The single highest-risk gap is external-provider and two-human acceptance, not another UI surface. Keep local and self-hosted bootstrap first-class, then prove the same journey on one clean deployed revision.",
    },
  }),
]

const liveTranscript = <Event extends { readonly sequence: number }>(
  request: Request,
  events: readonly Event[],
) => {
  const url = new URL(request.url)
  const headerCursor = Number(request.headers.get("Last-Event-ID") ?? "0")
  const queryCursor = Number(url.searchParams.get("after") ?? "0")
  const after = Math.max(headerCursor, queryCursor)
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode("event: ready\ndata: {}\n\n"))
        for (const event of events.filter((candidate) => candidate.sequence > after)) {
          await Bun.sleep(350)
          controller.enqueue(
            encoder.encode(
              `event: event\nid: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`,
            ),
          )
        }
        controller.enqueue(encoder.encode("event: end\ndata: {}\n\n"))
        controller.close()
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  )
}

const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const viewer = viewerFor(request)
    if (request.method === "GET" && url.pathname === "/external-auth/providers") {
      return Response.json({
        providers: [],
        registration: "closed",
      })
    }
    if (
      request.method === "POST" &&
      ["/external-auth/github/invite", "/external-auth/google/invite"].includes(url.pathname)
    ) {
      const body = (await request.json()) as { secret?: unknown }
      if (!/^mwi_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/.test(String(body.secret ?? ""))) {
        return Response.json({ error: { code: "PRINCIPAL_INVITATION_INVALID" } }, { status: 401 })
      }
      const provider = url.pathname.includes("github") ? "github" : "google"
      const authorization = new URL(
        provider === "github"
          ? "https://github.com/login/oauth/authorize"
          : "https://accounts.google.com/o/oauth2/v2/auth",
      )
      authorization.searchParams.set("state", "preview-invitation-state")
      authorization.searchParams.set("code_challenge", "preview-challenge")
      return Response.json({ authorizationUrl: authorization.href })
    }
    if (request.method === "POST" && url.pathname === "/browser-sessions") {
      const authorization = request.headers.get("Authorization")
      const recipientLogin = authorization === `Bearer ${PROJECT_WATCH_PREVIEW_RECIPIENT_ACCESS_KEY}`
      if (authorization !== `Bearer ${PROJECT_WATCH_PREVIEW_ACCESS_KEY}` && !recipientLogin) {
        return Response.json(
          { error: { code: "UNAUTHORIZED", message: "Invalid preview access key" } },
          { status: 401 },
        )
      }
      return Response.json(
        {
          session: {
            id: recipientLogin
              ? "00000000-0000-4000-8000-000000000302"
              : "00000000-0000-4000-8000-000000000301",
            ownerId: API_OWNER_ID,
            principalId: recipientLogin ? recipientPrincipal.id : API_PRINCIPAL_ID,
            createdAt: API_TIMESTAMP,
            expiresAt: previewAt(24 * 60 * MINUTE),
            lastUsedAt: null,
            revokedAt: null,
          },
          secret: recipientLogin ? previewRecipientSession : previewOwnerSession,
        },
        { status: 201 },
      )
    }
    if (request.method === "DELETE" && url.pathname === "/browser-sessions/current") {
      return Response.json({ session: { id: "00000000-0000-4000-8000-000000000301" } })
    }
    if (url.pathname === "/me") return Response.json({ principal: viewer, projects })
    if (request.method === "GET" && url.pathname === "/onboarding") {
      return Response.json(onboardingSnapshot(viewer))
    }
    if (request.method === "POST" && url.pathname === "/onboarding/agent-connections") {
      onboardingAgentConnected = true
      return Response.json({ connection: onboardingSnapshot(viewer).agentConnections[0] }, { status: 201 })
    }
    if (request.method === "POST" && url.pathname === "/onboarding/projects") {
      const input = (await request.json()) as { grantId?: string }
      if (input.grantId !== importGrantId) {
        return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 })
      }
      const created = !importedRepository
      if (created) projects.push(importedProject)
      importedRepository = true
      onboardingProjectSelections.add(importedProjectId)
      return Response.json({
        project: importedProject,
        binding: importedBinding,
        selection: {
          ownerId: API_OWNER_ID,
          principalId: viewer.id,
          projectId: importedProjectId,
          selectedAt: new Date().toISOString(),
          hiddenAt: null,
        },
        created,
      })
    }
    if (
      request.method === "DELETE" &&
      url.pathname === `/onboarding/agent-connections/${onboardingConnectionId}`
    ) {
      const connection = onboardingSnapshot(viewer).agentConnections[0]
      onboardingAgentConnected = false
      return Response.json({ connection: { ...connection, revokedAt: new Date().toISOString() } })
    }
    const onboardingSelection = url.pathname.match(
      /^\/onboarding\/projects\/([\w-]+)\/selection$/,
    )
    if (request.method === "PUT" && onboardingSelection !== null) {
      const input = await request.json() as { selected: boolean }
      const projectId = onboardingSelection[1] as string
      if (input.selected) onboardingProjectSelections.add(projectId)
      else onboardingProjectSelections.delete(projectId)
      return Response.json({
        selection: {
          ownerId: API_OWNER_ID,
          principalId: viewer.id,
          projectId,
          selectedAt: new Date().toISOString(),
          hiddenAt: input.selected ? null : new Date().toISOString(),
        },
      })
    }
    const project = projects.find((candidate) => url.pathname.startsWith(`/projects/${candidate.id}/`))
    const presence = url.pathname.match(/^\/projects\/([\w-]+)\/presence(?:\/([\w-]+))?$/)
    if (presence !== null) {
      const projectId = presence[1] as string
      const clientId = presence[2]
      if (request.method === "GET" && clientId === undefined) {
        return Response.json({
          items: [...presenceLeases.values()].filter(
            (lease) => lease.projectId === projectId && Date.parse(lease.expiresAt) > Date.now(),
          ),
        })
      }
      if (request.method === "PUT" && clientId !== undefined) {
        const key = `${projectId}:${clientId}`
        const existing = presenceLeases.get(key)
        const now = new Date().toISOString()
        const lease = {
          ownerId: API_OWNER_ID,
          projectId,
          clientId,
          principal: {
            id: viewer.id,
            kind: viewer.kind,
            displayName: viewer.displayName,
          },
          connectedAt: existing?.connectedAt ?? now,
          lastSeenAt: now,
          expiresAt: presenceExpiry(),
        }
        presenceLeases.set(key, lease)
        return Response.json({ lease })
      }
      if (request.method === "DELETE" && clientId !== undefined) {
        presenceLeases.delete(`${projectId}:${clientId}`)
        return new Response(null, { status: 204 })
      }
    }
    if (project !== undefined && url.pathname.endsWith("/participants")) {
      return Response.json({
        items:
          project.id === API_PROJECT_ID
            ? participants
            : [
                {
                  ...participants[0],
                  projectId: project.id,
                  source: project.id === importedProjectId ? "github" : "membership",
                },
              ],
      })
    }
    if (project !== undefined && url.pathname.endsWith("/work")) {
      return Response.json({
        items: workItems.filter((item) => item.projectId === project.id),
      })
    }
    if (project !== undefined && url.pathname.endsWith("/relay-inbox")) {
      return Response.json({
        items:
          relayCreated && viewer.id === recipientPrincipal.id && relayAcknowledgedAt === null
            ? [currentRelay()]
            : [],
      })
    }
    if (project !== undefined && url.pathname.endsWith("/recent-relays")) {
      const limit = Math.max(1, Math.min(20, Number(url.searchParams.get("limit") ?? "3")))
      return Response.json({
        items: project.id === API_PROJECT_ID ? previewRecentRelays().slice(0, limit) : [],
      })
    }
    if (project !== undefined && url.pathname.endsWith("/annotations")) {
      if (request.method === "POST") {
        const input = await request.json() as { anchor: typeof annotationAnchor; body: string }
        annotationAnchor = input.anchor
        annotationBody = input.body
        annotationResolvedAt = null
        return Response.json({ annotation: currentAnnotation() }, { status: 201 })
      }
      return Response.json({
        items:
          project.id === API_PROJECT_ID && url.searchParams.get("taskId") === API_RUN_ID
            ? [currentAnnotation()]
            : [],
      })
    }
    if (
      project !== undefined &&
      request.method === "POST" &&
      url.pathname.endsWith(`/annotations/${annotationId}/resolve`)
    ) {
      annotationResolvedAt = new Date().toISOString()
      return Response.json({ annotation: currentAnnotation() })
    }
    if (project !== undefined && url.pathname.endsWith("/relays")) {
      if (request.method === "POST") {
        relayCreated = true
        relayAcknowledgedAt = null
        return Response.json({ relay: currentRelay() }, { status: 201 })
      }
      return Response.json({
        items:
          relayCreated && project.id === API_PROJECT_ID && url.searchParams.get("taskId") === API_RUN_ID
            ? [currentRelay()]
            : [],
      })
    }
    if (
      project !== undefined &&
      request.method === "POST" &&
      url.pathname.endsWith(`/relays/${relayId}/acknowledge`)
    ) {
      relayAcknowledgedAt = relayAcknowledgedReceiptAt
      return Response.json({ relay: currentRelay() })
    }
    const runEventsRoute = url.pathname.match(/^\/runs\/([\w-]+)\/events$/)
    if (request.method === "GET" && runEventsRoute !== null) {
      const events = runEventsFor(runEventsRoute[1] ?? "")
      if (events === null) return new Response("Not Found", { status: 404 })
      if (request.headers.get("Accept")?.includes("text/event-stream")) {
        return liveTranscript(request, events)
      }
      return Response.json({ items: events, nextCursor: null })
    }
    const sessionEventsRoute = url.pathname.match(/^\/sessions\/([\w-]+)\/events$/)
    if (request.method === "GET" && sessionEventsRoute !== null) {
      const sessionId = sessionEventsRoute[1] ?? ""
      if (sessionId !== "00000000-0000-4000-8000-000000000122") {
        return new Response("Not Found", { status: 404 })
      }
      const events = sessionTranscriptEvents(sessionId)
      if (request.headers.get("Accept")?.includes("text/event-stream")) {
        return liveTranscript(request, events)
      }
      return Response.json({ items: events, nextCursor: null })
    }
    if (request.method === "POST" && url.pathname === "/runs") {
      const input = await request.json() as { projectId: string; prompt: string; agentType: string; workspace: unknown }
      const acceptedAt = new Date().toISOString()
      const runId = input.projectId === importedProjectId ? importedCreatedRunId : createdRunId
      createdRunStates.set(runId, {
        prompt: input.prompt,
        agentType: input.agentType,
        createdAt: acceptedAt,
      })
      const existingIndex = workItems.findIndex((item) => item.id === runId)
      if (existingIndex >= 0) workItems.splice(existingIndex, 1)
      workItems.unshift({
        kind: "run",
        id: runId,
        projectId: input.projectId,
        delegatedBy: { id: viewer.id, kind: "person", displayName: viewer.displayName },
        title: input.prompt,
        agentType: input.agentType,
        status: "running",
        createdAt: acceptedAt,
        updatedAt: acceptedAt,
      })
      return Response.json({
        run: {
          ...apiRun("running"),
          id: runId,
          projectId: input.projectId,
          delegatedBy: { id: viewer.id, kind: "person", displayName: viewer.displayName },
          workspace: input.workspace,
          agentType: input.agentType,
          prompt: input.prompt,
          createdAt: acceptedAt,
          updatedAt: acceptedAt,
        },
      }, { status: 201 })
    }
    const cancelCreatedRunRoute = url.pathname.match(/^\/runs\/([\w-]+)\/cancel$/)
    if (
      request.method === "POST" &&
      cancelCreatedRunRoute !== null &&
      createdRunStates.has(cancelCreatedRunRoute[1] ?? "")
    ) {
      const runId = cancelCreatedRunRoute[1] as string
      const index = workItems.findIndex((item) => item.id === runId)
      if (index >= 0 && workItems[index] !== undefined) {
        workItems[index] = {
          ...workItems[index],
          status: "cancelled",
          updatedAt: new Date().toISOString(),
        }
      }
      return Response.json({
        run: {
          ...apiRun("cancelled"),
          id: runId,
          projectId: workItems[index]?.projectId ?? API_PROJECT_ID,
          delegatedBy: { id: viewer.id, kind: "person", displayName: viewer.displayName },
        },
      }, { status: 202 })
    }
    return new Response("Not Found", { status: 404 })
  },
})

const board = new BoardServer({
  baseUrl: upstream.url.origin,
  assetsDir: new URL("../dist/", import.meta.url).pathname,
  hostname: "127.0.0.1",
  port: process.argv.includes("--check")
    ? 0
    : Number(Bun.env.MEANWHILE_BOARD_PORT ?? "7543"),
  defaultAgentType: "codex",
})
const started = board.start()

const assertPreview: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message)
}

const readJson = async (response: Response, step: string): Promise<Record<string, unknown>> => {
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  assertPreview(response.ok, `${step} failed with ${response.status}`)
  assertPreview(body !== null, `${step} did not return JSON`)
  return body
}

const runJourneyCheck = async () => {
  const origin = started.url
  const asset = await fetch(origin)
  const html = await asset.text()
  assertPreview(asset.ok && html.includes('id="root"'), "Entry asset is unavailable")

  const authProviders = await readJson(
    await fetch(`${origin}/auth/providers`),
    "Preview authentication providers",
  )
  assertPreview(
    Array.isArray(authProviders.providers) && authProviders.providers.length === 0,
    "Preview must not advertise an OAuth provider it cannot complete",
  )

  const invalidKey = `mwk_${"x".repeat(12)}_${"y".repeat(43)}`
  const rejected = await fetch(`${origin}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ apiKey: invalidKey }),
  })
  assertPreview(rejected.status === 401, "Preview accepted an unknown installation key")

  const login = await fetch(`${origin}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ apiKey: PROJECT_WATCH_PREVIEW_ACCESS_KEY }),
  })
  const setCookie = login.headers.get("set-cookie") ?? ""
  assertPreview(login.status === 201, `Login failed with ${login.status}`)
  assertPreview(setCookie.includes("HttpOnly"), "Session cookie is not HttpOnly")
  assertPreview(setCookie.includes("SameSite=Lax"), "Session cookie is not SameSite=Lax")
  const cookie = setCookie.split(";", 1)[0] ?? ""
  assertPreview(cookie.startsWith("mw_board_session="), "Session cookie is missing")

  const read = (path: string) => fetch(`${origin}${path}`, { headers: { Cookie: cookie } })
  const write = (path: string, method: string, body: unknown) =>
    fetch(`${origin}${path}`, {
      method,
      headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  const session = await readJson(await read("/session"), "Session read")
  assertPreview(
    (session.principal as { id?: unknown } | undefined)?.id === API_PRINCIPAL_ID,
    "Session Principal drifted",
  )

  const before = await readJson(await read("/onboarding"), "Initial onboarding")
  assertPreview(
    Array.isArray(before.agentConnections) && before.agentConnections.length === 0,
    "Initial onboarding is not disconnected",
  )

  await readJson(
    await write("/onboarding/agent-connections", "POST", { agentType: "codex" }),
    "Agent connection",
  )
  await readJson(
    await write(`/onboarding/projects/${API_PROJECT_ID}/selection`, "PUT", { selected: true }),
    "GitHub-backed Project selection",
  )
  const localProjectId = projects[1]?.id
  assertPreview(localProjectId !== undefined, "Local Project fixture is missing")
  await readJson(
    await write(`/onboarding/projects/${localProjectId}/selection`, "PUT", { selected: true }),
    "Local Project selection",
  )

  const ready = await readJson(await read("/onboarding"), "Ready onboarding")
  assertPreview(
    Array.isArray(ready.agentConnections) && ready.agentConnections.length === 1,
    "Agent connection did not persist",
  )
  assertPreview(
    Array.isArray(ready.projects) &&
      ready.projects.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { project?: { id?: unknown }; selected?: unknown }).project?.id ===
            API_PROJECT_ID &&
          (entry as { selected?: unknown }).selected === true,
      ),
    "Project selection did not persist",
  )
  assertPreview(
    (ready.projects as readonly unknown[]).filter(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { selected?: unknown }).selected === true,
    ).length === 2,
    "Mixed Project selection did not persist",
  )

  const lobby = await readJson(await read("/lobby"), "Project Lobby")
  assertPreview(Array.isArray(lobby.spaces) && lobby.spaces.length === 2, "Lobby source grouping drifted")
  assertPreview(
    (lobby.spaces as readonly { tables?: readonly unknown[] }[]).reduce(
      (total, space) => total + (space.tables?.length ?? 0),
      0,
    ) === 2,
    "Mixed GitHub and local Projects did not reach the Lobby",
  )

  const room = await readJson(
    await read(`/board?projectId=${encodeURIComponent(API_PROJECT_ID)}`),
    "Project room",
  )
  assertPreview(Array.isArray(room.rows) && room.rows.length === 4, "Live Deck work drifted")
  assertPreview(
    Array.isArray(room.presence) && room.presence.length >= 2,
    "Project room lost fixture presence",
  )

  const detail = await readJson(
    await read(
      `/task/run/${API_RUN_ID}/events?projectId=${encodeURIComponent(API_PROJECT_ID)}`,
    ),
    "Conversation detail",
  )
  assertPreview(Array.isArray(detail.events) && detail.events.length > 0, "Transcript is empty")
  const [migrationDetail, revocationDetail, releaseDetail] = await Promise.all([
    readJson(
      await read(`/task/run/00000000-0000-4000-8000-000000000111/events?projectId=${encodeURIComponent(API_PROJECT_ID)}`),
      "Migration conversation detail",
    ),
    readJson(
      await read(`/task/session/00000000-0000-4000-8000-000000000122/events?projectId=${encodeURIComponent(API_PROJECT_ID)}`),
      "Revocation conversation detail",
    ),
    readJson(
      await read(`/task/run/00000000-0000-4000-8000-000000000133/events?projectId=${encodeURIComponent(API_PROJECT_ID)}`),
      "Release conversation detail",
    ),
  ])
  assertPreview(
    [migrationDetail, revocationDetail, releaseDetail].every(
      (history) => Array.isArray(history.events) && history.events.length >= 5,
    ),
    "Every Live Deck card must resolve an authoritative conversation",
  )
  const distinctHistory = JSON.stringify({ migrationDetail, revocationDetail, releaseDetail })
  assertPreview(
    distinctHistory.includes("migration scripts and rollback strategy") &&
      distinctHistory.includes("revocation flow and token invalidation") &&
      distinctHistory.includes("notable changes, fixes, and impact"),
    "Task previews reused another task's transcript",
  )

  const annotation = await readJson(
    await write(`/projects/${API_PROJECT_ID}/annotations`, "POST", {
      task: { kind: "run", id: API_RUN_ID },
      anchor: annotationAnchor,
      body: "Verify resume remains idempotent after reconnect.",
    }),
    "Transcript annotation",
  )
  assertPreview("annotation" in annotation, "Annotation receipt is missing")

  const relay = await readJson(
    await write(`/projects/${API_PROJECT_ID}/relays`, "POST", {
      task: { kind: "run", id: API_RUN_ID },
      anchorSequence: annotationAnchor.sequence,
      recipientPrincipalId: thirdPrincipalId,
      body: "Confirm the callback ownership assumption.",
    }),
    "Exact-moment Relay",
  )
  assertPreview("relay" in relay, "Relay receipt is missing")

  const recipientLogin = await fetch(`${origin}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ apiKey: PROJECT_WATCH_PREVIEW_RECIPIENT_ACCESS_KEY }),
  })
  const recipientSetCookie = recipientLogin.headers.get("set-cookie") ?? ""
  assertPreview(recipientLogin.status === 201, `Recipient login failed with ${recipientLogin.status}`)
  const recipientCookie = recipientSetCookie.split(";", 1)[0] ?? ""
  assertPreview(recipientCookie.startsWith("mw_board_session="), "Recipient session cookie is missing")
  assertPreview(recipientCookie !== cookie, "Participants received the same browser session")
  const recipientRead = (path: string) =>
    fetch(`${origin}${path}`, { headers: { Cookie: recipientCookie } })
  const recipientWrite = (path: string, method: string, body: unknown) =>
    fetch(`${origin}${path}`, {
      method,
      headers: { Cookie: recipientCookie, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  const recipientSession = await readJson(await recipientRead("/session"), "Recipient session read")
  assertPreview(
    (recipientSession.principal as { id?: unknown } | undefined)?.id === thirdPrincipalId,
    "Recipient session did not bind the named Principal",
  )
  const recipientInbox = await readJson(
    await recipientRead(`/board?projectId=${encodeURIComponent(API_PROJECT_ID)}`),
    "Recipient Project room",
  )
  assertPreview(
    Array.isArray(recipientInbox.pendingRelays) && recipientInbox.pendingRelays.length === 1,
    "Recipient did not receive the exact-moment Relay",
  )
  const acknowledged = await readJson(
    await recipientWrite(
      `/projects/${API_PROJECT_ID}/relays/${relayId}/acknowledge`,
      "POST",
      {},
    ),
    "Recipient Relay acknowledgement",
  )
  assertPreview(
    typeof (acknowledged.relay as { acknowledgedAt?: unknown } | undefined)?.acknowledgedAt ===
      "string",
    "Recipient acknowledgement receipt is missing",
  )

  const created = await readJson(
    await write(`/projects/${API_PROJECT_ID}/runs`, "POST", {
      prompt: "Audit the authentication path and fix the highest-risk gap.",
      repositoryUrl: "",
      revision: "main",
      agentType: "codex",
      idempotencyKey: "project-watch-preview-journey-v1",
    }),
    "First delegation",
  )
  assertPreview(
    (created.run as { id?: unknown } | undefined)?.id === createdRunId,
    "Delegation did not return the fixture Run",
  )
  const acceptedCreatedAt = (created.run as { createdAt?: unknown }).createdAt
  assertPreview(
    typeof acceptedCreatedAt === "string",
    "Delegation did not return its acceptance time",
  )

  const createdHistory = await readJson(
    await read(
      `/task/run/${createdRunId}/events?projectId=${encodeURIComponent(API_PROJECT_ID)}`,
    ),
    "Created Run history",
  )
  const createdEvents = createdHistory.events as
    | readonly { createdAt?: unknown; payload?: unknown }[]
    | undefined
  assertPreview(
    Array.isArray(createdEvents) &&
      createdEvents.length === 7 &&
      createdEvents.every(
        (event) =>
          typeof event.createdAt === "string" &&
          Date.parse(event.createdAt) > Date.parse(acceptedCreatedAt),
      ),
    "Created Run transcript is not monotonic after task acceptance",
  )
  const createdHistoryText = JSON.stringify(createdEvents)
  assertPreview(
    createdHistoryText.includes("first entry") &&
      !createdHistoryText.includes("OAuth callback"),
    "Created Run transcript reused another task's conversation",
  )

  const refreshedRoom = await readJson(
    await read(`/board?projectId=${encodeURIComponent(API_PROJECT_ID)}`),
    "Refreshed Project room",
  )
  assertPreview(
    Array.isArray(refreshedRoom.rows) &&
      refreshedRoom.rows.some(
        (row) =>
          typeof row === "object" && row !== null && (row as { id?: unknown }).id === createdRunId,
      ),
    "Delegated Run did not enter the authoritative Project read model",
  )

  const cancelled = await readJson(
    await write(`/task/run/${createdRunId}/cancel`, "POST", {}),
    "Self cancellation",
  )
  assertPreview(
    (cancelled.run as { status?: unknown } | undefined)?.status === "cancelled",
    "Self cancellation did not reach the control-plane fixture",
  )

  const imported = await readJson(
    await write("/onboarding/projects", "POST", { grantId: importGrantId }),
    "Repository import",
  )
  assertPreview(
    (imported.project as { id?: unknown } | undefined)?.id === importedProjectId,
    "Repository import did not create the expected Project",
  )
  const importedRun = await readJson(
    await write(`/projects/${importedProjectId}/runs`, "POST", {
      prompt: "Audit the design token hierarchy and identify the highest-risk consistency gap.",
      repositoryUrl: importedBinding.repositoryUrl,
      revision: "main",
      agentType: "codex",
      idempotencyKey: "project-watch-imported-first-task-v1",
    }),
    "Imported Project first delegation",
  )
  assertPreview(
    (importedRun.run as { id?: unknown } | undefined)?.id === importedCreatedRunId,
    "Imported Project delegation did not return its own Run",
  )
  const importedRoom = await readJson(
    await read(`/board?projectId=${encodeURIComponent(importedProjectId)}`),
    "Imported Project refreshed room",
  )
  assertPreview(
    Array.isArray(importedRoom.rows) &&
      importedRoom.rows.some(
        (row) =>
          typeof row === "object" &&
          row !== null &&
          (row as { id?: unknown }).id === importedCreatedRunId,
      ),
    "Imported Project first task did not enter its Live Deck",
  )
  const importedHistory = await readJson(
    await read(
      `/task/run/${importedCreatedRunId}/events?projectId=${encodeURIComponent(importedProjectId)}`,
    ),
    "Imported Project first transcript",
  )
  assertPreview(
    Array.isArray(importedHistory.events) && importedHistory.events.length === 7,
    "Imported Project first task did not open its native transcript",
  )

  return {
    status: "succeeded",
    journey: "login-onboarding-import-lobby-room-detail-annotation-relay-delegation",
    projectId: API_PROJECT_ID,
    runId: createdRunId,
    checks: 34,
  }
}

const checkOnly = process.argv.includes("--check")
if (checkOnly) {
  try {
    console.log(JSON.stringify(await runJourneyCheck()))
  } finally {
    await board.stop()
    await upstream.stop(true)
  }
  process.exit(0)
}

console.log(
  JSON.stringify({
    status: "ready",
    boardUrl: started.url,
    accessKey: PROJECT_WATCH_PREVIEW_ACCESS_KEY,
  }),
)

const shutdown = () => {
  void board.stop()
  void upstream.stop(true)
  process.exit(0)
}
process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
await new Promise(() => {})
