import { posix } from "node:path"
import type { RunnerFrame, RunnerSpec, RunnerTerminalPayload } from "../../runner/protocol"
import { RUNNER_PROTOCOL_VERSION, runnerTerminalPayloadSchema } from "../../runner/protocol"
import { sanitizeRunnerTerminal } from "../agents/runner-evidence"
import type { RunnerSessionController } from "../agents/runner-session"
import type { ArtifactStore } from "../artifacts/artifact-store"
import type { ComponentHealth, ManagedComponent } from "../control-plane"
import {
  type Artifact,
  type AuditRecord,
  isTerminalRunStatus,
  type JsonObject,
  type RequestContext,
  type Run,
  type RunLogStream,
  type RunStatus,
  type StructuredError,
} from "../domain"
import { AppError, normalizeError } from "../errors"
import type { Store } from "../persistence/store"
import { assertProviderProvenance } from "../provenance"
import { observeRuntimeProvider } from "../providers/observed-provider"
import type { RuntimeProviderRegistry } from "../providers/registry"
import {
  type ProcessHandle,
  type RuntimeFileInfo,
  type RuntimeHandle,
  type RuntimeProvider,
  RuntimeProviderError,
  relativePath,
  restoreProcessHandle,
  restoreRuntimeHandle,
} from "../providers/runtime-provider"
import type { ResolvedSecretMaterial, SecretPurpose, SecretResolver } from "../secrets"
import type { OperationSpan, StructuredLogger, Telemetry, TelemetryScope } from "../telemetry"
import {
  ArtifactCollectionError,
  type ArtifactCollectionLimits,
  ArtifactCollector,
  type ArtifactWorkspace,
  artifactMetadata,
  ExactSecretArtifactScanner,
  type WorkspaceEntry,
} from "./artifact-collector"
import { attachAgentCredentialLease } from "./credential-lease-attacher"
import type { WorkspacePreparer } from "./workspace-preparer"

const DEFAULT_POLL_MS = 500
const MAX_TIMER_DELAY_MS = 2_147_000_000
const PROCESS_TERMINATION_GRACE_MS = 5_000

export interface RunExecutorOptions {
  readonly store: Store
  readonly providers: RuntimeProviderRegistry
  readonly runner: RunnerSessionController
  readonly workspace: WorkspacePreparer
  readonly artifactStore: ArtifactStore
  readonly artifactLimits: ArtifactCollectionLimits
  readonly secrets: SecretResolver
  readonly logger: StructuredLogger
  readonly telemetry?: Telemetry
  readonly concurrency?: number
  readonly pollMs?: number
  readonly clock?: () => Date
  readonly id?: () => string
}

/** Sole owner of durable run progression and remote execution orchestration. */
export class RunExecutor implements ManagedComponent {
  readonly name = "run-executor"
  readonly #store: Store
  readonly #providers: RuntimeProviderRegistry
  readonly #runner: RunnerSessionController
  readonly #workspace: WorkspacePreparer
  readonly #artifactStore: ArtifactStore
  readonly #artifactLimits: ArtifactCollectionLimits
  readonly #secrets: SecretResolver
  readonly #logger: StructuredLogger
  readonly #telemetry: Telemetry | undefined
  readonly #concurrency: number
  readonly #pollMs: number
  readonly #clock: () => Date
  readonly #id: () => string
  readonly #pending = new Set<string>()
  readonly #active = new Map<string, Promise<void>>()
  readonly #background = new Set<Promise<void>>()
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>()
  #interval: ReturnType<typeof setInterval> | null = null
  #observationAbortController: AbortController | null = null
  #stopping: Promise<void> | null = null
  #running = false
  #lastFailure: string | null = null

