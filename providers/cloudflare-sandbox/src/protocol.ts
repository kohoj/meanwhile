import { z } from "zod"

export const BRIDGE_PROTOCOL_VERSION = 3 as const
export const CLOUDFLARE_SANDBOX_VERSION = "0.12.3" as const
export const INITIAL_EVENT_CURSOR = "v2.0.0.0" as const
export const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024

const MAX_ARGV_BYTES = 64 * 1024
const MAX_ENV_BYTES = 256 * 1024
const MAX_STDIN_BYTES = 2 * 1024 * 1024
const MAX_FILE_ENCODED_BYTES = 8 * 1024 * 1024
const MAX_WRITE_ENCODED_BYTES = 16 * 1024 * 1024
const MAX_LIST_ENTRIES = 100_000
const MAX_READ_BYTES = 64 * 1024 * 1024

export const operationIdSchema = z.string().uuid()
export const runtimeIdSchema = z
  .string()
  .regex(/^mw-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
export const processIdSchema = z
  .string()
  .regex(/^mp-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

const relativePath = z
  .string()
  .min(1)
  .max(1_024)
  .refine(isSafeRelativePath, "must be a normalized relative workspace path")

export const relativeFilePathSchema = relativePath.refine(
  (path) => path !== ".",
  "must identify a file",
)
export const relativeDirectoryPathSchema = relativePath.or(z.literal("."))

export const createRuntimeRequestSchema = z.strictObject({
  operationId: operationIdSchema,
})

export const processSignalSchema = z.enum(["SIGINT", "SIGTERM", "SIGKILL"])
export const providerProcessStatusSchema = z.enum([
  "starting",
  "running",
  "completed",
  "failed",
  "killed",
  "error",
])

const environmentSchema = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    z
      .string()
      .max(64 * 1024)
      .refine((value) => !value.includes("\0"), "environment values cannot contain NUL"),
  )
  .superRefine((environment, context) => {
    if (Object.keys(environment).length > 256) {
      context.addIssue({ code: "custom", message: "environment contains too many entries" })
    }

    const bytes = Object.entries(environment).reduce(
      (total, [name, value]) => total + encodedLength(name) + encodedLength(value),
      0,
    )
    if (bytes > MAX_ENV_BYTES) {
      context.addIssue({ code: "custom", message: "environment is too large" })
    }
  })

export const spawnProcessRequestSchema = z
  .strictObject({
    operationId: operationIdSchema,
    argv: z
      .array(
        z
          .string()
          .max(8_192)
          .refine((value) => !value.includes("\0"), "arguments cannot contain NUL"),
      )
      .min(1)
      .max(128),
    cwd: relativeDirectoryPathSchema.optional(),
    env: environmentSchema.optional(),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60 * 1_000)
      .optional(),
    terminationGraceMs: z.number().int().positive().max(60_000).optional(),
    stdin: z
      .string()
      .refine((value) => encodedLength(value) <= MAX_STDIN_BYTES, "stdin is too large")
      .optional(),
  })
  .superRefine((request, context) => {
    if ((request.timeoutMs === undefined) !== (request.terminationGraceMs === undefined)) {
      context.addIssue({
        code: "custom",
        path: request.timeoutMs === undefined ? ["timeoutMs"] : ["terminationGraceMs"],
        message: "timeoutMs and terminationGraceMs must be supplied together",
      })
    }
    if (request.argv[0]?.length === 0) {
      context.addIssue({ code: "custom", path: ["argv", 0], message: "executable cannot be empty" })
    }
    const bytes = request.argv.reduce((total, argument) => total + encodedLength(argument), 0)
    if (bytes > MAX_ARGV_BYTES) {
      context.addIssue({ code: "custom", path: ["argv"], message: "argv is too large" })
    }
  })

export const signalProcessRequestSchema = z.strictObject({
  signal: z.literal("SIGKILL"),
})

const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const workspaceFileModeSchema = z
  .number()
  .int()
  .min(0)
  .max(0o777)
  .refine((mode) => (mode & 0o600) === 0o600, "owner read and write bits are required")

export const writeFilesRequestSchema = z
  .strictObject({
    files: z
      .array(
        z.strictObject({
          path: relativeFilePathSchema,
          contentBase64: z.string().max(MAX_FILE_ENCODED_BYTES).regex(canonicalBase64),
          mode: workspaceFileModeSchema,
        }),
      )
      .min(1)
      .max(32),
  })
  .superRefine((request, context) => {
    const paths = new Set<string>()
    let encodedBytes = 0

    request.files.forEach((file, index) => {
      encodedBytes += file.contentBase64.length
      if (paths.has(file.path)) {
        context.addIssue({
          code: "custom",
          path: ["files", index, "path"],
          message: "duplicate path",
        })
      }
      paths.add(file.path)
    })

    if (encodedBytes > MAX_WRITE_ENCODED_BYTES) {
      context.addIssue({ code: "custom", path: ["files"], message: "file batch is too large" })
    }
  })

export const listFilesQuerySchema = z.strictObject({
  path: relativeDirectoryPathSchema.default("."),
  recursive: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  maxEntries: z.coerce.number().int().min(0).max(MAX_LIST_ENTRIES).default(10_000),
})

export const readFileQuerySchema = z.strictObject({
  path: relativeFilePathSchema,
  maxBytes: z.coerce.number().int().min(0).max(MAX_READ_BYTES).default(MAX_READ_BYTES),
})

export const processEventsQuerySchema = z.strictObject({
  cursor: z.string().default(INITIAL_EVENT_CURSOR),
  limitChars: z.coerce.number().int().min(1).max(262_144).default(65_536),
})

export const waitProcessQuerySchema = z.strictObject({
  timeoutMs: z.coerce.number().int().min(1).max(25_000).default(20_000),
})

