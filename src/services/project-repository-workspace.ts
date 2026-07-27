import type { ProjectRepositoryBinding, WorkspaceSource } from "../domain"
import { AppError } from "../errors"
import { sameGitHubRepository } from "../github-repository"
import type { UploadedFilesWorkspaceSource } from "./run-service"

/**
 * A GitHub-backed Project owns one repository identity. Callers may select a
 * revision, but they may not redirect Project work to another repository.
 */
export function lockWorkspaceToProjectRepository(
  binding: ProjectRepositoryBinding,
  workspace: WorkspaceSource | UploadedFilesWorkspaceSource,
): WorkspaceSource {
  if (
    workspace.type !== "repository" ||
    !sameGitHubRepository(workspace.url, binding.repositoryUrl)
  ) {
    throw new AppError({
      code: "PROJECT_REPOSITORY_MISMATCH",
      status: 409,
      message: "Work must use the GitHub repository bound to this Project",
      details: { projectId: binding.projectId, repositoryId: binding.repositoryId },
    })
  }
  return { ...workspace, url: binding.repositoryUrl }
}
