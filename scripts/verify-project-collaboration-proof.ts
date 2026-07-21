import { resolve } from "node:path"
import { verifyProjectCollaborationProofReceipt } from "./project-collaboration-proof-receipt"

const arguments_ = process.argv.slice(2)
const pathArguments = arguments_.filter((argument) => !argument.startsWith("--"))
const requireClean = arguments_.includes("--require-clean")
const expectedCommitOption = arguments_.find((argument) => argument.startsWith("--commit="))

if (pathArguments.length !== 1) {
  throw new TypeError(
    "Usage: bun scripts/verify-project-collaboration-proof.ts <receipt> [--require-clean] [--commit=<sha>]",
  )
}

const expectedCommit = expectedCommitOption?.slice("--commit=".length)
if (expectedCommit !== undefined && !/^[a-f0-9]{40}$/.test(expectedCommit)) {
  throw new TypeError("Expected commit must be a full lowercase Git SHA")
}

const receipt = verifyProjectCollaborationProofReceipt(
  await Bun.file(resolve(pathArguments[0] as string)).json(),
)
if (requireClean && receipt.revision.dirty) {
  throw new TypeError("Project collaboration proof was produced from a dirty worktree")
}
if (expectedCommit !== undefined && receipt.revision.commit !== expectedCommit) {
  throw new TypeError("Project collaboration proof belongs to a different Git revision")
}

await Bun.write(
  Bun.stdout,
  `${JSON.stringify({
    status: "verified",
    proofClass: receipt.proofClass,
    revision: receipt.revision,
    receiptDigest: receipt.receiptDigest,
  })}\n`,
)
