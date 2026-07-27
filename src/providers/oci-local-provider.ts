import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, chmod, lstat, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { SERVICE_VERSION } from "../version"
import { LocalRuntimeProvider } from "./local-provider"
import {
  assertRuntimeId,
  type CreateRuntimeInput,
  type EventCursor,
  type ListRuntimeFilesOptions,
  type ProcessEvent,
  type ProcessExit,
  type ProcessHandle,
  type ProcessSignal,
  type ProcessSpec,
  type ProcessState,
  type ProviderHealth,
  processHandle,
  processHardTimeoutMs,
  processSpecFingerprint,
  type ReadRuntimeFileOptions,
  type RelativePath,
  type RuntimeFile,
  type RuntimeFileInfo,
  type RuntimeHandle,
  type RuntimeProvider,
  RuntimeProviderError,
  type RuntimeProviderOperation,
  type RuntimeState,
  relativePath,
  runtimeHandle,
} from "./runtime-provider"

const PROVIDER_NAME = "oci-local"
const STATE_VERSION = 1 as const
const DEFAULT_POLL_INTERVAL_MS = 50
const DEFAULT_STOP_GRACE_MS = 5_000
const DEFAULT_LOG_BYTES = 32 * 1024 * 1024
const OUTPUT_CHUNK_BYTES = 64 * 1024
const MAX_COMMAND_OUTPUT_BYTES = 70 * 1024 * 1024
const MAX_ENVIRONMENT_ENTRIES = 128
const MAX_ENVIRONMENT_NAME_BYTES = 256
const MAX_ENVIRONMENT_VALUE_BYTES = 64 * 1024
const MAX_ENVIRONMENT_BYTES = 1024 * 1024
const LABEL_PREFIX = "dev.meanwhile.oci-local"

interface ProcessIdentity {
  readonly runtimeId: string
  readonly processId: string
}

interface ProcessMetadata {
  readonly version: typeof STATE_VERSION
  readonly runtimeId: string
  readonly processId: string
  readonly specFingerprint: string
  readonly containerName: string
  readonly hardDeadline: string | null
  readonly createdAt: string
}

interface SignalReceipt {
  readonly signal: ProcessSignal
  readonly timedOut: boolean
  readonly acceptedAt: string
}

interface OciCursor {
  stdout: number
  stderr: number
}

interface CommandResult {
  readonly exitCode: number
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
}

export interface OciCommandExecutor {
  run(argv: readonly string[]): Promise<CommandResult>
  startAttached(argv: readonly string[], initialStdin: string): Promise<void>
}

export interface OciLocalRuntimeProviderOptions {
  /** Host state and bind-mounted workspaces. Keep this beneath a Docker-shared directory. */
  readonly rootDirectory: string
  /** Exact local image reference. The provider never pulls implicitly. */
  readonly imageReference: string
  /** Optional image ID assertion returned by `docker image inspect`, including `sha256:`. */
  readonly imageDigest?: string
  /** Digest of the runner installed in the image, without a `sha256:` prefix. */
  readonly runnerDigest?: string
  readonly engineExecutable?: string
  readonly commandExecutor?: OciCommandExecutor
  readonly idleArgv?: readonly [string, ...string[]]
  readonly containerUser?: string
  readonly memoryLimit?: string
  readonly cpuLimit?: string
  readonly pidsLimit?: number
  readonly logBytes?: number
  readonly pollIntervalMs?: number
  readonly stopGraceMs?: number
  readonly maxReadBytes?: number
}

/**
 * A local OCI provider backed by a Docker-compatible CLI (Docker Desktop or
 * Colima). Each process is its own container and shares only the runtime's
 * bind-mounted workspace. The adapter always disables container networking,
 * but does not claim exact-host policy or credential mediation.
 */
export class OciLocalRuntimeProvider implements RuntimeProvider {
  readonly name = PROVIDER_NAME
  readonly capabilities = Object.freeze({
    isolation: "container" as const,
    processRecovery: true,
    eventReplay: true,
    processInput: false,
    portExposure: false,
    networkPolicy: false,
    credentialMediation: "none" as const,
    processSignals: Object.freeze(["SIGINT", "SIGTERM", "SIGKILL"] as const),
  })
  readonly provenance: RuntimeProvider["provenance"]

  readonly #rootDirectory: string
  readonly #imageReference: string
  readonly #imageDigest: string | null
  readonly #engineExecutable: string
  readonly #executor: OciCommandExecutor
  readonly #workspace: LocalRuntimeProvider
  readonly #idleArgv: readonly [string, ...string[]]
  readonly #containerUser: string | null
  readonly #memoryLimit: string
  readonly #cpuLimit: string
  readonly #pidsLimit: number
  readonly #logBytes: number
  readonly #pollIntervalMs: number
  readonly #stopGraceMs: number
  readonly #timeoutTasks = new Map<string, () => void>()
  readonly #signalTasks = new Map<string, Promise<void>>()