  constructor(options: RunExecutorOptions) {
    this.#store = options.store
    this.#providers = options.providers
    this.#runner = options.runner
    this.#workspace = options.workspace
    this.#artifactStore = options.artifactStore
    this.#artifactLimits = options.artifactLimits
    this.#secrets = options.secrets
    this.#logger = options.logger
    this.#telemetry = options.telemetry
    this.#concurrency = options.concurrency ?? 2
    this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.#clock = options.clock ?? (() => new Date())
    this.#id = options.id ?? (() => crypto.randomUUID())
    if (!Number.isSafeInteger(this.#concurrency) || this.#concurrency < 1) {
      throw new TypeError("Run executor concurrency must be a positive integer")
    }
  }

  async start(): Promise<void> {
    if (this.#stopping !== null) await this.#stopping
    if (this.#running) return
    this.#running = true
    this.#observationAbortController = new AbortController()
    for (const run of this.#store.listRecoverableRuns()) this.#pending.add(run.id)
    for (const run of this.#store.listClaimableRuns(this.#concurrency * 2))
      this.#pending.add(run.id)
    this.#interval = setInterval(() => this.#scan(), this.#pollMs)
    this.#pump()
  }

  async stop(): Promise<void> {
    if (this.#stopping !== null) return this.#stopping
    const stopping = this.#stopInternal()
    this.#stopping = stopping
    try {
      await stopping
    } finally {
      if (this.#stopping === stopping) this.#stopping = null
    }
  }

  async #stopInternal(): Promise<void> {
    this.#running = false
    if (this.#interval !== null) clearInterval(this.#interval)
    this.#interval = null
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
    this.#pending.clear()
    // Observation cancellation only releases provider streams. It deliberately
    // does not signal runners: control-plane shutdown remains recoverable.
    this.#observationAbortController?.abort(new ControlPlaneStopped())
    this.#observationAbortController = null
    while (this.#active.size > 0 || this.#background.size > 0) {
      await Promise.allSettled([...this.#active.values(), ...this.#background])
    }
  }

  health(): ComponentHealth {
    if (!this.#running) return { status: "unavailable", message: "Run executor is stopped" }
    return this.#lastFailure === null
      ? { status: "healthy" }
      : { status: "degraded", message: this.#lastFailure }
  }

  enqueue(runId: string): void {
    this.#pending.add(runId)
    this.#pump()
  }

  async cancel(input: { readonly runId: string; readonly context: RequestContext }): Promise<void> {
    const run = this.#store.getRun(input.context.ownerId, input.runId)
    if (run === null) throw new AppError({ code: "NOT_FOUND", message: "Run not found" })
    const command = { run, context: input.context }
    if (this.#telemetry === undefined) return this.#cancelInternal(command)
    const started = this.#clock().getTime()
    return this.#telemetry.span(
      "meanwhile.run.cancel",
      { "run.id": run.id, "run.status": run.status },
      async (span) => {
        const scope = span.child({
          requestId: input.context.requestId,
          ownerId: run.ownerId,
          runId: run.id,
        })
        try {
          await this.#cancelInternal(command, scope)
          const current = this.#store.getRunInternal(run.id)
          if (current !== null) {
            span.setAttributes({
              "run.status": current.status,
              "run.status_version": current.statusVersion,
            })
          }
          span.setOutcome("succeeded")
        } finally {
          this.#telemetry?.metrics.record(
            "meanwhile.run.cancellation.duration",
            Math.max(0, this.#clock().getTime() - started),
            { agent: run.agentType, provider: run.provider },
          )
        }
      },
    )
  }

  async #cancelInternal(
    input: { readonly run: Run; readonly context: RequestContext },
    scope?: TelemetryScope,
  ): Promise<void> {
    await this.#claimCancellation(input.run, input.context, scope)
  }

  async #claimCancellation(
    run: Run,
    context?: RequestContext,
    scope?: TelemetryScope,
  ): Promise<void> {
    const at = this.#now()
    const requestId = context?.requestId ?? `system:${this.#id()}`
    const claim = this.#store.claimRunOutcome({
      kind: "cancel",
      ownerId: run.ownerId,
      runId: run.id,
      at,
      requestAudit: {
        actorApiKeyId: context?.apiKeyId ?? null,
        action: "run.cancel_request",
        requestId,
        traceId: context?.traceId ?? null,
        metadata: { status: run.status },
      },
      resultAudit: {
        actorApiKeyId: context?.apiKeyId ?? null,
        action: "run.cancelled",
        requestId,
        traceId: context?.traceId ?? null,
        metadata: { from: run.status, to: "cancelled" },
      },
      systemLog: { eventType: "run.cancelled", data: "Run cancelled" },
    })
    if (claim?.outcome !== "claimed") return
    this.#recordOutcomeMetrics(run, claim.run)
    this.#clearDeadline(run.id)
    await this.#signalRunner(run.id, scope, "run.cancel_signal_failed")
    await this.#stopRuntime(run.id, context, scope)
  }

  #scan(): void {
    if (!this.#running) return
    for (const run of this.#store.listClaimableRuns(this.#concurrency * 2))
      this.#pending.add(run.id)
    this.#pump()
  }

  #pump(): void {
    if (!this.#running) return
    while (this.#active.size < this.#concurrency) {
      const runId = this.#pending.values().next().value as string | undefined
      if (runId === undefined) break
      this.#pending.delete(runId)
      if (this.#active.has(runId)) continue
      const task = this.#execute(runId)
        .catch((error: unknown) => {
          const normalized = normalizeError(error)
          this.#lastFailure = normalized.code
          this.#logger.error("run.execution_failed", normalized.message, {
            runId,
            code: normalized.code,
          })
        })
        .finally(() => {
          this.#active.delete(runId)
          this.#clearDeadline(runId)
          this.#pump()
        })
      this.#active.set(runId, task)
    }
  }

  async #execute(runId: string): Promise<void> {
    const run = this.#store.getRunInternal(runId)
    if (this.#telemetry === undefined || run === null) return this.#executeInternal(runId)
    return this.#telemetry.span(
      "meanwhile.run.execute",
      { "run.id": run.id, "agent.type": run.agentType, "provider.name": run.provider },
      async (span) => {
        const scope = span.child({ ownerId: run.ownerId, runId: run.id })
        await this.#executeInternal(runId, scope)
        this.#setRunSpanOutcome(span, runId)
      },
    )
  }

  async #executeInternal(runId: string, scope?: TelemetryScope): Promise<void> {
    let run = this.#store.getRunInternal(runId)
    if (run === null || isTerminalRunStatus(run.status)) return
    if (run.status === "queued") {
      const at = this.#now()
      const deadlineAt = new Date(this.#clock().getTime() + run.timeoutMs).toISOString()
      const claimed = this.#store.claimRunProvisioning({
        runId,
        expectedVersion: run.statusVersion,
        at,
        deadlineAt,
        audit: this.#transitionAudit(run, "run.provision"),
        systemLog: { eventType: "run.provisioning", data: "Provisioning runtime" },
      })
      if (claimed === null) return
      run = claimed
      this.#telemetry?.metrics.record(
        "meanwhile.run.queue.duration",
        Math.max(0, this.#clock().getTime() - Date.parse(run.createdAt)),
        { agent: run.agentType, provider: run.provider },
      )
    }
    if (run.deadlineAt === null) {
      await this.#fail(
        run.id,
        new AppError({ code: "INTERNAL", message: "Run deadline is missing" }),
      )
      return
    }
    let persistedTerminal: RunnerTerminalPayload | null
    try {
      persistedTerminal = this.#readTerminalReservation(run)
    } catch (error) {
      await this.#fail(run.id, error)
      return
    }
    if (persistedTerminal === null && Date.parse(run.deadlineAt) <= this.#clock().getTime()) {
      await this.#timeout(run.id, scope)
      return
    }
    if (persistedTerminal === null) this.#scheduleDeadline(run.id, run.deadlineAt)

    try {
      await this.#provisionOrReconnect(run, scope)
    } catch (error) {
      if (!this.#running) return
      await this.#fail(run.id, error)
    }
  }

  async #provisionOrReconnect(run: Run, scope?: TelemetryScope): Promise<void> {
    this.#assertRunning()
    const baseProvider = this.#providers.get(run.provider)
    const credentialBroker = this.#providers.credentialBroker(run.provider)
    assertProviderProvenance(run.executionProvenance, baseProvider)
    const provider =
      scope === undefined
        ? baseProvider
        : observeRuntimeProvider(baseProvider, scope, { runId: run.id }, () =>
            this.#clock().getTime(),
          )
    let runtimeRecord = this.#store.getRuntimeForRun(run.id)
    const reconnecting = runtimeRecord !== null
    let session = this.#store.getRunnerSession(run.id)

    // A validated terminal frame durably reserves the runner outcome before
    // artifact capture. Disposable compute is useful only for that capture;
    // losing it must not replace the reserved result with RUNTIME_LOST.
    if (session?.terminalResult !== null && session?.terminalResult !== undefined) {
      const terminal = parsePersistedRunnerTerminal(session.terminalResult)
      await this.#finalizePersistedTerminal(run, provider, runtimeRecord, terminal, scope)
      return
    }

    let runtime: RuntimeHandle

    if (runtimeRecord === null) {
      const runtimeId = run.runtimeId ?? `rt-${run.id}`.slice(0, 128)
      const intent = this.#store.ensureRuntimeProvisioningIntent({
        runId: run.id,
        ownerId: run.ownerId,
        runtimeId,
        provider: provider.name,
        at: this.#now(),
      })
      if (intent === null) return
      const provisioning = this.#store.claimRuntimeProvisioning(runtimeId, this.#now(), "active")
      if (provisioning === null) {
        const current = this.#store.getRunInternal(run.id)
        if (current !== null && isTerminalRunStatus(current.status)) return
        throw new AppError({
          code: "INTERNAL",
          message: "Runtime provisioning intent could not be claimed",
        })
      }
      try {
        runtime = await provider.create({ runtimeId })
      } catch (error) {
        const at = this.#now()
        const normalized = normalizeError(error)
        this.#store.failRuntimeProvisioning({
          runtimeId,
          error: normalized.toStructuredError(),
          at,
          nextAttemptAt: at,
          audit: this.#audit({
            ownerId: run.ownerId,
            actorApiKeyId: null,
            action: "runtime.create_failed",
            resourceType: "runtime",
            resourceId: runtimeId,
            requestId: `system:${this.#id()}`,
            traceId: null,
            metadata: { runId: run.id, provider: provider.name, code: normalized.code },
            at,
          }),
        })
        throw error
      }
      const at = this.#now()
      runtimeRecord = this.#store.materializeRuntimeProvisioning(
        {
          id: runtimeId,
          ownerId: run.ownerId,
          runId: run.id,
          provider: provider.name,
          handle: jsonObject(runtime),
          processHandle: null,
          cleanupStatus: "pending",
          cleanupAttempts: 0,
          cleanupLastError: null,
          cleanupNextAttemptAt: null,
          createdAt: at,
          updatedAt: at,
          destroyedAt: null,
        },
        this.#audit({
          ownerId: run.ownerId,
          actorApiKeyId: null,
          action: "runtime.create",
          resourceType: "runtime",
          resourceId: runtimeId,
          requestId: `system:${this.#id()}`,
          traceId: null,
          metadata: { runId: run.id, provider: provider.name },
          at,
        }),
      )
      this.#assertRunning()
    } else {
      runtime = restoreRuntimeHandle(runtimeRecord.handle)
      const runtimeState = await provider.inspect(runtime)
      if (runtimeState.status === "missing") throw runtimeLost(provider.name, "runtime")
      this.#assertRunning()
    }

    await this.#startRuntime(run, provider, runtimeRecord.id, runtime)

    let process: ProcessHandle
    if (runtimeRecord.processHandle !== null && session !== null) {
      if (reconnecting && !provider.capabilities.processRecovery) {
        throw runtimeLost(provider.name, "process")
      }
      if (
        reconnecting &&
        !provider.capabilities.eventReplay &&
        (session.providerCursor !== null || session.runnerSequence > 0)
      ) {
        throw runtimeLost(provider.name, "event_replay")
      }
      process = restoreProcessHandle(runtimeRecord.processHandle)
      let processState: Awaited<ReturnType<RuntimeProvider["inspectProcess"]>>
      try {
        processState = await provider.inspectProcess(process)
      } catch (error) {
        if (isMissingProcess(error)) throw runtimeLost(provider.name, "process")
        throw error
      }
      if (processState.status === "missing") throw runtimeLost(provider.name, "process")
    } else {
      await this.#span(
        scope,
        "meanwhile.workspace.prepare",
        { "run.id": run.id, "provider.name": provider.name },
        () => this.#prepareWorkspace(run, provider, runtime),
      )
      this.#assertRunning()
      const current = this.#store.getRunInternal(run.id)
      if (current === null || isTerminalRunStatus(current.status)) return
      const processId = `runner-${run.id}`.slice(0, 128)
      const launch = this.#store.ensureRunProcessLaunchIntent({
        runId: run.id,
        ownerId: run.ownerId,
        runtimeId: runtimeRecord.id,
        processId,
        timeoutBudgetMs: Math.max(
          1,
          Date.parse(run.deadlineAt as string) - this.#clock().getTime(),
        ),
        createdAt: this.#now(),
      })
      if (launch === null) return
      const resolvedSecrets = await this.#secrets.resolve(
        run.secretRefs,
        secretScope(run.ownerId, "agent", run.id),
      )
      let secrets = resolvedSecrets
      try {
        secrets = await attachAgentCredentialLease(this.#store, {
          ownerId: run.ownerId,
          resourceType: "run",
          resourceId: run.id,
          runtimeId: runtimeRecord.id,
          runtime,
          providerName: provider.name,
          credentialBroker,
          agentSpec: run.agentSpec,
          secrets: resolvedSecrets,
          at: this.#now(),
        })
        const timeoutBudgetMs = launch.timeoutBudgetMs
        const spec: RunnerSpec = {
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          runId: run.id,
          runnerSessionId: processId,
          agent: {
            executable: run.agentSpec.executable,
            args: [...run.agentSpec.args],
            workingDirectory: run.agentSpec.workingDirectory,
          },
          prompt: run.prompt,
          permissionPolicy:
            run.agentSpec.permissionPolicy.mode === "deny-all"
              ? { mode: "deny-all" }
              : {
                  mode: "allow-once",
                  toolKinds: [...run.agentSpec.permissionPolicy.toolKinds],
                },
          artifactPaths: [...run.artifactPaths],
          timeoutBudgetMs,
          environment: { ...run.env },
          credentialEnvironmentNames: Object.keys(secrets.environment),
        }
        process = await this.#span(
          scope,
          "meanwhile.runner.launch",
          { "run.id": run.id, "provider.name": provider.name, "process.id": processId },
          () =>
            this.#runner.start({
              provider,
              runtime,
              processId,
              spec,
              credentialEnvironment: secrets.environment,
              timeoutMs: timeoutBudgetMs,
              terminationGraceMs: PROCESS_TERMINATION_GRACE_MS,
            }),
        )
        const at = this.#now()
        this.#store.materializeRunProcessLaunch({
          runId: run.id,
          ownerId: run.ownerId,
          runtimeId: runtimeRecord.id,
          processId,
          processHandle: jsonObject(process),
          at,
          audit: this.#audit({
            ownerId: run.ownerId,
            actorApiKeyId: null,
            action: "runtime.process_start",
            resourceType: "runtime",
            resourceId: runtimeRecord.id,
            requestId: `system:${this.#id()}`,
            traceId: null,
            metadata: { runId: run.id, processId },
            at,
          }),
        })
        session = this.#store.createRunnerSession({
          runId: run.id,
          ownerId: run.ownerId,
          runnerSessionId: processId,
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          createdAt: at,
        })
        this.#assertRunning()
        await this.#consume(
          run,
          provider,
          runtime,
          process,
          session,
          secrets,
          resolvedSecrets.environment,
          scope,
        )
      } finally {
        await secrets.release()
      }
      return
    }

    const resolvedRecoverySecrets = await this.#secrets.resolve(
      run.secretRefs,
      secretScope(run.ownerId, "agent", run.id),
    )
    let recoverySecrets = resolvedRecoverySecrets
    try {
      recoverySecrets = await attachAgentCredentialLease(this.#store, {
        ownerId: run.ownerId,
        resourceType: "run",
        resourceId: run.id,
        runtimeId: runtimeRecord.id,
        runtime,
        providerName: provider.name,
        credentialBroker,
        agentSpec: run.agentSpec,
        secrets: resolvedRecoverySecrets,
        at: this.#now(),
      })
      try {
        await this.#consume(
          run,
          provider,
          runtime,
          process,
          session,
          recoverySecrets,
          resolvedRecoverySecrets.environment,
          scope,
        )
      } catch (error) {
        if (reconnecting && isMissingProcess(error)) {
          throw runtimeLost(provider.name, "process")
        }
        throw error
      }
    } finally {
      await recoverySecrets.release()
    }
  }

  #readTerminalReservation(run: Run): RunnerTerminalPayload | null {
    const session = this.#store.getRunnerSession(run.id)
    if (session === null) return null
    if (session.terminalResult !== null) {
      return parsePersistedRunnerTerminal(session.terminalResult)
    }
    if (this.#store.hasUnreservedRunnerTerminalEvidence(run.id, session.runnerSessionId)) {
      throw new AppError({
        code: "DATABASE_INTEGRITY_FAILED",
        message: "Runner terminal evidence is missing its atomic reservation",
      })
    }
    return null
  }

  async #startRuntime(
    run: Run,
    provider: RuntimeProvider,
    runtimeId: string,
    runtime: RuntimeHandle,
  ): Promise<void> {
    await provider.start(runtime)
    this.#store.ensureRuntimeStartedAudit(
      this.#audit({
        ownerId: run.ownerId,
        actorApiKeyId: null,
        action: "runtime.start",
        resourceType: "runtime",
        resourceId: runtimeId,
        requestId: `system:${this.#id()}`,
        traceId: null,
        metadata: { runId: run.id, provider: provider.name },
        at: this.#now(),
      }),
    )
    this.#assertRunning()
  }

  async #finalizePersistedTerminal(
    initialRun: Run,
    provider: RuntimeProvider,
    runtimeRecord: ReturnType<Store["getRuntimeForRun"]>,
    terminal: RunnerTerminalPayload,
    scope?: TelemetryScope,
  ): Promise<void> {
    let current = this.#store.getRunInternal(initialRun.id)
    this.#assertTerminalCanFinalize(current, terminal)
    if (current === null || isTerminalRunStatus(current.status)) return

    if (current.artifactPaths.length > 0) {
      const captureSignal = this.#artifactCaptureSignal(current)
      let runtime: RuntimeHandle | null = null
      let unavailableReason = "RUNTIME_MISSING"
      let captureFailure: string | null = null
      if (runtimeRecord !== null) {
        try {
          captureSignal.throwIfAborted()
          const candidate = restoreRuntimeHandle(runtimeRecord.handle)
          const state = await provider.inspect(candidate, captureSignal)
          captureSignal.throwIfAborted()
          if (state.status === "running") {
            runtime = candidate
          } else if (state.status === "missing") {
            unavailableReason = "RUNTIME_MISSING"
          } else {
            unavailableReason = "RUNTIME_NOT_RUNNING"
          }
        } catch (error) {
          if (error instanceof ControlPlaneStopped) throw error
          if (captureSignal.aborted && captureSignal.reason instanceof ControlPlaneStopped) {
            throw captureSignal.reason
          }
          captureFailure = artifactCaptureErrorCode(error, captureSignal)
          if (captureFailure !== "ARTIFACT_CAPTURE_TIMED_OUT") {
            unavailableReason = isMissingRuntime(error) ? "RUNTIME_MISSING" : "RUNTIME_UNAVAILABLE"
            captureFailure = null
            this.#logger.warn(
              "artifact.capture_unavailable",
              "Persisted runner result could not access its disposable runtime",
              {
                runId: current.id,
                provider: provider.name,
                code: normalizeError(error).code,
              },
            )
          }
        }
      }

      if (captureFailure !== null) {
        this.#recordArtifactCaptureFailed(current, captureFailure)
      } else if (runtime === null) {
        this.#recordArtifactCaptureUnavailable(current, unavailableReason)
      } else {
        await this.#collectArtifacts(current, provider, runtime, scope, captureSignal)
      }
    }

    if (!this.#running) return
    current = this.#store.getRunInternal(initialRun.id)
    if (current === null || isTerminalRunStatus(current.status)) return
    await this.#claimRunnerTerminal(current, terminal, terminal.agentExit?.exitCode)
  }

  async #prepareWorkspace(
    run: Run,
    provider: RuntimeProvider,
    runtime: RuntimeHandle,
  ): Promise<void> {
    let repositoryCredential: string | undefined
    let repositorySecrets: ResolvedSecretMaterial | null = null
    if (run.workspace.type === "repository" && run.workspace.credentialRef !== undefined) {
      repositorySecrets = await this.#secrets.resolve(
        { MEANWHILE_REPOSITORY_CREDENTIAL: run.workspace.credentialRef },
        secretScope(run.ownerId, "repository", run.id),
      )
      repositoryCredential = repositorySecrets.environment["MEANWHILE_REPOSITORY_CREDENTIAL"]
    }
    try {
      const prepared = await this.#workspace.prepare({
        ownerId: run.ownerId,
        runId: run.id,
        source: run.workspace,
        provider,
        runtime,
        ...(repositoryCredential === undefined ? {} : { repositoryCredential }),
        // Workspace helper process IDs are stable across restart, so their
        // complete spawn specs must be stable too. The absolute run deadline
        // remains the control-plane owner; this is only the provider hard-stop
        // ceiling for an otherwise orphaned helper process.
        timeoutMs: run.timeoutMs,
        terminationGraceMs: PROCESS_TERMINATION_GRACE_MS,
        signal: this.#observationSignal(),
        emit: async (event) => {
          const data = repositorySecrets?.redactor.redactString(event.data) ?? event.data
          const log = this.#appendOutput(run, event.stream, event.event, data, event.timestamp)
          this.#logger
            .child({ ownerId: run.ownerId, runId: run.id })
            .debug("workspace.command", "Workspace preparation output accepted", {
              stream: event.stream,
              bytes: utf8ByteLength(data),
              ...(log === null ? {} : { sequence: log.sequence }),
            })
        },
      })
      if (prepared.resolvedRevision !== null) {
        this.#store.setRunResolvedRevision(
          run.id,
          prepared.resolvedRevision.toLowerCase(),
          this.#now(),
        )
      }
      this.#appendSystem(run, "workspace.ready", "Workspace prepared", this.#now())
    } finally {
      await repositorySecrets?.release()
    }
  }

  async #consume(
    initialRun: Run,
    provider: RuntimeProvider,
    runtime: RuntimeHandle,
    process: ProcessHandle,
    session: NonNullable<ReturnType<Store["getRunnerSession"]>>,
    secrets: Pick<ResolvedSecretMaterial, "environment" | "redactor">,
    resolvedCredentialValues: Readonly<Record<string, string>>,
    scope?: TelemetryScope,
  ): Promise<void> {
    const { redactor } = secrets
    let acceptedSequence = session.runnerSequence
    let acceptedTerminal: RunnerTerminalPayload | undefined
    if (session.terminalResult !== null) {
      acceptedTerminal = parsePersistedRunnerTerminal(session.terminalResult)
    }
    const result = await this.#span(
      scope,
      "meanwhile.runner.session",
      {
        "run.id": initialRun.id,
        "provider.name": provider.name,
        "session.id": session.runnerSessionId,
      },
      () =>
        this.#runner.consume({
          provider,
          process,
          runId: initialRun.id,
          runnerSessionId: session.runnerSessionId,
          cursor: session.providerCursor,
          lastSequence: session.runnerSequence,
          signal: this.#observationSignal(),
          ...(acceptedTerminal === undefined ? {} : { terminal: acceptedTerminal }),
          onFrame: async (frame, cursor) => {
            if (!this.#running) throw new ControlPlaneStopped()
            const terminalPayload =
              frame.type === "terminal"
                ? sanitizeRunnerTerminal(frame.payload, redactor)
                : undefined
            const payload = terminalPayload ?? redactor.redact(frame.payload)
            const data = JSON.stringify(payload)
            const transitionAt = this.#now()
            const accepted = this.#store.acceptRunnerFrame({
              ownerId: initialRun.ownerId,
              runId: initialRun.id,
              protocolVersion: session.protocolVersion,
              providerCursor: cursor,
              stream: streamForFrame(frame),
              eventType: frame.type,
              data,
              runnerSessionId: frame.runnerSessionId,
              runnerSequence: frame.sequence,
              ...(terminalPayload === undefined
                ? {}
                : { terminalResult: jsonObject(terminalPayload) }),
              createdAt: transitionAt,
              ...(frame.type === "session.started"
                ? {
                    runningTransition: {
                      at: transitionAt,
                      reason: "agent.session_started",
                      audit: this.#transitionAudit(initialRun, "agent.start"),
                      systemLog: {
                        eventType: "run.running",
                        data: "Agent session started",
                      },
                    },
                  }
                : {}),
            })
            if (accepted.accepted) {
              this.#telemetry?.metrics.increment("meanwhile.log.chunks", 1, {
                agent: initialRun.agentType,
                provider: provider.name,
              })
              this.#telemetry?.metrics.increment("meanwhile.log.bytes", utf8ByteLength(data), {
                agent: initialRun.agentType,
                provider: provider.name,
              })
            }
            acceptedSequence = frame.sequence
            if (terminalPayload !== undefined && accepted.terminalDisposition === "reserved") {
              acceptedTerminal = terminalPayload
              this.#clearDeadline(initialRun.id)
            }
            if (frame.type === "session.started" && accepted.accepted) {
              const provisioningAt = this.#store
                .listRunStatusEvents(accepted.run.ownerId, accepted.run.id)
                .find(({ toStatus }) => toStatus === "provisioning")?.createdAt
              this.#telemetry?.metrics.record(
                "meanwhile.run.provision.duration",
                Math.max(
                  0,
                  this.#clock().getTime() - Date.parse(provisioningAt ?? accepted.run.updatedAt),
                ),
                { agent: accepted.run.agentType, provider: accepted.run.provider },
              )
            }
          },
          onCursor: async (cursor) => {
            if (!this.#running) throw new ControlPlaneStopped()
            this.#store.advanceRunnerProviderCursor({
              runId: initialRun.id,
              ownerId: initialRun.ownerId,
              runnerSessionId: session.runnerSessionId,
              protocolVersion: session.protocolVersion,
              providerCursor: cursor,
              runnerSequence: acceptedSequence,
              updatedAt: this.#now(),
            })
          },
          onDiagnostic: (diagnostic) => {
            const data = redactor.redactString(diagnostic.data)
            const log = this.#appendOutput(
              initialRun,
              "stderr",
              "runner.diagnostic",
              data,
              diagnostic.timestamp,
            )
            this.#logger
              .child({
                ownerId: initialRun.ownerId,
                runId: initialRun.id,
                sessionId: session.runnerSessionId,
              })
              .debug("runner.diagnostic", "Runner diagnostic output accepted", {
                bytes: utf8ByteLength(data),
                cursorPresent: diagnostic.cursor.length > 0,
                ...(log === null ? {} : { sequence: log.sequence }),
              })
          },
        }),
    )

    if (!this.#running) return
    if (acceptedTerminal === undefined) {
      const current = this.#store.getRunInternal(initialRun.id)
      if (current !== null && isTerminalRunStatus(current.status)) return
      throw new AppError({
        code: "RUNNER_PROTOCOL_ERROR",
        message: "Runner completion did not produce accepted terminal evidence",
      })
    }
    let current = this.#store.getRunInternal(initialRun.id)
    this.#assertTerminalCanFinalize(current, acceptedTerminal)
    if (current === null || isTerminalRunStatus(current.status)) return
    const artifactSecretValues = Object.fromEntries(
      [...Object.values(resolvedCredentialValues), ...Object.values(secrets.environment)].map(
        (value, index) => [`credential-${index}`, value],
      ),
    )
    try {
      await this.#collectArtifacts(
        current,
        provider,
        runtime,
        scope,
        undefined,
        artifactSecretValues,
      )
    } finally {
      for (const name of Object.keys(artifactSecretValues)) artifactSecretValues[name] = ""
    }
    if (!this.#running) return
    current = this.#store.getRunInternal(initialRun.id)
    if (current === null || isTerminalRunStatus(current.status)) return
    await this.#claimRunnerTerminal(
      current,
      acceptedTerminal,
      acceptedTerminal.agentExit?.exitCode ?? result.exitCode,
    )
  }

  #assertTerminalCanFinalize(run: Run | null, terminal: RunnerTerminalPayload): void {
    if (run?.status === "provisioning" && terminal.outcome === "succeeded") {
      throw new AppError({
        code: "RUNNER_PROTOCOL_ERROR",
        message: "A successful runner result lacked accepted session-start evidence",
      })
    }
  }

  #recordArtifactCaptureUnavailable(run: Run, reason: string): void {
    this.#store.appendRunLogNext({
      ownerId: run.ownerId,
      runId: run.id,
      stream: "system",
      eventType: "artifact.capture_unavailable",
      data: JSON.stringify({ code: "ARTIFACT_CAPTURE_UNAVAILABLE", reason }),
      createdAt: this.#now(),
    })
  }

  #recordArtifactCaptureFailed(run: Run, code: string): void {
    this.#store.appendRunLogNext({
      ownerId: run.ownerId,
      runId: run.id,
      stream: "system",
      eventType: "artifact.capture_failed",
      data: JSON.stringify({ code }),
      createdAt: this.#now(),
    })
  }

  #artifactCaptureSignal(run: Run): AbortSignal {
    if (run.deadlineAt === null) {
      throw new AppError({ code: "INTERNAL", message: "Run deadline is missing" })
    }
    const remainingMs = Date.parse(run.deadlineAt) - this.#clock().getTime()
    const deadlineSignal =
      remainingMs <= 0
        ? AbortSignal.abort(new DOMException("Artifact capture deadline elapsed", "TimeoutError"))
        : AbortSignal.timeout(remainingMs)
    return AbortSignal.any([this.#observationSignal(), deadlineSignal])
  }

  async #collectArtifacts(
    run: Run,
    provider: RuntimeProvider,
    runtime: RuntimeHandle,
    scope?: TelemetryScope,
    signal?: AbortSignal,
    knownSecretValues?: Readonly<Record<string, string>>,
  ): Promise<void> {
    if (run.artifactPaths.length === 0) return
    const captureSignal = signal ?? this.#artifactCaptureSignal(run)
    await this.#span(
      scope,
      "meanwhile.artifact.collect",
      { "run.id": run.id, "provider.name": provider.name },
      async (span) => {
        const failure = await this.#collectArtifactsInternal(
          run,
          provider,
          runtime,
          captureSignal,
          knownSecretValues,
        )
        if (failure === null) span?.setOutcome("succeeded")
        else span?.setOutcome("failed", stableTelemetryCode(failure))
      },
    )
  }

  async #collectArtifactsInternal(
    run: Run,
    provider: RuntimeProvider,
    runtime: RuntimeHandle,
    signal: AbortSignal,
    knownSecretValues?: Readonly<Record<string, string>>,
  ): Promise<string | null> {
    const values: Record<string, string> = {}
    // Recovery may need to reacquire the durable run's credential boundary;
    // live execution passes the exact resolved values and issued placeholders.
    let secrets: ResolvedSecretMaterial | null = null
    try {
      signal.throwIfAborted()
      if (knownSecretValues === undefined) {
        secrets = await this.#secrets.resolve(
          run.secretRefs,
          secretScope(run.ownerId, "agent", run.id),
        )
        Object.assign(values, secrets.environment)
      } else {
        Object.assign(values, knownSecretValues)
      }
      const collector = new ArtifactCollector({
        store: this.#artifactStore,
        limits: this.#artifactLimits,
        scanner: new ExactSecretArtifactScanner(values),
        now: this.#clock,
      })
      const artifacts = await collector.collect({
        ownerId: run.ownerId,
        runId: run.id,
        declaredPaths: run.artifactPaths,
        workspace: new ProviderArtifactWorkspace(provider, runtime),
        signal,
      })
      signal.throwIfAborted()
      this.#store.insertArtifacts(
        artifacts.map((collected) => artifactMetadata(collected) as Artifact),
      )
      signal.throwIfAborted()
      for (const collected of artifacts) {
        this.#telemetry?.metrics.increment("meanwhile.artifact.count", 1, {
          "artifact.kind": collected.kind,
        })
        this.#telemetry?.metrics.increment("meanwhile.artifact.bytes", collected.size, {
          "artifact.kind": collected.kind,
        })
      }
    } catch (error) {
      if (error instanceof ControlPlaneStopped) throw error
      if (signal.aborted && signal.reason instanceof ControlPlaneStopped) {
        throw signal.reason
      }
      const at = this.#now()
      if (error instanceof ArtifactCollectionError && error.code === "ARTIFACT_SECRET_DETECTED") {
        this.#store.insertAudit(
          this.#audit({
            ownerId: run.ownerId,
            actorApiKeyId: null,
            action: "artifact.capture_rejected",
            resourceType: "artifact",
            resourceId: run.id,
            requestId: `system:${this.#id()}`,
            traceId: null,
            metadata: { runId: run.id, code: error.code },
            at,
          }),
        )
      }
      const code = artifactCaptureErrorCode(error, signal)
      this.#recordArtifactCaptureFailed(run, code)
      return code
    } finally {
      await secrets?.release()
      for (const key of Object.keys(values)) values[key] = ""
    }
    return null
  }

  async #fail(runId: string, error: unknown): Promise<void> {
    const normalized = normalizeError(error)
    const current = this.#store.getRunInternal(runId)
    if (current === null || isTerminalRunStatus(current.status)) return
    const at = this.#now()
    const claim = this.#store.claimRunOutcome({
      kind: "control_plane_failure",
      ownerId: current.ownerId,
      runId,
      status: "failed",
      at,
      error: normalized.toStructuredError(),
      resultAudit: {
        actorApiKeyId: null,
        action: "run.failed",
        requestId: `system:${this.#id()}`,
        traceId: null,
        metadata: { from: current.status, to: "failed" },
      },
      systemLog: { eventType: "run.failed", data: "Run failed" },
    })
    if (claim?.outcome === "claimed") {
      this.#recordOutcomeMetrics(current, claim.run)
      this.#clearDeadline(runId)
    }
  }

  async #timeout(runId: string, scope?: TelemetryScope): Promise<void> {
    const initial = this.#store.getRunInternal(runId)
    if (scope === undefined && this.#telemetry !== undefined && initial !== null) {
      return this.#telemetry.span(
        "meanwhile.run.timeout",
        { "run.id": initial.id, "run.status": initial.status },
        async (span) => {
          await this.#timeoutInternal(
            runId,
            span.child({ ownerId: initial.ownerId, runId: initial.id }),
          )
          const current = this.#store.getRunInternal(runId)
          if (current !== null) {
            span.setAttributes({
              "run.status": current.status,
              "run.status_version": current.statusVersion,
            })
          }
          span.setOutcome(current?.status === "timed_out" ? "timed_out" : "interrupted")
        },
      )
    }
    return this.#timeoutInternal(runId, scope)
  }

  async #timeoutInternal(runId: string, scope?: TelemetryScope): Promise<void> {
    const current = this.#store.getRunInternal(runId)
    if (current === null || isTerminalRunStatus(current.status)) return
    const at = this.#now()
    const claim = this.#store.claimRunOutcome({
      kind: "timeout",
      ownerId: current.ownerId,
      runId,
      at,
      resultAudit: {
        actorApiKeyId: null,
        action: "run.timed_out",
        requestId: `system:${this.#id()}`,
        traceId: null,
        metadata: { from: current.status, to: "timed_out" },
      },
      systemLog: { eventType: "run.timed_out", data: "Run timed_out" },
    })
    if (claim?.outcome !== "claimed") return
    this.#recordOutcomeMetrics(current, claim.run)
    this.#clearDeadline(runId)
    if (claim.run.deadlineAt !== null) {
      this.#telemetry?.metrics.record(
        "meanwhile.run.timeout.latency",
        Math.max(0, this.#clock().getTime() - Date.parse(claim.run.deadlineAt)),
        { agent: claim.run.agentType, provider: claim.run.provider },
      )
    }
    await this.#signalRunner(runId, scope, "run.timeout_signal_failed")
    await this.#stopRuntime(runId, undefined, scope)
  }

  async #claimRunnerTerminal(
    current: Run,
    terminal: RunnerTerminalPayload,
    exitCode?: number | null,
  ): Promise<Run | null> {
    const at = this.#now()
    const status = statusForTerminal(terminal)
    const claim = this.#store.claimRunOutcome({
      kind: "runner",
      ownerId: current.ownerId,
      runId: current.id,
      status,
      terminalResult: jsonObject(terminal),
      at,
      error: terminalError(terminal),
      ...(exitCode === undefined ? {} : { exitCode }),
      systemLog: { eventType: `runner.${status}`, data: `Run ${status}` },
      resultAudit: {
        actorApiKeyId: null,
        action: `runner.${status}`,
        requestId: `system:${this.#id()}`,
        traceId: null,
        metadata: { from: current.status, to: status },
      },
    })
    if (claim?.outcome !== "claimed") return claim?.run ?? null
    this.#recordOutcomeMetrics(current, claim.run)
    this.#clearDeadline(current.id)
    return claim.run
  }

  async #signalRunner(
    runId: string,
    scope: TelemetryScope | undefined,
    event: string,
  ): Promise<void> {
    const runtime = this.#store.getRuntimeForRun(runId)
    if (runtime?.processHandle === null || runtime?.processHandle === undefined) return
    try {
      const baseProvider = this.#providers.get(runtime.provider)
      const provider =
        scope === undefined
          ? baseProvider
          : observeRuntimeProvider(baseProvider, scope, { runId }, () => this.#clock().getTime())
      await this.#runner.cancel(provider, restoreProcessHandle(runtime.processHandle))
    } catch (error) {
      this.#logger.warn(event, "Runner cancellation signal failed", {
        runId,
        error: normalizeError(error).code,
      })
    }
  }

  #recordOutcomeMetrics(previous: Run, terminal: Run): void {
    if (!isTerminalRunStatus(terminal.status)) return
    this.#telemetry?.metrics.increment("meanwhile.run.outcomes", 1, {
      agent: previous.agentType,
      provider: previous.provider,
      outcome: terminal.status,
    })
    this.#telemetry?.metrics.record(
      "meanwhile.run.duration",
      Math.max(0, this.#clock().getTime() - Date.parse(previous.createdAt)),
      { agent: previous.agentType, provider: previous.provider, outcome: terminal.status },
    )
  }

  async #stopRuntime(
    runId: string,
    context?: RequestContext,
    scope?: TelemetryScope,
  ): Promise<void> {
    const runtime = this.#store.getRuntimeForRun(runId)
    if (runtime === null) return
    try {
      const baseProvider = this.#providers.get(runtime.provider)
      const provider =
        scope === undefined
          ? baseProvider
          : observeRuntimeProvider(baseProvider, scope, { runId }, () => this.#clock().getTime())
      await provider.stop(restoreRuntimeHandle(runtime.handle))
      this.#store.insertAudit(
        this.#audit({
          ownerId: runtime.ownerId,
          actorApiKeyId: context?.apiKeyId ?? null,
          action: "runtime.stop",
          resourceType: "runtime",
          resourceId: runtime.id,
          requestId: context?.requestId ?? `system:${this.#id()}`,
          traceId: context?.traceId ?? null,
          metadata: { runId },
          at: this.#now(),
        }),
      )
    } catch (error) {
      this.#logger.warn("runtime.stop_failed", "Runtime stop failed", {
        runId,
        code: normalizeError(error).code,
      })
    }
  }

  #scheduleDeadline(runId: string, deadline: string): void {
    this.#clearDeadline(runId)
    const schedule = () => {
      const remaining = Date.parse(deadline) - this.#clock().getTime()
      if (remaining <= 0) {
        if (this.#running) this.#trackBackground(this.#timeout(runId), runId)
        return
      }
      this.#timers.set(runId, setTimeout(schedule, Math.min(remaining, MAX_TIMER_DELAY_MS)))
    }
    schedule()
  }

  #clearDeadline(runId: string): void {
    const timer = this.#timers.get(runId)
    if (timer !== undefined) clearTimeout(timer)
    this.#timers.delete(runId)
  }

  #trackBackground(operation: Promise<void>, runId: string): void {
    const task = operation
      .catch((error: unknown) => {
        const normalized = normalizeError(error)
        this.#lastFailure = normalized.code
        this.#logger.error("run.background_failed", normalized.message, {
          runId,
          code: normalized.code,
        })
      })
      .finally(() => this.#background.delete(task))
    this.#background.add(task)
  }

  #observationSignal(): AbortSignal {
    this.#assertRunning()
    const signal = this.#observationAbortController?.signal
    if (signal === undefined) throw new ControlPlaneStopped()
    return signal
  }

  #assertRunning(): void {
    if (!this.#running) throw new ControlPlaneStopped()
  }

  #appendSystem(run: Run, eventType: string, data: string, createdAt: string): void {
    this.#store.appendRunLogNext({
      ownerId: run.ownerId,
      runId: run.id,
      stream: "system",
      eventType,
      data,
      createdAt,
    })
  }

  #appendOutput(
    run: Run,
    stream: Extract<RunLogStream, "stdout" | "stderr">,
    eventType: string,
    data: string,
    createdAt: string,
  ): ReturnType<Store["appendRunLogNext"]> {
    const log = this.#store.appendRunLogNext({
      ownerId: run.ownerId,
      runId: run.id,
      stream,
      eventType,
      data,
      createdAt,
    })
    if (log !== null) {
      this.#telemetry?.metrics.increment("meanwhile.log.chunks", 1, {
        agent: run.agentType,
        provider: run.provider,
      })
      this.#telemetry?.metrics.increment("meanwhile.log.bytes", utf8ByteLength(data), {
        agent: run.agentType,
        provider: run.provider,
      })
    }
    return log
  }

  #transitionAudit(
    run: Run,
    action: string,
  ): Omit<AuditRecord, "id" | "ownerId" | "resourceType" | "resourceId" | "createdAt"> {
    return {
      actorApiKeyId: null,
      action,
      requestId: `system:${this.#id()}`,
      traceId: null,
      metadata: { runId: run.id, statusVersion: run.statusVersion },
    }
  }

  #audit(input: Omit<AuditRecord, "id" | "createdAt"> & { at: string }): AuditRecord {
    const { at, ...record } = input
    return { ...record, id: this.#id(), createdAt: at }
  }

  #now(): string {
    return this.#clock().toISOString()
  }

  #setRunSpanOutcome(span: OperationSpan, runId: string): void {
    const run = this.#store.getRunInternal(runId)
    if (run === null) {
      span.setOutcome("failed", "RUN_NOT_FOUND")
      return
    }
    span.setAttributes({ "run.status": run.status, "run.status_version": run.statusVersion })
    if (run.status === "succeeded") span.setOutcome("succeeded")
    else if (run.status === "failed") {
      span.setOutcome("failed", stableTelemetryCode(run.error?.code ?? "RUN_FAILED"))
    } else if (run.status === "timed_out") span.setOutcome("timed_out", "RUN_TIMED_OUT")
    else if (run.status === "cancelled") span.setOutcome("cancelled")
    else span.setOutcome("interrupted")
  }

  #span<Value>(
    scope: TelemetryScope | undefined,
    name: string,
    attributes: Parameters<Telemetry["span"]>[1],
    operation: (span?: OperationSpan) => Promise<Value>,
  ): Promise<Value> {
    if (scope !== undefined) return scope.span(name, attributes, operation)
    return this.#telemetry === undefined
      ? operation()
      : this.#telemetry.span(name, attributes, operation)
  }
}

