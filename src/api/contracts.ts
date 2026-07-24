import { z } from "zod"
import { isSafeRepositoryRevision, RUN_STATUSES } from "../domain"
import { executionProvenanceSchema } from "../provenance"
import { relativePath } from "../providers/runtime-provider"

const timestamp = z.iso.datetime({ offset: true })
const environmentName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(128)
const safeJson = z.unknown()

export const IdentifierSchema = z.string().uuid()
export const ArtifactIdentifierSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const PrincipalSummarySchema = z
  .object({
    id: IdentifierSchema,
    kind: z.enum(["person", "service"]),
    displayName: z.string().min(1).max(120),
  })
  .strict()
  .meta({ id: "PrincipalSummary" })

export const PrincipalSchema = PrincipalSummarySchema.extend({
  ownerId: IdentifierSchema,
  ownerRole: z.enum(["admin", "member"]),
  createdAt: timestamp,
  disabledAt: timestamp.nullable(),
})
  .strict()
  .meta({ id: "Principal" })

export const ProjectSchema = z
  .object({
    id: IdentifierSchema,
    ownerId: IdentifierSchema,
    name: z.string().min(1).max(120),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(80),
    createdAt: timestamp,
    archivedAt: timestamp.nullable(),
  })
  .strict()
  .meta({ id: "Project" })

export const ProjectMemberSchema = z
  .object({
    projectId: IdentifierSchema,
    principal: PrincipalSummarySchema,
    role: z.enum(["maintainer", "member"]),
    joinedAt: timestamp,
  })
  .strict()
  .meta({ id: "ProjectMember" })

export const ProjectParticipantSchema = z
  .object({
    projectId: IdentifierSchema,
    principal: PrincipalSummarySchema,
    access: z.enum(["watch", "participate", "administer"]),
    source: z.enum(["membership", "github"]),
    since: timestamp,
  })
  .strict()
  .meta({ id: "ProjectParticipant" })

export const ProjectParticipantPageSchema = z.object({
  items: z.array(ProjectParticipantSchema).readonly(),
})

export const PresenceLeaseSchema = z
  .object({
    ownerId: IdentifierSchema,
    projectId: IdentifierSchema,
    clientId: IdentifierSchema,
    principal: PrincipalSummarySchema,
    connectedAt: timestamp,
    lastSeenAt: timestamp,
    expiresAt: timestamp,
  })
  .strict()
  .meta({ id: "PresenceLease" })

export const PresenceLeaseResponseSchema = z.object({ lease: PresenceLeaseSchema })
export const PresenceLeasePageSchema = z.object({
  items: z.array(PresenceLeaseSchema).readonly(),
})

const externalUrl = z
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "Expected HTTP(S) URL")

export const ExternalIdentitySchema = z
  .object({
    id: IdentifierSchema,
    ownerId: IdentifierSchema,
    principalId: IdentifierSchema,
    provider: z.enum(["github", "google"]),
    subjectId: z.string().min(1).max(255),
    login: z.string().min(1).max(255).nullable(),
    displayName: z.string().min(1).max(255).nullable(),
    avatarUrl: externalUrl.nullable(),
    createdAt: timestamp,
    lastVerifiedAt: timestamp,
    revokedAt: timestamp.nullable(),
  })
  .strict()
  .meta({ id: "ExternalIdentity" })

export const ExternalProjectGrantSchema = z
  .object({
    id: IdentifierSchema,
    ownerId: IdentifierSchema,
    principalId: IdentifierSchema,
    externalIdentityId: IdentifierSchema,
    provider: z.literal("github"),
    accountId: z.string().min(1).max(255),
    accountName: z.string().min(1).max(255),
    installationId: z.string().min(1).max(255),
    repositoryId: z.string().min(1).max(255),
    repositoryName: z.string().min(1).max(255),
    repositoryFullName: z.string().min(1).max(511),
    repositoryUrl: externalUrl,
    private: z.boolean(),
    access: z.enum(["watch", "participate", "administer"]),
    observedAt: timestamp,
    expiresAt: timestamp,
    revokedAt: timestamp.nullable(),
  })
  .strict()
  .meta({ id: "ExternalProjectGrant" })

export const ProjectRepositoryBindingSchema = z
  .object({
    id: IdentifierSchema,
    projectId: IdentifierSchema,
    ownerId: IdentifierSchema,
    grantId: IdentifierSchema,
    provider: z.literal("github"),
    accountId: z.string().min(1).max(255),
    accountName: z.string().min(1).max(255),
    installationId: z.string().min(1).max(255),
    repositoryId: z.string().min(1).max(255),
    repositoryName: z.string().min(1).max(255),
    repositoryFullName: z.string().min(1).max(511),
    repositoryUrl: externalUrl,
    private: z.boolean(),
    boundByPrincipalId: IdentifierSchema,
    createdAt: timestamp,
    revokedAt: timestamp.nullable(),
  })
  .strict()
  .meta({ id: "ProjectRepositoryBinding" })

export const AgentConnectionCapabilitiesSchema = z
  .object({
    oneShotRuns: z.boolean(),
    durableSessions: z.boolean(),
    runtimeProviders: z.array(z.string().min(1).max(64)).readonly(),
  })
  .strict()
  .meta({ id: "AgentConnectionCapabilities" })

export const AgentConnectionSchema = z
  .object({
    id: IdentifierSchema,
    ownerId: IdentifierSchema,
    principalId: IdentifierSchema,
    agentType: z.string().min(1).max(128),
    label: z.string().min(1).max(128),
    capabilities: AgentConnectionCapabilitiesSchema,
    createdAt: timestamp,
    lastVerifiedAt: timestamp,
    revokedAt: timestamp.nullable(),
  })
  .strict()
  .meta({ id: "AgentConnection" })

