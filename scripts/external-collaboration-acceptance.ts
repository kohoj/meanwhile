import { resolve } from "node:path"
import {
  createExternalCollaborationAcceptanceReceipt,
  writeExternalCollaborationAcceptanceReceipt,
} from "./external-collaboration-acceptance-receipt"

const options = new Map(
  process.argv
    .slice(2)
    .filter((argument) => argument.startsWith("--"))
    .map((argument) => {
      const separator = argument.indexOf("=")
      return separator < 0
        ? [argument.slice(2), ""]
        : [argument.slice(2, separator), argument.slice(separator + 1)]
    }),
)
const systemReceiptPath = requiredPath("system-receipt")
const firstAttestationPath = requiredPath("first-attestation")
const secondAttestationPath = requiredPath("second-attestation")
const outputPath = requiredPath("output")

const receipt = createExternalCollaborationAcceptanceReceipt(
  await Bun.file(systemReceiptPath).json(),
  [await Bun.file(firstAttestationPath).json(), await Bun.file(secondAttestationPath).json()],
)
await writeExternalCollaborationAcceptanceReceipt(outputPath, receipt)

await Bun.write(
  Bun.stdout,
  `${JSON.stringify({
    status: receipt.status,
    acceptanceClass: receipt.acceptanceClass,
    revision: receipt.revision,
    receipt: outputPath,
    receiptDigest: receipt.receiptDigest,
    externalHumanAcceptance: receipt.claimBoundary.externalHumanAcceptance,
    humanIdentity: receipt.claimBoundary.humanIdentity,
  })}\n`,
)

function requiredPath(name: string): string {
  const value = options.get(name)
  if (value === undefined || value.length === 0) {
    throw new TypeError(`Missing required --${name}=<path>`)
  }
  return resolve(value)
}
