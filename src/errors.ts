import { HTTPException } from "hono/http-exception"
import type { JsonObject, StructuredError } from "./domain"
import { RuntimeProviderError } from "./providers/runtime-provider"
import { SecretResolutionError } from "./secrets"

const PROVIDER_OPERATION_FAILED_MESSAGE = "Runtime provider operation failed"
const MALFORMED_REQUEST_MESSAGE = "Request body is malformed"
const SAFE_PROVIDER_CODE = /^[A-Z][A-Z0-9_]{0,127}$/

export const ERROR_HTTP_STATUS = {
  INVALID_REQUEST: 400,
  UNAUTHENTICATED: 401,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  IDEMPOTENCY_CONFLICT: 409,
  RUNNER_EVIDENCE_CONFLICT: 409,
  BOOTSTRAP_KEY_CONFLICT: 409,
  BOOTSTRAP_KEY_REQUIRED: 500,
  SCHEMA_DEFINITION_INVALID: 500,
  DATABASE_SCHEMA_MISMATCH: 500,
  INVALID_STATE_TRANSITION: 409,
  RUN_TERMINAL: 409,
  ARTIFACT_POLICY_REJECTED: 422,
  DEPLOYMENT_SOURCE_UNAVAILABLE: 422,
  PROVIDER_UNAVAILABLE: 503,
  RUNTIME_LOST: 502,
  RUNNER_PROTOCOL_ERROR: 502,
  INTERNAL: 500,
} as const

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS | (string & {})

export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly retryable: boolean
  readonly details?: JsonObject
  override readonly cause?: unknown

  constructor(input: {
    code: ErrorCode
    message: string
    status?: number
    retryable?: boolean
    details?: JsonObject
    cause?: unknown
  }) {
    super(input.message)
    this.name = "AppError"
    this.code = input.code
    this.status =
      input.status ?? ERROR_HTTP_STATUS[input.code as keyof typeof ERROR_HTTP_STATUS] ?? 500
    this.retryable = input.retryable ?? false
    if (input.details !== undefined) this.details = input.details
    if (input.cause !== undefined) this.cause = input.cause
  }

  toStructuredError(): StructuredError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    }
  }
}

export class ProviderError extends AppError {
  readonly provider: string
  readonly operation: string
  readonly providerCode?: string

  constructor(input: {
    provider: string
    operation: string
    providerCode?: string
    retryable?: boolean
  }) {
    const providerCode =
      input.providerCode === undefined ? undefined : safeProviderCode(input.providerCode)
    super({
      code: "PROVIDER_UNAVAILABLE",
      message: PROVIDER_OPERATION_FAILED_MESSAGE,
      status: 503,
      ...(input.retryable === undefined ? {} : { retryable: input.retryable }),
      details: {
        provider: input.provider,
        operation: input.operation,
        ...(providerCode === undefined ? {} : { providerCode }),
      },
    })
    this.name = "ProviderError"
    this.provider = input.provider
    this.operation = input.operation
    if (providerCode !== undefined) this.providerCode = providerCode
  }
}

export const normalizeError = (error: unknown): AppError => {
  if (error instanceof AppError) return error
  if (error instanceof SecretResolutionError) {
    return new AppError({
      code: "INVALID_REQUEST",
      message: error.message,
      status: 400,
      retryable: false,
      cause: error,
    })
  }
  if (error instanceof RuntimeProviderError) {
    return new ProviderError({
      provider: error.provider,
      operation: error.operation,
      providerCode: error.code,
      retryable: error.retryable,
    })
  }
  if (error instanceof HTTPException && error.status === 400) {
    return new AppError({
      code: "INVALID_REQUEST",
      message: MALFORMED_REQUEST_MESSAGE,
      status: 400,
      retryable: false,
      cause: error,
    })
  }
  return new AppError({
    code: "INTERNAL",
    message: "An unexpected internal error occurred",
    status: 500,
    retryable: false,
    cause: error,
  })
}

const safeProviderCode = (code: string): string =>
  SAFE_PROVIDER_CODE.test(code) ? code : "PROVIDER_ERROR"

export interface ErrorEnvelope {
  readonly error: {
    readonly code: string
    readonly message: string
    readonly requestId: string
    readonly details: JsonObject
  }
}

export const errorEnvelope = (error: AppError, requestId: string): ErrorEnvelope => ({
  error: {
    code: error.code,
    message: error.message,
    requestId,
    details: error.details ?? {},
  },
})
