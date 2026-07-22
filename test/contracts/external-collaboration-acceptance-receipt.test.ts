import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createDeployedCollaborationProofReceipt } from "../../scripts/deployed-collaboration-proof-receipt"
import {
  createExternalCollaborationAcceptanceReceipt,
  createExternalCollaborationParticipantAttestation,
  EXTERNAL_COLLABORATION_ACCEPTANCE_RECEIPT_VERSION,
  verifyExternalCollaborationAcceptanceAgainstSystemReceipt,
  verifyExternalCollaborationAcceptanceReceipt,
  writeExternalCollaborationAcceptanceReceipt,
} from "../../scripts/external-collaboration-acceptance-receipt"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe("external collaboration acceptance receipt", () => {
  test("binds two reciprocal human attestations to one clean deployed system receipt", () => {
    const systemReceipt = deployedReceipt()
    const receipt = createExternalCollaborationAcceptanceReceipt(systemReceipt, attestations())

    expect(receipt.schemaVersion).toBe(EXTERNAL_COLLABORATION_ACCEPTANCE_RECEIPT_VERSION)
    expect(receipt.acceptanceClass).toBe("external-two-person-attested")
    expect(receipt.claimBoundary).toEqual({
      externalHumanAcceptance: "participant_attested",
      humanIdentity: "not_machine_verified",
      systemBehavior: "verified_by_linked_receipt",
    })
    expect(receipt.sourceSystemReceipt.receiptDigest).toBe(systemReceipt.receiptDigest)
    expect(receipt.sourceSystemReceipt.finishedAt).toBe(systemReceipt.finishedAt)
    expect(receipt.participants.map((value) => value.participantRole)).toEqual(["first", "second"])
    expect(verifyExternalCollaborationAcceptanceReceipt(receipt)).toEqual(receipt)
    expect(
      verifyExternalCollaborationAcceptanceAgainstSystemReceipt(receipt, systemReceipt),
    ).toEqual(receipt)
  })

  test("rejects identity collapse, non-reciprocal work, and a dirty deployed revision", () => {
    const [first, second] = attestations()
    expect(() =>
      createExternalCollaborationAcceptanceReceipt(deployedReceipt(), [
        first,
        createExternalCollaborationParticipantAttestation({
          ...participantInput("second"),
          participantRole: "first",
        }),
      ]),
    ).toThrow("Acceptance requires one first and one second participant")

    expect(() =>
      createExternalCollaborationAcceptanceReceipt(deployedReceipt(), [
        first,
        createExternalCollaborationParticipantAttestation({
          ...participantInput("second"),
          work: {
            ...participantInput("second").work,
            observedOtherWorkId: "00000000-0000-4000-8000-000000000099",
          },
        }),
      ]),
    ).toThrow("Participants must reciprocally observe each other's delegated work")

    const dirtySystemReceipt = createDeployedCollaborationProofReceipt({
      ...deployedInput(),
      revision: { commit: "c".repeat(40), dirty: true },
    })
    expect(() =>
      createExternalCollaborationAcceptanceReceipt(dirtySystemReceipt, [first, second]),
    ).toThrow("External collaboration acceptance requires a clean deployed revision")
  })

  test("requires a real live-agent journey and three-second comprehension", () => {
    expect(() =>
      createExternalCollaborationParticipantAttestation({
        ...participantInput("first"),
        work: { ...participantInput("first").work, ownAgentType: "demo" },
      }),
    ).toThrow()
    expect(() =>
      createExternalCollaborationParticipantAttestation({
        ...participantInput("first"),
        experience: { ...participantInput("first").experience, triageSeconds: 4 },
      }),
    ).toThrow()
    expect(() =>
      createExternalCollaborationParticipantAttestation({
        ...participantInput("first"),
        attestedAt: "2026-07-22T23:59:59.000Z",
      }),
    ).toThrow("Participant attestation cannot precede the observed journey")
  })

  test("detects mutated attestations and a mismatched linked system receipt", () => {
    const systemReceipt = deployedReceipt()
    const receipt = createExternalCollaborationAcceptanceReceipt(systemReceipt, attestations())
    const mutated = structuredClone(receipt)
    const firstParticipant = mutated.participants[0]
    if (firstParticipant === undefined) throw new TypeError("Missing first participant")
    firstParticipant.experience.trustedEnoughToLookAway = false as never
    expect(() => verifyExternalCollaborationAcceptanceReceipt(mutated)).toThrow()

    const otherSystemReceipt = createDeployedCollaborationProofReceipt({
      ...deployedInput(),
      project: { id: "00000000-0000-4000-8000-000000000099", bothMembersActive: true },
    })
    expect(() =>
      verifyExternalCollaborationAcceptanceAgainstSystemReceipt(receipt, otherSystemReceipt),
    ).toThrow("External collaboration acceptance belongs to a different system receipt")
  })

  test("writes one atomic self-verifying acceptance receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meanwhile-external-acceptance-"))
    temporaryDirectories.push(directory)
    const path = join(directory, "nested", "receipt.json")
    const receipt = createExternalCollaborationAcceptanceReceipt(deployedReceipt(), attestations())

    await writeExternalCollaborationAcceptanceReceipt(path, receipt)

    expect(verifyExternalCollaborationAcceptanceReceipt(await Bun.file(path).json())).toEqual(
      receipt,
    )
  })

  test("executes the documented participant, assembly, and verification workflow", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meanwhile-external-acceptance-cli-"))
    temporaryDirectories.push(directory)
    const systemPath = join(directory, "system.json")
    const firstInputPath = join(directory, "first-input.json")
    const secondInputPath = join(directory, "second-input.json")
    const firstPath = join(directory, "first.json")
    const secondPath = join(directory, "second.json")
    const receiptPath = join(directory, "acceptance.json")
    await Promise.all([
      Bun.write(systemPath, JSON.stringify(deployedReceipt())),
      Bun.write(firstInputPath, JSON.stringify(participantInput("first"))),
      Bun.write(secondInputPath, JSON.stringify(participantInput("second"))),
    ])

    await expectCommand([
      "scripts/external-collaboration-participant.ts",
      firstInputPath,
      `--output=${firstPath}`,
    ])
    await expectCommand([
      "scripts/external-collaboration-participant.ts",
      secondInputPath,
      `--output=${secondPath}`,
    ])
    await expectCommand([
      "scripts/external-collaboration-acceptance.ts",
      `--system-receipt=${systemPath}`,
      `--first-attestation=${firstPath}`,
      `--second-attestation=${secondPath}`,
      `--output=${receiptPath}`,
    ])
    const verified = await expectCommand([
      "scripts/verify-external-collaboration-acceptance.ts",
      receiptPath,
      `--system-receipt=${systemPath}`,
      `--commit=${"c".repeat(40)}`,
    ])

    expect(JSON.parse(verified)).toMatchObject({
      status: "verified",
      acceptanceClass: "external-two-person-attested",
      externalHumanAcceptance: "participant_attested",
      humanIdentity: "not_machine_verified",
    })
  })

  test("keeps participant, assembly, and verification as explicit package commands", async () => {
    const manifest = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
      scripts: Record<string, string>
    }

    expect(manifest.scripts["acceptance:external-collaboration:participant"]).toContain(
      "scripts/external-collaboration-participant.ts",
    )
    expect(manifest.scripts["acceptance:external-collaboration"]).toContain(
      "scripts/external-collaboration-acceptance.ts",
    )
    expect(manifest.scripts["acceptance:external-collaboration:verify"]).toContain(
      "scripts/verify-external-collaboration-acceptance.ts",
    )
  })
})

