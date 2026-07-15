import { isAbsolute, resolve } from "node:path"
import { z } from "zod"
import type {
  AgentCredentialHttpMethod,
  AgentLaunchSnapshot,
  AgentPermissionPolicy,
  AgentToolKind,
} from "../domain"
import { AGENT_LAUNCH_SNAPSHOT_VERSION } from "../domain"
import { AppError } from "../errors"

const environmentNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/)
const exactHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    "Host must be an exact lowercase DNS name",
  )
const credentialMethodSchema = z.enum(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"])
const credentialPolicySchema = z
  .object({
    environmentVariable: environmentNameSchema,
    host: exactHostSchema,
    methods: z.array(credentialMethodSchema).min(1).max(7),
  })
  .strict()
const portableExecutableSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/, "Executable must be a bare, portable PATH name")

const agentCapabilitiesSchema = z
  .object({
    filesystem: z.boolean(),
    terminal: z.boolean(),
  })
  .strict()

const agentDefinitionSchema = z
  .object({
    transport: z.literal("stdio"),
    executable: portableExecutableSchema,
    args: z
      .array(
        z
          .string()
          .min(1)
          .max(32_768)
          .refine((value) => !value.includes("\0"), "Argument contains NUL"),
      )
      .max(128),
    workingDirectory: z.literal("workspace"),
    capabilities: agentCapabilitiesSchema,
    envNames: z.array(environmentNameSchema).max(64),
    networkPolicy: z.object({ allowedHosts: z.array(exactHostSchema).max(64) }).strict(),
    credentials: z.array(credentialPolicySchema).max(64),
  })
  .strict()
  .superRefine((definition, context) => {
    for (const [field, names] of [
      ["envNames", definition.envNames],
      ["networkPolicy.allowedHosts", definition.networkPolicy.allowedHosts],
    ] as const) {
      if (new Set(names).size !== names.length) {
        context.addIssue({
          code: "custom",
          path: field.split("."),
          message: `${field} must not contain duplicates`,
        })
      }
    }

    const credentialNames = definition.credentials.map(
      ({ environmentVariable }) => environmentVariable,
    )
    const persistedNames = new Set(definition.envNames)
    const overlap = credentialNames.filter((name) => persistedNames.has(name))
    if (overlap.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["credentials"],
        message: "Persisted and credential environment names must not overlap",
      })
    }
    const bindings = new Set<string>()
    definition.credentials.forEach((credential, index) => {
      const key = `${credential.environmentVariable}\0${credential.host}`
      if (bindings.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["credentials", index],
          message: "Credential environment and host bindings must be unique",
        })
      }
      bindings.add(key)
      if (new Set(credential.methods).size !== credential.methods.length) {
        context.addIssue({
          code: "custom",
          path: ["credentials", index, "methods"],
          message: "Credential methods must not contain duplicates",
        })
      }
    })
  })

const catalogSchema = z
  .object({
    version: z.literal(1),
    agents: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), agentDefinitionSchema),
  })
  .strict()

type ParsedAgentDefinition = z.infer<typeof agentDefinitionSchema>

export type AgentDefinition = Readonly<
  Omit<
    ParsedAgentDefinition,
    "args" | "capabilities" | "envNames" | "networkPolicy" | "credentials"
  > & {
    readonly args: readonly string[]
    readonly capabilities: Readonly<ParsedAgentDefinition["capabilities"]>
    readonly envNames: readonly string[]
    readonly networkPolicy: { readonly allowedHosts: readonly string[] }
    readonly credentials: readonly {
      readonly environmentVariable: string
      readonly host: string
      readonly methods: readonly AgentCredentialHttpMethod[]
    }[]
  }
>

export interface ResolvedAgentIntent {
  readonly agentSpec: AgentLaunchSnapshot
  readonly agentCatalogDigest: string
}

/** Validated, immutable launch definitions. No host-path resolution occurs here. */
export class AgentCatalog {
  readonly version: 1
  readonly sourcePath: string
  readonly digest: string
  private readonly agents: Readonly<Record<string, AgentDefinition>>
  private readonly definitionDigests: Readonly<Record<string, string>>

  private constructor(
    sourcePath: string,
    agents: Readonly<Record<string, ParsedAgentDefinition>>,
    digest: string,
  ) {
    this.version = 1
    this.sourcePath = sourcePath
    this.digest = digest
    this.agents = Object.freeze(
      Object.fromEntries(
        Object.entries(agents).map(([name, definition]) => [name, freezeDefinition(definition)]),
      ),
    )
    this.definitionDigests = Object.freeze(
      Object.fromEntries(
        Object.entries(agents).map(([name, definition]) => [name, digestJson(definition)]),
      ),
    )
  }