export const AvailableAgentConnectionSchema = z
  .object({
    agentType: z.string().min(1).max(128),
    label: z.string().min(1).max(128),
    capabilities: AgentConnectionCapabilitiesSchema,
  })
  .strict()
  .meta({ id: "AvailableAgentConnection" })

export const ProjectSelectionSchema = z
  .object({
    ownerId: IdentifierSchema,
    principalId: IdentifierSchema,
    projectId: IdentifierSchema,
    selectedAt: timestamp,
    hiddenAt: timestamp.nullable(),
  })
  .strict()
  .meta({ id: "ProjectSelection" })

export const ConnectedOnboardingResponseSchema = z
  .object({
    principal: PrincipalSchema,
    identities: z.array(ExternalIdentitySchema).readonly(),
    repositoryGrants: z.array(ExternalProjectGrantSchema).readonly(),
    repositoryBindings: z.array(ProjectRepositoryBindingSchema).readonly(),
    agentConnections: z.array(AgentConnectionSchema).readonly(),
    availableAgents: z.array(AvailableAgentConnectionSchema).readonly(),
    projects: z
      .array(
        z
          .object({
            project: ProjectSchema,
            access: z.enum(["watch", "participate", "administer"]),
            source: z.enum(["membership", "github"]),
            selected: z.boolean(),
          })
          .strict(),
      )
      .readonly(),
  })
  .strict()
  .meta({ id: "ConnectedOnboardingResponse" })

export const ConnectAgentRequestSchema = z
  .object({ agentType: z.string().min(1).max(128) })
  .strict()
  .meta({ id: "ConnectAgentRequest" })

export const SetProjectSelectionRequestSchema = z
  .object({ selected: z.boolean() })
  .strict()
  .meta({ id: "SetProjectSelectionRequest" })

export const BindProjectRepositoryRequestSchema = z
  .object({ grantId: IdentifierSchema })
  .strict()
  .meta({ id: "BindProjectRepositoryRequest" })

export const ImportProjectRepositoryRequestSchema = z
  .object({ grantId: IdentifierSchema })
  .strict()
  .meta({ id: "ImportProjectRepositoryRequest" })

export const AgentConnectionResponseSchema = z.object({ connection: AgentConnectionSchema })
export const ProjectSelectionResponseSchema = z.object({ selection: ProjectSelectionSchema })
export const ProjectRepositoryBindingResponseSchema = z.object({
  binding: ProjectRepositoryBindingSchema,
})
export const ImportedProjectRepositoryResponseSchema = z
  .object({
    project: ProjectSchema,
    binding: ProjectRepositoryBindingSchema,
    selection: ProjectSelectionSchema,
    created: z.boolean(),
  })
  .strict()
  .meta({ id: "ImportedProjectRepositoryResponse" })

export const TaskRelaySchema = z
  .object({
    id: IdentifierSchema,
    ownerId: IdentifierSchema,
    projectId: IdentifierSchema,
    task: z.object({ kind: z.enum(["run", "session"]), id: IdentifierSchema }).strict(),
    anchorSequence: z.number().int().nonnegative(),
    author: PrincipalSummarySchema,
    recipient: PrincipalSummarySchema,
    body: z.string().min(1).max(2_000),
    createdAt: timestamp,
    acknowledgedAt: timestamp.nullable(),
  })
  .strict()
  .meta({ id: "TaskRelay" })

export const CreateTaskRelayRequestSchema = z
  .object({
    task: z.object({ kind: z.enum(["run", "session"]), id: IdentifierSchema }).strict(),
    anchorSequence: z.number().int().nonnegative(),
    recipientPrincipalId: IdentifierSchema,
    body: z.string().trim().min(1).max(2_000),
  })
  .strict()
  .meta({ id: "CreateTaskRelayRequest" })

export const TaskRelayResponseSchema = z.object({ relay: TaskRelaySchema })
export const TaskRelayPageSchema = z.object({ items: z.array(TaskRelaySchema).readonly() })

export const TranscriptAnchorSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    blockId: z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/),
    startOffset: z.number().int().nonnegative().max(10_000_000),
    endOffset: z.number().int().positive().max(10_000_000),
    quote: z.string().min(1).max(4_096),
    prefix: z.string().max(256),
    suffix: z.string().max(256),
    contentDigest: ArtifactIdentifierSchema,
  })
  .strict()
  .superRefine((anchor, context) => {
    if (anchor.endOffset <= anchor.startOffset) {
      context.addIssue({
        code: "custom",
        path: ["endOffset"],
        message: "End offset must be greater than start offset",
      })
    }
    if (anchor.endOffset - anchor.startOffset !== anchor.quote.length) {
      context.addIssue({
        code: "custom",
        path: ["quote"],
        message: "Quote length must match the UTF-16 anchor range",
      })
    }
  })
  .meta({ id: "TranscriptAnchor" })

export const TaskAnnotationSchema = z
  .object({
    id: IdentifierSchema,
    ownerId: IdentifierSchema,
    projectId: IdentifierSchema,
    task: z.object({ kind: z.enum(["run", "session"]), id: IdentifierSchema }).strict(),
    anchor: TranscriptAnchorSchema,
    author: PrincipalSummarySchema,
    body: z.string().min(1).max(2_000),
    createdAt: timestamp,
    resolvedAt: timestamp.nullable(),
    resolvedBy: PrincipalSummarySchema.nullable(),
  })
  .strict()
  .superRefine((annotation, context) => {
    if ((annotation.resolvedAt === null) !== (annotation.resolvedBy === null)) {
      context.addIssue({
        code: "custom",
        path: ["resolvedBy"],
        message: "Resolved time and Principal must be present together",
      })
    }
  })
  .meta({ id: "TaskAnnotation" })