  constructor(options: OciLocalRuntimeProviderOptions) {
    if (options.rootDirectory.length === 0 || options.rootDirectory.includes("\0")) {
      throw new TypeError("rootDirectory is required and must be NUL-free")
    }
    if (options.rootDirectory.includes(",") || options.rootDirectory.includes("\n")) {
      throw new TypeError("rootDirectory must be safe for an OCI bind-mount argument")
    }
    if (!/^\S{1,512}$/.test(options.imageReference)) {
      throw new TypeError("imageReference must be a non-empty OCI image reference")
    }
    if (options.imageDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(options.imageDigest)) {
      throw new TypeError("imageDigest must be a sha256: digest")
    }
    if (options.runnerDigest !== undefined && !/^[a-f0-9]{64}$/.test(options.runnerDigest)) {
      throw new TypeError("runnerDigest must be a SHA-256 digest")
    }
    const engineExecutable = options.engineExecutable ?? "docker"
    if (
      engineExecutable.length === 0 ||
      engineExecutable.includes("\0") ||
      (engineExecutable.includes("/") && !isAbsolute(engineExecutable))
    ) {
      throw new TypeError("engineExecutable must be a bare executable or absolute path")
    }
    const idleArgv = options.idleArgv ?? ["bun", "--eval", "setInterval(() => {}, 2 ** 30)"]
    validateArgv(idleArgv)
    if (
      options.containerUser !== undefined &&
      !/^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/.test(options.containerUser)
    ) {
      throw new TypeError("containerUser is invalid")
    }

    this.#rootDirectory = resolve(options.rootDirectory)
    this.#imageReference = options.imageReference
    this.#imageDigest = options.imageDigest ?? null
    this.#engineExecutable = engineExecutable
    this.#executor = options.commandExecutor ?? new BunOciCommandExecutor(engineExecutable)
    this.#idleArgv = [...idleArgv]
    this.#containerUser = options.containerUser ?? null
    this.#memoryLimit = resourceLimit(options.memoryLimit ?? "1g", "memoryLimit")
    this.#cpuLimit = resourceLimit(options.cpuLimit ?? "2", "cpuLimit")
    this.#pidsLimit = positiveInteger(options.pidsLimit ?? 256, "pidsLimit")
    this.#logBytes = positiveInteger(options.logBytes ?? DEFAULT_LOG_BYTES, "logBytes")
    this.#pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    )
    this.#stopGraceMs = positiveInteger(options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS, "stopGraceMs")
    this.#workspace = new LocalRuntimeProvider({
      rootDirectory: this.#rootDirectory,
      ...(options.maxReadBytes === undefined ? {} : { maxReadBytes: options.maxReadBytes }),
      pollIntervalMs: this.#pollIntervalMs,
      stopGraceMs: this.#stopGraceMs,
    })
    this.provenance = Object.freeze({
      adapterVersion: SERVICE_VERSION,
      runnerDigest: options.runnerDigest ?? null,
      runtimeImageReference: this.#imageReference,
      runtimeImageDigest: this.#imageDigest,
      bridgeProtocolVersion: null,
    })
  }

  async create(input: CreateRuntimeInput): Promise<RuntimeHandle> {
    try {
      assertRuntimeId(input.runtimeId)
    } catch (cause) {
      throw this.#error("create", "INVALID_RUNTIME_ID", "Runtime identifier is invalid", cause)
    }
    await this.#ensureImage("create")
    await this.#workspaceCall("create", () => this.#workspace.create(input))
    await mkdir(this.#ociProcessDirectory(input.runtimeId), { recursive: true, mode: 0o700 })

    const existing = await this.#inspectContainer(this.#runtimeContainer(input.runtimeId), "create")
    if (existing !== null) {
      this.#assertRuntimeContainer(existing, input.runtimeId, "create")
      return runtimeHandle(this.name, input.runtimeId)
    }

    const argv = [
      "container",
      "create",
      "--name",
      this.#runtimeContainer(input.runtimeId),
      ...this.#containerPolicyArgs(input.runtimeId, null),
      "--entrypoint",
      this.#idleArgv[0],
      this.#imageReference,
      ...this.#idleArgv.slice(1),
    ]
    const result = await this.#run(argv, "create")
    if (result.exitCode !== 0) {
      const raced = await this.#inspectContainer(this.#runtimeContainer(input.runtimeId), "create")
      if (raced !== null) {
        this.#assertRuntimeContainer(raced, input.runtimeId, "create")
        return runtimeHandle(this.name, input.runtimeId)
      }
      throw this.#commandError(
        "create",
        "RUNTIME_CREATE_FAILED",
        "OCI runtime container could not be created",
        result,
        true,
      )
    }
    return runtimeHandle(this.name, input.runtimeId)
  }

  async start(runtime: RuntimeHandle): Promise<void> {
    const runtimeId = this.#runtimeId(runtime, "start")
    const snapshot = await this.#requireRuntimeContainer(runtimeId, "start")
    if (containerRunning(snapshot)) return
    const result = await this.#run(
      ["container", "start", this.#runtimeContainer(runtimeId)],
      "start",
    )
    if (result.exitCode !== 0) {
      throw this.#commandError(
        "start",
        "RUNTIME_START_FAILED",
        "OCI runtime container could not be started",
        result,
        true,
      )
    }
    await this.#workspaceCall("start", () =>
      this.#workspace.start(runtimeHandle("local", runtimeId)),
    )
  }

  async inspect(runtime: RuntimeHandle, signal?: AbortSignal): Promise<RuntimeState> {
    throwIfAborted(signal)
    const runtimeId = this.#runtimeId(runtime, "inspect")
    const snapshot = await this.#inspectContainer(this.#runtimeContainer(runtimeId), "inspect")
    throwIfAborted(signal)
    return {
      status: snapshot === null ? "missing" : containerRunning(snapshot) ? "running" : "stopped",
      observedAt: new Date().toISOString(),
    }
  }

  async stop(runtime: RuntimeHandle): Promise<void> {
    const runtimeId = this.#runtimeId(runtime, "stop")
    const snapshot = await this.#inspectContainer(this.#runtimeContainer(runtimeId), "stop")
    if (snapshot !== null) this.#assertRuntimeContainer(snapshot, runtimeId, "stop")

    for (const identity of await this.#listProcessIdentities(runtimeId, "stop")) {
      await this.#terminateProcess(identity, "stop")
    }
    if (snapshot !== null && containerRunning(snapshot)) {
      const result = await this.#run(
        [
          "container",
          "stop",
          "--signal",
          "SIGTERM",
          "--time",
          String(Math.ceil(this.#stopGraceMs / 1_000)),
          this.#runtimeContainer(runtimeId),
        ],
        "stop",
      )
      if (result.exitCode !== 0) {
        throw this.#commandError(
          "stop",
          "RUNTIME_STOP_FAILED",
          "OCI runtime container could not be stopped",
          result,
          true,
        )
      }
    }
    const workspaceRuntime = runtimeHandle("local", runtimeId)
    const workspaceState = await this.#workspaceCall("stop", () =>
      this.#workspace.inspect(workspaceRuntime),
    )
    if (workspaceState.status !== "missing") {
      await this.#workspaceCall("stop", () => this.#workspace.stop(workspaceRuntime))
    }
  }

  async destroy(runtime: RuntimeHandle): Promise<void> {
    const runtimeId = this.#runtimeId(runtime, "destroy")
    const snapshot = await this.#inspectContainer(this.#runtimeContainer(runtimeId), "destroy")
    if (snapshot !== null) this.#assertRuntimeContainer(snapshot, runtimeId, "destroy")
    if (snapshot !== null) await this.stop(runtime)
    for (const identity of await this.#listProcessIdentities(runtimeId, "destroy")) {
      await this.#removeProcessContainer(identity, "destroy")
    }
    if (snapshot !== null) {
      const result = await this.#run(
        ["container", "rm", "--force", this.#runtimeContainer(runtimeId)],
        "destroy",
      )
      if (result.exitCode !== 0) {
        throw this.#commandError(
          "destroy",
          "RUNTIME_DESTROY_FAILED",
          "OCI runtime container could not be removed",
          result,
          true,
        )
      }
    }
    await this.#workspaceCall("destroy", () =>
      this.#workspace.destroy(runtimeHandle("local", runtimeId)),
    )
  }

  async spawn(runtime: RuntimeHandle, spec: ProcessSpec): Promise<ProcessHandle> {
    const runtimeId = this.#runtimeId(runtime, "spawn")
    const runtimeSnapshot = await this.#requireRuntimeContainer(runtimeId, "spawn")
    if (!containerRunning(runtimeSnapshot)) {
      throw this.#error(
        "spawn",
        "RUNTIME_NOT_RUNNING",
        "Runtime must be running before spawning a process",
      )
    }
    validateProcessSpec(spec, (code, message, cause) => this.#error("spawn", code, message, cause))
    if (spec.input === "mailbox") {
      throw this.#error(
        "spawn",
        "PROCESS_INPUT_UNAVAILABLE",
        "The local OCI provider does not support ordered process input",
      )
    }
    let hardTimeoutMs: number | undefined
    try {
      hardTimeoutMs = processHardTimeoutMs(spec)
    } catch (cause) {
      throw this.#error("spawn", "INVALID_PROCESS_SPEC", "Process timeout policy is invalid", cause)
    }
    try {
      assertRuntimeId(spec.processId)
    } catch (cause) {
      throw this.#error("spawn", "INVALID_PROCESS_ID", "Process identifier is invalid", cause)
    }
    await this.#assertWorkingDirectory(runtimeId, spec.cwd, "spawn")

    const identity = { runtimeId, processId: spec.processId }
    const specFingerprint = await processSpecFingerprint(spec)
    const existing = await this.#inspectContainer(this.#processContainer(identity), "spawn")
    if (existing !== null) {
      this.#assertProcessContainer(existing, identity, specFingerprint, "spawn")
      const metadata = await this.#ensureProcessMetadata(identity, specFingerprint, hardTimeoutMs)
      if (containerCreated(existing)) await this.#startProcessContainer(identity, spec.initialStdin)
      this.#scheduleTimeout(identity, metadata)
      return processHandle(this.name, encodeProcessIdentity(identity))
    }

    const environment = validateEnvironment(spec.env ?? {})
    const argv = [
      "container",
      "create",
      "--name",
      this.#processContainer(identity),
      ...this.#containerPolicyArgs(runtimeId, identity),
      "--label",
      `${LABEL_PREFIX}.process-id=${identity.processId}`,
      "--label",
      `${LABEL_PREFIX}.spec-fingerprint=${specFingerprint}`,
      "--workdir",
      containerWorkspacePath(spec.cwd),
      "--env",
      "HOME=/home/meanwhile",
      "--env",
      "TMPDIR=/tmp",
      "--env",
      "TZ=UTC",
      ...Object.keys(environment)
        .sort()
        .flatMap((name) => ["--env", `${name}=${environment[name]}`]),
      ...(spec.initialStdin === undefined ? [] : ["--interactive"]),
      "--entrypoint",
      spec.argv[0],
      this.#imageReference,
      ...spec.argv.slice(1),
    ]
    const result = await this.#run(argv, "spawn")
    if (result.exitCode !== 0) {
      const raced = await this.#inspectContainer(this.#processContainer(identity), "spawn")
      if (raced === null) {
        throw this.#commandError(
          "spawn",
          "PROCESS_CREATE_FAILED",
          "OCI process container could not be created",
          result,
          true,
        )
      }
      this.#assertProcessContainer(raced, identity, specFingerprint, "spawn")
    }

    const metadata = await this.#ensureProcessMetadata(identity, specFingerprint, hardTimeoutMs)
    try {
      await this.#startProcessContainer(identity, spec.initialStdin)
    } catch (cause) {
      await this.#removeProcessContainer(identity, "spawn").catch(() => undefined)
      throw cause
    }
    this.#scheduleTimeout(identity, metadata)
    return processHandle(this.name, encodeProcessIdentity(identity))
  }

  async inspectProcess(process: ProcessHandle): Promise<ProcessState> {
    const identity = this.#processIdentity(process, "inspectProcess")
    const metadata = await this.#readProcessMetadata(identity, "inspectProcess", true)
    const snapshot = await this.#inspectContainer(
      this.#processContainer(identity),
      "inspectProcess",
    )
    const observedAt = new Date().toISOString()
    if (snapshot === null) return { status: "missing", observedAt }
    if (metadata === null) {
      throw this.#error("inspectProcess", "OCI_STATE_CORRUPT", "OCI process metadata is missing")
    }
    this.#assertProcessContainer(snapshot, identity, metadata.specFingerprint, "inspectProcess")
    if (containerRunning(snapshot) && deadlineExpired(metadata.hardDeadline)) {
      await this.#signalIdentity(identity, "SIGKILL", true, "inspectProcess")
      return this.inspectProcess(process)
    }
    if (containerRunning(snapshot) || containerCreated(snapshot)) {
      return { status: "running", observedAt }
    }
    await this.#signalTasks.get(processKey(identity))
    const exit = await this.#processExit(identity, snapshot, "inspectProcess")
    return { status: "exited", observedAt, exit }
  }

  async *events(
    process: ProcessHandle,
    cursor: EventCursor,
    signal?: AbortSignal,
  ): AsyncIterable<ProcessEvent> {
    throwIfAborted(signal)
    const identity = this.#processIdentity(process, "events")
    const metadata = await this.#readProcessMetadata(identity, "events", true)
    if (metadata === null) {
      throw this.#error("events", "PROCESS_NOT_FOUND", "OCI process does not exist")
    }
    const position = parseCursor(cursor, (code, message, cause) =>
      this.#error("events", code, message, cause),
    )

    while (true) {
      throwIfAborted(signal)
      let emitted = false
      for (const stream of ["stdout", "stderr"] as const) {
        const bytes = await this.#readLogs(identity, stream, "events")
        if (position[stream] > bytes.byteLength) {
          throw this.#error(
            "events",
            "PROCESS_OUTPUT_TRUNCATED",
            "OCI process replay output was truncated by the container log driver",
          )
        }
        if (position[stream] === bytes.byteLength) continue
        const end = Math.min(bytes.byteLength, position[stream] + OUTPUT_CHUNK_BYTES)
        const chunk = bytes.subarray(position[stream], end)
        const state = await this.inspectProcess(process)
        const completeBytes =
          state.status === "exited" ? chunk.byteLength : completeUtf8Length(chunk)
        if (completeBytes === 0) continue
        position[stream] += completeBytes
        emitted = true
        yield {
          cursor: formatCursor(position),
          timestamp: new Date().toISOString(),
          stream,
          data: new TextDecoder().decode(chunk.subarray(0, completeBytes)),
        }
        throwIfAborted(signal)
      }

      const state = await this.inspectProcess(process)
      if (state.status !== "running") {
        const stdout = await this.#readLogs(identity, "stdout", "events")
        const stderr = await this.#readLogs(identity, "stderr", "events")
        if (position.stdout >= stdout.byteLength && position.stderr >= stderr.byteLength) return
      }
      if (!emitted) await abortableDelay(this.#pollIntervalMs, signal)
    }
  }

  async signal(process: ProcessHandle, signal: ProcessSignal): Promise<void> {
    const identity = this.#processIdentity(process, "signal")
    await this.#signalIdentity(identity, signal, false, "signal")
  }

  async wait(process: ProcessHandle): Promise<ProcessExit> {
    const identity = this.#processIdentity(process, "wait")
    const metadata = await this.#readProcessMetadata(identity, "wait", true)
    if (metadata === null) {
      throw this.#error("wait", "PROCESS_NOT_FOUND", "OCI process does not exist")
    }
    while (true) {
      const state = await this.inspectProcess(process)
      if (state.status === "missing") {
        throw this.#error("wait", "PROCESS_NOT_FOUND", "OCI process does not exist")
      }
      if (state.status === "exited" && state.exit !== undefined) return state.exit
      await Bun.sleep(this.#pollIntervalMs)
    }
  }

  async writeFiles(runtime: RuntimeHandle, files: readonly RuntimeFile[]): Promise<void> {
    const runtimeId = this.#runtimeId(runtime, "writeFiles")
    await this.#requireRuntimeContainer(runtimeId, "writeFiles")
    await this.#workspaceCall("writeFiles", () =>
      this.#workspace.writeFiles(runtimeHandle("local", runtimeId), files),
    )
  }

  async listFiles(
    runtime: RuntimeHandle,
    path: RelativePath,
    options: ListRuntimeFilesOptions,
    signal?: AbortSignal,
  ): Promise<RuntimeFileInfo[]> {
    const runtimeId = this.#runtimeId(runtime, "listFiles")
    await this.#requireRuntimeContainer(runtimeId, "listFiles")
    return this.#workspaceCall("listFiles", () =>
      this.#workspace.listFiles(runtimeHandle("local", runtimeId), path, options, signal),
    )
  }

  async readFile(
    runtime: RuntimeHandle,
    path: RelativePath,
    options: ReadRuntimeFileOptions,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const runtimeId = this.#runtimeId(runtime, "readFile")
    await this.#requireRuntimeContainer(runtimeId, "readFile")
    return this.#workspaceCall("readFile", () =>
      this.#workspace.readFile(runtimeHandle("local", runtimeId), path, options, signal),
    )
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString()
    try {
      await mkdir(this.#rootDirectory, { recursive: true, mode: 0o700 })
      await access(this.#rootDirectory, constants.R_OK | constants.W_OK | constants.X_OK)
      const result = await this.#run(["version", "--format", "{{.Server.Version}}"], "health")
      if (result.exitCode !== 0) {
        return {
          status: "unavailable",
          checkedAt,
          message: "Docker-compatible OCI engine is unavailable",
        }
      }
      return {
        status: "healthy",
        checkedAt,
        message:
          "Local OCI isolation is operational with networking disabled; exact-host policy and credential mediation are unavailable",
      }
    } catch {
      return {
        status: "unavailable",
        checkedAt,
        message: "Local OCI runtime storage or engine is unavailable",
      }
    }
  }

  async #ensureImage(operation: RuntimeProviderOperation): Promise<void> {
    const result = await this.#run(["image", "inspect", this.#imageReference], operation)
    if (result.exitCode !== 0) {
      throw this.#commandError(
        operation,
        "IMAGE_NOT_FOUND",
        "Configured OCI image is not available locally; this provider never pulls implicitly",
        result,
      )
    }
    if (this.#imageDigest === null) return
    const snapshots = parseInspect(result.stdout, operation, (code, message, cause) =>
      this.#error(operation, code, message, cause),
    )
    const imageId = snapshots[0] === undefined ? undefined : stringAt(snapshots[0], ["Id"])
    if (imageId !== this.#imageDigest) {
      throw this.#error(
        operation,
        "IMAGE_DIGEST_MISMATCH",
        "Configured OCI image does not match the accepted image digest",
      )
    }
  }

  #containerPolicyArgs(runtimeId: string, identity: ProcessIdentity | null): string[] {
    const workspace = this.#workspaceDirectory(runtimeId)
    return [
      "--label",
      `${LABEL_PREFIX}.managed=true`,
      "--label",
      `${LABEL_PREFIX}.runtime-id=${runtimeId}`,
      "--label",
      `${LABEL_PREFIX}.kind=${identity === null ? "runtime" : "process"}`,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--pids-limit",
      String(this.#pidsLimit),
      "--memory",
      this.#memoryLimit,
      "--cpus",
      this.#cpuLimit,
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=64m",
      "--tmpfs",
      "/home/meanwhile:rw,nosuid,nodev,size=64m",
      "--mount",
      `type=bind,src=${workspace},dst=/workspace`,
      "--log-driver",
      "local",
      "--log-opt",
      `max-size=${this.#logBytes}`,
      "--log-opt",
      "max-file=1",
      "--log-opt",
      "compress=false",
      ...(this.#containerUser === null ? [] : ["--user", this.#containerUser]),
    ]
  }

  async #startProcessContainer(
    identity: ProcessIdentity,
    initialStdin: string | undefined,
  ): Promise<void> {
    const name = this.#processContainer(identity)
    if (initialStdin === undefined) {
      const result = await this.#run(["container", "start", name], "spawn")
      if (result.exitCode !== 0) {
        throw this.#commandError(
          "spawn",
          "PROCESS_START_FAILED",
          "OCI process container could not be started",
          result,
          true,
        )
      }
      return
    }
    try {
      await this.#executor.startAttached(
        [this.#engineExecutable, "container", "start", "--attach", "--interactive", name],
        initialStdin,
      )
    } catch (cause) {
      throw this.#error(
        "spawn",
        "PROCESS_STDIN_FAILED",
        "OCI process container could not be started with initial input",
        cause,
        true,
      )
    }
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const snapshot = await this.#inspectContainer(name, "spawn")
      if (snapshot !== null && !containerCreated(snapshot)) return
      await Bun.sleep(this.#pollIntervalMs)
    }
    throw this.#error(
      "spawn",
      "PROCESS_START_FAILED",
      "OCI process container did not accept its start request",
      undefined,
      true,
    )
  }

  async #signalIdentity(
    identity: ProcessIdentity,
    signal: ProcessSignal,
    timedOut: boolean,
    operation: RuntimeProviderOperation,
  ): Promise<void> {
    const key = processKey(identity)
    const active = this.#signalTasks.get(key)
    if (active !== undefined) return active
    const task = this.#signalIdentityOnce(identity, signal, timedOut, operation)
    this.#signalTasks.set(key, task)
    try {
      await task
    } finally {
      if (this.#signalTasks.get(key) === task) this.#signalTasks.delete(key)
    }
  }

  async #signalIdentityOnce(
    identity: ProcessIdentity,
    signal: ProcessSignal,
    timedOut: boolean,
    operation: RuntimeProviderOperation,
  ): Promise<void> {
    const metadata = await this.#readProcessMetadata(identity, operation, true)
    if (metadata === null) {
      throw this.#error(operation, "PROCESS_NOT_FOUND", "OCI process does not exist")
    }
    const snapshot = await this.#inspectContainer(this.#processContainer(identity), operation)
    if (snapshot === null || !containerRunning(snapshot)) return
    const result = await this.#run(
      ["container", "kill", "--signal", signal, this.#processContainer(identity)],
      operation,
    )
    if (result.exitCode !== 0) {
      const after = await this.#inspectContainer(this.#processContainer(identity), operation)
      if (after === null || !containerRunning(after)) return
      throw this.#commandError(
        operation,
        "PROCESS_SIGNAL_FAILED",
        "OCI process container could not be signalled",
        result,
        true,
      )
    }
    await writeJsonAtomic(this.#signalPath(identity), {
      signal,
      timedOut,
      acceptedAt: new Date().toISOString(),
    } satisfies SignalReceipt)
  }

  async #terminateProcess(identity: ProcessIdentity, operation: "stop" | "destroy"): Promise<void> {
    const process = processHandle(this.name, encodeProcessIdentity(identity))
    const state = await this.inspectProcess(process)
    if (state.status !== "running") return
    await this.#signalIdentity(identity, "SIGTERM", false, operation)
    if (await this.#waitUntilExited(process, this.#stopGraceMs)) return
    await this.#signalIdentity(identity, "SIGKILL", false, operation)
    if (!(await this.#waitUntilExited(process, Math.max(1_000, this.#pollIntervalMs * 4)))) {
      throw this.#error(operation, "PROCESS_STOP_FAILED", "OCI process did not stop after SIGKILL")
    }
  }

  async #waitUntilExited(process: ProcessHandle, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await this.inspectProcess(process)).status !== "running") return true
      await Bun.sleep(Math.min(this.#pollIntervalMs, Math.max(1, deadline - Date.now())))
    }
    return (await this.inspectProcess(process)).status !== "running"
  }

  async #removeProcessContainer(
    identity: ProcessIdentity,
    operation: RuntimeProviderOperation,
  ): Promise<void> {
    this.#timeoutTasks.get(processKey(identity))?.()
    this.#timeoutTasks.delete(processKey(identity))
    const snapshot = await this.#inspectContainer(this.#processContainer(identity), operation)
    if (snapshot === null) return
    const metadata = await this.#readProcessMetadata(identity, operation, true)
    if (metadata === null) {
      throw this.#error(operation, "OCI_STATE_CORRUPT", "OCI process metadata is missing")
    }
    this.#assertProcessContainer(snapshot, identity, metadata.specFingerprint, operation)
    const result = await this.#run(
      ["container", "rm", "--force", this.#processContainer(identity)],
      operation,
    )
    if (result.exitCode !== 0) {
      throw this.#commandError(
        operation,
        "PROCESS_REMOVE_FAILED",
        "OCI process container could not be removed",
        result,
        true,
      )
    }
  }

  async #processExit(
    identity: ProcessIdentity,
    snapshot: Record<string, unknown>,
    operation: RuntimeProviderOperation,
  ): Promise<ProcessExit> {
    const existing = await readJson(this.#exitPath(identity), true)
    if (existing !== null) {
      if (!isProcessExit(existing)) {
        throw this.#error(operation, "OCI_STATE_CORRUPT", "OCI process exit metadata is invalid")
      }
      return existing
    }
    const receiptValue = await readJson(this.#signalPath(identity), true)
    const receipt = isSignalReceipt(receiptValue) ? receiptValue : null
    const state = recordAt(snapshot, ["State"])
    const rawExitCode = state === null ? undefined : Reflect.get(state, "ExitCode")
    const exitCode =
      typeof rawExitCode === "number" && Number.isInteger(rawExitCode) ? rawExitCode : null
    const oomKilled = state !== null && Reflect.get(state, "OOMKilled") === true
    const finishedAt = state === null ? undefined : Reflect.get(state, "FinishedAt")
    const signal = receipt?.signal ?? (oomKilled ? "SIGKILL" : null)
    const exit: ProcessExit = {
      exitCode: signal === null ? exitCode : null,
      signal,
      reason: receipt?.timedOut === true ? "timed_out" : signal === null ? "exited" : "signaled",
      exitedAt:
        typeof finishedAt === "string" && Number.isFinite(Date.parse(finishedAt))
          ? new Date(finishedAt).toISOString()
          : new Date().toISOString(),
    }
    await writeJsonExclusive(this.#exitPath(identity), exit)
    this.#timeoutTasks.get(processKey(identity))?.()
    this.#timeoutTasks.delete(processKey(identity))
    return exit
  }

  async #readLogs(
    identity: ProcessIdentity,
    stream: "stdout" | "stderr",
    operation: RuntimeProviderOperation,
  ): Promise<Uint8Array> {
    const result = await this.#run(
      ["container", "logs", this.#processContainer(identity)],
      operation,
    )
    if (result.exitCode !== 0) {
      throw this.#commandError(
        operation,
        "PROCESS_LOG_READ_FAILED",
        "OCI process logs could not be replayed",
        result,
        true,
      )
    }
    return stream === "stdout" ? result.stdout : result.stderr
  }

  async #ensureProcessMetadata(
    identity: ProcessIdentity,
    specFingerprint: string,
    hardTimeoutMs: number | undefined,
  ): Promise<ProcessMetadata> {
    const existing = await this.#readProcessMetadata(identity, "spawn", true)
    if (existing !== null) {
      if (existing.specFingerprint !== specFingerprint) {
        throw this.#error(
          "spawn",
          "PROCESS_CONFLICT",
          "Process identifier is already bound to a different specification",
        )
      }
      return existing
    }
    const createdAt = new Date().toISOString()
    const metadata: ProcessMetadata = {
      version: STATE_VERSION,
      runtimeId: identity.runtimeId,
      processId: identity.processId,
      specFingerprint,
      containerName: this.#processContainer(identity),
      hardDeadline:
        hardTimeoutMs === undefined
          ? null
          : new Date(Date.parse(createdAt) + hardTimeoutMs).toISOString(),
      createdAt,
    }
    await mkdir(this.#ociProcessDirectory(identity.runtimeId), { recursive: true, mode: 0o700 })
    await writeJsonExclusive(this.#processMetadataPath(identity), metadata)
    const saved = await this.#readProcessMetadata(identity, "spawn", false)
    if (saved?.specFingerprint !== specFingerprint) {
      throw this.#error(
        "spawn",
        "PROCESS_CONFLICT",
        "Process identifier is already bound to a different specification",
      )
    }
    return saved
  }

  #scheduleTimeout(identity: ProcessIdentity, metadata: ProcessMetadata): void {
    if (metadata.hardDeadline === null || this.#timeoutTasks.has(processKey(identity))) return
    const delay = Math.max(0, Date.parse(metadata.hardDeadline) - Date.now())
    const timeout = setTimeout(
      () => {
        void this.#signalIdentity(identity, "SIGKILL", true, "signal").catch(() => undefined)
      },
      Math.min(delay, 2_147_000_000),
    )
    this.#timeoutTasks.set(processKey(identity), () => clearTimeout(timeout))
  }

  async #listProcessIdentities(
    runtimeId: string,
    operation: RuntimeProviderOperation,
  ): Promise<ProcessIdentity[]> {
    try {
      const entries = await readdir(this.#ociProcessDirectory(runtimeId), { withFileTypes: true })
      const identities: ProcessIdentity[] = []
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue
        if (entry.name.endsWith(".exit.json") || entry.name.endsWith(".signal.json")) continue
        const processId = entry.name.slice(0, -5)
        try {
          assertRuntimeId(processId)
        } catch {
          throw this.#error(operation, "OCI_STATE_CORRUPT", "OCI process metadata path is invalid")
        }
        identities.push({ runtimeId, processId })
      }
      return identities.sort((left, right) => left.processId.localeCompare(right.processId))
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) return []
      if (cause instanceof RuntimeProviderError) throw cause
      throw this.#error(
        operation,
        "OCI_STATE_READ_FAILED",
        "OCI process state could not be listed",
        cause,
        true,
      )
    }
  }

  async #readProcessMetadata(
    identity: ProcessIdentity,
    operation: RuntimeProviderOperation,
    missingAllowed: boolean,
  ): Promise<ProcessMetadata | null> {
    const value = await readJson(this.#processMetadataPath(identity), missingAllowed)
    if (value === null) return null
    if (!isProcessMetadata(value, identity, this.#processContainer(identity))) {
      throw this.#error(operation, "OCI_STATE_CORRUPT", "OCI process metadata is invalid")
    }
    return value
  }

  async #assertWorkingDirectory(
    runtimeId: string,
    path: RelativePath,
    operation: RuntimeProviderOperation,
  ): Promise<void> {
    let logical: RelativePath
    try {
      logical = relativePath(String(path))
    } catch (cause) {
      throw this.#error(operation, "INVALID_PATH", "Workspace path is invalid", cause)
    }
    let current = this.#workspaceDirectory(runtimeId)
    for (const segment of logical === "." ? [] : logical.split("/")) {
      current = join(current, segment)
      const state = await safeLstat(current)
      if (state === null || !state.isDirectory()) {
        throw this.#error(
          operation,
          "WORKING_DIRECTORY_NOT_FOUND",
          "Process working directory does not exist",
        )
      }
      if (state.isSymbolicLink()) {
        throw this.#error(operation, "SYMLINK_NOT_ALLOWED", "Working directory crosses a symlink")
      }
    }
  }

  async #inspectContainer(
    name: string,
    operation: RuntimeProviderOperation,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.#run(["container", "inspect", name], operation)
    if (result.exitCode !== 0) {
      const diagnostic = decode(result.stderr)
      if (diagnostic.includes("No such container") || diagnostic.includes("No such object")) {
        return null
      }
      throw this.#commandError(
        operation,
        "ENGINE_INSPECT_FAILED",
        "OCI engine could not inspect a container",
        result,
        true,
      )
    }
    const snapshots = parseInspect(result.stdout, operation, (code, message, cause) =>
      this.#error(operation, code, message, cause),
    )
    const snapshot = snapshots[0]
    if (snapshot === undefined) {
      throw this.#error(operation, "ENGINE_PROTOCOL_ERROR", "OCI engine returned no container")
    }
    return snapshot
  }

  async #requireRuntimeContainer(
    runtimeId: string,
    operation: RuntimeProviderOperation,
  ): Promise<Record<string, unknown>> {
    const snapshot = await this.#inspectContainer(this.#runtimeContainer(runtimeId), operation)
    if (snapshot === null) {
      throw this.#error(operation, "RUNTIME_NOT_FOUND", "OCI runtime does not exist")
    }
    this.#assertRuntimeContainer(snapshot, runtimeId, operation)
    return snapshot
  }

  #assertRuntimeContainer(
    snapshot: Record<string, unknown>,
    runtimeId: string,
    operation: RuntimeProviderOperation,
  ): void {
    const labels = containerLabels(snapshot)
    if (
      labels[`${LABEL_PREFIX}.managed`] !== "true" ||
      labels[`${LABEL_PREFIX}.kind`] !== "runtime" ||
      labels[`${LABEL_PREFIX}.runtime-id`] !== runtimeId ||
      stringAt(snapshot, ["Config", "Image"]) !== this.#imageReference
    ) {
      throw this.#error(
        operation,
        "RUNTIME_CONFLICT",
        "OCI container name is already bound to a different runtime",
      )
    }
  }

  #assertProcessContainer(
    snapshot: Record<string, unknown>,
    identity: ProcessIdentity,
    specFingerprint: string,
    operation: RuntimeProviderOperation,
  ): void {
    const labels = containerLabels(snapshot)
    if (
      labels[`${LABEL_PREFIX}.managed`] !== "true" ||
      labels[`${LABEL_PREFIX}.kind`] !== "process" ||
      labels[`${LABEL_PREFIX}.runtime-id`] !== identity.runtimeId ||
      labels[`${LABEL_PREFIX}.process-id`] !== identity.processId ||
      labels[`${LABEL_PREFIX}.spec-fingerprint`] !== specFingerprint ||
      stringAt(snapshot, ["Config", "Image"]) !== this.#imageReference
    ) {
      throw this.#error(
        operation,
        "PROCESS_CONFLICT",
        "Process identifier is already bound to a different specification",
      )
    }
  }

  async #run(args: readonly string[], operation: RuntimeProviderOperation): Promise<CommandResult> {
    try {
      return await this.#executor.run([this.#engineExecutable, ...args])
    } catch (cause) {
      throw this.#error(
        operation,
        "ENGINE_UNAVAILABLE",
        "Docker-compatible OCI engine is unavailable",
        cause,
        true,
      )
    }
  }

  async #workspaceCall<Value>(
    operation: RuntimeProviderOperation,
    execute: () => Promise<Value>,
  ): Promise<Value> {
    try {
      return await execute()
    } catch (cause) {
      if (cause instanceof RuntimeProviderError) {
        throw this.#error(operation, cause.code, cause.message, cause, cause.retryable)
      }
      throw cause
    }
  }

  #runtimeId(handle: RuntimeHandle, operation: RuntimeProviderOperation): string {
    if (handle.kind !== "runtime" || handle.version !== 1 || handle.provider !== this.name) {
      throw this.#error(
        operation,
        "INVALID_RUNTIME_HANDLE",
        "Runtime handle does not belong to this provider",
      )
    }
    try {
      assertRuntimeId(handle.opaque)
      return handle.opaque
    } catch (cause) {
      throw this.#error(operation, "INVALID_RUNTIME_HANDLE", "Runtime handle is invalid", cause)
    }
  }

  #processIdentity(handle: ProcessHandle, operation: RuntimeProviderOperation): ProcessIdentity {
    if (handle.kind !== "process" || handle.version !== 1 || handle.provider !== this.name) {
      throw this.#error(
        operation,
        "INVALID_PROCESS_HANDLE",
        "Process handle does not belong to this provider",
      )
    }
    try {
      return decodeProcessIdentity(handle.opaque)
    } catch (cause) {
      throw this.#error(operation, "INVALID_PROCESS_HANDLE", "Process handle is invalid", cause)
    }
  }

  #runtimeContainer(runtimeId: string): string {
    return `meanwhile-oci-runtime-${digestName(runtimeId)}`
  }

  #processContainer(identity: ProcessIdentity): string {
    return `meanwhile-oci-process-${digestName(`${identity.runtimeId}\0${identity.processId}`)}`
  }

  #runtimeDirectory(runtimeId: string): string {
    return join(this.#rootDirectory, runtimeId)
  }

  #workspaceDirectory(runtimeId: string): string {
    return join(this.#runtimeDirectory(runtimeId), "workspace")
  }

  #ociProcessDirectory(runtimeId: string): string {
    return join(this.#runtimeDirectory(runtimeId), "oci-processes")
  }

  #processMetadataPath(identity: ProcessIdentity): string {
    return join(this.#ociProcessDirectory(identity.runtimeId), `${identity.processId}.json`)
  }

  #signalPath(identity: ProcessIdentity): string {
    return join(this.#ociProcessDirectory(identity.runtimeId), `${identity.processId}.signal.json`)
  }

  #exitPath(identity: ProcessIdentity): string {
    return join(this.#ociProcessDirectory(identity.runtimeId), `${identity.processId}.exit.json`)
  }

  #commandError(
    operation: RuntimeProviderOperation,
    code: string,
    message: string,
    result: CommandResult,
    retryable = false,
  ): RuntimeProviderError {
    const diagnostic = sanitizeDiagnostic(decode(result.stderr) || decode(result.stdout))
    return this.#error(
      operation,
      code,
      diagnostic.length === 0 ? message : `${message}: ${diagnostic}`,
      undefined,
      retryable,
    )
  }

  #error(
    operation: RuntimeProviderOperation,
    code: string,
    message: string,
    cause?: unknown,
    retryable = false,
  ): RuntimeProviderError {
    return new RuntimeProviderError({
      provider: this.name,
      operation,
      code,
      message,
      retryable,
      cause,
    })
  }
}

