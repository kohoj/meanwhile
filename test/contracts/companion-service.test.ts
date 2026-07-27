import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type CompanionCommandRunner,
  CompanionProfileStore,
  createCompanionProfile,
  MacOSCompanionService,
  MacOSKeychainCompanionCredentials,
  renderLaunchAgentPlist,
} from "../../src/connectors/companion-service"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("macOS Companion service", () => {
  test("stores a secret-free private profile and LaunchAgent with Keychain custody", async () => {
    const root = await temporaryRoot()
    const transcriptPath = join(root, "session.jsonl")
    await writeFile(transcriptPath, "{}\n")
    const secret = `mwd_${"a".repeat(12)}_${"b".repeat(43)}`
    const fake = new FakeMacOS(secret)
    const profiles = new CompanionProfileStore(join(root, "state"))
    const service = new MacOSCompanionService(
      profiles,
      new MacOSKeychainCompanionCredentials(fake.run),
      ["/opt/meanwhile/bin/bun", "/opt/meanwhile/src/cli.ts"],
      join(root, "LaunchAgents"),
      501,
      fake.run,
    )
    const profile = createCompanionProfile({
      source: "codex",
      projectId: "00000000-0000-4000-8000-000000000006",
      transcriptPath,
      sourceConversationId: "codex-session-1",
      stateRoot: profiles.root,
      baseUrl: "https://meanwhile.example",
      title: "Selected local conversation",
      now: new Date("2026-07-27T00:00:00.000Z"),
    })

    const installed = await service.install(profile, secret)
    expect(installed).toMatchObject({ installed: true, loaded: true, processState: "running" })
    expect(installed.processId).toBe(4242)

    const profilePath = profiles.profilePath(profile.id)
    const plistPath = service.plistPath(profile.id)
    expect((await stat(profilePath)).mode & 0o777).toBe(0o600)
    expect((await stat(profiles.directory(profile.id))).mode & 0o777).toBe(0o700)
    expect((await stat(plistPath)).mode & 0o777).toBe(0o600)
    expect(
      `${await readFile(profilePath, "utf8")}\n${await readFile(plistPath, "utf8")}`,
    ).not.toContain(secret)
    expect(fake.keychainInput).toBe(`${secret}\n`)
    expect(fake.commands.some((argv) => argv.includes(secret))).toBeFalse()
    expect(await readFile(plistPath, "utf8")).toContain(
      `<string>${profiles.profilePath(profile.id)}</string>`,
    )

    await profiles.writeStatus({
      version: 1,
      profileId: profile.id,
      phase: "following",
      updatedAt: "2026-07-27T00:01:00.000Z",
      mirrorId: "mirror-1",
      acceptedSequence: 42,
      issueCodes: ["source_lagging"],
      errorCode: null,
    })
    const paused = await service.pause(profile.id)
    expect(paused).toMatchObject({ installed: true, loaded: false })
    expect(paused.runtime).toMatchObject({
      phase: "paused",
      mirrorId: "mirror-1",
      acceptedSequence: 42,
      issueCodes: ["source_lagging"],
    })
    expect((await service.resume(profile.id)).loaded).toBeTrue()

    await writeFile(profile.statePath, "preserved")
    const receipt = await service.uninstall(profile.id)
    expect(receipt.statePath).toBe(profile.statePath)
    expect(await Bun.file(profile.statePath).text()).toBe("preserved")
    expect(await profiles.read(profile.id)).toBeNull()
    expect(fake.deletedCredential).toBeTrue()
  })

  test("derives a stable profile identity and refuses silent rebinding", async () => {
    const root = await temporaryRoot()
    const profiles = new CompanionProfileStore(join(root, "state"))
    const input = {
      source: "claude-code" as const,
      projectId: "project-1",
      transcriptPath: join(root, "conversation.jsonl"),
      sourceConversationId: "claude-session-1",
      stateRoot: profiles.root,
      baseUrl: "http://127.0.0.1:7331",
    }
    const first = createCompanionProfile({ ...input, now: new Date("2026-07-27T00:00:00Z") })
    const retried = createCompanionProfile({ ...input, now: new Date("2026-07-28T00:00:00Z") })
    expect(retried.id).toBe(first.id)
    expect(retried.sourceConversationId).toBe("claude-session-1")
    expect(
      createCompanionProfile({ ...input, sourceConversationId: "another-session" }).id,
    ).not.toBe(first.id)
    await profiles.write(first)
    await profiles.write(retried)

    await expect(profiles.write({ ...retried, projectId: "project-2" })).rejects.toThrow(
      "already bound",
    )
  })

  test("renders argv as plist data without shell interpolation", () => {
    const plist = renderLaunchAgentPlist({
      label: `dev.meanwhile.companion.${"a".repeat(24)}`,
      programArguments: ["/opt/Bun & Sons/bun", "/tmp/<cli>.ts", "companion", "daemon"],
      stdoutPath: "/tmp/meanwhile out.log",
      stderrPath: "/tmp/meanwhile error.log",
    })
    expect(plist).toContain("/opt/Bun &amp; Sons/bun")
    expect(plist).toContain("/tmp/&lt;cli&gt;.ts")
    expect(plist).not.toContain("mwd_")
  })

  test.skipIf(process.platform !== "darwin")(
    "emits a LaunchAgent accepted by the native plist parser",
    async () => {
      const root = await temporaryRoot()
      const path = join(root, "companion.plist")
      await writeFile(
        path,
        renderLaunchAgentPlist({
          label: `dev.meanwhile.companion.${"b".repeat(24)}`,
          programArguments: ["/opt/meanwhile/bin/bun", "/opt/meanwhile/src/cli.ts"],
          stdoutPath: join(root, "stdout.log"),
          stderrPath: join(root, "stderr.log"),
        }),
      )
      const process = Bun.spawn(["/usr/bin/plutil", "-lint", path], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ])
      expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0, stderr: "" })
    },
  )
})

class FakeMacOS {
  loaded = false
  deletedCredential = false
  keychainInput = ""
  readonly commands: string[][] = []

  constructor(private readonly secret: string) {}

  readonly run: CompanionCommandRunner = async (argv, input) => {
    this.commands.push([...argv])
    if (argv[0] === "/usr/bin/security") {
      if (argv[1] === "add-generic-password") {
        this.keychainInput = input ?? ""
        return { exitCode: 0, stdout: "", stderr: "" }
      }
      if (argv[1] === "find-generic-password") {
        return { exitCode: 0, stdout: `${this.secret}\n`, stderr: "" }
      }
      if (argv[1] === "delete-generic-password") {
        this.deletedCredential = true
        return { exitCode: 0, stdout: "", stderr: "" }
      }
    }
    if (argv[0] === "/bin/launchctl") {
      if (argv[1] === "bootstrap") {
        this.loaded = true
        return { exitCode: 0, stdout: "", stderr: "" }
      }
      if (argv[1] === "bootout") {
        if (!this.loaded) {
          return { exitCode: 3, stdout: "", stderr: "Could not find specified service" }
        }
        this.loaded = false
        return { exitCode: 0, stdout: "", stderr: "" }
      }
      if (argv[1] === "print") {
        return this.loaded
          ? { exitCode: 0, stdout: "state = running\npid = 4242\n", stderr: "" }
          : { exitCode: 113, stdout: "", stderr: "Could not find service" }
      }
    }
    throw new Error(`Unexpected command: ${argv.join(" ")}`)
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meanwhile-companion-service-"))
  roots.push(root)
  await mkdir(root, { recursive: true })
  return root
}