export const exposePortParamsSchema = z.strictObject({
  runtimeId: runtimeIdSchema,
  port: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(65_535)
    .refine((port) => port !== 3_000, "port 3000 is reserved by Cloudflare Sandbox"),
})

export const runtimeHandleSchema = z.strictObject({
  version: z.literal(BRIDGE_PROTOCOL_VERSION),
  id: runtimeIdSchema,
})

export const processHandleSchema = z.strictObject({
  version: z.literal(BRIDGE_PROTOCOL_VERSION),
  runtimeId: runtimeIdSchema,
  id: processIdSchema,
})

export const runtimeStateSchema = z.enum([
  "created",
  "active",
  "idle",
  "stopped",
  "destroyed",
  "unknown",
])

export const processSnapshotSchema = z.strictObject({
  handle: processHandleSchema,
  status: providerProcessStatusSchema,
  pid: z.number().int().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  exitCode: z.number().int().nullable(),
})

export const runtimeSnapshotSchema = z.strictObject({
  handle: runtimeHandleSchema,
  state: runtimeStateSchema,
  processCount: z.number().int().nonnegative(),
  activeProcessCount: z.number().int().nonnegative(),
})

export const processOutputEventSchema = z.strictObject({
  type: z.literal("output"),
  cursor: z.string(),
  timestamp: z.iso.datetime(),
  stream: z.enum(["stdout", "stderr"]),
  data: z.string(),
})

export const processExitEventSchema = z.strictObject({
  type: z.literal("exit"),
  cursor: z.string(),
  timestamp: z.iso.datetime(),
  status: providerProcessStatusSchema,
  exitCode: z.number().int().nullable(),
})

export const processEventSchema = z.discriminatedUnion("type", [
  processOutputEventSchema,
  processExitEventSchema,
])

export const processEventsResponseSchema = z.strictObject({
  events: z.array(processEventSchema),
  nextCursor: z.string(),
})

export const runtimeFileInfoSchema = z.strictObject({
  path: relativeFilePathSchema,
  type: z.enum(["file", "directory", "symlink", "other"]),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string(),
})

export const exposedEndpointSchema = z.strictObject({
  port: z.number().int(),
  url: z.string().url(),
  expiresOnRuntimeStop: z.literal(true),
})

export const bridgeErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.record(z.string(), z.unknown()),
  }),
})

export type CreateRuntimeRequest = z.infer<typeof createRuntimeRequestSchema>
export type SpawnProcessRequest = z.infer<typeof spawnProcessRequestSchema>
export type SignalProcessRequest = z.infer<typeof signalProcessRequestSchema>
export type WriteFilesRequest = z.infer<typeof writeFilesRequestSchema>
export type ProviderProcessStatus = z.infer<typeof providerProcessStatusSchema>
export type ProcessSignal = z.infer<typeof processSignalSchema>
export type RuntimeHandle = z.infer<typeof runtimeHandleSchema>
export type ProcessHandle = z.infer<typeof processHandleSchema>
export type RuntimeSnapshot = z.infer<typeof runtimeSnapshotSchema>
export type ProcessSnapshot = z.infer<typeof processSnapshotSchema>
export type ProcessEvent = z.infer<typeof processEventSchema>
export type ProcessEventsResponse = z.infer<typeof processEventsResponseSchema>
export type RuntimeFileInfo = z.infer<typeof runtimeFileInfoSchema>
export type ExposedEndpoint = z.infer<typeof exposedEndpointSchema>

export interface EventCursor {
  readonly stdoutOffset: number
  readonly stderrOffset: number
  readonly terminalSeen: boolean
}

export class BridgeError extends Error {
  readonly code: string
  readonly status: number
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: string,
    message: string,
    status: number,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = "BridgeError"
    this.code = code
    this.status = status
    this.details = details
  }
}

export function runtimeIdFromOperation(operationId: string): string {
  return `mw-${operationId}`
}

export function processIdFromOperation(operationId: string): string {
  return `mp-${operationId}`
}

/**
 * Produces the durable idempotency identity for a process launch without
 * retaining environment values or initial input. The bridge stores only this
 * digest; the canonical preimage never crosses the request boundary.
 */
export async function processSpecFingerprint(request: SpawnProcessRequest): Promise<string> {
  const environment = await Promise.all(
    Object.entries(request.env ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([name, value]) => [name, await sha256(value)] as const),
  )
  const canonical = JSON.stringify({
    version: 1,
    argv: request.argv,
    cwd: request.cwd ?? ".",
    environment,
    initialStdin: request.stdin === undefined ? null : await sha256(request.stdin),
    timeoutMs: request.timeoutMs ?? null,
    terminationGraceMs: request.terminationGraceMs ?? null,
  })
  return `sha256:${await sha256(canonical)}`
}

export function encodeEventCursor(cursor: EventCursor): string {
  return `v2.${cursor.stdoutOffset}.${cursor.stderrOffset}.${cursor.terminalSeen ? 1 : 0}`
}

export function decodeEventCursor(value: string): EventCursor {
  const match = /^v2\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.([01])$/.exec(value)
  if (!match) {
    throw new BridgeError("EVENT_CURSOR_INVALID", "The event cursor is invalid.", 400)
  }

  const stdoutOffset = Number(match[1])
  const stderrOffset = Number(match[2])
  if (!Number.isSafeInteger(stdoutOffset) || !Number.isSafeInteger(stderrOffset)) {
    throw new BridgeError("EVENT_CURSOR_INVALID", "The event cursor is invalid.", 400)
  }

  return { stdoutOffset, stderrOffset, terminalSeen: match[3] === "1" }
}

export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return false
  }

  const segments = path.split("/")
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
}

function encodedLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  )
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
