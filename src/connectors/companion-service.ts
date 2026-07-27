import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { ConnectorSource } from "../domain"

const PROFILE_VERSION = 2 as const
const KEYCHAIN_SERVICE = "dev.meanwhile.companion"
const LABEL_PREFIX = "dev.meanwhile.companion"

export interface CompanionProfile {
  readonly version: typeof PROFILE_VERSION
  readonly id: string
  readonly source: ConnectorSource
  readonly projectId: string
  readonly transcriptPath: string
  readonly sourceConversationId: string
  readonly statePath: string
  readonly baseUrl: string
  readonly title: string | null
  readonly createdAt: string
}

export type CompanionRuntimePhase =
  | "starting"
  | "following"
  | "caught_up"
  | "blocked"
  | "retrying"
  | "paused"

export interface CompanionRuntimeStatus {
  readonly version: 1
  readonly profileId: string
  readonly phase: CompanionRuntimePhase
  readonly updatedAt: string
  readonly mirrorId: string | null
  readonly acceptedSequence: number
  readonly issueCodes: readonly string[]
  readonly errorCode: string | null
}

export interface CompanionServiceStatus {
  readonly profile: CompanionProfile
  readonly installed: boolean
  readonly loaded: boolean
  readonly processState: string | null
  readonly processId: number | null
  readonly runtime: CompanionRuntimeStatus | null
}

export interface CompanionCommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type CompanionCommandRunner = (
  argv: readonly string[],
  input?: string,
) => Promise<CompanionCommandResult>

export class CompanionProfileStore {
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  async write(profile: CompanionProfile): Promise<string> {
    validateProfile(profile)
    const directory = this.directory(profile.id)
    await ensurePrivateDirectory(directory)
    const path = this.profilePath(profile.id)
    const existing = await this.read(profile.id)
    if (existing !== null && canonicalProfile(existing) !== canonicalProfile(profile)) {
      throw new Error("Companion profile identity is already bound to different settings")
    }
    await atomicPrivateWrite(path, `${JSON.stringify(profile, null, 2)}\n`)
    return path
  }

  async read(id: string): Promise<CompanionProfile | null> {
    assertProfileId(id)
    try {
      const profile = JSON.parse(await readFile(this.profilePath(id), "utf8")) as unknown
      return parseProfile(profile)
    } catch (error) {
      if (isFilesystemCode(error, "ENOENT")) return null
      throw error
    }
  }

  async readPath(path: string): Promise<CompanionProfile> {
    const absolute = resolve(path)
    const profile = parseProfile(JSON.parse(await readFile(absolute, "utf8")) as unknown)
    if (absolute !== this.profilePath(profile.id)) {
      throw new Error("Companion profile path does not match its identity")
    }
    return profile
  }

  async list(): Promise<readonly CompanionProfile[]> {
    let entries: string[]
    try {
      entries = await readdir(this.root)
    } catch (error) {
      if (isFilesystemCode(error, "ENOENT")) return []
      throw error
    }
    const profiles: CompanionProfile[] = []
    for (const entry of entries.sort()) {
      if (!/^[0-9a-f]{24}$/.test(entry)) continue
      const profile = await this.read(entry)
      if (profile !== null) profiles.push(profile)
    }
    return profiles
  }

  async writeStatus(status: CompanionRuntimeStatus): Promise<void> {
    assertProfileId(status.profileId)
    await ensurePrivateDirectory(this.directory(status.profileId))
    await atomicPrivateWrite(this.statusPath(status.profileId), `${JSON.stringify(status)}\n`)
  }

  async readStatus(id: string): Promise<CompanionRuntimeStatus | null> {
    assertProfileId(id)
    try {
      return parseStatus(JSON.parse(await readFile(this.statusPath(id), "utf8")) as unknown)
    } catch (error) {
      if (isFilesystemCode(error, "ENOENT")) return null
      throw error
    }
  }

  async remove(id: string, purgeState: boolean): Promise<void> {
    assertProfileId(id)
    if (purgeState) {
      await rm(this.directory(id), { recursive: true, force: true })
      return
    }
    await Promise.all([
      unlink(this.profilePath(id)).catch(ignoreMissing),
      unlink(this.statusPath(id)).catch(ignoreMissing),
    ])
  }

  directory(id: string): string {
    assertProfileId(id)
    return join(this.root, id)
  }

  profilePath(id: string): string {
    return join(this.directory(id), "profile.json")
  }