function attestations() {
  return [
    createExternalCollaborationParticipantAttestation(participantInput("first")),
    createExternalCollaborationParticipantAttestation(participantInput("second")),
  ] as const
}

function participantInput(role: "first" | "second") {
  const first = role === "first"
  return {
    acceptanceId: "00000000-0000-4000-8000-000000000010",
    participantRole: role,
    attestationId: first
      ? "00000000-0000-4000-8000-000000000011"
      : "00000000-0000-4000-8000-000000000012",
    observedAt: first ? "2026-07-23T00:00:00.000Z" : "2026-07-23T00:00:02.000Z",
    attestedAt: first ? "2026-07-23T00:01:00.000Z" : "2026-07-23T00:01:02.000Z",
    deployment: {
      controlPlaneOrigin: "https://api.example.com/",
      boardOrigin: "https://watch.example.com/",
      projectId: "00000000-0000-4000-8000-000000000003",
    },
    humanContext: {
      distinctHuman: "attested" as const,
      personalCredential: "used" as const,
      separateDeviceOrNetwork: "attested" as const,
    },
    work: {
      ownWorkId: first
        ? "00000000-0000-4000-8000-000000000020"
        : "00000000-0000-4000-8000-000000000021",
      ownAgentType: first ? ("codex" as const) : ("claude-code" as const),
      executionClass: "credentialed-live-agent" as const,
      observedOtherWorkId: first
        ? "00000000-0000-4000-8000-000000000021"
        : "00000000-0000-4000-8000-000000000020",
    },
    experience: {
      projectAndViewerEstablished: true as const,
      otherWorkVisible: true as const,
      otherDelegatorIdentified: true as const,
      otherConversationOpened: true as const,
      personalAttentionUnderstood: true as const,
      attention: {
        workId: "00000000-0000-4000-8000-000000000020",
        relationship: first ? ("own" as const) : ("other" as const),
        condition: "failed" as const,
        projectConditionVisible: true as const,
        personalVerdict: first ? ("needs_me" as const) : ("does_not_need_me" as const),
      },
      noCrossMemberControlsPresented: true as const,
      triageSeconds: 2,
      trustedEnoughToLookAway: true as const,
      wouldUseAgain: true as const,
    },
    verdict: "accepted" as const,
  }
}

function deployedReceipt() {
  return createDeployedCollaborationProofReceipt(deployedInput())
}

function deployedInput(): Parameters<typeof createDeployedCollaborationProofReceipt>[0] {
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

async function expectCommand(arguments_: readonly string[]): Promise<string> {
  const child = Bun.spawn([process.execPath, ...arguments_], {
    cwd: resolve(new URL("../../", import.meta.url).pathname),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(stderr).toBe("")
  expect(exitCode).toBe(0)
  return stdout
}
