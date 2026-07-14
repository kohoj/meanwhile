const textEncoder = new TextEncoder()

export const REDACTED_VALUE = "[REDACTED]"

const redactedBytes = textEncoder.encode(REDACTED_VALUE)
const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/
const secretReferencePattern = /^env:\/\/([A-Za-z_][A-Za-z0-9_]*)$/

const reservedSecretSourcePrefixes = [
  "MEANWHILE_",
  "CLOUDFLARE_",
  "CF_",
  "OTEL_",
  "WRANGLER_",
] as const
const reservedSecretSourceNames = new Set(["BRIDGE_TOKEN"])

type SecretPattern = {
  readonly bytes: Uint8Array
  readonly text?: string
}

export type SecretReferences = Readonly<Record<string, string>>

export type SecretPurpose = "agent" | "repository" | "deployment"

export interface SecretAccessScope {
  readonly ownerId: string
  readonly purpose: SecretPurpose
}

export type SecretResourceType = "run" | "session" | "deployment"

export interface SecretResolutionScope extends SecretAccessScope {
  /** Stable durable identity used to reacquire the complete redaction boundary after restart. */
  readonly resourceType: SecretResourceType
  readonly resourceId: string
}

/**
 * Sensitive values held by one control-plane attachment to a durable resource.
 * Idempotent `release()` zeroizes only these local copies and the matching redactor. It
 * must never revoke or rotate a credential already injected into surviving
 * compute; external credential lifetime belongs to a separate resource-cleanup
 * contract.
 */
export interface ResolvedSecretMaterial {
  readonly environment: Record<string, string>
  readonly redactor: SecretRedactor
  release(): void | Promise<void>
}

export interface SecretSource {
  get(name: string): string | undefined
}

export interface SecretReferenceValidator {
  validate(references: SecretReferences, scope: SecretAccessScope): void
}

/**
 * Resolves local secret material for one attachment to a durable resource.
 * Reacquisition for the same still-existing resource must redact every value
 * previously injected into its compute. Resolution and local release do not
 * own external credential revocation because control-plane observation may end
 * while that compute intentionally survives for restart recovery.
 */
export interface SecretResolver extends SecretReferenceValidator {
  resolve(
    references: SecretReferences,
    scope: SecretResolutionScope,
  ): ResolvedSecretMaterial | Promise<ResolvedSecretMaterial>
}

export interface EnvironmentSecretResolverOptions {
  /** The process environment in production; injectable only for deterministic tests. */
  readonly source?: SecretSource
  /** Explicit source names that public `env://` references may resolve. */
  readonly allowedSourceNames?: Iterable<string>
  /** Owners allowed to consume this process-global catalog. */
  readonly allowedOwnerIds?: Iterable<string>
}

export class SecretResolutionError extends Error {
  readonly code:
    | "INVALID_SECRET_REFERENCE"
    | "INVALID_SECRET_TARGET"
    | "SECRET_SOURCE_NOT_ALLOWED"
    | "SECRET_SCOPE_NOT_ALLOWED"
    | "SECRET_NOT_FOUND"
    | "EMPTY_SECRET"

  constructor(code: SecretResolutionError["code"], message: string) {
    super(message)
    this.name = "SecretResolutionError"
    this.code = code
  }
}

/**
 * Resolves the deliberately small `env://NAME` reference language.
 *
 * Resolution returns resource-bound local material and its matching redactor
 * together so callers cannot accidentally begin consuming output before
 * constructing the redaction boundary.
 */
export class EnvironmentSecretResolver implements SecretResolver {
  readonly #source: SecretSource
  readonly #allowedSourceNames: ReadonlySet<string>
  readonly #allowedOwnerIds: ReadonlySet<string>

  constructor(options: EnvironmentSecretResolverOptions = {}) {
    this.#source =
      options.source ??
      ({
        get: (name) => Bun.env[name],
      } satisfies SecretSource)
    this.#allowedSourceNames = validateSecretSourceCatalog(options.allowedSourceNames ?? [])
    this.#allowedOwnerIds = new Set(options.allowedOwnerIds ?? [])
  }

  /**
   * Validates the reference language and source catalog without reading any
   * values. Call this before persisting user intent.
   */
  validate(references: SecretReferences, scope: SecretAccessScope): void {
    if (Object.keys(references).length === 0) return
    this.#assertScope(scope)
    for (const [target, reference] of Object.entries(references)) {
      this.#parseReference(target, reference, scope.purpose)
    }
  }

