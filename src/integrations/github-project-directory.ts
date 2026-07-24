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
const INSTALLATION_CONCURRENCY = 4

const GitHubIdentifierSchema = z.union([z.number().int().nonnegative(), z.string().min(1)])
const GitHubAccountSchema = z
  .object({
    id: GitHubIdentifierSchema,
    login: z.string().min(1),
    type: z.string().min(1),
    avatar_url: z.string().url().nullable().optional(),
  })
  .passthrough()
const GitHubInstallationSchema = z
  .object({
    id: GitHubIdentifierSchema,
    account: GitHubAccountSchema,
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
    permissions: z.record(z.string(), z.boolean()).optional(),
  })
  .passthrough()
const GitHubInstallationPageSchema = z
  .object({ installations: z.array(GitHubInstallationSchema) })
  .passthrough()
const GitHubRepositoryPageSchema = z
  .object({ repositories: z.array(GitHubRepositorySchema) })
  .passthrough()

type GitHubInstallation = z.infer<typeof GitHubInstallationSchema>
type GitHubRepository = z.infer<typeof GitHubRepositorySchema>

export interface GitHubProjectDirectoryOptions {
  readonly fetch?: GitHubFetch
  readonly apiOrigin?: string
}

type GitHubFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Lists repositories visible through a GitHub App user access token. GitHub
 * applies the intersection of the App installation and the user's own access;
 * this adapter only normalizes that answer and never persists the token.
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
    const installations = await this.#listInstallations(credential, options.signal)
    const grouped = await mapWithConcurrency(
      installations,
      INSTALLATION_CONCURRENCY,
      async (installation) => {
        const repositories = await this.#listRepositories(installation, credential, options.signal)
        return repositories.map((repository) => normalizeRepository(installation, repository))
      },
    )
    return grouped
      .flat()
      .sort((left, right) => left.repository.fullName.localeCompare(right.repository.fullName))
  }

  async #listInstallations(
    credential: RepositoryDirectoryCredential,
    signal?: AbortSignal,
  ): Promise<readonly GitHubInstallation[]> {
    const items: GitHubInstallation[] = []
    let url: URL | null = new URL(`user/installations?per_page=${PAGE_SIZE}`, this.#apiOrigin)
    while (url !== null) {
      const response = await this.#request(url, credential, signal, "list_installations")
      const body = GitHubInstallationPageSchema.safeParse(await response.json().catch(() => null))
      if (!body.success) throw invalidGitHubResponse("list_installations")
      items.push(...body.data.installations)
      url = nextPage(response.headers.get("Link"), this.#apiOrigin)
    }
    return items
  }

  async #listRepositories(
    installation: GitHubInstallation,
    credential: RepositoryDirectoryCredential,
    signal?: AbortSignal,
  ): Promise<readonly GitHubRepository[]> {
    const items: GitHubRepository[] = []
    const installationId = encodeURIComponent(String(installation.id))
    let url: URL | null = new URL(
      `user/installations/${installationId}/repositories?per_page=${PAGE_SIZE}`,
      this.#apiOrigin,
    )
    while (url !== null) {
      const response = await this.#request(url, credential, signal, "list_repositories")
      const body = GitHubRepositoryPageSchema.safeParse(await response.json().catch(() => null))
      if (!body.success) throw invalidGitHubResponse("list_repositories")
      items.push(...body.data.repositories)
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

function normalizeRepository(
  installation: GitHubInstallation,
  repository: GitHubRepository,
): RepositoryDirectoryEntry {
  const account: RepositoryDirectoryAccount = {
    id: String(installation.account.id),
    login: installation.account.login,
    type: installation.account.type.toLowerCase() === "organization" ? "organization" : "user",
    avatarUrl: installation.account.avatar_url ?? null,
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
    installationId: String(installation.id),
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

async function mapWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  mapper: (input: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  const results = new Array<Output>(inputs.length)
  let index = 0
  const worker = async () => {
    while (index < inputs.length) {
      const current = index
      index += 1
      const input = inputs[current]
      if (input !== undefined) results[current] = await mapper(input)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()))
  return results
}
