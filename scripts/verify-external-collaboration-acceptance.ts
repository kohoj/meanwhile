import { resolve } from "node:path"
import { verifyExternalCollaborationAcceptanceAgainstSystemReceipt } from "./external-collaboration-acceptance-receipt"

const arguments_ = process.argv.slice(2)
const pathArguments = arguments_.filter((argument) => !argument.startsWith("--"))
const systemReceiptOption = arguments_.find((argument) => argument.startsWith("--system-receipt="))
const expectedCommitOption = arguments_.find((argument) => argument.startsWith("--commit="))

if (pathArguments.length !== 1 || systemReceiptOption === undefined) {
  throw new TypeError(
    "Usage: bun scripts/verify-external-collaboration-acceptance.ts <receipt> --system-receipt=<receipt> [--commit=<sha>]",
  )
}

const expectedCommit = expectedCommitOption?.slice("--commit=".length)
if (expectedCommit !== undefined && !/^[a-f0-9]{40}$/.test(expectedCommit)) {
  throw new TypeError("Expected commit must be a full lowercase Git SHA")
}

const receipt = verifyExternalCollaborationAcceptanceAgainstSystemReceipt(
  await Bun.file(resolve(pathArguments[0] as string)).json(),
  await Bun.file(resolve(systemReceiptOption.slice("--system-receipt=".length))).json(),
)
if (expectedCommit !== undefined && receipt.revision.commit !== expectedCommit) {
  throw new TypeError("External collaboration acceptance belongs to a different Git revision")
}

await Bun.write(
  Bun.stdout,
  `${JSON.stringify({
    status: "verified",
    acceptanceClass: receipt.acceptanceClass,
    revision: receipt.revision,
    receiptDigest: receipt.receiptDigest,
    externalHumanAcceptance: receipt.claimBoundary.externalHumanAcceptance,
    humanIdentity: receipt.claimBoundary.humanIdentity,
  })}\n`,
)
