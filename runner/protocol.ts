import { z } from "zod"

export const RUNNER_PROTOCOL_VERSION = 3 as const

export const MAX_RUNNER_SPEC_BYTES = 2 * 1024 * 1024
export const MAX_RUNNER_FRAME_BYTES = 256 * 1024
export const MAX_ACP_LINE_BYTES = 1024 * 1024
export const MAX_SESSION_UPDATE_BYTES = 128 * 1024
export const MAX_STDERR_CHUNK_BYTES = 16 * 1024

const MAX_PATH_LENGTH = 4_096
const MAX_ARGUMENT_LENGTH = 32_768
const MAX_PROMPT_LENGTH = 1_048_576
const MAX_ENVIRONMENT_VALUE_LENGTH = 65_536
const MAX_TIMEOUT_BUDGET_MS = 24 * 60 * 60 * 1_000

const withoutNullBytes = <Schema extends z.ZodString>(schema: Schema) =>
  schema.refine((value) => !value.includes("\0"), "Must not contain NUL bytes")

export const environmentNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid environment variable name")

export const relativePathSchema = withoutNullBytes(
  z.string().min(1).max(MAX_PATH_LENGTH),
).superRefine((value, context) => {
  if (value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/.test(value)) {
    context.addIssue({
      code: "custom",
      message: "Path must be normalized and relative",
    })
    return
  }

  if (
    value.endsWith("/") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    context.addIssue({
      code: "custom",
      message: "Path contains a non-normalized segment",
    })
  }
})

export const absolutePathSchema = withoutNullBytes(z.string().min(1).max(MAX_PATH_LENGTH)).refine(
  (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value),
  "Path must be absolute",
)

const commandPartSchema = withoutNullBytes(z.string().min(1).max(MAX_ARGUMENT_LENGTH))
const portableExecutableSchema = commandPartSchema.regex(
  /^[A-Za-z0-9][A-Za-z0-9._+-]*$/,
  "Agent executable must be a bare, portable PATH name",
)

const runnerAgentSchema = z
  .object({
    executable: portableExecutableSchema,
    args: z.array(commandPartSchema).max(256),
    workingDirectory: z.literal("workspace").optional(),
  })
  .strict()

const toolKindSchema = z.enum([
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

export const runnerPermissionPolicySchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("deny-all"),
    })
    .strict(),
  z
    .object({
      mode: z.literal("allow-once"),
      toolKinds: z.array(toolKindSchema).min(1).max(10),
    })
    .strict()
    .transform((policy) => ({
      ...policy,
      toolKinds: [...new Set(policy.toolKinds)],
    })),
])

export const runnerSpecSchema = z
  .object({
    protocolVersion: z.literal(RUNNER_PROTOCOL_VERSION),
    runId: withoutNullBytes(z.string().min(1).max(128)),
    runnerSessionId: withoutNullBytes(z.string().min(1).max(128)),
    agent: runnerAgentSchema,
    prompt: withoutNullBytes(z.string().max(MAX_PROMPT_LENGTH)),
    permissionPolicy: runnerPermissionPolicySchema,
    artifactPaths: z.array(relativePathSchema).max(256),
    timeoutBudgetMs: z.number().int().positive().max(MAX_TIMEOUT_BUDGET_MS),
    environment: z.record(
      environmentNameSchema,
      withoutNullBytes(z.string().max(MAX_ENVIRONMENT_VALUE_LENGTH)),
    ),
    secretEnvironmentNames: z.array(environmentNameSchema).max(128),
  })
  .strict()
  .superRefine((spec, context) => {
    if (Object.keys(spec.environment).length > 128) {
      context.addIssue({
        code: "custom",
        path: ["environment"],
        message: "At most 128 environment variables are allowed",
      })
    }

    const secretNames = new Set(spec.secretEnvironmentNames)
    if (secretNames.size !== spec.secretEnvironmentNames.length) {
      context.addIssue({
        code: "custom",
        path: ["secretEnvironmentNames"],
        message: "Secret environment names must be unique",
      })
    }

    for (const name of Object.keys(spec.environment)) {
      if (secretNames.has(name)) {
        context.addIssue({
          code: "custom",
          path: ["environment", name],
          message: "A variable cannot be both persisted and secret",
        })
      }
    }

    if (new Set(spec.artifactPaths).size !== spec.artifactPaths.length) {
      context.addIssue({
        code: "custom",
        path: ["artifactPaths"],
        message: "Artifact paths must be unique",
      })
    }
  })

