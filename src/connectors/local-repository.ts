import { resolve } from "node:path"
import {
  githubRepositoryFullNameFromUrl,
  normalizeGitHubRepositoryFullName,
} from "../github-repository"
import type { LocalConversation } from "./transcript-discovery"

export interface LocalRepositoryCommandResult {
  readonly exitCode: number
  readonly stdout: string
}

export type LocalRepositoryCommand = (
  argv: readonly string[],
) => Promise<LocalRepositoryCommandResult>

/**
 * Proves locally that the selected source conversation is running inside the
 * GitHub repository represented by the approved Project. No local path or git
 * remote is sent to the control plane.
 */
export async function requireConversationRepository(
  conversation: LocalConversation,
  repositoryFullName: string,
  run: LocalRepositoryCommand = runGit,
): Promise<void> {
  const expected = normalizeGitHubRepositoryFullName(repositoryFullName)
  if (expected === null) throw new Error("Project GitHub repository identity is invalid")
  const rootResult = await run([
    "git",
    "-C",
    resolve(conversation.workspacePath),
    "rev-parse",
    "--show-toplevel",
  ])
  const root = rootResult.stdout.trim()
  if (rootResult.exitCode !== 0 || !root.startsWith("/")) {
    throw new Error("Selected conversation is not attached to a Git repository")
  }
  const remoteResult = await run(["git", "-C", resolve(root), "remote", "get-url", "origin"])
  const actual =
    remoteResult.exitCode === 0 ? githubRepositoryFullNameFromUrl(remoteResult.stdout.trim()) : null
  if (actual === null) {
    throw new Error("Selected conversation has no supported GitHub origin")
  }
  if (actual !== expected) {
    throw new Error(
      `Selected conversation belongs to ${actual}, not the approved Project repository ${expected}`,
    )
  }
}

async function runGit(argv: readonly string[]): Promise<LocalRepositoryCommandResult> {
  const process = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
  const [stdout, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ])
  return { stdout, exitCode }
}