  resolve(references: SecretReferences, scope: SecretResolutionScope): ResolvedSecretMaterial {
    if (scope.resourceId.length === 0) {
      throw new SecretResolutionError(
        "SECRET_SCOPE_NOT_ALLOWED",
        "Secret resolution requires a durable resource identity",
      )
    }
    const environment: Record<string, string> = Object.create(null)
    const values: string[] = []

    this.validate(references, scope)
    for (const [target, reference] of Object.entries(references)) {
      const sourceName = this.#parseReference(target, reference, scope.purpose)
      const value = this.#source.get(sourceName)
      if (value === undefined) {
        throw new SecretResolutionError(
          "SECRET_NOT_FOUND",
          `Secret reference env://${sourceName} is not configured`,
        )
      }
      if (value.length === 0) {
        throw new SecretResolutionError(
          "EMPTY_SECRET",
          `Secret reference env://${sourceName} resolved to an empty value`,
        )
      }

      environment[target] = value
      values.push(value)
    }

    const redactor = new SecretRedactor(values)
    let released = false

    return {
      environment,
      redactor,
      release() {
        if (released) return
        released = true

        for (const target of Object.keys(environment)) {
          environment[target] = ""
          delete environment[target]
        }
        redactor.dispose()
        values.fill("")
      },
    }
  }

  #assertScope(scope: SecretAccessScope): void {
    if (!this.#allowedOwnerIds.has(scope.ownerId)) {
      throw new SecretResolutionError(
        "SECRET_SCOPE_NOT_ALLOWED",
        "The authenticated owner cannot access process-environment secrets",
      )
    }
  }

  #parseReference(target: string, reference: string, purpose: SecretPurpose): string {
    if (!environmentNamePattern.test(target)) {
      throw new SecretResolutionError(
        "INVALID_SECRET_TARGET",
        `Secret target ${JSON.stringify(target)} is not a valid environment name`,
      )
    }

    const match = secretReferencePattern.exec(reference)
    const sourceName = match?.[1]
    if (sourceName === undefined) {
      throw new SecretResolutionError(
        "INVALID_SECRET_REFERENCE",
        `Secret reference for ${target} must use env://NAME`,
      )
    }
    if (!this.#allowedSourceNames.has(sourceName)) {
      throw new SecretResolutionError(
        "SECRET_SOURCE_NOT_ALLOWED",
        `Secret source env://${sourceName} is not in the configured secret catalog`,
      )
    }
    if (purpose === "repository") {
      throw new SecretResolutionError(
        "SECRET_SOURCE_NOT_ALLOWED",
        "Process-environment secrets are not authorized for repository credentials",
      )
    } else if (sourceName !== target) {
      throw new SecretResolutionError(
        "SECRET_SOURCE_NOT_ALLOWED",
        `Secret target ${target} must reference env://${target}`,
      )
    }
    return sourceName
  }
}

/** Reserved control-plane and provider variables are never agent-addressable. */
export const isReservedSecretSourceName = (name: string): boolean =>
  reservedSecretSourceNames.has(name) ||
  reservedSecretSourcePrefixes.some((prefix) => name.startsWith(prefix))

export const parseSecretSourceCatalog = (value: string): readonly string[] => {
  if (value.length === 0) return []
  const names = value.split(",")
  validateSecretSourceCatalog(names)
  return names
}

const validateSecretSourceCatalog = (names: Iterable<string>): ReadonlySet<string> => {
  const catalog = new Set<string>()
  for (const name of names) {
    if (!environmentNamePattern.test(name)) {
      throw new SecretResolutionError(
        "INVALID_SECRET_REFERENCE",
        `Secret source catalog entry ${JSON.stringify(name)} is not a valid environment name`,
      )
    }
    if (catalog.has(name)) {
      throw new SecretResolutionError(
        "INVALID_SECRET_REFERENCE",
        `Secret source catalog contains duplicate entry ${JSON.stringify(name)}`,
      )
    }
    if (isReservedSecretSourceName(name)) {
      throw new SecretResolutionError(
        "SECRET_SOURCE_NOT_ALLOWED",
        `Secret source catalog entry ${JSON.stringify(name)} is reserved by the control plane`,
      )
    }
    catalog.add(name)
  }
  return catalog
}

/**
 * Exact-value defense against accidental persistence of already resolved
 * secrets. It intentionally does not claim to detect transformed values.
 */
export class SecretRedactor {
  #patterns: SecretPattern[]
  #disposed = false

  constructor(values: Iterable<string | Uint8Array>) {
    const patterns: SecretPattern[] = []
    const seen = new Set<string>()

    for (const value of values) {
      const bytes = typeof value === "string" ? textEncoder.encode(value) : Uint8Array.from(value)

      if (bytes.byteLength === 0) {
        throw new SecretResolutionError(
          "EMPTY_SECRET",
          "An empty value cannot be registered as a secret",
        )
      }

      const identity = bytesToHex(bytes)
      if (seen.has(identity)) continue
      seen.add(identity)

      patterns.push({
        bytes,
        ...(typeof value === "string" ? { text: value } : {}),
      })
    }

    // Longest-first prevents a shorter secret from exposing the suffix of a
    // longer one that shares its prefix.
    patterns.sort((left, right) => right.bytes.byteLength - left.bytes.byteLength)
    this.#patterns = patterns
  }