  statusPath(id: string): string {
    return join(this.directory(id), "status.json")
  }
}

export class MacOSKeychainCompanionCredentials {
  constructor(private readonly run: CompanionCommandRunner = runCompanionCommand) {}

  async set(profileId: string, secret: string): Promise<void> {
    assertProfileId(profileId)
    if (!/^mwd_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/.test(secret)) {
      throw new Error("Connector credential is invalid")
    }
    const result = await this.run(
      [
        "/usr/bin/security",
        "add-generic-password",
        "-a",
        profileId,
        "-s",
        KEYCHAIN_SERVICE,
        "-l",
        `Meanwhile companion ${profileId}`,
        "-U",
        "-T",
        "/usr/bin/security",
        "-w",
      ],
      `${secret}\n`,
    )
    if (result.exitCode !== 0)
      throw new Error("Connector credential could not be stored in Keychain")
  }

  async get(profileId: string): Promise<string> {
    assertProfileId(profileId)
    const result = await this.run([
      "/usr/bin/security",
      "find-generic-password",
      "-a",
      profileId,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ])
    const secret = result.stdout.trim()
    if (result.exitCode !== 0 || !/^mwd_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/.test(secret)) {
      throw new Error("Connector credential is unavailable in Keychain")
    }
    return secret
  }

  async remove(profileId: string): Promise<void> {
    assertProfileId(profileId)
    const result = await this.run([
      "/usr/bin/security",
      "delete-generic-password",
      "-a",
      profileId,
      "-s",
      KEYCHAIN_SERVICE,
    ])
    if (result.exitCode !== 0 && !result.stderr.includes("could not be found")) {
      throw new Error("Connector credential could not be removed from Keychain")
    }
  }
}

export class MacOSCompanionService {
  readonly launchAgentsDirectory: string

  constructor(
    readonly profiles: CompanionProfileStore,
    readonly credentials: MacOSKeychainCompanionCredentials,
    private readonly invocation: readonly [string, ...string[]],
    launchAgentsDirectory: string,
    private readonly uid: number,
    private readonly run: CompanionCommandRunner = runCompanionCommand,
  ) {
    if (!invocation.every((value) => value.startsWith("/") && !value.includes("\0"))) {
      throw new TypeError("Companion service invocation must use absolute paths")
    }
    if (!Number.isSafeInteger(uid) || uid < 0) throw new TypeError("User identifier is invalid")
    this.launchAgentsDirectory = resolve(launchAgentsDirectory)
  }

  async install(
    profile: CompanionProfile,
    connectorSecret: string,
  ): Promise<CompanionServiceStatus> {
    const profilePath = await this.profiles.write(profile)
    await this.credentials.set(profile.id, connectorSecret)
    await ensureDirectory(this.launchAgentsDirectory, false)
    const plistPath = this.plistPath(profile.id)
    await atomicPrivateWrite(
      plistPath,
      renderLaunchAgentPlist({
        label: companionServiceLabel(profile.id),
        programArguments: [...this.invocation, "companion", "daemon", "--profile", profilePath],
        stdoutPath: join(this.profiles.directory(profile.id), "companion.log"),
        stderrPath: join(this.profiles.directory(profile.id), "companion.error.log"),
      }),
      false,
    )
    await this.#bootout(plistPath)
    const result = await this.run(["/bin/launchctl", "bootstrap", this.domain(), plistPath])
    if (result.exitCode !== 0) throw new Error("Companion LaunchAgent could not be installed")
    return this.status(profile.id)
  }

  async pause(profileId: string): Promise<CompanionServiceStatus> {
    const profile = await this.requireProfile(profileId)
    await this.#bootout(this.plistPath(profile.id))
    const previous = await this.profiles.readStatus(profile.id)
    await this.profiles.writeStatus({
      version: 1,
      profileId: profile.id,
      phase: "paused",
      updatedAt: new Date().toISOString(),
      mirrorId: previous?.mirrorId ?? null,
      acceptedSequence: previous?.acceptedSequence ?? 0,
      issueCodes: previous?.issueCodes ?? [],
      errorCode: null,
    })
    return this.status(profile.id)
  }

  async resume(profileId: string): Promise<CompanionServiceStatus> {
    const profile = await this.requireProfile(profileId)
    await this.credentials.get(profile.id)
    const plistPath = this.plistPath(profile.id)
    const info = await lstat(plistPath).catch(() => null)
    if (info === null || !info.isFile() || info.isSymbolicLink()) {
      throw new Error("Companion LaunchAgent is not installed")
    }
    await this.#bootout(plistPath)
    const result = await this.run(["/bin/launchctl", "bootstrap", this.domain(), plistPath])
    if (result.exitCode !== 0) throw new Error("Companion LaunchAgent could not be resumed")
    return this.status(profile.id)
  }