export type RunnerSpec = z.infer<typeof runnerSpecSchema>
export type RunnerPermissionPolicy = z.infer<typeof runnerPermissionPolicySchema>

export const sessionRunnerSpecSchema = z
  .object({
    protocolVersion: z.literal(RUNNER_PROTOCOL_VERSION),
    mode: z.literal("session"),
    sessionId: withoutNullBytes(z.string().min(1).max(128)),
    runnerSessionId: withoutNullBytes(z.string().min(1).max(128)),
    agent: runnerAgentSchema,
    permissionPolicy: runnerPermissionPolicySchema,
    environment: z.record(
      environmentNameSchema,
      withoutNullBytes(z.string().max(MAX_ENVIRONMENT_VALUE_LENGTH)),
    ),
    secretEnvironmentNames: z.array(environmentNameSchema).max(128),
    idleTimeoutMs: z.number().int().positive().max(MAX_TIMEOUT_BUDGET_MS),
  })
  .strict()

export type SessionRunnerSpec = z.infer<typeof sessionRunnerSpecSchema>
export type AnyRunnerSpec = RunnerSpec | SessionRunnerSpec

const jsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonPrimitiveSchema, z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
)

const frameBase = {
  protocolVersion: z.literal(RUNNER_PROTOCOL_VERSION),
  runId: withoutNullBytes(z.string().min(1).max(128)),
  runnerSessionId: withoutNullBytes(z.string().min(1).max(128)),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  timestamp: z.string().datetime({ offset: true }),
}

const safeAgentInfoSchema = z
  .object({
    name: z.string().min(1).max(256),
    title: z.string().max(256).optional(),
    version: z.string().min(1).max(128),
  })
  .strict()

const agentCapabilitySummarySchema = z
  .object({
    loadSession: z.boolean(),
    session: z
      .object({
        close: z.boolean(),
      })
      .strict(),
    prompt: z
      .object({
        image: z.boolean(),
        audio: z.boolean(),
        embeddedContext: z.boolean(),
      })
      .strict(),
    mcp: z
      .object({
        http: z.boolean(),
        sse: z.boolean(),
      })
      .strict(),
  })
  .strict()

const runnerStopReasonSchema = z.enum([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
])

function outcomesForStopReason(
  stopReason: z.infer<typeof runnerStopReasonSchema>,
): readonly ("succeeded" | "failed" | "cancelled" | "timed_out")[] {
  switch (stopReason) {
    case "end_turn":
      return ["succeeded"]
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
      return ["failed"]
    case "cancelled":
      return ["cancelled", "timed_out"]
  }
}