  get active(): boolean {
    return !this.#disposed
  }

  redactString(value: string): string {
    this.#assertActive()
    let output = value
    for (const pattern of this.#patterns) {
      if (pattern.text !== undefined) {
        output = output.split(pattern.text).join(REDACTED_VALUE)
      }
    }
    // A configured value may itself occur in the marker, or two surrounding
    // fragments may join into a secret after replacement. Removal is the
    // fail-closed final pass and strictly shortens the string until safe.
    let previous: string
    do {
      previous = output
      for (const pattern of this.#patterns) {
        if (pattern.text !== undefined) output = output.split(pattern.text).join("")
      }
    } while (output !== previous)
    return output
  }

  redactBytes(value: Uint8Array): Uint8Array {
    this.#assertActive()
    return removeRemainingSecrets(
      redactByteRange(value, this.#patterns, value.byteLength, redactedBytes).output,
      this.#patterns,
    )
  }

  /** Returns a JSON-safe, accessor-free redacted copy. */
  redact(value: unknown): unknown {
    this.#assertActive()
    return this.#redactValue(value, new WeakSet<object>())
  }

  contains(value: unknown): boolean {
    this.#assertActive()
    return this.#containsValue(value, new WeakSet<object>())
  }

  createByteStream(): StreamingSecretRedactor {
    this.#assertActive()
    return new StreamingSecretRedactor(this.#patterns)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const pattern of this.#patterns) pattern.bytes.fill(0)
    this.#patterns = []
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("SecretRedactor has been disposed")
    }
  }

  #redactValue(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === "string") return this.redactString(value)
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === undefined
    ) {
      return value
    }
    if (typeof value === "bigint") return value.toString()
    if (typeof value === "symbol" || typeof value === "function") {
      return `[${typeof value}]`
    }
    if (value instanceof Uint8Array) return this.redactBytes(value)
    if (value instanceof ArrayBuffer) {
      return this.redactBytes(new Uint8Array(value)).buffer
    }
    if (value instanceof Date) return value.toISOString()

    if (seen.has(value)) return "[Circular]"
    seen.add(value)

    if (value instanceof Error) {
      const output: {
        name: string
        message: string
        cause?: unknown
      } = {
        name: this.redactString(value.name),
        message: this.redactString(value.message),
      }
      if (value.cause !== undefined) {
        output.cause = this.#redactValue(value.cause, seen)
      }
      return output
    }

    if (Array.isArray(value)) {
      return value.map((entry) => this.#redactValue(entry, seen))
    }

    const output: Record<string, unknown> = {}
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue
      const safeKey = this.redactString(key)
      output[safeKey] =
        "value" in descriptor ? this.#redactValue(descriptor.value, seen) : "[Accessor]"
    }
    return output
  }

  #containsValue(value: unknown, seen: WeakSet<object>): boolean {
    if (typeof value === "string") {
      return this.#patterns.some(
        (pattern) => pattern.text !== undefined && value.includes(pattern.text),
      )
    }
    if (value instanceof Uint8Array) {
      return this.#patterns.some((pattern) => indexOfBytes(value, pattern.bytes, 0) >= 0)
    }
    if (value instanceof ArrayBuffer) {
      return this.#containsValue(new Uint8Array(value), seen)
    }
    if (value === null || typeof value !== "object") return false
    if (seen.has(value)) return false
    seen.add(value)

    if (value instanceof Error) {
      return (
        this.#containsValue(value.name, seen) ||
        this.#containsValue(value.message, seen) ||
        this.#containsValue(value.cause, seen)
      )
    }
    if (Array.isArray(value)) {
      return value.some((entry) => this.#containsValue(entry, seen))
    }

    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue
      if (this.#containsValue(key, seen)) return true
      if ("value" in descriptor && this.#containsValue(descriptor.value, seen)) {
        return true
      }
    }
    return false
  }
}

/** Redacts exact byte patterns even when a secret crosses chunk boundaries. */
export class StreamingSecretRedactor {
  readonly #patterns: SecretPattern[]
  readonly #maximumPatternLength: number
  readonly #replacement: Uint8Array
  #pending = new Uint8Array()
  #outputPending = new Uint8Array()
  #finished = false