  async uninstall(profileId: string, purgeState = false): Promise<{ readonly statePath: string }> {
    const profile = await this.requireProfile(profileId)
    const plistPath = this.plistPath(profile.id)
    await this.#bootout(plistPath)
    await unlink(plistPath).catch(ignoreMissing)
    await this.credentials.remove(profile.id)
    await this.profiles.remove(profile.id, purgeState)
    return { statePath: profile.statePath }
  }

  async status(profileId: string): Promise<CompanionServiceStatus> {
    const profile = await this.requireProfile(profileId)
    const plistPath = this.plistPath(profile.id)
    const installed = await lstat(plistPath)
      .then((info) => info.isFile() && !info.isSymbolicLink())
      .catch(() => false)
    const result = await this.run([
      "/bin/launchctl",
      "print",
      `${this.domain()}/${companionServiceLabel(profile.id)}`,
    ])
    return {
      profile,
      installed,
      loaded: result.exitCode === 0,
      processState: result.exitCode === 0 ? captureLaunchctlValue(result.stdout, "state") : null,
      processId:
        result.exitCode === 0
          ? parseOptionalInteger(captureLaunchctlValue(result.stdout, "pid"))
          : null,
      runtime: await this.profiles.readStatus(profile.id),
    }
  }

  async listStatus(): Promise<readonly CompanionServiceStatus[]> {
    return Promise.all((await this.profiles.list()).map((profile) => this.status(profile.id)))
  }

  plistPath(profileId: string): string {
    return join(this.launchAgentsDirectory, `${companionServiceLabel(profileId)}.plist`)
  }

  domain(): string {
    return `gui/${this.uid}`
  }

  private async requireProfile(profileId: string): Promise<CompanionProfile> {
    const profile = await this.profiles.read(profileId)
    if (profile === null) throw new Error("Companion profile not found")
    return profile
  }

  async #bootout(plistPath: string): Promise<void> {
    const result = await this.run(["/bin/launchctl", "bootout", this.domain(), plistPath])
    if (
      result.exitCode !== 0 &&
      !result.stderr.includes("Could not find specified service") &&
      !result.stderr.includes("No such process")
    ) {
      throw new Error("Companion LaunchAgent could not be stopped")
    }
  }
}

export function createCompanionProfile(input: {
  readonly source: ConnectorSource
  readonly projectId: string
  readonly transcriptPath: string
  readonly sourceConversationId: string
  readonly stateRoot: string
  readonly baseUrl: string | URL
  readonly title?: string
  readonly now?: Date
}): CompanionProfile {
  const transcriptPath = resolve(input.transcriptPath)
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const id = new Bun.CryptoHasher("sha256")
    .update(
      `${baseUrl}\0${input.source}\0${input.projectId}\0${input.sourceConversationId}\0${transcriptPath}`,
    )
    .digest("hex")
    .slice(0, 24)
  return {
    version: PROFILE_VERSION,
    id,
    source: input.source,
    projectId: input.projectId,
    transcriptPath,
    sourceConversationId: input.sourceConversationId,
    statePath: join(resolve(input.stateRoot), id, "outbox.sqlite"),
    baseUrl,
    title: input.title?.trim() || null,
    createdAt: (input.now ?? new Date()).toISOString(),
  }
}

export function companionServiceLabel(profileId: string): string {
  assertProfileId(profileId)
  return `${LABEL_PREFIX}.${profileId}`
}

export function renderLaunchAgentPlist(input: {
  readonly label: string
  readonly programArguments: readonly string[]
  readonly stdoutPath: string
  readonly stderrPath: string
}): string {
  if (!/^dev\.meanwhile\.companion\.[0-9a-f]{24}$/.test(input.label)) {
    throw new TypeError("Companion LaunchAgent label is invalid")
  }
  if (
    input.programArguments.length === 0 ||
    input.programArguments.some((value) => value.includes("\0"))
  ) {
    throw new TypeError("Companion LaunchAgent arguments are invalid")
  }
  const argumentsXml = input.programArguments
    .map((value) => `      <string>${escapeXml(value)}</string>`)
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(input.label)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(resolve(input.stdoutPath))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(resolve(input.stderrPath))}</string>
  </dict>