class ProviderArtifactWorkspace implements ArtifactWorkspace {
  constructor(
    private readonly provider: RuntimeProvider,
    private readonly runtime: RuntimeHandle,
  ) {}

  async list(
    path: string,
    limits: { readonly maxEntries: number; readonly maxDepth: number },
    signal: AbortSignal,
  ): Promise<readonly WorkspaceEntry[]> {
    const root = relativePath(path)
    const rootInfo = await this.#stat(root, limits.maxEntries, signal)
    if (rootInfo.type === "file" || rootInfo.type === "symlink") return [toWorkspaceEntry(rootInfo)]

    const result: WorkspaceEntry[] = [toWorkspaceEntry(rootInfo)]
    const queue: { path: ReturnType<typeof relativePath>; depth: number }[] = [
      { path: root, depth: 0 },
    ]
    while (queue.length > 0) {
      const directory = queue.shift()
      if (directory === undefined) break
      const remaining = limits.maxEntries - result.length
      if (remaining <= 0) {
        throw new ArtifactCollectionError(
          "ARTIFACT_LIMIT_EXCEEDED",
          "Artifact workspace exceeded its entry limit.",
          { limit: limits.maxEntries },
        )
      }
      for (const entry of await this.provider.listFiles(
        this.runtime,
        directory.path,
        {
          maxEntries: remaining,
        },
        signal,
      )) {
        const depth = directory.depth + 1
        if (depth > limits.maxDepth) {
          throw new ArtifactCollectionError(
            "ARTIFACT_LIMIT_EXCEEDED",
            "Artifact workspace exceeded its depth limit.",
            { limit: limits.maxDepth, path: entry.path },
          )
        }
        result.push(toWorkspaceEntry(entry))
        if (entry.type === "directory") queue.push({ path: entry.path, depth })
      }
    }
    return result
  }

