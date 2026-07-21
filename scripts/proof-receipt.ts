import { mkdir, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"

export function digestProofPayload(payload: unknown): string {
  const digest = new Bun.CryptoHasher("sha256").update(canonicalJson(payload)).digest("hex")
  return `sha256:${digest}`
}

export async function writeProofReceipt<Receipt>(
  path: string,
  receipt: Receipt,
  verify: (value: unknown) => Receipt,
): Promise<void> {
  const verified = verify(receipt)
  const directory = dirname(path)
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`
  await mkdir(directory, { recursive: true })
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(verified, null, 2)}\n`)
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value)
  }
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value !== "object") throw new TypeError("Proof receipt is not JSON serializable")

  const record = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`
}
