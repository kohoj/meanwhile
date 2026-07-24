import { z } from "zod"
import {
  type DeployedCollaborationProofReceipt,
  verifyDeployedCollaborationProofReceipt,
} from "./deployed-collaboration-proof-receipt"
import { digestProofPayload, writeProofReceipt } from "./proof-receipt"

export const EXTERNAL_COLLABORATION_PARTICIPANT_ATTESTATION_VERSION = 3 as const
export const EXTERNAL_COLLABORATION_ACCEPTANCE_RECEIPT_VERSION = 3 as const

const timestampSchema = z.string().datetime({ offset: true })
const identifierSchema = z.string().uuid()
const taggedSha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const httpsOriginSchema = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === "https:", "Acceptance origins must use HTTPS")

const participantAttestationInputSchema = z
  .object({
    acceptanceId: identifierSchema,
    participantRole: z.enum(["first", "second"]),
    attestationId: identifierSchema,
    observedAt: timestampSchema,
    attestedAt: timestampSchema,
    deployment: z
      .object({
        controlPlaneOrigin: httpsOriginSchema,
        boardOrigin: httpsOriginSchema,
        projectId: identifierSchema,
      })
      .strict(),
    humanContext: z
      .object({
        distinctHuman: z.literal("attested"),
        personalCredential: z.literal("used"),
        separateDeviceOrNetwork: z.literal("attested"),
      })
      .strict(),
    work: z
      .object({
        ownWorkId: identifierSchema,
        ownAgentType: z.enum(["codex", "claude-code", "pi"]),
        executionClass: z.literal("credentialed-live-agent"),
        observedOtherWorkId: identifierSchema,
      })
      .strict(),
    experience: z
      .object({
        connectedOnboardingCompleted: z.literal(true),
        projectLobbyEntered: z.literal(true),
        ownTaskDelegatedFromBoard: z.literal(true),
        liveDeckUnderstood: z.literal(true),
        otherWorkVisible: z.literal(true),
        otherDelegatorIdentified: z.literal(true),
        otherConversationOpened: z.literal(true),
        liveTranscriptFollowed: z.literal(true),
        foldableDetailsUnderstood: z.literal(true),
        annotation: z
          .object({
            id: identifierSchema,
            workId: identifierSchema,
            relationship: z.enum(["author", "viewer"]),
            sourceAnchorUnderstood: z.literal(true),
            progressRailUnderstood: z.literal(true),
            projectVisibilityUnderstood: z.literal(true),
          })
          .strict(),
        relay: z
          .object({
            id: identifierSchema,
            workId: identifierSchema,
            relationship: z.enum(["author", "recipient"]),
            roomAttentionUnderstood: z.literal(true),
            sourceAnchorUnderstood: z.literal(true),
            acknowledged: z.literal(true),
            acknowledgementReceiptUnderstood: z.literal(true),
          })
          .strict(),
        noCrossMemberControlsPresented: z.literal(true),
        otherWorkFoundSeconds: z.number().int().min(0).max(15),
        trustedEnoughToLookAway: z.literal(true),
        wouldUseAgain: z.literal(true),
      })
      .strict(),
    verdict: z.literal("accepted"),
  })
  .strict()
  .superRefine((attestation, context) => {
    if (Date.parse(attestation.attestedAt) < Date.parse(attestation.observedAt)) {
      context.addIssue({
        code: "custom",
        path: ["attestedAt"],
        message: "Participant attestation cannot precede the observed journey",
      })
    }
    if (attestation.work.ownWorkId === attestation.work.observedOtherWorkId) {
      context.addIssue({
        code: "custom",
        path: ["work"],
        message: "Participant must observe work delegated by the other person",
      })
    }
  })

const participantAttestationPayloadSchema = participantAttestationInputSchema.extend({
  schemaVersion: z.literal(EXTERNAL_COLLABORATION_PARTICIPANT_ATTESTATION_VERSION),
  attestation: z.literal("meanwhile-external-project-collaboration-participant"),
})

const participantAttestationSchema = participantAttestationPayloadSchema.extend({
  attestationDigest: taggedSha256Schema,
})

export type ExternalCollaborationParticipantAttestationInput = z.infer<
  typeof participantAttestationInputSchema
>
export type ExternalCollaborationParticipantAttestation = z.infer<
  typeof participantAttestationSchema
>

