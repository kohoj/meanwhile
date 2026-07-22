import { resolve } from "node:path"
import {
  createExternalCollaborationParticipantAttestation,
  writeExternalCollaborationParticipantAttestation,
} from "./external-collaboration-acceptance-receipt"

const arguments_ = process.argv.slice(2)
const pathArguments = arguments_.filter((argument) => !argument.startsWith("--"))
const outputOption = arguments_.find((argument) => argument.startsWith("--output="))

if (pathArguments.length !== 1 || outputOption === undefined) {
  throw new TypeError(
    "Usage: bun scripts/external-collaboration-participant.ts <input.json> --output=<attestation.json>",
  )
}

const inputPath = resolve(pathArguments[0] as string)
const outputPath = resolve(outputOption.slice("--output=".length))
const attestation = createExternalCollaborationParticipantAttestation(
  await Bun.file(inputPath).json(),
)
await writeExternalCollaborationParticipantAttestation(outputPath, attestation)

await Bun.write(
  Bun.stdout,
  `${JSON.stringify({
    status: "attested",
    participantRole: attestation.participantRole,
    acceptanceId: attestation.acceptanceId,
    attestationDigest: attestation.attestationDigest,
    output: outputPath,
  })}\n`,
)