export class BunOciCommandExecutor implements OciCommandExecutor {
  readonly #engineExecutable: string

  constructor(engineExecutable = "docker") {
    this.#engineExecutable = engineExecutable
  }

  async run(argv: readonly string[]): Promise<CommandResult> {
    if (argv[0] !== this.#engineExecutable) {
      throw new TypeError("OCI command executor received an unexpected executable")
    }
    const child = Bun.spawn({
      cmd: [...argv],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(child.stdout, MAX_COMMAND_OUTPUT_BYTES),
      readBounded(child.stderr, MAX_COMMAND_OUTPUT_BYTES),
      child.exited,
    ])
    return { exitCode, stdout, stderr }
  }

  async startAttached(argv: readonly string[], initialStdin: string): Promise<void> {
    if (argv[0] !== this.#engineExecutable) {
      throw new TypeError("OCI command executor received an unexpected executable")
    }
    const child = Bun.spawn({
      cmd: [...argv],
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    })
    const stdin = child.stdin
    if (stdin === undefined || typeof stdin === "number") {
      child.kill("SIGKILL")
      throw new TypeError("OCI engine process has no writable stdin")
    }
    stdin.write(initialStdin)
    stdin.end()
    child.unref()
  }
}

function validateProcessSpec(
  spec: ProcessSpec,
  error: (code: string, message: string, cause?: unknown) => RuntimeProviderError,
): void {
  try {
    validateArgv(spec.argv)
    relativePath(String(spec.cwd))
    validateEnvironment(spec.env ?? {})
  } catch (cause) {
    throw error("INVALID_PROCESS_SPEC", "Process specification is invalid", cause)
  }
  if (spec.initialStdin?.includes("\0")) {
    throw error("INVALID_PROCESS_SPEC", "Initial process input must not contain NUL bytes")
  }
  if (
    spec.initialStdin !== undefined &&
    new TextEncoder().encode(spec.initialStdin).byteLength > 1024 * 1024
  ) {
    throw error("INVALID_PROCESS_SPEC", "Initial process input exceeds 1 MiB")
  }
}