export const CreateTaskAnnotationRequestSchema = z
  .object({
    task: z.object({ kind: z.enum(["run", "session"]), id: IdentifierSchema }).strict(),
    anchor: TranscriptAnchorSchema,
    body: z.string().trim().min(1).max(2_000),
  })
  .strict()
  .meta({ id: "CreateTaskAnnotationRequest" })

export const TaskAnnotationResponseSchema = z.object({ annotation: TaskAnnotationSchema })
export const TaskAnnotationPageSchema = z.object({
  items: z.array(TaskAnnotationSchema).readonly(),
})

const boundedEnvironment = z
  .record(environmentName, z.string().max(32_768))
  .superRefine((value, context) => {
    if (Object.keys(value).length > 128) {
      context.addIssue({ code: "custom", message: "At most 128 environment entries are allowed" })
    }
  })

export const SecretReferencesSchema = z
  .record(
    environmentName,
    z
      .string()
      .regex(/^env:\/\/[A-Za-z_][A-Za-z0-9_]*$/)
      .max(512),
  )
  .superRefine((value, context) => {
    if (Object.keys(value).length > 128) {
      context.addIssue({ code: "custom", message: "At most 128 secret references are allowed" })
    }
  })

export const RelativeWorkspacePathSchema = z
  .string()
  .max(1_024)
  .refine(
    (value) => {
      try {
        relativePath(value)
        return true
      } catch {
        return false
      }
    },
    { message: "Path must be a normalized relative workspace path" },
  )

const repositoryUrl = z
  .string()
  .max(2_048)
  .refine((value) => {
    if (value !== value.trim() || hasAsciiControlCharacter(value)) return false
    if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s?#]+$/.test(value)) return true
    try {
      const url = new URL(value)
      return (
        (url.protocol === "https:" || url.protocol === "ssh:") &&
        url.password.length === 0 &&
        (url.protocol === "ssh:" || url.username.length === 0) &&
        url.search.length === 0 &&
        url.hash.length === 0
      )
    } catch {
      return false
    }
  }, "Repository URL must use https, ssh, or scp syntax and must not contain embedded credentials")

export const WorkspaceSourceSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("repository"),
      url: repositoryUrl,
      revision: z
        .string()
        .max(255)
        .refine(isSafeRepositoryRevision, {
          message: "Revision must be a literal branch, tag, or commit name",
        })
        .optional(),
      credentialRef: z
        .string()
        .regex(/^env:\/\/[A-Za-z_][A-Za-z0-9_]*$/)
        .max(512)
        .optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.credentialRef !== undefined && !value.url.startsWith("https://")) {
        context.addIssue({
          code: "custom",
          path: ["credentialRef"],
          message: "Repository credentialRef is supported only for HTTPS repositories",
        })
      }
    }),
  z
    .object({
      type: z.literal("bundle"),
      artifactId: ArtifactIdentifierSchema,
    })
    .strict(),
])

export const WorkspaceBasisSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("repository"),
      url: repositoryUrl,
      requestedRevision: z.string().max(255).refine(isSafeRepositoryRevision).nullable(),
      resolvedRevision: z
        .string()
        .regex(/^[a-f0-9]{40,64}$/i)
        .nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("bundle"),
      artifactId: ArtifactIdentifierSchema,
    })
    .strict(),
])

export const ExecutionContextArtifactSchema = z
  .object({
    artifactId: ArtifactIdentifierSchema,
    sourceRunId: IdentifierSchema,
    sourceWorkspace: WorkspaceBasisSchema.nullable().default(null),
    path: RelativeWorkspacePathSchema,
    digest: ArtifactIdentifierSchema,
    mediaType: z.string().min(1).max(256),
    byteSize: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: "ExecutionContextArtifact" })

export const UploadedFileSchema = z
  .object({
    path: RelativeWorkspacePathSchema,
    contentBase64: z
      .string()
      .max(6 * 1024 * 1024)
      .refine((value) => {
        try {
          Uint8Array.fromBase64(value)
          return true
        } catch {
          return false
        }
      }, "File content must be valid base64"),
    mode: z.number().int().min(0o600).max(0o777).optional(),
  })
  .strict()

export const CreateWorkspaceSourceSchema = z.discriminatedUnion("type", [
  ...WorkspaceSourceSchema.options,
  z
    .object({
      type: z.literal("files"),
      files: z.array(UploadedFileSchema).min(1).max(256),
    })
    .strict(),
])

export const StructuredErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: "StructuredError" })

export const NullableStructuredErrorSchema = z.union([StructuredErrorSchema, z.null()])

const AgentToolKindSchema = z.enum([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
])

const AgentPermissionPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("deny-all") }).strict(),
  z
    .object({
      mode: z.literal("allow-once"),
      toolKinds: z.array(AgentToolKindSchema).min(1).max(10).readonly(),
    })
    .strict(),
])

export const AgentLaunchSnapshotSchema = z
  .object({
    version: z.literal(1),
    catalogVersion: z.literal(1),
    definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    executable: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),
    args: z.array(z.string()).max(128).readonly(),
    workingDirectory: z.literal("workspace"),
    capabilities: z
      .object({
        filesystem: z.boolean(),
        terminal: z.boolean(),
      })
      .strict(),
    permissionPolicy: AgentPermissionPolicySchema,
    envNames: z.array(environmentName).max(64).readonly(),
    networkPolicy: z.object({ allowedHosts: z.array(z.string()).max(64).readonly() }).strict(),
    credentials: z
      .array(
        z
          .object({
            environmentVariable: environmentName,
            host: z.string(),
            methods: z
              .array(z.enum(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]))
              .min(1)
              .max(7)
              .readonly(),
          })
          .strict(),
      )
      .max(64)
      .readonly(),
  })
  .strict()
  .meta({ id: "AgentLaunchSnapshot" })

