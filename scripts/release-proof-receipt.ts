import { mkdir, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"

export const RELEASE_PROOF_RECEIPT_VERSION = 2 as const

export const releaseProofClassSchema = z.enum([
  "local-control-plane",
  "remote-provider-compatibility",
  "remote-live-agent",
])

const proofProviderSchema = z.enum(["local", "cloudflare"])
const proofAgentSchema = z.enum(["demo", "codex", "claude-code", "pi"])
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const taggedSha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const timestampSchema = z.string().datetime({ offset: true })
const nonEmptyStringSchema = z.string().min(1)

const telemetryCaptureSchema = z
  .object({
    requests: z.number().int().positive(),
    bytes: z.number().int().positive(),
  })
  .strict()

const releaseProofPayloadSchema = z
  .object({
    schemaVersion: z.literal(RELEASE_PROOF_RECEIPT_VERSION),
    proof: z.literal("meanwhile-release"),
    proofClass: releaseProofClassSchema,
    status: z.literal("succeeded"),
    startedAt: timestampSchema,
    finishedAt: timestampSchema,
    provider: proofProviderSchema,
    agent: z
      .object({
        type: proofAgentSchema,
        adapter: nonEmptyStringSchema,
        runtime: nonEmptyStringSchema,
        authenticationEvidence: nonEmptyStringSchema,
        executionEvidence: z.enum(["deterministic-fixture", "credentialed-live-agent"]),
        modelIdentityEvidence: z.enum(["not-applicable", "not-attested"]),
      })
      .strict(),
    revision: z
      .object({
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        dirty: z.boolean(),
      })
      .strict(),
    provenance: z
      .object({
        digest: sha256Schema,
        runnerDigest: sha256Schema.nullable(),
        runtimeImageReference: nonEmptyStringSchema.nullable(),
        runtimeImageDigest: taggedSha256Schema.nullable(),
        bridgeProtocolVersion: z.number().int().positive().nullable(),
        configuredIdentityComplete: z.boolean(),
        runnerDigestAuthority: z.enum(["measured-local-file", "operator-asserted"]),
        runtimeImageDigestAuthority: z.enum(["unavailable", "operator-asserted-platform-evidence"]),
      })
      .strict(),
    credentialBoundary: z.discriminatedUnion("mode", [
      z
        .object({
          mode: z.literal("not-required"),
          runLeaseId: z.null(),
          sessionLeaseId: z.null(),
          runLeaseRevoked: z.null(),
          sessionLeaseRevoked: z.null(),
          sourceValuesAbsent: z.literal(true),
        })
        .strict(),
      z
        .object({
          mode: z.literal("brokered"),
          runLeaseId: nonEmptyStringSchema,
          sessionLeaseId: nonEmptyStringSchema,
          runLeaseRevoked: z.literal(true),
          sessionLeaseRevoked: z.literal(true),
          sourceValuesAbsent: z.literal(true),
        })
        .strict(),
    ]),
    roundTrip: z
      .object({
        promptDigest: sha256Schema,
        responseDigest: sha256Schema,
        durableResponse: z.literal(true),
        agentProducedArtifact: z.literal(true),
        sdkArtifactDownloadVerified: z.literal(true),
        sdkDeploymentVerified: z.literal(true),
      })
      .strict(),
    sharedExecution: z
      .object({
        briefId: sha256Schema,
        sourceRunId: nonEmptyStringSchema,
        sourceArtifactId: sha256Schema,
        sourcePath: nonEmptyStringSchema,
        sourceDigest: sha256Schema,
        followUpRunId: nonEmptyStringSchema,
        followUpArtifactId: sha256Schema,
        cleanupAuditId: nonEmptyStringSchema,
        credentialLeaseId: nonEmptyStringSchema.nullable(),
        credentialLeaseRevoked: z.literal(true).nullable(),
        contextSnapshotVerified: z.literal(true),
        runnerRevalidationVerified: z.literal(true),
        semanticReuseVerified: z.literal(true),
        persistedAfterRestart: z.literal(true),
        restoredAfterBackup: z.literal(true),
      })
      .strict(),
    session: z
      .object({
        id: nonEmptyStringSchema,
        turns: z.literal(2),
        events: z.number().int().positive(),
        agentSessionIdentityPreserved: z.literal(true),
        controlPlaneRestartBetweenTurns: z.literal(true),
        continuityTokenVerified: z.literal(true),
        cleanupAuditId: nonEmptyStringSchema,
      })
      .strict(),
    telemetry: z
      .object({
        health: z.literal("healthy"),
        traces: telemetryCaptureSchema,
        metrics: telemetryCaptureSchema,
        structuredLogs: z.number().int().positive(),
      })
      .strict(),
    run: z
      .object({
        id: nonEmptyStringSchema,
        statusHistory: z.tuple([
          z.literal("queued"),
          z.literal("provisioning"),
          z.literal("running"),
          z.literal("succeeded"),
        ]),
        runnerSequence: z.number().int().positive(),
        logs: z.number().int().positive(),
        cleanupAuditId: nonEmptyStringSchema,
      })
      .strict(),
    artifact: z
      .object({
        id: nonEmptyStringSchema,
        digest: sha256Schema,
        files: z.number().int().positive(),
      })
      .strict(),
    deployment: z
      .object({
        id: nonEmptyStringSchema,
        target: z.literal("local-static"),
        previewBoundary: z.literal("control-plane-local-static"),
        url: z.string().url(),
        previewVerifiedAfterRestart: z.literal(true),
      })
      .strict(),
    persistence: z
      .object({
        restartVerified: z.literal(true),
        restoreVerified: z.literal(true),
        privateValuesAbsent: z.literal(true),
        deploymentLogs: z.number().int().positive(),
        auditRecords: z.number().int().positive(),
      })
      .strict(),
    backup: z
      .object({
        digest: sha256Schema,
        artifacts: z.number().int().nonnegative(),
        deployments: z.number().int().nonnegative(),
        verified: z.literal(true),
      })
      .strict(),
  })
  .strict()

const releaseProofPayloadV1Schema = releaseProofPayloadSchema
  .omit({ sharedExecution: true })
  .extend({ schemaVersion: z.literal(1) })

const releaseProofReceiptV2Schema = releaseProofPayloadSchema
  .extend({ receiptDigest: taggedSha256Schema })
  .superRefine(refineReceipt)

const releaseProofReceiptV1Schema = releaseProofPayloadV1Schema
  .extend({ receiptDigest: taggedSha256Schema })
  .superRefine(refineReceipt)

export const releaseProofReceiptSchema = z.union([
  releaseProofReceiptV2Schema,
  releaseProofReceiptV1Schema,
])

type RefinableReceipt =
  | z.infer<typeof releaseProofPayloadSchema>
  | z.infer<typeof releaseProofPayloadV1Schema>

function refineReceipt(receipt: RefinableReceipt, context: z.RefinementCtx): void {
  const expectedClass = releaseProofClass(receipt.provider, receipt.agent.type)
  if (receipt.proofClass !== expectedClass) {
    context.addIssue({
      code: "custom",
      path: ["proofClass"],
      message: `Proof class must be ${expectedClass}`,
    })
  }

  const fixture = receipt.agent.type === "demo"
  if (
    receipt.agent.executionEvidence !==
    (fixture ? "deterministic-fixture" : "credentialed-live-agent")
  ) {
    context.addIssue({
      code: "custom",
      path: ["agent", "executionEvidence"],
      message: "Agent execution evidence does not match the selected agent",
    })
  }
  if (receipt.agent.modelIdentityEvidence !== (fixture ? "not-applicable" : "not-attested")) {
    context.addIssue({
      code: "custom",
      path: ["agent", "modelIdentityEvidence"],
      message: "Model identity evidence does not match the selected agent",
    })
  }
  if (receipt.credentialBoundary.mode !== (fixture ? "not-required" : "brokered")) {
    context.addIssue({
      code: "custom",
      path: ["credentialBoundary", "mode"],
      message: "Credential evidence does not match the selected agent",
    })
  }
  if ("sharedExecution" in receipt) {
    const expectedLease = fixture ? null : "revoked"
    const observedLease =
      receipt.sharedExecution.credentialLeaseId === null &&
      receipt.sharedExecution.credentialLeaseRevoked === null
        ? null
        : receipt.sharedExecution.credentialLeaseId !== null &&
            receipt.sharedExecution.credentialLeaseRevoked === true
          ? "revoked"
          : "invalid"
    if (observedLease !== expectedLease) {
      context.addIssue({
        code: "custom",
        path: ["sharedExecution", "credentialLeaseId"],
        message: "Shared-execution credential evidence does not match the selected agent",
      })
    }
  }

  if (Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)) {
    context.addIssue({
      code: "custom",
      path: ["finishedAt"],
      message: "Proof completion cannot precede proof start",
    })
  }

  if (receipt.provider === "local") {
    if (
      receipt.agent.type !== "demo" ||
      receipt.provenance.runtimeImageReference !== null ||
      receipt.provenance.runtimeImageDigest !== null ||
      receipt.provenance.bridgeProtocolVersion !== null ||
      receipt.provenance.runnerDigestAuthority !== "measured-local-file" ||
      receipt.provenance.runtimeImageDigestAuthority !== "unavailable"
    ) {
      context.addIssue({
        code: "custom",
        path: ["provider"],
        message: "Local proof evidence must describe the deterministic local boundary",
      })
    }
  } else if (
    receipt.provenance.runtimeImageReference === null ||
    receipt.provenance.runtimeImageDigest === null ||
    receipt.provenance.bridgeProtocolVersion === null ||
    receipt.provenance.runnerDigestAuthority !== "operator-asserted" ||
    receipt.provenance.runtimeImageDigestAuthority !== "operator-asserted-platform-evidence" ||
    !receipt.provenance.configuredIdentityComplete
  ) {
    context.addIssue({
      code: "custom",
      path: ["provenance"],
      message: "Remote release evidence requires complete operator-asserted provenance",
    })
  }
}