function validateArgv(argv: readonly string[]): asserts argv is readonly [string, ...string[]] {
  if (
    argv.length === 0 ||
    argv[0]?.length === 0 ||
    argv.some((argument) => argument.includes("\0"))
  ) {
    throw new TypeError("argv must contain a non-empty executable and NUL-free arguments")
  }
}

function validateEnvironment(
  environment: Readonly<Record<string, string>>,
): Record<string, string> {
  const entries = Object.entries(environment)
  if (entries.length > MAX_ENVIRONMENT_ENTRIES) {
    throw new TypeError(`environment must not exceed ${MAX_ENVIRONMENT_ENTRIES} entries`)
  }
  const result: Record<string, string> = {}
  let totalBytes = 0
  for (const [name, value] of entries) {
    const nameBytes = new TextEncoder().encode(name).byteLength
    const valueBytes = new TextEncoder().encode(value).byteLength
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      value.includes("\0") ||
      nameBytes > MAX_ENVIRONMENT_NAME_BYTES ||
      valueBytes > MAX_ENVIRONMENT_VALUE_BYTES
    ) {
      throw new TypeError("environment contains an invalid name or value")
    }
    totalBytes += nameBytes + valueBytes
    if (totalBytes > MAX_ENVIRONMENT_BYTES) {
      throw new TypeError(`environment must not exceed ${MAX_ENVIRONMENT_BYTES} UTF-8 bytes`)
    }
    result[name] = value
  }
  return result
}