export const ExecutionProvenanceSchema = executionProvenanceSchema.meta({
  id: "ExecutionProvenance",
})

export const RunSchema = z
  .object({
    id: IdentifierSchema,
    ownerId: IdentifierSchema,
    projectId: IdentifierSchema,
    delegatedBy: PrincipalSummarySchema,
    workspace: WorkspaceSourceSchema,
    agentType: z.string(),
    agentSpec: AgentLaunchSnapshotSchema,
    agentCatalogDigest: z.string().regex(/^[a-f0-9]{64}$/),
    executionProvenance: ExecutionProvenanceSchema,
    prompt: z.string(),
    env: z.record(z.string(), z.string()),
    secretRefs: z.record(z.string(), z.string()),
    provider: z.string(),
    contextArtifacts: z.array(ExecutionContextArtifactSchema).max(16).readonly(),
    artifactPaths: z.array(z.string()).readonly(),
    timeoutMs: z.number().int().positive(),
    deadlineAt: timestamp.nullable(),
    status: z.enum(RUN_STATUSES),
    statusVersion: z.number().int().positive(),
    runtimeId: z.string().nullable(),
    processId: z.string().nullable(),
    resolvedRevision: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/i)
      .nullable(),
    createdAt: timestamp,
    startedAt: timestamp.nullable(),
    finishedAt: timestamp.nullable(),
    updatedAt: timestamp,
    error: NullableStructuredErrorSchema,
    exitCode: z.number().int().nullable(),
  })
  .meta({ id: "Run" })

export const RunLogSchema = z
  .object({
    runId: IdentifierSchema,
    ownerId: IdentifierSchema,
    sequence: z.number().int().positive(),
    stream: z.enum(["stdout", "stderr", "agent", "system"]),
    eventType: z.string(),
    data: z.string(),
    createdAt: timestamp,
  })
  .meta({ id: "RunLogChunk" })

const RunEventBaseShape = {
  version: z.literal(1),
  runId: IdentifierSchema,
  ownerId: IdentifierSchema,
  sequence: z.number().int().positive(),
  createdAt: timestamp,
} as const

const AgentEventPayloadSchema = z.record(z.string(), safeJson)

export const RunEventSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        ...RunEventBaseShape,
        type: z.literal("run.status"),
        source: z.literal("control-plane"),
        payload: z
          .object({
            fromStatus: z.enum(RUN_STATUSES).nullable(),
            toStatus: z.enum(RUN_STATUSES),
            statusVersion: z.number().int().positive(),
            reason: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    ...(
      [
        "runner.started",
        "agent.initialized",
        "agent.session_started",
        "agent.update",
        "agent.permission",
        "agent.diagnostic",
        "agent.stderr",
        "agent.terminal",
      ] as const
    ).map((type) =>
      z
        .object({
          ...RunEventBaseShape,
          type: z.literal(type),
          source: z.literal("runner"),
          payload: AgentEventPayloadSchema,
        })
        .strict(),
    ),
    z
      .object({
        ...RunEventBaseShape,
        type: z.literal("artifact.captured"),
        source: z.literal("control-plane"),
        payload: z
          .object({
            artifactId: ArtifactIdentifierSchema,
            logicalPath: z.string(),
            kind: z.enum(["file", "directory", "workspace"]),
            digest: ArtifactIdentifierSchema,
            byteSize: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...RunEventBaseShape,
        type: z.literal("runtime.cleanup"),
        source: z.literal("control-plane"),
        payload: z
          .object({
            runtimeId: z.string().min(1),
            status: z.enum(["pending", "running", "succeeded", "failed"]),
            attempt: z.number().int().nonnegative(),
            error: NullableStructuredErrorSchema,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...RunEventBaseShape,
        type: z.literal("runtime.provisioning"),
        source: z.literal("control-plane"),
        payload: z
          .object({
            runtimeId: z.string().min(1),
            status: z.enum(["materialized", "failed"]),
            attempt: z.number().int().nonnegative(),
            error: StructuredErrorSchema.optional(),
            nextAttemptAt: timestamp.nullable().optional(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...RunEventBaseShape,
        type: z.literal("run.log"),
        source: z.enum(["control-plane", "runner"]),
        payload: z
          .object({
            stream: z.enum(["stdout", "stderr", "agent", "system"]),
            eventType: z.string(),
            data: z.string(),
          })
          .strict(),
      })
      .strict(),
  ])
  .meta({ id: "RunEvent" })

export const ArtifactSchema = z
  .object({
    id: ArtifactIdentifierSchema,
    ownerId: IdentifierSchema,
    runId: IdentifierSchema,
    logicalPath: z.string(),
    kind: z.enum(["file", "directory", "workspace"]),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    mediaType: z.string(),
    byteSize: z.number().int().nonnegative(),
    createdAt: timestamp,
  })
  .meta({ id: "Artifact" })

export const ArtifactEntrySchema = z
  .object({
    path: RelativeWorkspacePathSchema,
    logicalPath: RelativeWorkspacePathSchema,
    mediaType: z.string(),
    digest: ArtifactIdentifierSchema,
    size: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: "ArtifactEntry" })

export const ArtifactDetailSchema = z.object({
  artifact: ArtifactSchema,
  entries: z.array(ArtifactEntrySchema).readonly(),
})

export const BriefSchema = z
  .object({
    id: ArtifactIdentifierSchema,
    ownerId: IdentifierSchema,
    title: z.string().min(1).max(160),
    artifactId: ArtifactIdentifierSchema,
    sourceRunId: IdentifierSchema,
    sourceWorkspace: WorkspaceBasisSchema,
    path: RelativeWorkspacePathSchema,
    digest: ArtifactIdentifierSchema,
    mediaType: z.string().min(1).max(256),
    byteSize: z.number().int().nonnegative(),
    createdAt: timestamp,
  })
  .strict()
  .meta({ id: "Brief" })

export const CreateBriefRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    artifactId: ArtifactIdentifierSchema,
    path: RelativeWorkspacePathSchema.optional(),
  })
  .strict()
  .meta({ id: "CreateBriefRequest" })

export const BriefResponseSchema = z.object({ brief: BriefSchema })
export const BriefPageSchema = z.object({
  items: z.array(BriefSchema).readonly(),
  nextCursor: z.string().nullable(),
})

export const CursorQuerySchema = z
  .object({
    after: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(1_000).default(100),
  })
  .strict()

export const LogQuerySchema = CursorQuerySchema.extend({
  follow: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
})

export const IdParamSchema = z.object({ id: IdentifierSchema }).strict()
export const ArtifactIdParamSchema = z.object({ id: ArtifactIdentifierSchema }).strict()

export const CreatedPageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(1_024)
      .optional(),
  })
  .strict()

export const ErrorEnvelopeSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      requestId: z.string(),
      details: z.record(z.string(), z.unknown()),
    }),
  })
  .meta({ id: "ErrorEnvelope" })

