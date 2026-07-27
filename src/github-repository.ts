const GITHUB_HOST = "github.com"

/**
 * Returns GitHub's stable human repository coordinate (`owner/name`) from a
 * browser or git remote URL. Repository IDs remain the durable authority; this
 * parser is only for preventing a caller-selected workspace from drifting away
 * from the bound repository.
 */
export function githubRepositoryFullNameFromUrl(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.includes("\0")) return null

  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed)
  if (scp !== null) return normalizeFullName(`${scp[1]}/${scp[2]}`)

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.hostname.toLowerCase() !== GITHUB_HOST || url.search !== "" || url.hash !== "") {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "ssh:" && url.protocol !== "git:") {
    return null
  }
  const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "")
  return normalizeFullName(path)
}

export function sameGitHubRepository(left: string, right: string): boolean {
  const leftName = githubRepositoryFullNameFromUrl(left)
  const rightName = githubRepositoryFullNameFromUrl(right)
  return leftName !== null && leftName === rightName
}

export function normalizeGitHubRepositoryFullName(value: string): string | null {
  return normalizeFullName(
    value
      .trim()
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, ""),
  )
}

function normalizeFullName(value: string): string | null {
  const parts = value.split("/")
  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        part.length === 0 ||
        part.length > 255 ||
        !/^[A-Za-z0-9_.-]+$/.test(part) ||
        part === "." ||
        part === "..",
    )
  ) {
    return null
  }
  return `${parts[0]}/${parts[1]}`.toLowerCase()
}