  constructor(patterns: readonly SecretPattern[]) {
    this.#patterns = patterns.map((pattern) => ({
      bytes: Uint8Array.from(pattern.bytes),
      ...(pattern.text === undefined ? {} : { text: pattern.text }),
    }))
    this.#maximumPatternLength = this.#patterns.reduce(
      (maximum, pattern) => Math.max(maximum, pattern.bytes.byteLength),
      0,
    )
    this.#replacement = this.#patterns.some(
      (pattern) => indexOfBytes(redactedBytes, pattern.bytes, 0) >= 0,
    )
      ? new Uint8Array()
      : redactedBytes
  }

  push(chunk: Uint8Array): Uint8Array {
    if (this.#finished) throw new Error("StreamingSecretRedactor has finished")
    if (chunk.byteLength === 0) return new Uint8Array()

    this.#pending = concatenateBytes(this.#pending, chunk)
    if (this.#maximumPatternLength === 0) {
      const output = concatenateBytes(this.#outputPending, this.#pending)
      this.#pending = new Uint8Array()
      this.#outputPending = new Uint8Array()
      return output
    }

    const safeStartLimit = Math.max(0, this.#pending.byteLength - this.#maximumPatternLength + 1)
    if (safeStartLimit === 0) return new Uint8Array()

    const redacted = redactByteRange(
      this.#pending,
      this.#patterns,
      safeStartLimit,
      this.#replacement,
    )
    this.#pending = this.#pending.slice(redacted.consumed)
    return this.#emitSafe(redacted.output, false)
  }

  finish(): Uint8Array {
    if (this.#finished) throw new Error("StreamingSecretRedactor has finished")
    this.#finished = true
    const output = redactByteRange(
      this.#pending,
      this.#patterns,
      this.#pending.byteLength,
      this.#replacement,
    ).output
    this.#pending.fill(0)
    this.#pending = new Uint8Array()
    const finalOutput = this.#emitSafe(output, true)
    this.#outputPending.fill(0)
    this.#outputPending = new Uint8Array()
    for (const pattern of this.#patterns) pattern.bytes.fill(0)
    return finalOutput
  }

  #emitSafe(output: Uint8Array, final: boolean): Uint8Array {
    const safe = removeRemainingSecrets(
      concatenateBytes(this.#outputPending, output),
      this.#patterns,
    )
    if (final || this.#maximumPatternLength === 0) return safe

    const emitLength = Math.max(0, safe.byteLength - this.#maximumPatternLength + 1)
    this.#outputPending = safe.slice(emitLength)
    return safe.slice(0, emitLength)
  }
}

function redactByteRange(
  input: Uint8Array,
  patterns: readonly SecretPattern[],
  safeStartLimit: number,
  replacement: Uint8Array,
): { readonly output: Uint8Array; readonly consumed: number } {
  const chunks: Uint8Array[] = []
  let outputLength = 0
  let index = 0
  let literalStart = 0

  while (index < safeStartLimit) {
    const match = patterns.find((pattern) => bytesMatchAt(input, pattern.bytes, index))
    if (!match) {
      index += 1
      continue
    }

    if (literalStart < index) {
      const literal = input.slice(literalStart, index)
      chunks.push(literal)
      outputLength += literal.byteLength
    }
    chunks.push(replacement)
    outputLength += replacement.byteLength
    index += match.bytes.byteLength
    literalStart = index
  }

  if (literalStart < index) {
    const literal = input.slice(literalStart, index)
    chunks.push(literal)
    outputLength += literal.byteLength
  }

  const output = new Uint8Array(outputLength)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { output, consumed: index }
}

function removeRemainingSecrets(input: Uint8Array, patterns: readonly SecretPattern[]): Uint8Array {
  let output = input
  let changed: boolean
  do {
    changed = false
    for (const pattern of patterns) {
      let match = indexOfBytes(output, pattern.bytes, 0)
      while (match >= 0) {
        const shortened = new Uint8Array(output.byteLength - pattern.bytes.byteLength)
        shortened.set(output.subarray(0, match), 0)
        shortened.set(output.subarray(match + pattern.bytes.byteLength), match)
        output = shortened
        changed = true
        match = indexOfBytes(output, pattern.bytes, 0)
      }
    }
  } while (changed)
  return output
}

function bytesMatchAt(input: Uint8Array, pattern: Uint8Array, offset: number): boolean {
  if (offset + pattern.byteLength > input.byteLength) return false
  for (let index = 0; index < pattern.byteLength; index += 1) {
    if (input[offset + index] !== pattern[index]) return false
  }
  return true
}

function indexOfBytes(input: Uint8Array, pattern: Uint8Array, fromIndex: number): number {
  const lastStart = input.byteLength - pattern.byteLength
  for (let index = fromIndex; index <= lastStart; index += 1) {
    if (bytesMatchAt(input, pattern, index)) return index
  }
  return -1
}

function concatenateBytes(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(left.byteLength + right.byteLength)
  output.set(left, 0)
  output.set(right, left.byteLength)
  return output
}

function bytesToHex(value: Uint8Array): string {
  let output = ""
  for (const byte of value) output += byte.toString(16).padStart(2, "0")
  return output
}
