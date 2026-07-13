import { isSafeRepositoryRevision, type WorkspaceSource } from "../domain"
import { AppError } from "../errors"
import {
  type ProcessEvent,
  type ProcessSpec,
  type RuntimeFile,
  type RuntimeHandle,
  type RuntimeProvider,
  relativePath,
} from "../providers/runtime-provider"

export interface WorkspaceBundleReader {
  read(ownerId: string, artifactId: string): Promise<readonly RuntimeFile[]>
}

export interface WorkspacePreparationLog {
  readonly stream: ProcessEvent["stream"]
  readonly event: "workspace.command"
  readonly data: string
  readonly timestamp: string
}

export interface PrepareWorkspaceInput {
  readonly ownerId: string
  readonly runId: string
  readonly source: WorkspaceSource
  readonly provider: RuntimeProvider
  readonly runtime: RuntimeHandle
  readonly repositoryCredential?: string
  readonly timeoutMs: number
  readonly terminationGraceMs: number
  readonly emit: (log: WorkspacePreparationLog) => Promise<void>
}

export interface PreparedWorkspace {
  readonly resolvedRevision: string | null
}

/** Converts immutable user input into one provider-relative workspace. */
export class WorkspacePreparer {
  constructor(private readonly bundles: WorkspaceBundleReader) {}

  async prepare(input: PrepareWorkspaceInput): Promise<PreparedWorkspace> {
    if (input.source.type === "bundle") {
      const files = await this.bundles.read(input.ownerId, input.source.artifactId)
      await input.provider.writeFiles(input.runtime, files)
      return { resolvedRevision: null }
    }

    const revision = input.source.revision ?? "HEAD"
    if (!isSafeRepositoryRevision(revision)) {
      throw new AppError({
        code: "INVALID_REQUEST",
        message: "Repository revision must be a literal branch, tag, or commit name",
      })
    }

    const environment: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" }
    if (input.repositoryCredential !== undefined) {
      if (!input.source.url.startsWith("https://")) {
        throw new AppError({
          code: "INVALID_REQUEST",
          message: "Repository credentials are supported only for HTTPS repositories",
        })
      }
      environment["GIT_CONFIG_COUNT"] = "1"
      environment["GIT_CONFIG_KEY_0"] = "http.extraHeader"
      environment["GIT_CONFIG_VALUE_0"] = `Authorization: Bearer ${input.repositoryCredential}`
    }

    const prefix = input.runId.replaceAll(/[^A-Za-z0-9_-]/g, "-").slice(0, 80)
    await this.command(input, `${prefix}-git-init`, ["git", "init", "--quiet", "."], environment)
    await this.command(
      input,
      `${prefix}-git-remote`,
      ["git", "remote", "add", "origin", input.source.url],
      environment,
    )
    await this.command(
      input,
      `${prefix}-git-fetch`,
      ["git", "fetch", "--quiet", "--depth=1", "--", "origin", revision],
      environment,
    )
    await this.command(
      input,
      `${prefix}-git-checkout`,
      ["git", "checkout", "--quiet", "--detach", "FETCH_HEAD"],
      environment,
    )
    const resolved = await this.command(
      input,
      `${prefix}-git-revision`,
      ["git", "rev-parse", "HEAD"],
      { GIT_TERMINAL_PROMPT: "0" },
    )
    const resolvedRevision = resolved.stdout.trim()
    if (!/^[0-9a-f]{40,64}$/i.test(resolvedRevision)) {
      throw new AppError({
        code: "PROVIDER_UNAVAILABLE",
        message: "Repository checkout did not produce a valid commit",
        retryable: false,
      })
    }
    return { resolvedRevision }
  }

  private async command(
    input: PrepareWorkspaceInput,
    processId: string,
    argv: readonly [string, ...string[]],
    env: Readonly<Record<string, string>>,
  ): Promise<{ stdout: string }> {
    const spec: ProcessSpec = {
      processId,
      argv,
      cwd: relativePath("."),
      env,
      timeoutMs: input.timeoutMs,
      terminationGraceMs: input.terminationGraceMs,
    }
    const process = await input.provider.spawn(input.runtime, spec)
    let stdout = ""
    const consume = async () => {
      for await (const event of input.provider.events(process, null)) {
        if (event.stream === "stdout") stdout += event.data
        await input.emit({
          stream: event.stream,
          event: "workspace.command",
          data: event.data,
          timestamp: event.timestamp,
        })
      }
    }
    const [exit] = await Promise.all([input.provider.wait(process), consume()])
    if (exit.exitCode !== 0) {
      throw new AppError({
        code: "PROVIDER_UNAVAILABLE",
        message: "Workspace preparation command failed",
        retryable: false,
        details: { operation: processId, exitCode: exit.exitCode ?? -1 },
      })
    }
    return { stdout }
  }
}