  readFile(path: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
    return this.provider.readFile(this.runtime, relativePath(path), { maxBytes }, signal)
  }

  async #stat(
    path: ReturnType<typeof relativePath>,
    maxEntries: number,
    signal: AbortSignal,
  ): Promise<RuntimeFileInfo> {
    if (path === ".") {
      return { path, type: "directory", size: 0, modifiedAt: new Date(0).toISOString() }
    }
    const parent = relativePath(posix.dirname(path) === "." ? "." : posix.dirname(path))
    const entries = await this.provider.listFiles(this.runtime, parent, { maxEntries }, signal)
    const found = entries.find((entry) => entry.path === path)
    if (found === undefined) {
      throw new ArtifactCollectionError(
        "ARTIFACT_SOURCE_INCONSISTENT",
        "Declared artifact path does not exist",
        { path },
      )
    }
    return found
  }
}

const toWorkspaceEntry = (entry: RuntimeFileInfo): WorkspaceEntry => ({
  path: entry.path,
  type:
    entry.type === "file" || entry.type === "directory" || entry.type === "symlink"
      ? entry.type
      : "symlink",
  size: entry.type === "directory" ? 0 : entry.size,
})

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength

const stableTelemetryCode = (value: string): string =>
  /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : "INTERNAL"

const artifactCaptureErrorCode = (error: unknown, signal: AbortSignal): string => {
  if (
    signal.aborted &&
    signal.reason instanceof DOMException &&
    signal.reason.name === "TimeoutError"
  ) {
    return "ARTIFACT_CAPTURE_TIMED_OUT"
  }
  return error instanceof ArtifactCollectionError ? error.code : "ARTIFACT_CAPTURE_FAILED"
}