  static async load(path: string): Promise<AgentCatalog> {
    const absolutePath = isAbsolute(path) ? path : resolve(path)
    let source: unknown
    try {
      source = await Bun.file(absolutePath).json()
    } catch (error) {
      throw new AppError({
        code: "INVALID_REQUEST",
        message: "Agent catalog could not be read",
        details: { path: absolutePath },
        cause: error,
      })
    }
    const result = catalogSchema.safeParse(source)
    if (!result.success) {
      throw new AppError({
        code: "INVALID_REQUEST",
        message: "Agent catalog is invalid",
        details: { issues: result.error.issues.map((issue) => issue.message).join("; ") },
      })
    }
    if (Object.keys(result.data.agents).length === 0) {
      throw new AppError({ code: "INVALID_REQUEST", message: "Agent catalog must not be empty" })
    }
    return new AgentCatalog(absolutePath, result.data.agents, digestJson(result.data))
  }

  resolve(agentType: string): AgentDefinition {
    const definition = this.agents[agentType]
    if (definition === undefined) {
      throw new AppError({
        code: "INVALID_REQUEST",
        message: `Unknown agent type: ${agentType}`,
        details: { agentType },
      })
    }
    return definition
  }

  list(): readonly string[] {
    return Object.keys(this.agents).sort()
  }

  resolveIntent(
    agentType: string,
    environment: Readonly<Record<string, string>>,
    secretReferences: Readonly<Record<string, string>>,
  ): ResolvedAgentIntent {
    const definition = this.resolve(agentType)
    const definitionDigest = this.definitionDigests[agentType]
    if (definitionDigest === undefined) {
      throw new AppError({ code: "INTERNAL", message: "Agent definition digest is unavailable" })
    }
    assertAllowedNames(Object.keys(environment), definition.envNames, "non-secret environment")
    assertAllowedNames(
      Object.keys(secretReferences),
      [...new Set(definition.credentials.map(({ environmentVariable }) => environmentVariable))],
      "credential environment",
    )

    const permissionPolicy = permissionPolicyFor(definition.capabilities)
    return {
      agentCatalogDigest: this.digest,
      agentSpec: {
        version: AGENT_LAUNCH_SNAPSHOT_VERSION,
        catalogVersion: this.version,
        definitionDigest,
        executable: definition.executable,
        args: [...definition.args],
        workingDirectory: definition.workingDirectory,
        capabilities: { ...definition.capabilities },
        permissionPolicy,
        envNames: [...definition.envNames],
        networkPolicy: { allowedHosts: [...definition.networkPolicy.allowedHosts] },
        credentials: definition.credentials.map((credential) => ({
          environmentVariable: credential.environmentVariable,
          host: credential.host,
          methods: [...credential.methods],
        })),
      },
    }
  }
}

const freezeDefinition = (definition: ParsedAgentDefinition): AgentDefinition =>
  Object.freeze({
    ...definition,
    args: Object.freeze([...definition.args]),
    capabilities: Object.freeze({ ...definition.capabilities }),
    envNames: Object.freeze([...definition.envNames]),
    networkPolicy: Object.freeze({
      allowedHosts: Object.freeze([...definition.networkPolicy.allowedHosts]),
    }),
    credentials: Object.freeze(
      definition.credentials.map((credential) =>
        Object.freeze({ ...credential, methods: Object.freeze([...credential.methods]) }),
      ),
    ),
  })

const permissionPolicyFor = (
  capabilities: AgentDefinition["capabilities"],
): AgentPermissionPolicy => {
  const toolKinds: AgentToolKind[] = []
  if (capabilities.filesystem) {
    toolKinds.push("read", "edit", "delete", "move", "search")
  }
  if (capabilities.terminal) toolKinds.push("execute")
  return toolKinds.length === 0 ? { mode: "deny-all" } : { mode: "allow-once", toolKinds }
}

const assertAllowedNames = (
  actual: readonly string[],
  allowed: readonly string[],
  label: string,
) => {
  const allowlist = new Set(allowed)
  const rejected = actual.filter((name) => !allowlist.has(name)).sort()
  if (rejected.length > 0) {
    throw new AppError({
      code: "INVALID_REQUEST",
      message: `Agent does not allow the requested ${label}`,
      details: { names: rejected.join(",") },
    })
  }
}

const digestJson = (value: unknown): string =>
  new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex")

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new TypeError("Agent definition must be JSON")
    return serialized
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`
}