export const CreateRunRequestSchema = z
  .object({
    projectId: IdentifierSchema.optional(),
    workspace: CreateWorkspaceSourceSchema,
    agentType: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
      .max(128),
    prompt: z.string().min(1).max(262_144),
    env: boundedEnvironment.default({}),
    secretRefs: SecretReferencesSchema.default({}),
    provider: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
      .max(64)
      .optional(),
    briefIds: z.array(ArtifactIdentifierSchema).max(16).default([]),
    artifactPaths: z.array(RelativeWorkspacePathSchema).max(128).default([]),
    timeoutMs: z.number().int().min(1_000).max(86_400_000).default(3_600_000),
  })
  .strict()
  .superRefine((value, context) => {
    for (const name of Object.keys(value.secretRefs)) {
      if (Object.hasOwn(value.env, name)) {
        context.addIssue({
          code: "custom",
          message: "A name cannot appear in both env and secretRefs",
          path: ["secretRefs", name],
        })
      }
    }
    if (new Set(value.artifactPaths).size !== value.artifactPaths.length) {
      context.addIssue({
        code: "custom",
        message: "Artifact paths must be unique",
        path: ["artifactPaths"],
      })
    }
    if (new Set(value.briefIds).size !== value.briefIds.length) {
      context.addIssue({
        code: "custom",
        message: "Brief IDs must be unique",
        path: ["briefIds"],
      })
    }
  })
  .meta({ id: "CreateRunRequest" })

const IdempotencyKeySchema = z.string().min(1).max(255)

export const IdempotencyHeaderSchema = z.object({
  "idempotency-key": IdempotencyKeySchema.optional(),
})

export const RequiredIdempotencyHeaderSchema = z.object({
  "idempotency-key": IdempotencyKeySchema,
})

export const RunResponseSchema = z.object({ run: RunSchema })
export const RunPageSchema = z.object({
  items: z.array(RunSchema).readonly(),
  nextCursor: z.string().nullable(),
})
export const RunLogPageSchema = z.object({
  items: z.array(RunLogSchema).readonly(),
  nextCursor: z.number().int().positive().nullable(),
})
export const RunEventPageSchema = z.object({
  items: z.array(RunEventSchema).readonly(),
  nextCursor: z.number().int().positive().nullable(),
})

export const CreateSessionRequestSchema = z
  .object({
    projectId: IdentifierSchema.optional(),
    workspace: CreateWorkspaceSourceSchema,
    agentType: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
      .max(128),
    env: boundedEnvironment.default({}),
    secretRefs: SecretReferencesSchema.default({}),
    provider: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
      .max(64)
      .optional(),
    idleTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(86_400_000)
      .default(30 * 60_000),
  })
  .strict()
  .superRefine((value, context) => {
    for (const name of Object.keys(value.secretRefs)) {
      if (Object.hasOwn(value.env, name)) {
        context.addIssue({
          code: "custom",
          path: ["secretRefs", name],
          message: "A name cannot appear in both env and secretRefs",
        })
      }
    }
  })
  .meta({ id: "CreateSessionRequest" })

const AgentSessionStatusSchema = z.enum([
  "queued",
  "provisioning",
  "idle",
  "running",
  "closing",
  "closed",
  "failed",
  "continuity_lost",
])
const TurnStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "timed_out",
])

export const AgentSessionSchema = z
  .object({
    id: IdentifierSchema,
    ownerId: IdentifierSchema,
    projectId: IdentifierSchema,
    delegatedBy: PrincipalSummarySchema,
    workspace: WorkspaceSourceSchema,
    agentType: z.string(),
    agentSpec: AgentLaunchSnapshotSchema,
    agentCatalogDigest: ArtifactIdentifierSchema,
    executionProvenance: ExecutionProvenanceSchema,
    env: z.record(z.string(), z.string()),
    secretRefs: z.record(z.string(), z.string()),
    provider: z.string(),
    status: AgentSessionStatusSchema,
    statusVersion: z.number().int().positive(),
    activeTurnId: IdentifierSchema.nullable(),
    runtimeId: z.string().nullable(),
    processId: z.string().nullable(),
    agentSessionId: z.string().nullable(),
    capabilities: z.record(z.string(), safeJson).nullable(),
    resolvedRevision: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/i)
      .nullable(),
    idleTimeoutMs: z.number().int().positive(),
    createdAt: timestamp,
    startedAt: timestamp.nullable(),
    closedAt: timestamp.nullable(),
    updatedAt: timestamp,
    error: NullableStructuredErrorSchema,
  })
  .meta({ id: "AgentSession" })