function resourceLimit(value: string, name: string): string {
  if (!/^[A-Za-z0-9.]+$/.test(value)) throw new TypeError(`${name} is invalid`)
  return value
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}

function containerWorkspacePath(path: RelativePath): string {
  return path === "." ? "/workspace" : `/workspace/${path}`
}

function digestName(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

function encodeProcessIdentity(identity: ProcessIdentity): string {
  return `${identity.runtimeId}.${identity.processId}`
}

function decodeProcessIdentity(value: string): ProcessIdentity {
  const separator = value.indexOf(".")
  if (separator < 1 || separator === value.length - 1 || value.indexOf(".", separator + 1) !== -1) {
    throw new TypeError("process identity is invalid")
  }
  const runtimeId = value.slice(0, separator)
  const processId = value.slice(separator + 1)
  assertRuntimeId(runtimeId)
  assertRuntimeId(processId)
  return { runtimeId, processId }
}

function processKey(identity: ProcessIdentity): string {
  return `${identity.runtimeId}/${identity.processId}`
}

function parseCursor(
  cursor: EventCursor,
  error: (code: string, message: string, cause?: unknown) => RuntimeProviderError,
): OciCursor {
  if (cursor === null) return { stdout: 0, stderr: 0 }
  const match = /^oci1:(\d+):(\d+)$/.exec(cursor)
  if (match === null) throw error("INVALID_EVENT_CURSOR", "OCI event cursor is invalid")
  const stdout = Number(match[1])
  const stderr = Number(match[2])
  if (!Number.isSafeInteger(stdout) || !Number.isSafeInteger(stderr)) {
    throw error("INVALID_EVENT_CURSOR", "OCI event cursor is invalid")
  }
  return { stdout, stderr }
}

function formatCursor(cursor: OciCursor): string {
  return `oci1:${cursor.stdout}:${cursor.stderr}`
}

function parseInspect(
  bytes: Uint8Array,
  _operation: RuntimeProviderOperation,
  error: (code: string, message: string, cause?: unknown) => RuntimeProviderError,
): Record<string, unknown>[] {
  try {
    const value: unknown = JSON.parse(decode(bytes))
    if (!Array.isArray(value) || value.some((entry) => !isRecord(entry))) {
      throw new TypeError("inspect response is not an object array")
    }
    return value
  } catch (cause) {
    throw error("ENGINE_PROTOCOL_ERROR", "OCI engine returned invalid inspect JSON", cause)
  }
}

function containerLabels(snapshot: Record<string, unknown>): Record<string, string> {
  const labels = recordAt(snapshot, ["Config", "Labels"])
  if (labels === null) return {}
  return Object.fromEntries(
    Object.entries(labels).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  )
}

function containerRunning(snapshot: Record<string, unknown>): boolean {
  return valueAt(snapshot, ["State", "Running"]) === true
}

function containerCreated(snapshot: Record<string, unknown>): boolean {
  return valueAt(snapshot, ["State", "Status"]) === "created"
}

function recordAt(
  value: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> | null {
  let current: unknown = value
  for (const key of path) {
    if (!isRecord(current)) return null
    current = Reflect.get(current, key)
  }
  return isRecord(current) ? current : null
}

function stringAt(value: Record<string, unknown>, path: readonly string[]): string | undefined {
  const result = valueAt(value, path)
  return typeof result === "string" ? result : undefined
}

function valueAt(value: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = Reflect.get(current, key)
  }
  return current
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isProcessMetadata(
  value: unknown,
  identity: ProcessIdentity,
  containerName: string,
): value is ProcessMetadata {
  if (!isRecord(value)) return false
  const hardDeadline = Reflect.get(value, "hardDeadline")
  return (
    Reflect.get(value, "version") === STATE_VERSION &&
    Reflect.get(value, "runtimeId") === identity.runtimeId &&
    Reflect.get(value, "processId") === identity.processId &&
    typeof Reflect.get(value, "specFingerprint") === "string" &&
    Reflect.get(value, "containerName") === containerName &&
    (hardDeadline === null ||
      (typeof hardDeadline === "string" && Number.isFinite(Date.parse(hardDeadline)))) &&
    typeof Reflect.get(value, "createdAt") === "string"
  )
}

function isSignalReceipt(value: unknown): value is SignalReceipt {
  return (
    isRecord(value) &&
    ["SIGINT", "SIGTERM", "SIGKILL"].includes(String(Reflect.get(value, "signal"))) &&
    typeof Reflect.get(value, "timedOut") === "boolean" &&
    typeof Reflect.get(value, "acceptedAt") === "string"
  )
}

function isProcessExit(value: unknown): value is ProcessExit {
  if (!isRecord(value)) return false
  const exitCode = Reflect.get(value, "exitCode")
  const signal = Reflect.get(value, "signal")
  const reason = Reflect.get(value, "reason")
  return (
    (exitCode === null || (typeof exitCode === "number" && Number.isInteger(exitCode))) &&
    (signal === null || ["SIGINT", "SIGTERM", "SIGKILL"].includes(String(signal))) &&
    ["exited", "signaled", "timed_out", "unknown"].includes(String(reason)) &&
    typeof Reflect.get(value, "exitedAt") === "string"
  )
}

function deadlineExpired(value: string | null): boolean {
  return value !== null && Date.now() >= Date.parse(value)
}

async function readJson(path: string, missingAllowed: boolean): Promise<unknown | null> {
  try {
    return JSON.parse(await Bun.file(path).text()) as unknown
  } catch (cause) {
    if (missingAllowed && isErrno(cause, "ENOENT")) return null
    throw cause
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 })
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 })
  } catch (cause) {
    if (!isErrno(cause, "EEXIST")) throw cause
  }
}

async function safeLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path)
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) return null
    throw cause
  }
}

function isErrno(value: unknown, code: string): boolean {
  return isRecord(value) && Reflect.get(value, "code") === code
}

function completeUtf8Length(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 0
  const start = Math.max(0, bytes.byteLength - 3)
  for (let index = bytes.byteLength - 1; index >= start; index -= 1) {
    const byte = bytes[index]
    if (byte === undefined) return 0
    if ((byte & 0xc0) === 0x80) continue
    const width = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4
    return index + width <= bytes.byteLength ? bytes.byteLength : index
  }
  return start
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    await Bun.sleep(milliseconds)
    return
  }
  throwIfAborted(signal)
  await new Promise<void>((resolveDelay, reject) => {
    const timeout = setTimeout(resolveDelay, milliseconds)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw signal.reason
}

async function readBounded(
  stream: ReadableStream<Uint8Array> | number | undefined,
  maxBytes: number,
): Promise<Uint8Array> {
  if (stream === undefined || typeof stream === "number") return new Uint8Array()
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) throw new RangeError("OCI command output exceeded its bounded limit")
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 512)
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}