const streamForFrame = (frame: RunnerFrame): RunLogStream => {
  if (frame.type === "agent.stderr") return "stderr"
  if (frame.type === "session.update" || frame.type === "permission.resolved") return "agent"
  return "system"
}

const statusForTerminal = (
  terminal: RunnerTerminalPayload,
): Extract<RunStatus, "succeeded" | "failed" | "cancelled" | "timed_out"> => terminal.outcome

const terminalError = (terminal: RunnerTerminalPayload): StructuredError | null => {
  if (terminal.error === undefined) return null
  return {
    code: terminal.error.code,
    message: terminal.error.message,
    retryable: false,
  }
}

const parsePersistedRunnerTerminal = (value: unknown): RunnerTerminalPayload => {
  const parsed = runnerTerminalPayloadSchema.safeParse(value)
  if (!parsed.success) {
    throw new AppError({
      code: "RUNNER_PROTOCOL_ERROR",
      message: "Persisted runner terminal evidence is invalid",
    })
  }
  return parsed.data
}

const isMissingProcess = (error: unknown): boolean =>
  error instanceof RuntimeProviderError && error.code === "PROCESS_NOT_FOUND"

const isMissingRuntime = (error: unknown): boolean =>
  error instanceof RuntimeProviderError && error.code === "RUNTIME_NOT_FOUND"

const runtimeLost = (provider: string, resource: string): AppError =>
  new AppError({
    code: "RUNTIME_LOST",
    message: "Runtime execution state could not be recovered",
    retryable: false,
    details: { provider, resource },
  })

const secretScope = (ownerId: string, purpose: SecretPurpose, resourceId: string) => ({
  ownerId,
  purpose,
  resourceType: "run" as const,
  resourceId,
})

const jsonObject = (value: object): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject

class ControlPlaneStopped extends Error {
  override readonly name = "ControlPlaneStopped"
}
