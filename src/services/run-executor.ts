import { posix } from "node:path"
import type { RunnerFrame, RunnerSpec, RunnerTerminalPayload } from "../../runner/protocol"
import { RUNNER_PROTOCOL_VERSION, runnerTerminalPayloadSchema } from "../../runner/protocol"
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
import type { EnvironmentSecretResolver, SecretPurpose, SecretRedactor } from "../secrets"
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
  readonly secrets: EnvironmentSecretResolver
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
  readonly #secrets: EnvironmentSecretResolver
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
    const at = this.#now()
    const requestAudit = this.#audit({
      ownerId: input.run.ownerId,
      actorApiKeyId: input.context.apiKeyId,
      action: "run.cancel_request",
      resourceType: "run",
      resourceId: input.run.id,
      requestId: input.context.requestId,
      traceId: input.context.traceId,
      metadata: { status: input.run.status },
      at,
    })
    const current = this.#store.requestCancellation(
      input.run.ownerId,
      input.run.id,
      at,
      requestAudit,
    )
    if (current === null || isTerminalRunStatus(current.status)) return
    if ((this.#store.getRunnerSession(current.id)?.terminalResult ?? null) !== null) return

    const runtime = this.#store.getRuntimeForRun(current.id)
    if (runtime?.processHandle !== null && runtime?.processHandle !== undefined) {
      try {
        const baseProvider = this.#providers.get(runtime.provider)
        const provider =
          scope === undefined
            ? baseProvider
            : observeRuntimeProvider(baseProvider, scope, { runId: current.id }, () =>
                this.#clock().getTime(),
              )
        await this.#runner.cancel(provider, restoreProcessHandle(runtime.processHandle))
      } catch (error) {
        this.#logger.warn("run.cancel_signal_failed", "Runner cancellation signal failed", {
          runId: current.id,
          error: normalizeError(error).code,
        })
      }
    }
    await this.#claimTerminal(current.id, "cancelled", "run.cancelled", null, input.context)
    await this.#stopRuntime(current.id, input.context, scope)
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
    if (
      this.#store.isCancellationRequested(run.id) &&
      (this.#store.getRunnerSession(run.id)?.terminalResult ?? null) === null
    ) {
      await this.#claimTerminal(run.id, "cancelled", "run.cancelled", null)
      await this.#stopRuntime(run.id, undefined, scope)
      return
    }
    if (run.status === "queued") {
      const at = this.#now()
      const deadlineAt = new Date(this.#clock().getTime() + run.timeoutMs).toISOString()
      const claimed = this.#store.transitionRun({
        runId,
        expectedStatus: "queued",
        expectedVersion: run.statusVersion,
        toStatus: "provisioning",
        reason: "run.claimed",
        at,
        deadlineAt,
        audit: this.#transitionAudit(run, "run.provision"),
      })
      if (claimed === null) return
      run = claimed
      this.#telemetry?.metrics.record(
        "meanwhile.run.queue.duration",
        Math.max(0, this.#clock().getTime() - Date.parse(run.createdAt)),
        { agent: run.agentType, provider: run.provider },
      )
      this.#appendSystem(run, "run.provisioning", "Provisioning runtime", at)
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
      persistedTerminal = this.#restoreAcceptedTerminal(run)
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

    if (session !== null) {
      await this.#reconcileAcceptedSessionStarted(run, session.runnerSessionId)
    }

    // A validated terminal frame is durable agent evidence. Disposable compute
    // is useful only for best-effort artifact capture after this point; losing
    // it must not replace the already accepted result with RUNTIME_LOST.
    if (session?.terminalResult !== null && session?.terminalResult !== undefined) {
      const terminal = parsePersistedRunnerTerminal(session.terminalResult)
      await this.#finalizePersistedTerminal(run, provider, runtimeRecord, session, terminal, scope)
      return
    }

    let runtime: RuntimeHandle

    if (runtimeRecord === null) {
      const runtimeId = run.runtimeId ?? `rt-${run.id}`.slice(0, 128)
      this.#store.setRunRuntime({ runId: run.id, runtimeId, at: this.#now() })
      runtime = await provider.create({ runtimeId })
      const at = this.#now()
      runtimeRecord = {
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
      }
      this.#store.createRuntime(
        runtimeRecord,
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
      const secrets = this.#secrets.resolve(run.secretRefs, secretScope(run.ownerId, "agent"))
      try {
        const timeoutBudgetMs = Math.max(
          1,
          Date.parse(run.deadlineAt as string) - this.#clock().getTime(),
        )
        const spec: RunnerSpec = {
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          runId: run.id,
          runnerSessionId: processId,
          agent: {
            executable: run.agentSpec.executable,
            args: [...run.agentSpec.args],
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
          secretEnvironmentNames: Object.keys(secrets.environment),
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
              secretEnvironment: secrets.environment,
              timeoutMs: timeoutBudgetMs,
              terminationGraceMs: PROCESS_TERMINATION_GRACE_MS,
            }),
        )
        const at = this.#now()
        this.#store.setRuntimeProcess(
          runtimeRecord.id,
          jsonObject(process),
          at,
          this.#audit({
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
        )
        this.#store.setRunRuntime({
          runId: run.id,
          runtimeId: runtimeRecord.id,
          processId,
          at,
        })
        session = {
          runId: run.id,
          ownerId: run.ownerId,
          runnerSessionId: processId,
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          providerCursor: null,
          runnerSequence: 0,
          terminalResult: null,
          createdAt: at,
          updatedAt: at,
        }
        this.#store.upsertRunnerSession(session)
        this.#assertRunning()
        await this.#consume(run, provider, runtime, process, session, secrets.redactor, scope)
      } finally {
        secrets.dispose()
      }
      return
    }

    const recoverySecrets = this.#secrets.resolve(run.secretRefs, secretScope(run.ownerId, "agent"))
    try {
      try {
        await this.#consume(
          run,
          provider,
          runtime,
          process,
          session,
          recoverySecrets.redactor,
          scope,
        )
      } catch (error) {
        if (reconnecting && isMissingProcess(error)) {
          throw runtimeLost(provider.name, "process")
        }
        throw error
      }
    } finally {
      recoverySecrets.dispose()
    }
  }

  #restoreAcceptedTerminal(run: Run): RunnerTerminalPayload | null {
    const session = this.#store.getRunnerSession(run.id)
    if (session === null) return null
    if (session.terminalResult !== null) {
      return parsePersistedRunnerTerminal(session.terminalResult)
    }

    let after = 0
    for (;;) {
      const logs = this.#store.listRunLogs(run.ownerId, run.id, after, 1_000)
      const accepted = logs.find(
        (log) =>
          log.eventType === "terminal" &&
          log.runnerSessionId === session.runnerSessionId &&
          log.runnerSequence !== undefined,
      )
      if (accepted !== undefined) {
        let payload: unknown
        try {
          payload = JSON.parse(accepted.data)
        } catch (cause) {
          throw new AppError({
            code: "RUNNER_PROTOCOL_ERROR",
            message: "Persisted runner terminal log is invalid",
            cause,
          })
        }
        const terminal = parsePersistedRunnerTerminal(payload)
        this.#store.upsertRunnerSession({
          ...session,
          runnerSequence: Math.max(session.runnerSequence, accepted.runnerSequence ?? 0),
          terminalResult: jsonObject(terminal),
          updatedAt: this.#now(),
        })
        return terminal
      }
      const last = logs.at(-1)
      if (logs.length < 1_000 || last === undefined) return null
      after = last.sequence
    }
  }

  async #startRuntime(
    run: Run,
    provider: RuntimeProvider,
    runtimeId: string,
    runtime: RuntimeHandle,
  ): Promise<void> {
    await provider.start(runtime)
    this.#store.insertAudit(
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
    session: NonNullable<ReturnType<Store["getRunnerSession"]>>,
    terminal: RunnerTerminalPayload,
    scope?: TelemetryScope,
  ): Promise<void> {
    let current = await this.#reconcileSessionStarted(initialRun, session.runnerSessionId, terminal)
    if (current === null || isTerminalRunStatus(current.status)) return

    if (current.artifactPaths.length > 0) {
      let runtime: RuntimeHandle | null = null
      let unavailableReason = "RUNTIME_MISSING"
      if (runtimeRecord !== null) {
        try {
          const candidate = restoreRuntimeHandle(runtimeRecord.handle)
          const state = await provider.inspect(candidate)
          if (state.status !== "missing") {
            if (state.status !== "running") {
              await this.#startRuntime(current, provider, runtimeRecord.id, candidate)
            }
            runtime = candidate
          }
        } catch (error) {
          unavailableReason = isMissingRuntime(error) ? "RUNTIME_MISSING" : "RUNTIME_UNAVAILABLE"
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

      if (runtime === null) {
        this.#recordArtifactCaptureUnavailable(current, unavailableReason)
      } else {
        await this.#collectArtifacts(current, provider, runtime, scope)
      }
    }

    if (!this.#running) return
    current = this.#store.getRunInternal(initialRun.id)
    if (current === null || isTerminalRunStatus(current.status)) return
    await this.#claimTerminal(
      current.id,
      statusForTerminal(terminal),
      `runner.${terminal.outcome}`,
      terminalError(terminal),
      undefined,
      terminal.agentExit?.exitCode,
    )
  }

  async #prepareWorkspace(
    run: Run,
    provider: RuntimeProvider,
    runtime: RuntimeHandle,
  ): Promise<void> {
    let repositoryCredential: string | undefined
    let repositorySecrets: ReturnType<EnvironmentSecretResolver["resolve"]> | null = null
    if (run.workspace.type === "repository" && run.workspace.credentialRef !== undefined) {
      repositorySecrets = this.#secrets.resolve(
        { MEANWHILE_REPOSITORY_CREDENTIAL: run.workspace.credentialRef },
        secretScope(run.ownerId, "repository"),
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
        timeoutMs: Math.max(1, Date.parse(run.deadlineAt as string) - this.#clock().getTime()),
        terminationGraceMs: PROCESS_TERMINATION_GRACE_MS,
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
      repositorySecrets?.dispose()
    }
  }

  async #consume(
    initialRun: Run,
    provider: RuntimeProvider,
    runtime: RuntimeHandle,
    process: ProcessHandle,
    session: NonNullable<ReturnType<Store["getRunnerSession"]>>,
    redactor: SecretRedactor,
    scope?: TelemetryScope,
  ): Promise<void> {
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
            if (terminalPayload !== undefined) {
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
            this.#store.upsertRunnerSession({
              ...session,
              providerCursor: cursor,
              runnerSequence: acceptedSequence,
              terminalResult: null,
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
      throw new AppError({
        code: "RUNNER_PROTOCOL_ERROR",
        message: "Runner completion did not produce accepted terminal evidence",
      })
    }
    let current = await this.#reconcileSessionStarted(
      initialRun,
      session.runnerSessionId,
      acceptedTerminal,
    )
    if (current === null || isTerminalRunStatus(current.status)) return
    await this.#collectArtifacts(current, provider, runtime, scope)
    if (!this.#running) return
    current = this.#store.getRunInternal(initialRun.id)
    if (current === null || isTerminalRunStatus(current.status)) return
    const terminal = statusForTerminal(acceptedTerminal)
    const structuredError = terminalError(acceptedTerminal)
    await this.#claimTerminal(
      current.id,
      terminal,
      `runner.${terminal}`,
      structuredError,
      undefined,
      acceptedTerminal.agentExit?.exitCode ?? result.exitCode,
    )
  }

  async #reconcileSessionStarted(
    initialRun: Run,
    runnerSessionId: string,
    terminal: RunnerTerminalPayload,
  ): Promise<Run | null> {
    const current = await this.#reconcileAcceptedSessionStarted(initialRun, runnerSessionId)
    if (current === null || current.status !== "provisioning") return current

    if (terminal.outcome === "succeeded") {
      throw new AppError({
        code: "RUNNER_PROTOCOL_ERROR",
        message: "A successful runner result lacked accepted session-start evidence",
      })
    }
    return current
  }

  async #reconcileAcceptedSessionStarted(
    initialRun: Run,
    runnerSessionId: string,
  ): Promise<Run | null> {
    let current = this.#store.getRunInternal(initialRun.id)
    if (current === null || current.status !== "provisioning") return current
    if (!this.#hasAcceptedSessionStarted(current, runnerSessionId)) return current
    await this.#markRunning(current.id)
    current = this.#store.getRunInternal(current.id)
    return current
  }

  #hasAcceptedSessionStarted(run: Run, runnerSessionId: string): boolean {
    let after = 0
    for (;;) {
      const logs = this.#store.listRunLogs(run.ownerId, run.id, after, 1_000)
      if (
        logs.some(
          (log) => log.eventType === "session.started" && log.runnerSessionId === runnerSessionId,
        )
      ) {
        return true
      }
      const last = logs.at(-1)
      if (logs.length < 1_000 || last === undefined) return false
      after = last.sequence
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

  async #markRunning(runId: string): Promise<void> {
    const current = this.#store.getRunInternal(runId)
    if (current === null || current.status !== "provisioning") return
    const at = this.#now()
    const running = this.#store.transitionRun({
      runId,
      expectedStatus: "provisioning",
      expectedVersion: current.statusVersion,
      toStatus: "running",
      reason: "agent.session_started",
      at,
      audit: this.#transitionAudit(current, "agent.start"),
      systemLog: { eventType: "run.running", data: "Agent session started" },
    })
    if (running !== null) {
      const provisioningAt = this.#store
        .listRunStatusEvents(running.ownerId, running.id)
        .find(({ toStatus }) => toStatus === "provisioning")?.createdAt
      this.#telemetry?.metrics.record(
        "meanwhile.run.provision.duration",
        Math.max(0, this.#clock().getTime() - Date.parse(provisioningAt ?? running.updatedAt)),
        { agent: running.agentType, provider: running.provider },
      )
    }
  }

  async #collectArtifacts(
    run: Run,
    provider: RuntimeProvider,
    runtime: RuntimeHandle,
    scope?: TelemetryScope,
  ): Promise<void> {
    if (run.artifactPaths.length === 0) return
    await this.#span(
      scope,
      "meanwhile.artifact.collect",
      { "run.id": run.id, "provider.name": provider.name },
      async (span) => {
        const failure = await this.#collectArtifactsInternal(run, provider, runtime)
        if (failure === null) span?.setOutcome("succeeded")
        else span?.setOutcome("failed", stableTelemetryCode(failure))
      },
    )
  }

  async #collectArtifactsInternal(
    run: Run,
    provider: RuntimeProvider,
    runtime: RuntimeHandle,
  ): Promise<string | null> {
    const values: Record<string, string> = {}
    // SecretRedactor intentionally does not expose values; resolve again only
    // inside this operation to construct the exact-byte artifact scanner.
    let secrets: ReturnType<EnvironmentSecretResolver["resolve"]> | null = null
    try {
      secrets = this.#secrets.resolve(run.secretRefs, secretScope(run.ownerId, "agent"))
      Object.assign(values, secrets.environment)
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
      })
      this.#store.insertArtifacts(
        artifacts.map((collected) => artifactMetadata(collected) as Artifact),
      )
      for (const collected of artifacts) {
        this.#telemetry?.metrics.increment("meanwhile.artifact.count", 1, {
          "artifact.kind": collected.kind,
        })
        this.#telemetry?.metrics.increment("meanwhile.artifact.bytes", collected.size, {
          "artifact.kind": collected.kind,
        })
      }
    } catch (error) {
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
      this.#store.appendRunLogNext({
        ownerId: run.ownerId,
        runId: run.id,
        stream: "system",
        eventType: "artifact.capture_failed",
        data: JSON.stringify({
          code: error instanceof ArtifactCollectionError ? error.code : "ARTIFACT_CAPTURE_FAILED",
        }),
        createdAt: at,
      })
      return error instanceof ArtifactCollectionError ? error.code : "ARTIFACT_CAPTURE_FAILED"
    } finally {
      secrets?.dispose()
      for (const key of Object.keys(values)) values[key] = ""
    }
    return null
  }

  async #fail(runId: string, error: unknown): Promise<void> {
    const normalized = normalizeError(error)
    await this.#claimTerminal(runId, "failed", "run.failed", normalized.toStructuredError())
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
    if ((this.#store.getRunnerSession(runId)?.terminalResult ?? null) !== null) return
    const runtime = this.#store.getRuntimeForRun(runId)
    if (runtime?.processHandle !== null && runtime?.processHandle !== undefined) {
      try {
        const baseProvider = this.#providers.get(runtime.provider)
        const provider =
          scope === undefined
            ? baseProvider
            : observeRuntimeProvider(baseProvider, scope, { runId }, () => this.#clock().getTime())
        await this.#runner.cancel(provider, restoreProcessHandle(runtime.processHandle))
      } catch {
        // The durable timeout claim below remains authoritative.
      }
    }
    const terminal = await this.#claimTerminal(runId, "timed_out", "run.timed_out", null)
    if (terminal?.deadlineAt !== null && terminal?.deadlineAt !== undefined) {
      this.#telemetry?.metrics.record(
        "meanwhile.run.timeout.latency",
        Math.max(0, this.#clock().getTime() - Date.parse(terminal.deadlineAt)),
        { agent: terminal.agentType, provider: terminal.provider },
      )
    }
    await this.#stopRuntime(runId, undefined, scope)
  }

  async #claimTerminal(
    runId: string,
    status: Extract<RunStatus, "succeeded" | "failed" | "cancelled" | "timed_out">,
    reason: string,
    error: StructuredError | null,
    context?: RequestContext,
    exitCode?: number | null,
  ): Promise<Run | null> {
    const current = this.#store.getRunInternal(runId)
    if (current === null || isTerminalRunStatus(current.status)) return current
    const at = this.#now()
    const terminal = this.#store.transitionRun({
      runId,
      expectedStatus: current.status,
      expectedVersion: current.statusVersion,
      toStatus: status,
      reason,
      at,
      error,
      ...(exitCode === undefined ? {} : { exitCode }),
      systemLog: { eventType: reason, data: `Run ${status}` },
      audit: {
        actorApiKeyId: context?.apiKeyId ?? null,
        action: reason,
        requestId: context?.requestId ?? `system:${this.#id()}`,
        traceId: context?.traceId ?? null,
        metadata: { from: current.status, to: status },
      },
    })
    if (terminal !== null) {
      this.#telemetry?.metrics.increment("meanwhile.run.outcomes", 1, {
        agent: current.agentType,
        provider: current.provider,
        outcome: status,
      })
      this.#telemetry?.metrics.record(
        "meanwhile.run.duration",
        Math.max(0, this.#clock().getTime() - Date.parse(current.createdAt)),
        { agent: current.agentType, provider: current.provider, outcome: status },
      )
      const runtime = this.#store.getRuntimeForRun(runId)
      if (runtime !== null) this.#store.markRuntimeCleanupPending(runtime.id, at)
    }
    return terminal
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
    } finally {
      this.#store.markRuntimeCleanupPending(runtime.id, this.#now())
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
  ): Promise<readonly WorkspaceEntry[]> {
    const root = relativePath(path)
    const rootInfo = await this.#stat(root, limits.maxEntries)
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
      for (const entry of await this.provider.listFiles(this.runtime, directory.path, {
        maxEntries: remaining,
      })) {
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

  readFile(path: string, maxBytes: number): Promise<Uint8Array> {
    return this.provider.readFile(this.runtime, relativePath(path), { maxBytes })
  }

  async #stat(path: ReturnType<typeof relativePath>, maxEntries: number): Promise<RuntimeFileInfo> {
    if (path === ".") {
      return { path, type: "directory", size: 0, modifiedAt: new Date(0).toISOString() }
    }
    const parent = relativePath(posix.dirname(path) === "." ? "." : posix.dirname(path))
    const entries = await this.provider.listFiles(this.runtime, parent, { maxEntries })
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

const sanitizeRunnerTerminal = (
  value: unknown,
  redactor: SecretRedactor,
): RunnerTerminalPayload => {
  const parsed = runnerTerminalPayloadSchema.safeParse(redactor.redact(value))
  if (!parsed.success) {
    throw new AppError({
      code: "RUNNER_PROTOCOL_ERROR",
      message: "Redacted runner terminal evidence is invalid",
    })
  }
  return parsed.data
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

const secretScope = (ownerId: string, purpose: SecretPurpose) => ({ ownerId, purpose })

const jsonObject = (value: object): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject

class ControlPlaneStopped extends Error {
  override readonly name = "ControlPlaneStopped"
}
