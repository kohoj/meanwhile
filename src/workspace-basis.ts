import type { WorkspaceBasis, WorkspaceRelationship, WorkspaceSource } from "./domain"

/** Removes credential references while preserving the workspace identity. */
export const workspaceBasis = (
  source: WorkspaceSource,
  resolvedRevision: string | null,
): WorkspaceBasis =>
  source.type === "bundle"
    ? { type: "bundle", artifactId: source.artifactId }
    : {
        type: "repository",
        url: source.url,
        requestedRevision: source.revision ?? null,
        resolvedRevision,
      }

/**
 * Classifies provenance conservatively. Repository URLs must match exactly;
 * aliases are not guessed because a false "same repository" claim is worse
 * than asking the agent to revalidate transferable evidence.
 */
export const workspaceRelationship = (
  source: WorkspaceBasis | null,
  current: WorkspaceBasis,
): WorkspaceRelationship => {
  if (source === null) return "unknown"
  if (source.type === "bundle" || current.type === "bundle") {
    return source.type === "bundle" &&
      current.type === "bundle" &&
      source.artifactId === current.artifactId
      ? "exact"
      : "different_workspace"
  }
  if (source.url !== current.url) return "different_workspace"
  if (source.resolvedRevision === null || current.resolvedRevision === null) {
    return "same_repository_unresolved"
  }
  return source.resolvedRevision.toLowerCase() === current.resolvedRevision.toLowerCase()
    ? "exact"
    : "same_repository_changed"
}

export const sameWorkspaceBasis = (left: WorkspaceBasis, right: WorkspaceBasis): boolean => {
  if (left.type !== right.type) return false
  if (left.type === "bundle" || right.type === "bundle") {
    return left.type === "bundle" && right.type === "bundle" && left.artifactId === right.artifactId
  }
  return (
    left.url === right.url &&
    left.requestedRevision === right.requestedRevision &&
    left.resolvedRevision?.toLowerCase() === right.resolvedRevision?.toLowerCase()
  )
}
