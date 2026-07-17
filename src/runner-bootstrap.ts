import { rename } from "node:fs/promises"
import { join, resolve } from "node:path"
import { DEFAULT_RUNNER_PATH } from "./config"

/**
 * The standalone runner is a compiled artifact under `dist/`, not a committed
 * or published file. A published package therefore ships the runner source but
 * not its binary, and modern package managers block dependency `postinstall`
 * scripts by default, so the binary cannot be produced at install time.
 *
 * This module produces it on first use instead: when the control plane is asked
 * to start against the default runner path and that binary is absent, it is
 * compiled once from the in-tree source before the runner path is consumed.
 *
 * Scope is deliberately narrow. A caller that overrides `MEANWHILE_RUNNER_PATH`
 * to a non-default location has taken ownership of provisioning that file, so a
 * missing binary there is a configuration error surfaced by the normal runner
 * path check — never a silent rebuild at an operator-chosen location.
 */

const packageRoot = resolve(import.meta.dir, "..")
const defaultRunnerPath = resolve(packageRoot, DEFAULT_RUNNER_PATH)
const runnerSource = join(packageRoot, "runner", "main.ts")

/** Whether `runnerPath` is the built-in default location this module manages. */
export const isDefaultRunnerPath = (runnerPath: string): boolean =>
  resolve(runnerPath) === defaultRunnerPath

/**
 * Ensure the compiled runner exists at the default path, building it once if it
 * does not. No-ops when the runner already exists or when a non-default path is
 * configured. Returns the absolute path that is now guaranteed present, or the
 * unchanged input for a caller-owned path.
 */
export const ensureDefaultRunnerBuilt = async (runnerPath: string): Promise<string> => {
  if (!isDefaultRunnerPath(runnerPath)) return runnerPath
  if (await Bun.file(defaultRunnerPath).exists()) return defaultRunnerPath

  if (!(await Bun.file(runnerSource).exists())) {
    throw new Error(
      `Cannot build the Meanwhile runner: source is missing at ${runnerSource}. ` +
        "Reinstall the package or build it explicitly with `bun run runner:build`.",
    )
  }

  // Compile to a sibling temp path, then atomically move it into place so a
  // concurrent start can never observe a partially written executable. This is
  // the same `bun build --compile` invocation as the `runner:build` script, so
  // published and from-source builds stay identical.
  const temporaryPath = `${defaultRunnerPath}.building-${process.pid}`
  const build = Bun.spawn({
    cmd: ["bun", "build", runnerSource, "--compile", "--minify", "--outfile", temporaryPath],
    cwd: packageRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  const exitCode = await build.exited
  if (exitCode !== 0) {
    const reason = (await new Response(build.stderr).text()).trim()
    throw new Error(`Failed to build the Meanwhile runner${reason ? `: ${reason}` : ""}.`)
  }
  await rename(temporaryPath, defaultRunnerPath)
  return defaultRunnerPath
}
