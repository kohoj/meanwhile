import { z } from "zod"
import { digestProofPayload, writeProofReceipt } from "./proof-receipt"

export const PROJECT_COLLABORATION_PROOF_RECEIPT_VERSION = 1 as const

const timestampSchema = z.string().datetime({ offset: true })
const identifierSchema = z.string().uuid()
const taggedSha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const urlSchema = z.string().url()

const deniedSchema = z.literal("not_found")

const projectCollaborationProofPayloadSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_COLLABORATION_PROOF_RECEIPT_VERSION),
    proof: z.literal("meanwhile-project-collaboration"),
    proofClass: z.literal("local-deployed-collaboration"),
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
        controlPlaneOrigin: urlSchema,
        boardOrigin: urlSchema,
        runtimeProvider: z.literal("local-deterministic"),
        boardBoundary: z.literal("project-watch-bff"),
      })
      .strict(),
    identities: z
      .object({
        alicePrincipalId: identifierSchema,
        bobPrincipalId: identifierSchema,
        carolPrincipalId: identifierSchema,
        distinctPrincipals: z.literal(true),
      })
      .strict(),
    project: z
      .object({
        id: identifierSchema,
        aliceAndBobInitiallyActive: z.literal(true),
        carolNeverMember: z.literal(true),
      })
      .strict(),
    work: z
      .object({
        runId: identifierSchema,
        sessionId: identifierSchema,
        delegatedByAlice: z.literal(true),
        visibleToAlice: z.literal(true),
        visibleToBob: z.literal(true),
        conversationVisibleToBob: z.literal(true),
        artifactVisibleToBob: z.literal(true),
      })
      .strict(),
    authorization: z
      .object({
        bobCancelAliceRun: deniedSchema,
        bobDeployAliceRun: deniedSchema,
        bobSendAliceSession: deniedSchema,
        bobInterruptAliceSession: deniedSchema,
        bobCloseAliceSession: deniedSchema,
        carolProjectList: z.literal("empty"),
        carolProjectRead: deniedSchema,
        carolRunRead: deniedSchema,
        carolRunEvents: deniedSchema,
        carolArtifactRead: deniedSchema,
        carolSessionRead: deniedSchema,
        boardMutation: z.literal("method_not_allowed"),
        browserSessionMutation: z.literal("forbidden"),
      })
      .strict(),
    browser: z
      .object({
        independentAliceAndBobSessions: z.literal(true),
        httpOnlyCookies: z.literal(true),
        sameSiteStrictCookies: z.literal(true),
        bothSeeAliceRun: z.literal(true),
        bobOpenedTaskConversation: z.literal(true),
      })
      .strict(),
    credentialRotation: z
      .object({
        oldAliceKeyRejected: z.literal(true),
        replacementKeyAccepted: z.literal(true),
        principalIdentityPreserved: z.literal(true),
        historicalAttributionPreserved: z.literal(true),
      })
      .strict(),
    membershipRevocation: z
      .object({
        bobRemoved: z.literal(true),
        bobSdkReadDenied: z.literal(true),
        bobBoardReadDenied: z.literal(true),
        aliceUnaffected: z.literal(true),
      })
      .strict(),
    persistence: z
      .object({
        restartVerified: z.literal(true),
        backupDigest: taggedSha256Schema,
        backupVerified: z.literal(true),
        restoreVerified: z.literal(true),
        attributionPreserved: z.literal(true),
        currentMembershipEnforced: z.literal(true),
        plaintextCredentialsAbsent: z.literal(true),
      })
      .strict(),
    presentation: z
      .object({
        staticAssetsServed: z.literal(true),
        selectedReferenceDigest: taggedSha256Schema,
        designQa: z.literal("passed"),
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
    const principalIds = [
      receipt.identities.alicePrincipalId,
      receipt.identities.bobPrincipalId,
      receipt.identities.carolPrincipalId,
    ]
    if (new Set(principalIds).size !== principalIds.length) {
      context.addIssue({
        code: "custom",
        path: ["identities"],
        message: "Collaboration proof requires three distinct Principals",
      })
    }
  })

const projectCollaborationProofReceiptSchema = projectCollaborationProofPayloadSchema.extend({
  receiptDigest: taggedSha256Schema,
})

export type ProjectCollaborationProofPayload = z.infer<
  typeof projectCollaborationProofPayloadSchema
>
export type ProjectCollaborationProofReceipt = z.infer<
  typeof projectCollaborationProofReceiptSchema
>

export function createProjectCollaborationProofReceipt(
  input: Omit<
    ProjectCollaborationProofPayload,
    "schemaVersion" | "proof" | "proofClass" | "status"
  >,
): ProjectCollaborationProofReceipt {
  const payload = projectCollaborationProofPayloadSchema.parse({
    schemaVersion: PROJECT_COLLABORATION_PROOF_RECEIPT_VERSION,
    proof: "meanwhile-project-collaboration",
    proofClass: "local-deployed-collaboration",
    status: "succeeded",
    ...input,
  })
  return projectCollaborationProofReceiptSchema.parse({
    ...payload,
    receiptDigest: digestProofPayload(payload),
  })
}

export function verifyProjectCollaborationProofReceipt(
  value: unknown,
): ProjectCollaborationProofReceipt {
  const receipt = projectCollaborationProofReceiptSchema.parse(value)
  const { receiptDigest, ...payload } = receipt
  if (digestProofPayload(payload) !== receiptDigest) {
    throw new TypeError("Project collaboration proof receipt digest does not match its evidence")
  }
  return receipt
}

export async function writeProjectCollaborationProofReceipt(
  path: string,
  receipt: ProjectCollaborationProofReceipt,
): Promise<void> {
  await writeProofReceipt(path, receipt, verifyProjectCollaborationProofReceipt)
}