export const SessionTurnSchema = z
  .object({
    id: IdentifierSchema,
    ownerId: IdentifierSchema,
    sessionId: IdentifierSchema,
    sequence: z.number().int().positive(),
    prompt: z.string(),
    contextArtifacts: z.array(ExecutionContextArtifactSchema).max(16).readonly(),
    timeoutMs: z.number().int().positive(),
    deadlineAt: timestamp.nullable(),
    status: TurnStatusSchema,
    statusVersion: z.number().int().positive(),
    createdAt: timestamp,
    startedAt: timestamp.nullable(),
    finishedAt: timestamp.nullable(),
    updatedAt: timestamp,
    error: NullableStructuredErrorSchema,
  })
  .meta({ id: "SessionTurn" })

export const CreateSessionTurnRequestSchema = z
  .object({
    prompt: z.string().min(1).max(1_048_576),
    briefIds: z.array(ArtifactIdentifierSchema).max(16).default([]),
    timeoutMs: z.number().int().min(1_000).max(86_400_000).default(3_600_000),
    conflictPolicy: z.enum(["reject", "enqueue", "interrupt_and_send"]).default("reject"),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.briefIds).size !== value.briefIds.length) {
      context.addIssue({
        code: "custom",
        message: "Brief IDs must be unique",
        path: ["briefIds"],
      })
    }
  })
  .meta({ id: "CreateSessionTurnRequest" })

const SessionEventBaseShape = {
  version: z.literal(1),
  sessionId: IdentifierSchema,
  ownerId: IdentifierSchema,
  sequence: z.number().int().positive(),
  turnId: IdentifierSchema.nullable(),
  createdAt: timestamp,
} as const

export const SessionEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...SessionEventBaseShape,
      type: z.literal("session.status"),
      source: z.literal("control-plane"),
      payload: z
        .object({
          fromStatus: AgentSessionStatusSchema.nullable(),
          toStatus: AgentSessionStatusSchema,
          statusVersion: z.number().int().positive(),
          reason: z.string(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...SessionEventBaseShape,
      type: z.literal("turn.status"),
      source: z.literal("control-plane"),
      payload: z
        .object({
          fromStatus: TurnStatusSchema.nullable(),
          toStatus: TurnStatusSchema,
          statusVersion: z.number().int().positive(),
          reason: z.string(),
        })
        .strict(),
    })
    .strict(),
  ...(
    [
      "session.ready",
      "turn.started",
      "turn.update",
      "turn.permission",
      "agent.stderr",
      "turn.terminal",
      "session.closed",
    ] as const
  ).map((type) =>
    z
      .object({
        ...SessionEventBaseShape,
        type: z.literal(type),
        source: z.literal("runner"),
        payload: z.record(z.string(), safeJson),
      })
      .strict(),
  ),
  z
    .object({
      ...SessionEventBaseShape,
      type: z.literal("session.diagnostic"),
      source: z.literal("control-plane"),
      payload: z.record(z.string(), safeJson),
    })
    .strict(),
])

export const AgentSessionResponseSchema = z.object({ session: AgentSessionSchema })
export const AgentSessionPageSchema = z.object({
  items: z.array(AgentSessionSchema).readonly(),
  nextCursor: z.string().nullable(),
})
export const SessionTurnResponseSchema = z.object({ turn: SessionTurnSchema })
export const SessionTurnPageSchema = z.object({
  items: z.array(SessionTurnSchema).readonly(),
  nextCursor: z.number().int().positive().nullable(),
})
export const SessionEventPageSchema = z.object({
  items: z.array(SessionEventSchema).readonly(),
  nextCursor: z.number().int().positive().nullable(),
})
export const ArtifactPageSchema = z.object({ items: z.array(ArtifactSchema).readonly() })

export const ProjectWorkItemSchema = z
  .object({
    kind: z.enum(["run", "session"]),
    id: IdentifierSchema,
    projectId: IdentifierSchema,
    delegatedBy: PrincipalSummarySchema,
    title: z.string(),
    agentType: z.string(),
    status: z.union([z.enum(RUN_STATUSES), AgentSessionStatusSchema]),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict()
  .meta({ id: "ProjectWorkItem" })

export const CreatePrincipalRequestSchema = z
  .object({
    kind: z.enum(["person", "service"]),
    displayName: z.string().trim().min(1).max(120),
  })
  .strict()
  .meta({ id: "CreatePrincipalRequest" })

export const CreateProjectRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(80),
  })
  .strict()
  .meta({ id: "CreateProjectRequest" })

export const AddProjectMemberRequestSchema = z
  .object({ principalId: IdentifierSchema, role: z.enum(["maintainer", "member"]) })
  .strict()
  .meta({ id: "AddProjectMemberRequest" })

export const MeResponseSchema = z.object({
  principal: PrincipalSchema,
  projects: z.array(ProjectSchema).readonly(),
})
export const PrincipalResponseSchema = z.object({ principal: PrincipalSchema })
export const PrincipalPageSchema = z.object({ items: z.array(PrincipalSchema).readonly() })
export const ProjectResponseSchema = z.object({ project: ProjectSchema })
export const ProjectPageSchema = z.object({ items: z.array(ProjectSchema).readonly() })
export const ProjectMemberResponseSchema = z.object({ member: ProjectMemberSchema })
export const ProjectMemberPageSchema = z.object({ items: z.array(ProjectMemberSchema).readonly() })
export const ProjectWorkPageSchema = z.object({ items: z.array(ProjectWorkItemSchema).readonly() })

