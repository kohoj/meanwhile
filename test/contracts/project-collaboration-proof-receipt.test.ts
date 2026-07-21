import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createProjectCollaborationProofReceipt,
  PROJECT_COLLABORATION_PROOF_RECEIPT_VERSION,
  verifyProjectCollaborationProofReceipt,
  writeProjectCollaborationProofReceipt,
} from "../../scripts/project-collaboration-proof-receipt"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe("Project collaboration proof receipt", () => {
  test("binds the complete two-person acceptance boundary to one digest", () => {
    const receipt = createProjectCollaborationProofReceipt(proofInput())

    expect(receipt.schemaVersion).toBe(PROJECT_COLLABORATION_PROOF_RECEIPT_VERSION)
    expect(receipt.proofClass).toBe("local-deployed-collaboration")
    expect(receipt.authorization).toMatchObject({
      bobCancelAliceRun: "not_found",
      carolProjectList: "empty",
      browserSessionMutation: "forbidden",
    })
    expect(verifyProjectCollaborationProofReceipt(receipt)).toEqual(receipt)

    const mutated = structuredClone(receipt)
    mutated.persistence.backupDigest = `sha256:${"b".repeat(64)}`
    expect(() => verifyProjectCollaborationProofReceipt(mutated)).toThrow(
      "Project collaboration proof receipt digest does not match its evidence",
    )
  })

  test("rejects identity collapse and incomplete acceptance evidence", () => {
    const input = proofInput()
    expect(() =>
      createProjectCollaborationProofReceipt({
        ...input,
        identities: {
          ...input.identities,
          bobPrincipalId: input.identities.alicePrincipalId,
        },
      }),
    ).toThrow("Collaboration proof requires three distinct Principals")
  })

  test("writes one atomic self-verifying receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meanwhile-project-proof-receipt-"))
    temporaryDirectories.push(directory)
    const path = join(directory, "nested", "receipt.json")
    const receipt = createProjectCollaborationProofReceipt(proofInput())

    await writeProjectCollaborationProofReceipt(path, receipt)

    expect(verifyProjectCollaborationProofReceipt(await Bun.file(path).json())).toEqual(receipt)
  })

  test("keeps execution and clean-revision verification as explicit package commands", async () => {
    const manifest = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
      scripts: Record<string, string>
    }

    expect(manifest.scripts["proof:project-collaboration"]).toContain(
      ".proof/project-collaboration.json",
    )
    expect(manifest.scripts["proof:project-collaboration:execute"]).toContain(
      "scripts/project-collaboration-proof.ts",
    )
    expect(manifest.scripts["proof:project-collaboration:verify"]).toContain(
      "scripts/verify-project-collaboration-proof.ts",
    )
  })
})

function proofInput(): Parameters<typeof createProjectCollaborationProofReceipt>[0] {
  const sha256 = `sha256:${"a".repeat(64)}` as const
  return {
    startedAt: "2026-07-22T00:00:00.000Z",
    finishedAt: "2026-07-22T00:01:00.000Z",
    revision: { commit: "c".repeat(40), dirty: false },
    topology: {
      controlPlaneOrigin: "http://127.0.0.1:7331",
      boardOrigin: "http://127.0.0.1:7333",
      runtimeProvider: "local-deterministic",
      boardBoundary: "project-watch-bff",
    },
    identities: {
      alicePrincipalId: "00000000-0000-4000-8000-000000000001",
      bobPrincipalId: "00000000-0000-4000-8000-000000000002",
      carolPrincipalId: "00000000-0000-4000-8000-000000000003",
      distinctPrincipals: true,
    },
    project: {
      id: "00000000-0000-4000-8000-000000000004",
      aliceAndBobInitiallyActive: true,
      carolNeverMember: true,
    },
    work: {
      runId: "00000000-0000-4000-8000-000000000005",
      sessionId: "00000000-0000-4000-8000-000000000006",
      delegatedByAlice: true,
      visibleToAlice: true,
      visibleToBob: true,
      conversationVisibleToBob: true,
      artifactVisibleToBob: true,
    },
    authorization: {
      bobCancelAliceRun: "not_found",
      bobDeployAliceRun: "not_found",
      bobSendAliceSession: "not_found",
      bobInterruptAliceSession: "not_found",
      bobCloseAliceSession: "not_found",
      carolProjectList: "empty",
      carolProjectRead: "not_found",
      carolRunRead: "not_found",
      carolRunEvents: "not_found",
      carolArtifactRead: "not_found",
      carolSessionRead: "not_found",
      boardMutation: "method_not_allowed",
      browserSessionMutation: "forbidden",
    },
    browser: {
      independentAliceAndBobSessions: true,
      httpOnlyCookies: true,
      sameSiteStrictCookies: true,
      bothSeeAliceRun: true,
      bobOpenedTaskConversation: true,
    },
    credentialRotation: {
      oldAliceKeyRejected: true,
      replacementKeyAccepted: true,
      principalIdentityPreserved: true,
      historicalAttributionPreserved: true,
    },
    membershipRevocation: {
      bobRemoved: true,
      bobSdkReadDenied: true,
      bobBoardReadDenied: true,
      aliceUnaffected: true,
    },
    persistence: {
      restartVerified: true,
      backupDigest: sha256,
      backupVerified: true,
      restoreVerified: true,
      attributionPreserved: true,
      currentMembershipEnforced: true,
      plaintextCredentialsAbsent: true,
    },
    presentation: {
      staticAssetsServed: true,
      selectedReferenceDigest: sha256,
      designQa: "passed",
    },
  }
}
