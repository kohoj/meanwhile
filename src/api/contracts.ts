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
    secretEnvNames: z.array(environmentName).max(64).readonly(),
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
    workspace: WorkspaceSourceSchema,
    agentType: z.string(),
    agentSpec: AgentLaunchSnapshotSchema,
    agentCatalogDigest: z.string().regex(/^[a-f0-9]{64}$/),
    executionProvenance: ExecutionProvenanceSchema.nullable(),
    prompt: z.string(),
    env: z.record(z.string(), z.string()),
    secretRefs: z.record(z.string(), z.string()),
    provider: z.string(),
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
  })
  .meta({ id: "CreateRunRequest" })

export const IdempotencyHeaderSchema = z.object({
  "idempotency-key": z.string().min(1).max(255).optional(),
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
export const ArtifactPageSchema = z.object({ items: z.array(ArtifactSchema).readonly() })

export const ApiKeySchema = z
  .object({
    id: IdentifierSchema,
    ownerId: IdentifierSchema,
    prefix: z.string().regex(/^mwk_[A-Za-z0-9_-]{12}$/),
    name: z.string().min(1).max(128),
    createdAt: timestamp,
    lastUsedAt: timestamp.nullable(),
    revokedAt: timestamp.nullable(),
  })
  .strict()
  .meta({ id: "ApiKey" })

export const CreateApiKeyRequestSchema = z
  .object({ name: z.string().trim().min(1).max(128) })
  .strict()
  .meta({ id: "CreateApiKeyRequest" })

export const ApiKeyResponseSchema = z.object({ key: ApiKeySchema })
export const CreatedApiKeyResponseSchema = z.object({
  key: ApiKeySchema,
  secret: z.string().regex(/^mwk_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/),
})
export const ApiKeyPageSchema = z.object({ items: z.array(ApiKeySchema).readonly() })

export const AuditRecordSchema = z
  .object({
    id: IdentifierSchema,
    ownerId: IdentifierSchema,
    actorApiKeyId: IdentifierSchema.nullable(),
    action: z.string(),
    resourceType: z.enum(["owner", "api_key", "run", "runtime", "artifact", "deployment"]),
    resourceId: z.string(),
    requestId: z.string(),
    traceId: z.string().nullable(),
    metadata: z.record(z.string(), safeJson),
    createdAt: timestamp,
  })
  .strict()
  .meta({ id: "AuditRecord" })

export const AuditQuerySchema = CreatedPageQuerySchema.extend({
  resourceType: z.enum(["owner", "api_key", "run", "runtime", "artifact", "deployment"]).optional(),
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
export type Run = z.output<typeof RunSchema>
export type RunLog = z.output<typeof RunLogSchema>
export type Artifact = z.output<typeof ArtifactSchema>
export type ArtifactEntry = z.output<typeof ArtifactEntrySchema>
export type ArtifactDetail = z.output<typeof ArtifactDetailSchema>
export type ApiKey = z.output<typeof ApiKeySchema>
export type AuditRecord = z.output<typeof AuditRecordSchema>
export type AuditPage = z.output<typeof AuditPageSchema>
export type RunPage = z.output<typeof RunPageSchema>
export type RunLogPage = z.output<typeof RunLogPageSchema>
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