export const ApiKeySchema = z
  .object({
    id: IdentifierSchema,
    ownerId: IdentifierSchema,
    principalId: IdentifierSchema,
    prefix: z.string().regex(/^mwk_[A-Za-z0-9_-]{12}$/),
    name: z.string().min(1).max(128),
    createdAt: timestamp,
    lastUsedAt: timestamp.nullable(),
    revokedAt: timestamp.nullable(),
  })
  .strict()
  .meta({ id: "ApiKey" })

export const CreateApiKeyRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    principalId: IdentifierSchema.optional(),
  })
  .strict()
  .meta({ id: "CreateApiKeyRequest" })

export const ApiKeyResponseSchema = z.object({ key: ApiKeySchema })
export const CreatedApiKeyResponseSchema = z.object({
  key: ApiKeySchema,
  secret: z.string().regex(/^mwk_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/),
})
export const ApiKeyPageSchema = z.object({ items: z.array(ApiKeySchema).readonly() })

export const PrincipalInvitationSchema = z
  .object({
    id: IdentifierSchema,
    ownerId: IdentifierSchema,
    principalId: IdentifierSchema,
    prefix: z.string().regex(/^mwi_[A-Za-z0-9_-]{12}$/),
    createdByPrincipalId: IdentifierSchema,
    createdAt: timestamp,
    expiresAt: timestamp,
    redeemedAt: timestamp.nullable(),
    revokedAt: timestamp.nullable(),
  })
  .strict()
  .meta({ id: "PrincipalInvitation" })

export const CreatePrincipalInvitationRequestSchema = z
  .object({
    principalId: IdentifierSchema,
    expiresInSeconds: z
      .number()
      .int()
      .min(5 * 60)
      .max(30 * 24 * 60 * 60)
      .optional(),
  })
  .strict()
  .meta({ id: "CreatePrincipalInvitationRequest" })

export const PrincipalInvitationResponseSchema = z.object({
  invitation: PrincipalInvitationSchema,
})
export const CreatedPrincipalInvitationResponseSchema = z.object({
  invitation: PrincipalInvitationSchema,
  secret: z.string().regex(/^mwi_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/),
})
export const PrincipalInvitationPageSchema = z.object({
  items: z.array(PrincipalInvitationSchema).readonly(),
})

export const BrowserSessionSchema = z
  .object({
    id: IdentifierSchema,
    ownerId: IdentifierSchema,
    principalId: IdentifierSchema,
    createdAt: timestamp,
    expiresAt: timestamp,
    lastUsedAt: timestamp.nullable(),
    revokedAt: timestamp.nullable(),
  })
  .strict()
  .meta({ id: "BrowserSession" })

export const CreatedBrowserSessionResponseSchema = z.object({
  session: BrowserSessionSchema,
  secret: z.string().regex(/^mws_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/),
})
export const BrowserSessionResponseSchema = z.object({ session: BrowserSessionSchema })

export const AuditRecordSchema = z
  .object({
    id: IdentifierSchema,
    ownerId: IdentifierSchema,
    actorApiKeyId: IdentifierSchema.nullable(),
    action: z.string(),
    resourceType: z.enum([
      "owner",
      "principal",
      "project",
      "project_membership",
      "external_identity",
      "identity_credential",
      "external_project_grant",
      "project_repository_binding",
      "agent_connection",
      "project_selection",
      "principal_invitation",
      "task_relay",
      "task_annotation",
      "browser_session",
      "api_key",
      "run",
      "session",
      "turn",
      "runtime",
      "credential_lease",
      "artifact",
      "brief",
      "deployment",
    ]),
    resourceId: z.string(),
    requestId: z.string(),
    traceId: z.string().nullable(),
    metadata: z.record(z.string(), safeJson),
    createdAt: timestamp,
  })
  .strict()
  .meta({ id: "AuditRecord" })

export const AuditQuerySchema = CreatedPageQuerySchema.extend({
  resourceType: z
    .enum([
      "owner",
      "principal",
      "project",
      "project_membership",
      "external_identity",
      "external_project_grant",
      "project_repository_binding",
      "agent_connection",
      "project_selection",
      "principal_invitation",
      "task_relay",
      "task_annotation",
      "browser_session",
      "api_key",
      "run",
      "session",
      "turn",
      "runtime",
      "credential_lease",
      "artifact",
      "brief",
      "deployment",
    ])
    .optional(),
  resourceId: z.string().min(1).max(256).optional(),
  action: z.string().min(1).max(128).optional(),
})

export const AuditPageSchema = z.object({
  items: z.array(AuditRecordSchema).readonly(),
  nextCursor: z.string().nullable(),
})

export const DeploymentSchema = z
  .object({
    id: IdentifierSchema,
    ownerId: IdentifierSchema,
    runId: IdentifierSchema,
    artifactId: ArtifactIdentifierSchema,
    target: z.string(),
    targetConfig: z.record(z.string(), safeJson),
    secretRefs: z.record(z.string(), z.string()),
    status: z.enum(["queued", "running", "succeeded", "failed"]),
    url: z.url().nullable(),
    error: NullableStructuredErrorSchema,
    createdAt: timestamp,
    startedAt: timestamp.nullable(),
    finishedAt: timestamp.nullable(),
    updatedAt: timestamp,
  })
  .meta({ id: "Deployment" })

export const DeploymentLogSchema = z
  .object({
    deploymentId: IdentifierSchema,
    sequence: z.number().int().positive(),
    level: z.enum(["debug", "info", "warn", "error"]),
    event: z.string(),
    message: z.string(),
    fields: z.record(z.string(), safeJson),
    createdAt: timestamp,
  })
  .meta({ id: "DeploymentLogChunk" })

const CreateDeploymentCommonShape = {
  runId: IdentifierSchema,
  deployTarget: z
    .string()
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
    .max(64),
  config: z.record(z.string(), safeJson).default({}),
  secretRefs: SecretReferencesSchema.default({}),
} as const

