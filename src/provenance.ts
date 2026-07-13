import { z } from "zod"
import {
  type AgentLaunchSnapshot,
  EXECUTION_PROVENANCE_VERSION,
  type ExecutionProvenance,
} from "./domain"
import { AppError } from "./errors"
import type { RuntimeProviderRegistry } from "./providers/registry"
import type { RuntimeProvider } from "./providers/runtime-provider"

export interface ExecutionProvenanceInput {
  readonly provider: string
  readonly agentSpec: AgentLaunchSnapshot
  readonly agentCatalogDigest: string
}

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const executionProvenanceSchema = z
  .object({
    version: z.literal(EXECUTION_PROVENANCE_VERSION),
    agentDefinitionDigest: digestSchema,
    agentCatalogDigest: digestSchema,
    runnerDigest: digestSchema.nullable(),
    provider: z
      .object({
        name: z.string().min(1),
        adapterVersion: z.string().min(1),
        capabilitiesDigest: digestSchema,
        runtimeImageReference: z.string().min(1).nullable(),
        runtimeImageDigest: z
          .string()
          .regex(/^sha256:[a-f0-9]{64}$/)
          .nullable(),
        bridgeProtocolVersion: z.number().int().positive().nullable(),
      })
      .strict(),
    digest: digestSchema,
  })
  .strict()

/** Captures every executable input whose later mutation must not rewrite run history. */
export class ExecutionProvenanceCatalog {
  constructor(private readonly providers: Pick<RuntimeProviderRegistry, "get">) {}

  capture(input: ExecutionProvenanceInput): ExecutionProvenance {
    const provider = this.providers.get(input.provider)
    const snapshot = {
      version: EXECUTION_PROVENANCE_VERSION,
      agentDefinitionDigest: input.agentSpec.definitionDigest,
      agentCatalogDigest: input.agentCatalogDigest,
      runnerDigest: provider.provenance.runnerDigest,
      provider: {
        name: provider.name,
        adapterVersion: provider.provenance.adapterVersion,
        capabilitiesDigest: digestRuntimeCapabilities(provider.capabilities),
        runtimeImageReference: provider.provenance.runtimeImageReference,
        runtimeImageDigest: provider.provenance.runtimeImageDigest,
        bridgeProtocolVersion: provider.provenance.bridgeProtocolVersion,
      },
    } as const
    return { ...snapshot, digest: digestExecutionProvenance(snapshot) }
  }
}

export async function sha256File(path: string): Promise<string> {
  try {
    return new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex")
  } catch (cause) {
    throw new Error("Executable could not be read for provenance", { cause })
  }
}

export function assertProviderProvenance(
  snapshot: ExecutionProvenance | null,
  provider: RuntimeProvider,
): void {
  if (snapshot === null) {
    throw new AppError({
      code: "EXECUTION_PROVENANCE_UNAVAILABLE",
      message: "Run execution provenance is unavailable",
    })
  }
  const current = {
    name: provider.name,
    adapterVersion: provider.provenance.adapterVersion,
    capabilitiesDigest: digestRuntimeCapabilities(provider.capabilities),
    runtimeImageReference: provider.provenance.runtimeImageReference,
    runtimeImageDigest: provider.provenance.runtimeImageDigest,
    bridgeProtocolVersion: provider.provenance.bridgeProtocolVersion,
  }
  if (
    snapshot.runnerDigest !== provider.provenance.runnerDigest ||
    canonicalJson(snapshot.provider) !== canonicalJson(current)
  ) {
    throw new AppError({
      code: "EXECUTION_PROVENANCE_MISMATCH",
      message: "The configured runtime no longer matches the accepted run provenance",
      details: { provider: provider.name },
    })
  }
}

export function parseExecutionProvenance(value: unknown): ExecutionProvenance {
  const parsed = executionProvenanceSchema.safeParse(value)
  if (!parsed.success) throw invalidProvenance()
  const { digest, ...snapshot } = parsed.data
  if (digest !== digestExecutionProvenance(snapshot)) throw invalidProvenance()
  return parsed.data
}

export const digestExecutionProvenance = (snapshot: Omit<ExecutionProvenance, "digest">): string =>
  sha256Canonical(snapshot)

export const digestRuntimeCapabilities = (capabilities: RuntimeProvider["capabilities"]): string =>
  sha256Canonical(capabilities)

const sha256Canonical = (value: unknown): string =>
  new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex")

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new TypeError("Execution provenance must be JSON")
    return serialized
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`
}

const invalidProvenance = (): AppError =>
  new AppError({
    code: "EXECUTION_PROVENANCE_INVALID",
    message: "Persisted execution provenance is invalid",
  })