const externalCollaborationAcceptancePayloadSchema = z
  .object({
    schemaVersion: z.literal(EXTERNAL_COLLABORATION_ACCEPTANCE_RECEIPT_VERSION),
    acceptance: z.literal("meanwhile-external-project-collaboration"),
    acceptanceClass: z.literal("external-two-person-attested"),
    status: z.literal("accepted"),
    acceptanceId: identifierSchema,
    startedAt: timestampSchema,
    finishedAt: timestampSchema,
    revision: z
      .object({
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        dirty: z.literal(false),
      })
      .strict(),
    deployment: z
      .object({
        controlPlaneOrigin: httpsOriginSchema,
        boardOrigin: httpsOriginSchema,
        projectId: identifierSchema,
      })
      .strict(),
    sourceSystemReceipt: z
      .object({
        proofClass: z.literal("deployed-two-principal-system"),
        receiptDigest: taggedSha256Schema,
        finishedAt: timestampSchema,
      })
      .strict(),
    participants: z.array(participantAttestationSchema).length(2),
    claimBoundary: z
      .object({
        externalHumanAcceptance: z.literal("participant_attested"),
        humanIdentity: z.literal("not_machine_verified"),
        systemBehavior: z.literal("verified_by_linked_receipt"),
      })
      .strict(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)) {
      context.addIssue({
        code: "custom",
        path: ["finishedAt"],
        message: "Acceptance completion cannot precede its start",
      })
    }
    if (Date.parse(receipt.startedAt) < Date.parse(receipt.sourceSystemReceipt.finishedAt)) {
      context.addIssue({
        code: "custom",
        path: ["startedAt"],
        message: "Human acceptance must follow the linked deployed-system proof",
      })
    }

    const first = receipt.participants.find(
      (participant) => participant.participantRole === "first",
    )
    const second = receipt.participants.find(
      (participant) => participant.participantRole === "second",
    )
    if (first === undefined || second === undefined) {
      context.addIssue({
        code: "custom",
        path: ["participants"],
        message: "Acceptance requires one first and one second participant",
      })
      return
    }
    if (first.attestationId === second.attestationId) {
      context.addIssue({
        code: "custom",
        path: ["participants"],
        message: "Participant attestations must have distinct identities",
      })
    }
    if (
      first.acceptanceId !== receipt.acceptanceId ||
      second.acceptanceId !== receipt.acceptanceId
    ) {
      context.addIssue({
        code: "custom",
        path: ["participants"],
        message: "Participant attestations belong to a different acceptance",
      })
    }
    for (const participant of receipt.participants) {
      if (
        participant.deployment.controlPlaneOrigin !== receipt.deployment.controlPlaneOrigin ||
        participant.deployment.boardOrigin !== receipt.deployment.boardOrigin ||
        participant.deployment.projectId !== receipt.deployment.projectId
      ) {
        context.addIssue({
          code: "custom",
          path: ["participants"],
          message: "Participant attestations belong to a different deployment or Project",
        })
      }
    }
    if (
      first.work.ownWorkId !== second.work.observedOtherWorkId ||
      second.work.ownWorkId !== first.work.observedOtherWorkId
    ) {
      context.addIssue({
        code: "custom",
        path: ["participants", "work"],
        message: "Participants must reciprocally observe each other's delegated work",
      })
    }
    if (
      first.experience.annotation.relationship !== "author" ||
      second.experience.annotation.relationship !== "viewer" ||
      first.experience.annotation.id !== second.experience.annotation.id ||
      first.experience.annotation.workId !== second.experience.annotation.workId ||
      first.experience.annotation.workId !== first.work.observedOtherWorkId ||
      second.experience.annotation.workId !== second.work.ownWorkId
    ) {
      context.addIssue({
        code: "custom",
        path: ["participants", "experience", "annotation"],
        message: "Participants must attest to the same anchored Project annotation",
      })
    }
    if (
      first.experience.relay.relationship !== "author" ||
      second.experience.relay.relationship !== "recipient" ||
      first.experience.relay.id !== second.experience.relay.id ||
      first.experience.relay.workId !== second.experience.relay.workId ||
      first.experience.relay.workId !== first.work.observedOtherWorkId ||
      second.experience.relay.workId !== second.work.ownWorkId
    ) {
      context.addIssue({
        code: "custom",
        path: ["participants", "experience", "relay"],
        message: "Participants must attest to the same authored and acknowledged Relay",
      })
    }

    const expectedStartedAt = earliest(receipt.participants.map((value) => value.observedAt))
    const expectedFinishedAt = latest(receipt.participants.map((value) => value.attestedAt))
    if (receipt.startedAt !== expectedStartedAt || receipt.finishedAt !== expectedFinishedAt) {
      context.addIssue({
        code: "custom",
        path: ["startedAt"],
        message: "Acceptance time window must be derived from participant attestations",
      })
    }
  })

const externalCollaborationAcceptanceReceiptSchema =
  externalCollaborationAcceptancePayloadSchema.extend({
    receiptDigest: taggedSha256Schema,
  })

export type ExternalCollaborationAcceptanceReceipt = z.infer<
  typeof externalCollaborationAcceptanceReceiptSchema
>

export function createExternalCollaborationParticipantAttestation(
  input: unknown,
): ExternalCollaborationParticipantAttestation {
  const parsed = participantAttestationInputSchema.parse(input)
  const payload = participantAttestationPayloadSchema.parse({
    schemaVersion: EXTERNAL_COLLABORATION_PARTICIPANT_ATTESTATION_VERSION,
    attestation: "meanwhile-external-project-collaboration-participant",
    ...parsed,
  })
  return participantAttestationSchema.parse({
    ...payload,
    attestationDigest: digestProofPayload(payload),
  })
}