export const CreateDeploymentRequestSchema = z
  .union([
    z
      .object({
        ...CreateDeploymentCommonShape,
        artifactPath: RelativeWorkspacePathSchema,
      })
      .strict(),
    z
      .object({
        ...CreateDeploymentCommonShape,
        workspacePath: RelativeWorkspacePathSchema,
      })
      .strict(),
  ])
  .meta({ id: "CreateDeploymentRequest" })

export const DeploymentResponseSchema = z.object({ deployment: DeploymentSchema })
export const DeploymentPageSchema = z.object({
  items: z.array(DeploymentSchema).readonly(),
  nextCursor: z.string().nullable(),
})
export const DeploymentLogPageSchema = z.object({
  items: z.array(DeploymentLogSchema).readonly(),
  nextCursor: z.number().int().positive().nullable(),
})

export const ProviderTestRequestSchema = z
  .object({
    provider: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
      .max(64),
  })
  .strict()

export const ProviderDiagnosticsSchema = z
  .object({
    provider: z.string(),
    capabilities: z.object({
      isolation: z.enum(["none", "container", "virtual-machine"]),
      processRecovery: z.boolean(),
      eventReplay: z.boolean(),
      processInput: z.boolean(),
      portExposure: z.boolean(),
      processSignals: z.array(z.enum(["SIGINT", "SIGTERM", "SIGKILL"])).readonly(),
    }),
    health: z.object({
      status: z.enum(["healthy", "degraded", "unavailable"]),
      checkedAt: timestamp,
      message: z.string().optional(),
    }),
  })
  .meta({ id: "ProviderDiagnostics" })

export type CreateRunRequest = z.input<typeof CreateRunRequestSchema>
export type Principal = z.output<typeof PrincipalSchema>
export type Project = z.output<typeof ProjectSchema>
export type ProjectMember = z.output<typeof ProjectMemberSchema>
export type ProjectParticipant = z.output<typeof ProjectParticipantSchema>
export type PresenceLease = z.output<typeof PresenceLeaseSchema>
export type ExternalIdentity = z.output<typeof ExternalIdentitySchema>
export type ExternalProjectGrant = z.output<typeof ExternalProjectGrantSchema>
export type ProjectRepositoryBinding = z.output<typeof ProjectRepositoryBindingSchema>
export type AgentConnection = z.output<typeof AgentConnectionSchema>
export type AvailableAgentConnection = z.output<typeof AvailableAgentConnectionSchema>
export type ProjectSelection = z.output<typeof ProjectSelectionSchema>
export type ConnectedOnboarding = z.output<typeof ConnectedOnboardingResponseSchema>
export type ImportedProjectRepository = z.output<typeof ImportedProjectRepositoryResponseSchema>
export type ProjectWorkItem = z.output<typeof ProjectWorkItemSchema>
export type TaskRelay = z.output<typeof TaskRelaySchema>
export type TranscriptAnchor = z.output<typeof TranscriptAnchorSchema>
export type TaskAnnotation = z.output<typeof TaskAnnotationSchema>
export type CreatePrincipalRequest = z.input<typeof CreatePrincipalRequestSchema>
export type CreateProjectRequest = z.input<typeof CreateProjectRequestSchema>
export type AddProjectMemberRequest = z.input<typeof AddProjectMemberRequestSchema>
export type CreateTaskRelayRequest = z.input<typeof CreateTaskRelayRequestSchema>
export type CreateTaskAnnotationRequest = z.input<typeof CreateTaskAnnotationRequestSchema>
export type Run = z.output<typeof RunSchema>
export type RunLog = z.output<typeof RunLogSchema>
export type RunEvent = z.output<typeof RunEventSchema>
export type Artifact = z.output<typeof ArtifactSchema>
export type ArtifactEntry = z.output<typeof ArtifactEntrySchema>
export type ArtifactDetail = z.output<typeof ArtifactDetailSchema>
export type CreateBriefRequest = z.input<typeof CreateBriefRequestSchema>
export type Brief = z.output<typeof BriefSchema>
export type BriefPage = z.output<typeof BriefPageSchema>
export type ApiKey = z.output<typeof ApiKeySchema>
export type PrincipalInvitation = z.output<typeof PrincipalInvitationSchema>
export type BrowserSession = z.output<typeof BrowserSessionSchema>
export type AuditRecord = z.output<typeof AuditRecordSchema>
export type AuditPage = z.output<typeof AuditPageSchema>
export type RunPage = z.output<typeof RunPageSchema>
export type RunLogPage = z.output<typeof RunLogPageSchema>
export type RunEventPage = z.output<typeof RunEventPageSchema>
export type CreateSessionRequest = z.input<typeof CreateSessionRequestSchema>
export type CreateSessionTurnRequest = z.input<typeof CreateSessionTurnRequestSchema>
export type AgentSession = z.output<typeof AgentSessionSchema>
export type AgentSessionPage = z.output<typeof AgentSessionPageSchema>
export type SessionTurn = z.output<typeof SessionTurnSchema>
export type SessionTurnPage = z.output<typeof SessionTurnPageSchema>
export type SessionEvent = z.output<typeof SessionEventSchema>
export type SessionEventPage = z.output<typeof SessionEventPageSchema>
export type CreateDeploymentRequest = z.input<typeof CreateDeploymentRequestSchema>
export type Deployment = z.output<typeof DeploymentSchema>
export type DeploymentPage = z.output<typeof DeploymentPageSchema>
export type DeploymentLog = z.output<typeof DeploymentLogSchema>
export type DeploymentLogPage = z.output<typeof DeploymentLogPageSchema>
export type ProviderDiagnostics = z.output<typeof ProviderDiagnosticsSchema>

const hasAsciiControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true
  }
  return false
}