export type ReleaseProofReceipt = z.infer<typeof releaseProofReceiptSchema>
export type ReleaseProofPayload = z.infer<typeof releaseProofPayloadSchema>
export type ReleaseProofClass = z.infer<typeof releaseProofClassSchema>

export function releaseProofClass(
  provider: z.infer<typeof proofProviderSchema>,
  agent: z.infer<typeof proofAgentSchema>,
): ReleaseProofClass {
  if (provider === "local") {
    if (agent !== "demo") throw new TypeError("Local release proof supports only the demo agent")
    return "local-control-plane"
  }
  return agent === "demo" ? "remote-provider-compatibility" : "remote-live-agent"
}

export function createReleaseProofReceipt(
  input: Omit<ReleaseProofPayload, "schemaVersion" | "proof" | "status">,
): ReleaseProofReceipt {
  const payload = releaseProofPayloadSchema.parse({
    schemaVersion: RELEASE_PROOF_RECEIPT_VERSION,
    proof: "meanwhile-release",
    status: "succeeded",
    ...input,
  })
  return releaseProofReceiptSchema.parse({
    ...payload,
    receiptDigest: digestPayload(payload),
  })
}

export function verifyReleaseProofReceipt(value: unknown): ReleaseProofReceipt {
  const receipt = releaseProofReceiptSchema.parse(value)
  const { receiptDigest, ...payload } = receipt
  if (digestPayload(payload) !== receiptDigest) {
    throw new TypeError("Release proof receipt digest does not match its evidence")
  }
  return receipt
}

export async function writeReleaseProofReceipt(
  path: string,
  receipt: ReleaseProofReceipt,
): Promise<void> {
  const verified = verifyReleaseProofReceipt(receipt)
  const directory = dirname(path)
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`
  await mkdir(directory, { recursive: true })
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(verified, null, 2)}\n`)
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

function digestPayload(payload: unknown): string {
  const digest = new Bun.CryptoHasher("sha256").update(canonicalJson(payload)).digest("hex")
  return `sha256:${digest}`
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value)
  }
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value !== "object") throw new TypeError("Proof receipt is not JSON serializable")

  const record = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`
}