export const runnerTerminalPayloadSchema = z
  .object({
    outcome: z.enum(["succeeded", "failed", "cancelled", "timed_out"]),
    stopReason: runnerStopReasonSchema.optional(),
    error: z
      .object({
        code: z.enum([
          "AGENT_SPAWN_FAILED",
          "ACP_MAX_TOKENS",
          "ACP_MAX_TURN_REQUESTS",
          "ACP_REFUSAL",
          "ACP_OUTPUT_LIMIT_EXCEEDED",
          "ACP_CONNECTION_FAILED",
          "ACP_PROTOCOL_UNSUPPORTED",
          "ACP_SESSION_FAILED",
          "AGENT_EXITED",
          "MISSING_SECRET_ENVIRONMENT",
          "WORKSPACE_INVALID",
          "RUNNER_INTERNAL_ERROR",
        ]),
        message: z.string().min(1).max(1_024),
      })
      .strict()
      .optional(),
    agentExit: z
      .object({
        exitCode: z.number().int().nullable(),
        signal: z.string().max(64).nullable(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((terminal, context) => {
    const expectedOutcomes = terminal.stopReason
      ? outcomesForStopReason(terminal.stopReason)
      : undefined
    if (expectedOutcomes && !expectedOutcomes.includes(terminal.outcome)) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: `Stop reason ${terminal.stopReason} is incompatible with outcome ${terminal.outcome}`,
      })
    }
    if (terminal.outcome === "succeeded" && terminal.stopReason !== "end_turn") {
      context.addIssue({
        code: "custom",
        path: ["stopReason"],
        message: "A succeeded runner terminal requires stop reason end_turn",
      })
    }
    if (terminal.outcome === "failed" && terminal.error === undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "A failed runner terminal requires a structured error",
      })
    }
    if (terminal.outcome !== "failed" && terminal.error !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Only a failed runner terminal may contain an error",
      })
    }
  })