</plist>
`
}

export const runCompanionCommand: CompanionCommandRunner = async (argv, input) => {
  const process = Bun.spawn([...argv], {
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (input !== undefined) {
    const stdin = process.stdin
    if (stdin === undefined) throw new Error("Companion command stdin is unavailable")
    stdin.write(input)
    stdin.end()
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { exitCode, stdout, stderr }
}

function validateProfile(profile: CompanionProfile): void {
  assertProfileId(profile.id)
  if (profile.version !== PROFILE_VERSION)
    throw new Error("Companion profile version is unsupported")
  if (profile.source !== "codex" && profile.source !== "claude-code") {
    throw new Error("Companion profile source is invalid")
  }
  if (profile.projectId.length === 0 || profile.projectId.length > 200) {
    throw new Error("Companion profile Project is invalid")
  }
  if (profile.sourceConversationId.length === 0 || profile.sourceConversationId.length > 500) {
    throw new Error("Companion profile source conversation is invalid")
  }
  if (!profile.transcriptPath.startsWith("/") || !profile.statePath.startsWith("/")) {
    throw new Error("Companion profile paths must be absolute")
  }
  normalizeBaseUrl(profile.baseUrl)
  if (profile.title !== null && (profile.title.length === 0 || profile.title.length > 500)) {
    throw new Error("Companion profile title is invalid")
  }
  if (!Number.isFinite(new Date(profile.createdAt).getTime())) {
    throw new Error("Companion profile creation time is invalid")
  }
}

function parseProfile(value: unknown): CompanionProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Companion profile is invalid")
  }
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate).sort().join(",")
  if (
    keys !==
    "baseUrl,createdAt,id,projectId,source,sourceConversationId,statePath,title,transcriptPath,version"
  ) {
    throw new Error("Companion profile contains unsupported fields")
  }
  const profile = candidate as unknown as CompanionProfile
  validateProfile(profile)
  return profile
}

function parseStatus(value: unknown): CompanionRuntimeStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Companion runtime status is invalid")
  }
  const candidate = value as Record<string, unknown>
  const phases: readonly CompanionRuntimePhase[] = [
    "starting",
    "following",
    "caught_up",
    "blocked",
    "retrying",
    "paused",
  ]
  if (
    candidate["version"] !== 1 ||
    typeof candidate["profileId"] !== "string" ||
    !phases.includes(candidate["phase"] as CompanionRuntimePhase) ||
    typeof candidate["updatedAt"] !== "string" ||
    (candidate["mirrorId"] !== null && typeof candidate["mirrorId"] !== "string") ||
    !Number.isSafeInteger(candidate["acceptedSequence"]) ||
    (candidate["acceptedSequence"] as number) < 0 ||
    !Array.isArray(candidate["issueCodes"]) ||
    !(candidate["issueCodes"] as unknown[]).every((item) => typeof item === "string") ||
    (candidate["errorCode"] !== null && typeof candidate["errorCode"] !== "string")
  ) {
    throw new Error("Companion runtime status is invalid")
  }
  assertProfileId(candidate["profileId"])
  return candidate as unknown as CompanionRuntimeStatus
}

function canonicalProfile(profile: CompanionProfile): string {
  return JSON.stringify({ ...profile, createdAt: null })
}

function normalizeBaseUrl(value: string | URL): string {
  const url = new URL(value)
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("Companion base URL must be a plain HTTP origin")
  }
  url.pathname = "/"
  return url.toString()
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await ensureDirectory(path, true)
}

async function ensureDirectory(path: string, forcePrivateMode: boolean): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Companion state path is not a private directory")
  }
  if (forcePrivateMode) await chmod(path, 0o700)
}

async function atomicPrivateWrite(
  path: string,
  content: string,
  forcePrivateDirectoryMode = true,
): Promise<void> {
  await ensureDirectory(dirname(path), forcePrivateDirectoryMode)
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" })
    await rename(temporary, path)
    await chmod(path, 0o600)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

function captureLaunchctlValue(output: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "m").exec(output)
  return match?.[1] ?? null
}

function parseOptionalInteger(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function assertProfileId(value: string): void {
  if (!/^[0-9a-f]{24}$/.test(value)) throw new Error("Companion profile identifier is invalid")
}

function isFilesystemCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

function ignoreMissing(error: unknown): void {
  if (!isFilesystemCode(error, "ENOENT")) throw error
}
