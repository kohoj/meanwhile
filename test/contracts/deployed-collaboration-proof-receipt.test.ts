import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createDeployedCollaborationProofReceipt,
  DEPLOYED_COLLABORATION_PROOF_RECEIPT_VERSION,
  verifyDeployedCollaborationProofReceipt,
  writeDeployedCollaborationProofReceipt,
} from "../../scripts/deployed-collaboration-proof-receipt"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe("deployed collaboration proof receipt", () => {
  test("binds the two-Principal HTTPS system proof without claiming human acceptance", () => {
    const receipt = createDeployedCollaborationProofReceipt(proofInput())

    expect(receipt.schemaVersion).toBe(DEPLOYED_COLLABORATION_PROOF_RECEIPT_VERSION)
    expect(receipt.proofClass).toBe("deployed-two-principal-system")
    expect(receipt.claimBoundary.externalHumanAcceptance).toBe("not_claimed")
    expect(verifyDeployedCollaborationProofReceipt(receipt)).toEqual(receipt)

    const mutated = structuredClone(receipt)
    mutated.work.secondSeesFirstRun = false as never
    expect(() => verifyDeployedCollaborationProofReceipt(mutated)).toThrow()
  })

  test("rejects identity collapse and non-HTTPS ingress", () => {
    const input = proofInput()
    expect(() =>
      createDeployedCollaborationProofReceipt({
        ...input,
        identities: {
          ...input.identities,
          secondPrincipalId: input.identities.firstPrincipalId,
        },
      }),
    ).toThrow("Deployed collaboration proof requires two distinct Principals")

    expect(() =>
      createDeployedCollaborationProofReceipt({
        ...input,
        topology: { ...input.topology, controlPlaneOrigin: "http://127.0.0.1:7331" },
      }),
    ).toThrow("Deployed control-plane ingress must use HTTPS")
  })

  test("writes one atomic self-verifying receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meanwhile-deployed-proof-receipt-"))
    temporaryDirectories.push(directory)
    const path = join(directory, "nested", "receipt.json")
    const receipt = createDeployedCollaborationProofReceipt(proofInput())

    await writeDeployedCollaborationProofReceipt(path, receipt)

    expect(verifyDeployedCollaborationProofReceipt(await Bun.file(path).json())).toEqual(receipt)
  })

  test("keeps execution and verification as explicit package commands", async () => {
    const manifest = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
      scripts: Record<string, string>
    }

    expect(manifest.scripts["proof:deployed-collaboration"]).toContain(
      "scripts/deployed-collaboration-proof.ts",
    )
    expect(manifest.scripts["proof:deployed-collaboration:verify"]).toContain(
      "scripts/verify-deployed-collaboration-proof.ts",
    )
  })
})

function proofInput(): Parameters<typeof createDeployedCollaborationProofReceipt>[0] {
  return {
    startedAt: "2026-07-22T00:00:00.000Z",
    finishedAt: "2026-07-22T00:01:00.000Z",
    revision: { commit: "c".repeat(40), dirty: false },
    topology: {
      controlPlaneOrigin: "https://api.example.com/",
      boardOrigin: "https://watch.example.com/",
      controlPlaneTransport: "https",
      boardTransport: "https",
      runtimeProvider: "local",
      agentType: "demo",
      boardBoundary: "project-watch-bff",
    },
    identities: {
      firstPrincipalId: "00000000-0000-4000-8000-000000000001",
      secondPrincipalId: "00000000-0000-4000-8000-000000000002",
      distinctPrincipals: true,
    },
    project: {
      id: "00000000-0000-4000-8000-000000000003",
      bothMembersActive: true,
    },
    work: {
      firstRunId: "00000000-0000-4000-8000-000000000004",
      secondRunId: "00000000-0000-4000-8000-000000000005",
      firstRunAttributed: true,
      secondRunAttributed: true,
      firstSeesSecondRun: true,
      secondSeesFirstRun: true,
      firstOpenedSecondConversation: true,
      secondOpenedFirstConversation: true,
    },
    authorization: {
      firstCannotCancelSecondRun: "not_found",
      secondCannotCancelFirstRun: "not_found",
      boardMutation: "method_not_allowed",
      browserSessionMutation: "forbidden",
    },
    browser: {
      independentSessions: true,
      httpOnlyCookies: true,
      sameSiteStrictCookies: true,
      secureCookies: true,
      bothBoardsSeeBothRuns: true,
    },
    security: { plaintextCredentialsAbsent: true },
    claimBoundary: { externalHumanAcceptance: "not_claimed" },
  }
}