export const runnerFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...frameBase,
      type: z.literal("runner.started"),
      payload: z
        .object({
          timeoutBudgetMs: z.number().int().positive().max(MAX_TIMEOUT_BUDGET_MS),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...frameBase,
      type: z.literal("runner.diagnostic"),
      payload: z
        .object({
          code: z.enum(["ACP_SDK_DIAGNOSTIC", "ACP_SDK_DIAGNOSTICS_SUPPRESSED"]),
          severity: z.enum(["info", "warning", "error"]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...frameBase,
      type: z.literal("agent.initialized"),
      payload: z
        .object({
          protocolVersion: z.number().int().nonnegative(),
          agentInfo: safeAgentInfoSchema.optional(),
          capabilities: agentCapabilitySummarySchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...frameBase,
      type: z.literal("session.started"),
      payload: z
        .object({
          sessionId: z.string().min(1).max(512),
          modeId: z.string().max(256).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...frameBase,
      type: z.literal("session.update"),
      payload: z
        .object({
          sessionId: z.string().min(1).max(512),
          update: z.record(z.string(), jsonValueSchema),
          truncated: z.boolean(),
          originalBytes: z.number().int().positive().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...frameBase,
      type: z.literal("permission.resolved"),
      payload: z
        .object({
          toolCallId: z.string().min(1).max(512),
          toolKind: toolKindSchema.optional(),
          decision: z.enum(["allowed", "denied"]),
          selectedOptionKind: z.enum(["allow_once", "reject_once", "reject_always"]).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...frameBase,
      type: z.literal("agent.stderr"),
      payload: z
        .object({
          chunk: z.string().max(MAX_STDERR_CHUNK_BYTES),
          truncated: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...frameBase,
      type: z.literal("terminal"),
      payload: runnerTerminalPayloadSchema,
    })
    .strict(),
])

export type RunnerFrame = z.infer<typeof runnerFrameSchema>
export type RunnerEvent = RunnerFrame extends infer Frame
  ? Frame extends RunnerFrame
    ? Omit<Frame, keyof typeof frameBase>
    : never
  : never
export type RunnerTerminalPayload = Extract<RunnerFrame, { type: "terminal" }>["payload"]

const sessionFrameBase = {
  protocolVersion: z.literal(RUNNER_PROTOCOL_VERSION),
  sessionId: withoutNullBytes(z.string().min(1).max(128)),
  runnerSessionId: withoutNullBytes(z.string().min(1).max(128)),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  timestamp: z.string().datetime({ offset: true }),
}

export const sessionRunnerFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...sessionFrameBase,
      type: z.literal("session.ready"),
      payload: z
        .object({
          agentSessionId: z.string().min(1).max(512),
          capabilities: agentCapabilitySummarySchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...sessionFrameBase,
      type: z.literal("turn.started"),
      payload: z.object({ turnId: z.string().min(1).max(128) }).strict(),
    })
    .strict(),
  z
    .object({
      ...sessionFrameBase,
      type: z.literal("turn.update"),
      payload: z
        .object({
          turnId: z.string().min(1).max(128),
          update: z.record(z.string(), jsonValueSchema),
          truncated: z.boolean(),
          originalBytes: z.number().int().positive().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...sessionFrameBase,
      type: z.literal("turn.permission"),
      payload: z
        .object({
          turnId: z.string().min(1).max(128),
          toolCallId: z.string().min(1).max(512),
          toolKind: toolKindSchema.optional(),
          decision: z.enum(["allowed", "denied"]),
          selectedOptionKind: z.enum(["allow_once", "reject_once", "reject_always"]).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...sessionFrameBase,
      type: z.literal("agent.stderr"),
      payload: z
        .object({ chunk: z.string().max(MAX_STDERR_CHUNK_BYTES), truncated: z.boolean() })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...sessionFrameBase,
      type: z.literal("turn.terminal"),
      payload: z
        .object({ turnId: z.string().min(1).max(128), result: runnerTerminalPayloadSchema })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...sessionFrameBase,
      type: z.literal("session.closed"),
      payload: z
        .object({ reason: z.enum(["requested", "idle_timeout", "agent_exit", "failed"]) })
        .strict(),
    })
    .strict(),
])

export type SessionRunnerFrame = z.infer<typeof sessionRunnerFrameSchema>
export type SessionRunnerEvent = SessionRunnerFrame extends infer Frame
  ? Frame extends SessionRunnerFrame
    ? Omit<Frame, keyof typeof sessionFrameBase>
    : never
  : never

export const sessionRunnerCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      version: z.literal(1),
      sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      id: z.string().uuid(),
      type: z.literal("turn.start"),
      turnId: z.string().min(1).max(128),
      prompt: withoutNullBytes(z.string().min(1).max(MAX_PROMPT_LENGTH)),
      timeoutBudgetMs: z.number().int().positive().max(MAX_TIMEOUT_BUDGET_MS),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      id: z.string().uuid(),
      type: z.literal("turn.interrupt"),
      turnId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      id: z.string().uuid(),
      type: z.literal("session.close"),
    })
    .strict(),
])

export type SessionRunnerCommand = z.infer<typeof sessionRunnerCommandSchema>

const encoder = new TextEncoder()

export function parseRunnerSpec(input: unknown): RunnerSpec {
  return runnerSpecSchema.parse(input)
}

export function parseAnyRunnerSpec(input: unknown): AnyRunnerSpec {
  if (typeof input === "object" && input !== null && Reflect.get(input, "mode") === "session") {
    return sessionRunnerSpecSchema.parse(input)
  }
  return runnerSpecSchema.parse(input)
}

export function decodeRunnerSpec(text: string): RunnerSpec {
  if (encoder.encode(text).byteLength > MAX_RUNNER_SPEC_BYTES) {
    throw new Error("Runner specification exceeds the byte limit")
  }

  return parseRunnerSpec(JSON.parse(text))
}

export function decodeAnyRunnerSpec(text: string): AnyRunnerSpec {
  if (encoder.encode(text).byteLength > MAX_RUNNER_SPEC_BYTES) {
    throw new Error("Runner specification exceeds the byte limit")
  }
  return parseAnyRunnerSpec(JSON.parse(text))
}

export function encodeRunnerFrame(frame: RunnerFrame): string {
  const validFrame = runnerFrameSchema.parse(frame)
  const line = JSON.stringify(validFrame)
  if (encoder.encode(line).byteLength > MAX_RUNNER_FRAME_BYTES) {
    throw new Error("Runner frame exceeds the byte limit")
  }

  return line
}
