import { copyFile, mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)))
const outputDirectory = join(repositoryRoot, "providers/cloudflare-sandbox/.runner")
const manifest = (await Bun.file(join(repositoryRoot, "package.json")).json()) as unknown
const packageManager =
  typeof manifest === "object" && manifest !== null
    ? Reflect.get(manifest, "packageManager")
    : undefined
const match =
  typeof packageManager === "string" ? /^bun@(\d+\.\d+\.\d+)$/.exec(packageManager) : null
if (match === null) throw new Error("Root packageManager must pin an exact Bun version")
const version = match[1] as string
if (Bun.version !== version) {
  throw new Error(`Cloudflare runner staging requires Bun ${version}, received ${Bun.version}`)
}

const target = `bun-linux-x64-baseline-v${version}`
await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })

for (const [entrypoint, output] of [
  ["runner/main.ts", "meanwhile-runner"],
  ["test/fixtures/acp-agent.ts", "meanwhile-demo-agent"],
] as const) {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "build",
      join(repositoryRoot, entrypoint),
      "--compile",
      `--target=${target}`,
      "--minify",
      `--outfile=${join(outputDirectory, output)}`,
    ],
    cwd: repositoryRoot,
    stdout: "inherit",
    stderr: "inherit",
  })
  if ((await child.exited) !== 0) throw new Error(`Failed to stage ${output}`)
}

await Promise.all([
  copyFile(join(repositoryRoot, "LICENSE"), join(outputDirectory, "LICENSE")),
  copyFile(
    join(repositoryRoot, "THIRD_PARTY_NOTICES"),
    join(outputDirectory, "THIRD_PARTY_NOTICES"),
  ),
  Bun.write(join(outputDirectory, "BUN_VERSION"), `${version}\n`),
])
