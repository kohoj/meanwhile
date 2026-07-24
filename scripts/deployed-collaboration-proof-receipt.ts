import { z } from "zod"
import { digestProofPayload, writeProofReceipt } from "./proof-receipt"

export const DEPLOYED_COLLABORATION_PROOF_RECEIPT_VERSION = 5 as const

const timestampSchema = z.string().datetime({ offset: true })
const identifierSchema = z.string().uuid()
const taggedSha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

export function normalizeDeployedOrigin(value: string, label: string): string {
  const url = new URL(value)
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError(`${label} must be an origin without credentials, path, query, or fragment`)
  }
  return url.origin
}

const deployedCollaborationProofPayloadSchema = z
  .object({
    schemaVersion: z.literal(DEPLOYED_COLLABORATION_PROOF_RECEIPT_VERSION),
    proof: z.literal("meanwhile-deployed-project-collaboration"),
    proofClass: z.literal("deployed-two-principal-system"),
    status: z.literal("succeeded"),
    startedAt: timestampSchema,
    finishedAt: timestampSchema,
    revision: z
      .object({
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        dirty: z.boolean(),
      })
      .strict(),
    topology: z
      .object({
        controlPlaneOrigin: z.string().url(),
        boardOrigin: z.string().url(),
        controlPlaneTransport: z.literal("https"),
        boardTransport: z.literal("https"),
        runtimeProvider: z.literal("local"),
        agentType: z.literal("demo"),
        boardBoundary: z.literal("project-watch-bff"),
      })
      .strict(),
    identities: z
      .object({
        firstPrincipalId: identifierSchema,
        secondPrincipalId: identifierSchema,
        distinctPrincipals: z.literal(true),
      })
      .strict(),
    project: z
      .object({
        id: identifierSchema,
        bothMembersActive: z.literal(true),
      })
      .strict(),
    onboarding: z
      .object({
        bothAgentsConnected: z.literal(true),
        bothProjectsSelected: z.literal(true),
      })
      .strict(),
    presence: z
      .object({
        independentClientLeases: z.literal(true),
        bothPrincipalsVisible: z.literal(true),
      })
      .strict(),
    work: z
      .object({
        firstRunId: identifierSchema,
        secondRunId: identifierSchema,
        firstRunAttributed: z.literal(true),
        secondRunAttributed: z.literal(true),
        firstSeesSecondRun: z.literal(true),
        secondSeesFirstRun: z.literal(true),
        firstOpenedSecondConversation: z.literal(true),
        secondOpenedFirstConversation: z.literal(true),
      })
      .strict(),
    relay: z
      .object({
        id: identifierSchema,
        workId: identifierSchema,
        anchorSequence: z.number().int().positive(),
        firstCreatedForSecond: z.literal(true),
        secondSawPendingAttention: z.literal(true),
        secondOpenedSourceAnchor: z.literal(true),
        secondAcknowledged: z.literal(true),
      })
      .strict(),
    annotation: z
      .object({
        id: identifierSchema,
        workId: identifierSchema,
        anchorSequence: z.number().int().nonnegative(),
        sourceDigest: sha256Schema,
        firstCreatedOnSecondWork: z.literal(true),
        secondSawSameAnchor: z.literal(true),
      })
      .strict(),
    authorization: z
      .object({
        firstCannotCancelSecondRun: z.literal("not_found"),
        secondCannotCancelFirstRun: z.literal("not_found"),
        boardMutation: z.literal("method_not_allowed"),
        browserSessionForeignRunControl: z.literal("not_found"),
      })
      .strict(),
    browser: z
      .object({
        independentSessions: z.literal(true),
        httpOnlyCookies: z.literal(true),
        sameSiteLaxCookies: z.literal(true),
        secureCookies: z.literal(true),
        bothBoardsSeeBothRuns: z.literal(true),
      })
      .strict(),
    security: z
      .object({
        plaintextCredentialsAbsent: z.literal(true),
      })
      .strict(),
    claimBoundary: z
      .object({
        externalHumanAcceptance: z.literal("not_claimed"),
      })
      .strict(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)) {
      context.addIssue({
        code: "custom",
        path: ["finishedAt"],
        message: "Proof completion cannot precede proof start",
      })
    }
    if (receipt.identities.firstPrincipalId === receipt.identities.secondPrincipalId) {
      context.addIssue({
        code: "custom",
        path: ["identities"],
        message: "Deployed collaboration proof requires two distinct Principals",
      })
    }
    if (new URL(receipt.topology.controlPlaneOrigin).protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: ["topology", "controlPlaneOrigin"],
        message: "Deployed control-plane ingress must use HTTPS",
      })
    }
    if (new URL(receipt.topology.boardOrigin).protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: ["topology", "boardOrigin"],
        message: "Deployed Project Watch ingress must use HTTPS",
      })
    }
    for (const [name, value] of [
      ["controlPlaneOrigin", receipt.topology.controlPlaneOrigin],
      ["boardOrigin", receipt.topology.boardOrigin],
    ] as const) {
      try {
        normalizeDeployedOrigin(value, name)
      } catch (error) {
        context.addIssue({
          code: "custom",
          path: ["topology", name],
          message: error instanceof Error ? error.message : "Deployed endpoint is not an origin",
        })
      }
    }
  })

const deployedCollaborationProofReceiptSchema = deployedCollaborationProofPayloadSchema.extend({
  receiptDigest: taggedSha256Schema,
})

export type DeployedCollaborationProofPayload = z.infer<
  typeof deployedCollaborationProofPayloadSchema
>
export type DeployedCollaborationProofReceipt = z.infer<
  typeof deployedCollaborationProofReceiptSchema
>

export function createDeployedCollaborationProofReceipt(
  input: Omit<
    DeployedCollaborationProofPayload,
    "schemaVersion" | "proof" | "proofClass" | "status"
  >,
): DeployedCollaborationProofReceipt {
  const payload = deployedCollaborationProofPayloadSchema.parse({
    schemaVersion: DEPLOYED_COLLABORATION_PROOF_RECEIPT_VERSION,
    proof: "meanwhile-deployed-project-collaboration",
    proofClass: "deployed-two-principal-system",
    status: "succeeded",
    ...input,
  })
  return deployedCollaborationProofReceiptSchema.parse({
    ...payload,
    receiptDigest: digestProofPayload(payload),
  })
}

export function verifyDeployedCollaborationProofReceipt(
  value: unknown,
): DeployedCollaborationProofReceipt {
  const receipt = deployedCollaborationProofReceiptSchema.parse(value)
  const { receiptDigest, ...payload } = receipt
  if (digestProofPayload(payload) !== receiptDigest) {
    throw new TypeError("Deployed collaboration proof receipt digest does not match its evidence")
  }
  return receipt
}

export async function writeDeployedCollaborationProofReceipt(
  path: string,
  receipt: DeployedCollaborationProofReceipt,
): Promise<void> {
  await writeProofReceipt(path, receipt, verifyDeployedCollaborationProofReceipt)
}
