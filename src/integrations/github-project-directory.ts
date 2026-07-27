import { z } from "zod"
import {
  type RepositoryDirectoryAccount,
  type RepositoryDirectoryCredential,
  type RepositoryDirectoryEntry,
  RepositoryDirectoryError,
  type RepositoryProjectDirectory,
} from "./repository-directory"

const GITHUB_API_VERSION = "2022-11-28"
const PAGE_SIZE = 100

const GitHubIdentifierSchema = z.union([z.number().int().nonnegative(), z.string().min(1)])
const GitHubAccountSchema = z
  .object({
    id: GitHubIdentifierSchema,
    login: z.string().min(1),
    type: z.string().min(1),
    avatar_url: z.string().url().nullable().optional(),
  })
  .passthrough()
const GitHubRepositorySchema = z
  .object({
    id: GitHubIdentifierSchema,
    name: z.string().min(1),
    full_name: z.string().min(3),
    private: z.boolean(),
    default_branch: z.string().min(1),
    html_url: z.string().url(),
    owner: GitHubAccountSchema,
    permissions: z.record(z.string(), z.boolean()).optional(),
  })
  .passthrough()

type GitHubRepository = z.infer<typeof GitHubRepositorySchema>

export interface GitHubProjectDirectoryOptions {
  readonly fetch?: GitHubFetch
  readonly apiOrigin?: string
}

type GitHubFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Lists repositories visible to one GitHub OAuth user token. The user grants
 * repository access once in GitHub; no per-account App installation is part of
 * the product journey. This adapter normalizes GitHub's answer and never
 * persists the plaintext token.
 */
export class GitHubProjectDirectory implements RepositoryProjectDirectory {
  readonly provider = "github"
  readonly #fetch: GitHubFetch
  readonly #apiOrigin: URL

  constructor(options: GitHubProjectDirectoryOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#apiOrigin = new URL(options.apiOrigin ?? "https://api.github.com/")
  }

  async list(
    credential: RepositoryDirectoryCredential,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly RepositoryDirectoryEntry[]> {
    if (credential.bearerToken.trim().length === 0) {
      throw new RepositoryDirectoryError({
        provider: this.provider,
        operation: "list",
        message: "GitHub authorization is required",
      })
    }
    return (await this.#listRepositories(credential, options.signal))
      .map(normalizeRepository)
      .sort((left, right) => left.repository.fullName.localeCompare(right.repository.fullName))
  }

  async #listRepositories(
    credential: RepositoryDirectoryCredential,
    signal?: AbortSignal,
  ): Promise<readonly GitHubRepository[]> {
    const items: GitHubRepository[] = []
    let url: URL | null = new URL(
      `user/repos?affiliation=owner,collaborator,organization_member&per_page=${PAGE_SIZE}&sort=full_name`,
      this.#apiOrigin,
    )
    while (url !== null) {
      const response = await this.#request(url, credential, signal, "list_repositories")
      const body = z
        .array(GitHubRepositorySchema)
        .safeParse(await response.json().catch(() => null))
      if (!body.success) throw invalidGitHubResponse("list_repositories")
      items.push(...body.data)
      url = nextPage(response.headers.get("Link"), this.#apiOrigin)
    }
    return items
  }

  async #request(
    url: URL,
    credential: RepositoryDirectoryCredential,
    signal: AbortSignal | undefined,
    operation: string,
  ): Promise<Response> {
    let response: Response
    try {
      response = await this.#fetch(url, {
        ...(signal === undefined ? {} : { signal }),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${credential.bearerToken}`,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
      })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new RepositoryDirectoryError({
        provider: this.provider,
        operation,
        retryable: true,
        message: "GitHub repository access is unavailable",
      })
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new RepositoryDirectoryError({
        provider: this.provider,
        operation,
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
        message:
          response.status === 401 || response.status === 403
            ? "GitHub authorization could not be verified"
            : "GitHub repository access is unavailable",
      })
    }
    return response
  }
}

function normalizeRepository(repository: GitHubRepository): RepositoryDirectoryEntry {
  const account: RepositoryDirectoryAccount = {
    id: String(repository.owner.id),
    login: repository.owner.login,
    type: repository.owner.type.toLowerCase() === "organization" ? "organization" : "user",
    avatarUrl: repository.owner.avatar_url ?? null,
  }
  const permissions = repository.permissions ?? {}
  const access =
    permissions["admin"] === true
      ? "administer"
      : permissions["maintain"] === true || permissions["push"] === true
        ? "participate"
        : "watch"
  return {
    provider: "github",
    account,
    repository: {
      id: String(repository.id),
      name: repository.name,
      fullName: repository.full_name,
      private: repository.private,
      defaultBranch: repository.default_branch,
      webUrl: repository.html_url,
    },
    access,
  }
}

function nextPage(link: string | null, origin: URL): URL | null {
  if (link === null) return null
  for (const part of link.split(",")) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/)
    if (match?.[2] !== "next") continue
    const next = new URL(match[1] ?? "", origin)
    if (next.origin !== origin.origin) throw invalidGitHubResponse("pagination")
    return next
  }
  return null
}

function invalidGitHubResponse(operation: string): RepositoryDirectoryError {
  return new RepositoryDirectoryError({
    provider: "github",
    operation,
    retryable: true,
    message: "GitHub returned an invalid repository directory response",
  })
}