export function verifyExternalCollaborationParticipantAttestation(
  value: unknown,
): ExternalCollaborationParticipantAttestation {
  const attestation = participantAttestationSchema.parse(value)
  const { attestationDigest, ...payload } = attestation
  if (digestProofPayload(payload) !== attestationDigest) {
    throw new TypeError("External collaboration participant attestation digest does not match")
  }
  return attestation
}

export async function writeExternalCollaborationParticipantAttestation(
  path: string,
  attestation: ExternalCollaborationParticipantAttestation,
): Promise<void> {
  await writeProofReceipt(path, attestation, verifyExternalCollaborationParticipantAttestation)
}

export function createExternalCollaborationAcceptanceReceipt(
  systemReceiptValue: unknown,
  participantValues: readonly [unknown, unknown],
): ExternalCollaborationAcceptanceReceipt {
  const systemReceipt = verifyDeployedCollaborationProofReceipt(systemReceiptValue)
  if (systemReceipt.revision.dirty) {
    throw new TypeError("External collaboration acceptance requires a clean deployed revision")
  }
  const participants = participantValues
    .map(verifyExternalCollaborationParticipantAttestation)
    .sort((left, right) => left.participantRole.localeCompare(right.participantRole)) as [
    ExternalCollaborationParticipantAttestation,
    ExternalCollaborationParticipantAttestation,
  ]
  const acceptanceId = participants[0].acceptanceId
  const payload = externalCollaborationAcceptancePayloadSchema.parse({
    schemaVersion: EXTERNAL_COLLABORATION_ACCEPTANCE_RECEIPT_VERSION,
    acceptance: "meanwhile-external-project-collaboration",
    acceptanceClass: "external-two-person-attested",
    status: "accepted",
    acceptanceId,
    startedAt: earliest(participants.map((value) => value.observedAt)),
    finishedAt: latest(participants.map((value) => value.attestedAt)),
    revision: systemReceipt.revision,
    deployment: {
      controlPlaneOrigin: systemReceipt.topology.controlPlaneOrigin,
      boardOrigin: systemReceipt.topology.boardOrigin,
      projectId: systemReceipt.project.id,
    },
    sourceSystemReceipt: {
      proofClass: systemReceipt.proofClass,
      receiptDigest: systemReceipt.receiptDigest,
      finishedAt: systemReceipt.finishedAt,
    },
    participants,
    claimBoundary: {
      externalHumanAcceptance: "participant_attested",
      humanIdentity: "not_machine_verified",
      systemBehavior: "verified_by_linked_receipt",
    },
  })
  return externalCollaborationAcceptanceReceiptSchema.parse({
    ...payload,
    receiptDigest: digestProofPayload(payload),
  })
}

export function verifyExternalCollaborationAcceptanceReceipt(
  value: unknown,
): ExternalCollaborationAcceptanceReceipt {
  const receipt = externalCollaborationAcceptanceReceiptSchema.parse(value)
  const { receiptDigest, ...payload } = receipt
  if (digestProofPayload(payload) !== receiptDigest) {
    throw new TypeError("External collaboration acceptance receipt digest does not match")
  }
  for (const participant of receipt.participants) {
    verifyExternalCollaborationParticipantAttestation(participant)
  }
  return receipt
}

export function verifyExternalCollaborationAcceptanceAgainstSystemReceipt(
  acceptanceValue: unknown,
  systemReceiptValue: unknown,
): ExternalCollaborationAcceptanceReceipt {
  const acceptance = verifyExternalCollaborationAcceptanceReceipt(acceptanceValue)
  const systemReceipt: DeployedCollaborationProofReceipt =
    verifyDeployedCollaborationProofReceipt(systemReceiptValue)
  if (systemReceipt.revision.dirty) {
    throw new TypeError("External collaboration acceptance requires a clean deployed revision")
  }
  if (
    acceptance.sourceSystemReceipt.receiptDigest !== systemReceipt.receiptDigest ||
    acceptance.sourceSystemReceipt.finishedAt !== systemReceipt.finishedAt ||
    acceptance.revision.commit !== systemReceipt.revision.commit ||
    acceptance.deployment.controlPlaneOrigin !== systemReceipt.topology.controlPlaneOrigin ||
    acceptance.deployment.boardOrigin !== systemReceipt.topology.boardOrigin ||
    acceptance.deployment.projectId !== systemReceipt.project.id
  ) {
    throw new TypeError("External collaboration acceptance belongs to a different system receipt")
  }
  return acceptance
}

export async function writeExternalCollaborationAcceptanceReceipt(
  path: string,
  receipt: ExternalCollaborationAcceptanceReceipt,
): Promise<void> {
  await writeProofReceipt(path, receipt, verifyExternalCollaborationAcceptanceReceipt)
}

function earliest(values: readonly string[]): string {
  return [...values].sort((left, right) => Date.parse(left) - Date.parse(right))[0] as string
}

function latest(values: readonly string[]): string {
  return [...values].sort((left, right) => Date.parse(right) - Date.parse(left))[0] as string
}
