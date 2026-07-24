/**
 * A provider-neutral view of repositories the current external identity may
 * enter. It is deliberately separate from Project membership: a directory
 * grant qualifies access, while Meanwhile still owns durable identity,
 * delegation, lifecycle authority, and audit.
 */
export type RepositoryAccessLevel = "watch" | "participate" | "administer"

export interface RepositoryDirectoryAccount {
  readonly id: string
  readonly login: string
  readonly type: "organization" | "user"
  readonly avatarUrl: string | null
}

export interface RepositoryDirectoryEntry {
  readonly provider: string
  readonly installationId: string
  readonly account: RepositoryDirectoryAccount
  readonly repository: {
    readonly id: string
    readonly name: string
    readonly fullName: string
    readonly private: boolean
    readonly defaultBranch: string
    readonly webUrl: string
  }
  readonly access: RepositoryAccessLevel
}

/** A credential is accepted only for one provider call and is never returned. */
export interface RepositoryDirectoryCredential {
  readonly bearerToken: string
}

export interface RepositoryProjectDirectory {
  readonly provider: string
  list(
    credential: RepositoryDirectoryCredential,
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly RepositoryDirectoryEntry[]>
}

export class RepositoryDirectoryError extends Error {
  readonly provider: string
  readonly operation: string
  readonly status: number | null
  readonly retryable: boolean

  constructor(input: {
    readonly provider: string
    readonly operation: string
    readonly status?: number
    readonly retryable?: boolean
    readonly message: string
  }) {
    super(input.message)
    this.name = "RepositoryDirectoryError"
    this.provider = input.provider
    this.operation = input.operation
    this.status = input.status ?? null
    this.retryable = input.retryable ?? false
  }
}
