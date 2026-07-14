export const hashCanonical = (value: unknown): string =>
  new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex")

export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new TypeError("Idempotency input must be JSON")
    return serialized
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`

  const record = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`
}
