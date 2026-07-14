import {
  RUNNER_PROTOCOL_VERSION,
  type SessionRunnerFrame,
  type SessionRunnerSpec,
} from "../../runner/protocol"
import { sanitizeSessionRunnerPayload } from "../agents/runner-evidence"
import type { SessionRunnerController } from "../agents/session-runner"
import type { ComponentHealth, ManagedComponent } from "../control-plane"
import type { AgentSession, JsonObject, StructuredError } from "../domain"
import { AppError, normalizeError } from "../errors"
import type { Store } from "../persistence/store"
import { assertProviderProvenance } from "../provenance"
import { observeRuntimeProvider } from "../providers/observed-provider"
import type { RuntimeProviderRegistry } from "../providers/registry"
import {
  type ProcessHandle,
  type RuntimeHandle,
  type RuntimeProvider,
  restoreProcessHandle,
  restoreRuntimeHandle,
} from "../providers/runtime-provider"
import type { EnvironmentSecretResolver, SecretRedactor } from "../secrets"
import type { StructuredLogger, Telemetry, TelemetryScope } from "../telemetry"
import type { WorkspacePreparer } from "./workspace-preparer"

const DEFAULT_POLL_MS = 250
const PROVISION_TIMEOUT_MS = 10 * 60_000
const PROCESS_TERMINATION_GRACE_MS = 5_000
const TERMINAL_SESSION_STATUSES = new Set<AgentSession["status"]>([
  "closed",
  "failed",
  "continuity_lost",
])

export interface SessionExecutorOptions {
  readonly store: Store
  readonly providers: RuntimeProviderRegistry
  readonly runner: SessionRunnerController
  readonly workspace: WorkspacePreparer
  readonly secrets: EnvironmentSecretResolver
  readonly logger: StructuredLogger
  readonly telemetry?: Telemetry
  readonly concurrency?: number
  readonly pollMs?: number
  readonly clock?: () => Date
}

/** Owns durable AgentSession, Turn, command delivery, recovery, and runtime lease cleanup. */
export class SessionExecutor implements ManagedComponent {
  readonly name = "session-executor"
  readonly #store: Store
  readonly #providers: RuntimeProviderRegistry
  readonly #runner: SessionRunnerController
  readonly #workspace: WorkspacePreparer
  readonly #secrets: EnvironmentSecretResolver
  readonly #logger: StructuredLogger
  readonly #telemetry: Telemetry | undefined
  readonly #concurrency: number
  readonly #pollMs: number
  readonly #clock: () => Date
  readonly #pending = new Set<string>()
  readonly #active = new Map<string, Promise<void>>()
  readonly #cleanupActive = new Set<string>()
  #interval: ReturnType<typeof setInterval> | null = null
  #observation: AbortController | null = null
  #stopping: Promise<void> | null = null
  #running = false
  #lastFailure: string | null = null

  constructor(options: SessionExecutorOptions) {
    this.#store = options.store
    this.#providers = options.providers
    this.#runner = options.runner
    this.#workspace = options.workspace
    this.#secrets = options.secrets
    this.#logger = options.logger
    this.#telemetry = options.telemetry
    this.#concurrency = options.concurrency ?? 2
    this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.#clock = options.clock ?? (() => new Date())
    if (!Number.isSafeInteger(this.#concurrency) || this.#concurrency < 1) {
      throw new TypeError("Session executor concurrency must be a positive integer")
    }
  }

  async start(): Promise<void> {
    if (this.#stopping !== null) await this.#stopping
    if (this.#running) return
    this.#running = true
    this.#observation = new AbortController()
    const recoveryAt = this.#now()
    this.#store.recoverInterruptedSessionRuntimeProvisioning(recoveryAt)
    this.#store.recoverInterruptedSessionRuntimeCleanups(recoveryAt)
    for (const session of this.#store.listRecoverableAgentSessions()) this.#pending.add(session.id)
    for (const session of this.#store.listClaimableAgentSessions(this.#concurrency * 2)) {
      this.#pending.add(session.id)
    }
    for (const sessionId of this.#store.listSessionCleanupCandidates(this.#now())) {
      this.#pending.add(sessionId)
    }
    for (const sessionId of this.#store.listSessionRuntimeProvisioningCleanupCandidates(
      this.#now(),
    )) {
      this.#pending.add(sessionId)
    }
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
    if (!this.#running) return
    this.#running = false
    if (this.#interval) clearInterval(this.#interval)
    this.#interval = null
    this.#observation?.abort(new Error("control_plane_stopping"))
    await Promise.allSettled(this.#active.values())
    this.#active.clear()
    this.#cleanupActive.clear()
    this.#pending.clear()
    this.#observation = null
  }

  health(): ComponentHealth {
    if (!this.#running) return { status: "unavailable", message: "Session executor is stopped" }
    return this.#lastFailure === null
      ? { status: "healthy" }
      : { status: "degraded", message: this.#lastFailure }
  }

  enqueue(sessionId: string): void {
    this.#pending.add(sessionId)
    this.#pump()
  }

  #scan(): void {
    if (!this.#running) return
    for (const session of this.#store.listRecoverableAgentSessions()) {
      if (!this.#active.has(session.id)) this.#pending.add(session.id)
    }
    for (const session of this.#store.listClaimableAgentSessions(this.#concurrency * 2)) {
      if (!this.#active.has(session.id)) this.#pending.add(session.id)
    }
    for (const sessionId of this.#store.listSessionCleanupCandidates(this.#now())) {
      if (!this.#active.has(sessionId)) this.#pending.add(sessionId)
    }
    for (const sessionId of this.#store.listSessionRuntimeProvisioningCleanupCandidates(
      this.#now(),
    )) {
      if (!this.#active.has(sessionId)) this.#pending.add(sessionId)
    }
    this.#pump()
  }

  #pump(): void {
    if (!this.#running) return
    for (const sessionId of this.#pending) {
      if (this.#active.has(sessionId)) continue
      const session = this.#store.getAgentSessionInternal(sessionId)
      if (session === null) {
        this.#pending.delete(sessionId)
        continue
      }
      const cleanup = TERMINAL_SESSION_STATUSES.has(session.status)
      const operationalActive = this.#active.size - this.#cleanupActive.size
      if (session.status === "queued" && operationalActive >= this.#concurrency) continue
      if (cleanup && this.#cleanupActive.size >= this.#concurrency) continue
      this.#pending.delete(sessionId)
      if (cleanup) this.#cleanupActive.add(sessionId)
      const task = this.#execute(sessionId)
        .catch((error) => this.#handleFailure(sessionId, error))
        .finally(() => {
          this.#active.delete(sessionId)
          this.#cleanupActive.delete(sessionId)
          if (this.#running) this.#pump()
        })
      this.#active.set(sessionId, task)
    }
  }

  async #execute(sessionId: string): Promise<void> {
    const session = this.#store.getAgentSessionInternal(sessionId)
    if (this.#telemetry === undefined || session === null) {
      return this.#executeInternal(sessionId)
    }
    return this.#telemetry.span(
      "meanwhile.session.execute",
      {
        "session.id": session.id,
        "agent.type": session.agentType,
        "provider.name": session.provider,
      },
      async (span) => {
        const scope = span.child({ ownerId: session.ownerId, sessionId: session.id })
        await this.#executeInternal(sessionId, scope)
        const current = this.#store.getAgentSessionInternal(sessionId)
        if (current) {
          span.setAttributes({
            "session.status": current.status,
            "session.status_version": current.statusVersion,
          })
          if (current.status === "failed" || current.status === "continuity_lost") {
            span.setOutcome("failed", current.error?.code ?? "SESSION_FAILED")
          } else {
            span.setOutcome("succeeded")
          }
        }
      },
    )
  }

  async #executeInternal(sessionId: string, scope?: TelemetryScope): Promise<void> {
    let session = this.#store.getAgentSessionInternal(sessionId)
    if (!session) return
    const rawProvider = this.#providers.get(session.provider)
    const provider =
      scope === undefined
        ? rawProvider
        : observeRuntimeProvider(rawProvider, scope, {
            ...(session.runtimeId === null ? {} : { runtimeId: session.runtimeId }),
          })
    if (TERMINAL_SESSION_STATUSES.has(session.status)) {
      if (this.#store.getSessionRuntimeLease(session.id) === null) {
        await this.#reconcileTerminalRuntimeProvisioning(session, provider)
      }
      await this.#cleanup(session.id, provider)
      return
    }
    if (session.status === "queued") {
      session = this.#store.claimAgentSessionProvisioning(session.id, this.#now())
      if (!session) return
    }

    let lease = this.#store.getSessionRuntimeLease(session.id)
    if (session.status === "closing" && lease === null) {
      this.#store.closeAgentSession(session.id, "closed_before_provisioning", this.#now())
      return
    }
    assertProviderProvenance(session.executionProvenance, provider)
    if (!provider.capabilities.processInput || provider.send === undefined) {
      throw new AppError({
        code: "PROVIDER_CAPABILITY_UNAVAILABLE",
        status: 422,
        message: "Runtime provider no longer supports durable agent sessions",
        details: { capability: "processInput" },
      })
    }

    let runtime: RuntimeHandle
    if (lease === null) {
      const runtimeId = `session-${session.id}`.slice(0, 128)
      const intent = this.#store.ensureSessionRuntimeProvisioningIntent({
        sessionId: session.id,
        ownerId: session.ownerId,
        provider: provider.name,
        runtimeId,
        at: this.#now(),
      })
      if (intent === null) return
      if (this.#store.claimSessionRuntimeProvisioning(session.id, this.#now(), "active") === null) {
        const current = this.#store.getAgentSessionInternal(session.id)
        if (current !== null && TERMINAL_SESSION_STATUSES.has(current.status)) return
        throw new AppError({
          code: "INTERNAL",
          message: "Session runtime provisioning intent could not be claimed",
        })
      }
      try {
        runtime = await provider.create({ runtimeId })
      } catch (error) {
        this.#store.failSessionRuntimeProvisioning({
          sessionId: session.id,
          error: normalizeError(error).toStructuredError(),
          at: this.#now(),
        })
        throw error
      }
      this.#store.materializeSessionRuntimeProvisioning({
        sessionId: session.id,
        ownerId: session.ownerId,
        provider: provider.name,
        runtimeId,
        runtimeHandle: jsonObject(runtime),
        at: this.#now(),
      })
      await provider.start(runtime)
      this.#recordRuntimeStarted(session, runtimeId, provider, false)
      lease = this.#store.getSessionRuntimeLease(session.id)
    } else {
      if (session.runtimeId === null) {
        throw new AppError({
          code: "DATABASE_INTEGRITY_FAILED",
          message: "Session runtime lease is missing its durable runtime identity",
        })
      }
      runtime = restoreRuntimeHandle(lease.runtimeHandle)
      const runtimeState = await provider.inspect(runtime)
      if (runtimeState.status === "missing") {
        this.#store.loseAgentSession(session.id, continuityLost("runtime"), this.#now())
        return
      }
      if (runtimeState.status !== "running") await provider.start(runtime)
      this.#recordRuntimeStarted(
        session,
        session.runtimeId,
        provider,
        runtimeState.status === "running",
      )
    }

    const agentSecrets = this.#secrets.resolve(session.secretRefs, {
      ownerId: session.ownerId,
      purpose: "agent",
    })
    try {
      if (!lease?.processHandle) {
        session = this.#store.getAgentSessionInternal(session.id) as AgentSession
        if (session.status === "closing") {
          this.#store.closeAgentSession(session.id, "closed_before_agent_start", this.#now())
          await this.#cleanup(session.id, provider)
          return
        }
        await this.#launchRunner(session, provider, runtime, agentSecrets.environment)
        lease = this.#store.getSessionRuntimeLease(session.id)
        if (!lease?.processHandle) throw new Error("Session runner process handle is missing")
      }
      const reconnecting = session.processId !== null
      if (reconnecting && !provider.capabilities.processRecovery) {
        this.#store.loseAgentSession(session.id, continuityLost("process_recovery"), this.#now())
        await this.#cleanup(session.id, provider)
        return
      }
      if (
        reconnecting &&
        !provider.capabilities.eventReplay &&
        (lease.providerCursor !== null || lease.runnerSequence > 0)
      ) {
        this.#store.loseAgentSession(session.id, continuityLost("event_replay"), this.#now())
        await this.#cleanup(session.id, provider)
        return
      }
      const process = restoreProcessHandle(lease.processHandle)
      const processState = await provider.inspectProcess(process)
      if (processState.status !== "running") {
        this.#store.loseAgentSession(session.id, continuityLost("process"), this.#now())
        await this.#cleanup(session.id, provider)
        return
      }

      const commandsAbort = new AbortController()
      const observationSignal = this.#observation?.signal ?? AbortSignal.abort()
      const dispatch = this.#dispatchCommands(session.id, provider, process, commandsAbort.signal)
      const observedSession = session as AgentSession
      try {
        await this.#runner.consume({
          provider,
          process,
          sessionId: observedSession.id,
          runnerSessionId:
            observedSession.processId ?? `session-runner-${observedSession.id}`.slice(0, 128),
          cursor: lease.providerCursor,
          lastSequence: lease.runnerSequence,
          signal: observationSignal,
          onFrame: async (frame, cursor) => {
            this.#acceptFrame(observedSession, frame, cursor, agentSecrets.redactor)
          },
          onCursor: async (cursor) => {
            this.#store.updateSessionProviderCursor(observedSession.id, cursor, this.#now())
          },
        })
      } finally {
        commandsAbort.abort()
        await dispatch
      }
      if (!this.#running || observationSignal.aborted) return

      const current = this.#store.getAgentSessionInternal(observedSession.id)
      if (current && !TERMINAL_SESSION_STATUSES.has(current.status)) {
        this.#store.loseAgentSession(
          observedSession.id,
          continuityLost("agent_process_exit"),
          this.#now(),
        )
      }
      await this.#cleanup(observedSession.id, provider)
    } finally {
      agentSecrets.dispose()
    }
  }

  async #reconcileTerminalRuntimeProvisioning(
    session: AgentSession,
    provider: RuntimeProvider,
  ): Promise<void> {
    const intent = this.#store.getSessionRuntimeProvisioningIntent(session.id)
    if (intent === null) return
    assertProviderProvenance(session.executionProvenance, provider)
    const claimed = this.#store.claimSessionRuntimeProvisioning(session.id, this.#now(), "terminal")
    if (claimed === null) return
    try {
      const runtime = await provider.create({ runtimeId: claimed.runtimeId })
      this.#store.materializeSessionRuntimeProvisioning({
        sessionId: session.id,
        ownerId: session.ownerId,
        provider: provider.name,
        runtimeId: claimed.runtimeId,
        runtimeHandle: jsonObject(runtime),
        at: this.#now(),
      })
    } catch (error) {
      const normalized = normalizeError(error)
      this.#lastFailure = normalized.code
      this.#store.failSessionRuntimeProvisioning({
        sessionId: session.id,
        error: normalized.toStructuredError(),
        at: this.#now(),
      })
      this.#logger.error(
        "session.runtime_provisioning_reconciliation_failed",
        "Session runtime provisioning could not be reconciled",
        { sessionId: session.id, code: normalized.code },
      )
    }
  }

  async #launchRunner(
    session: AgentSession,
    provider: RuntimeProvider,
    runtime: RuntimeHandle,
    secretEnvironment: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.#prepareWorkspace(session, provider, runtime)
    const processId = `session-runner-${session.id}`.slice(0, 128)
    const spec: SessionRunnerSpec = {
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      mode: "session",
      sessionId: session.id,
      runnerSessionId: processId,
      agent: {
        executable: session.agentSpec.executable,
        args: [...session.agentSpec.args],
        workingDirectory: session.agentSpec.workingDirectory,
      },
      permissionPolicy:
        session.agentSpec.permissionPolicy.mode === "deny-all"
          ? { mode: "deny-all" }
          : {
              mode: "allow-once",
              toolKinds: [...session.agentSpec.permissionPolicy.toolKinds],
            },
      environment: { ...session.env },
      secretEnvironmentNames: Object.keys(secretEnvironment),
      idleTimeoutMs: session.idleTimeoutMs,
    }
    const process = await this.#runner.start({
      provider,
      runtime,
      processId,
      spec,
      secretEnvironment,
    })
    this.#store.materializeSessionProcessLaunch({
      sessionId: session.id,
      ownerId: session.ownerId,
      processId,
      processHandle: jsonObject(process),
      at: this.#now(),
    })
  }

  async #prepareWorkspace(
    session: AgentSession,
    provider: RuntimeProvider,
    runtime: RuntimeHandle,
  ): Promise<void> {
    let repositorySecrets: ReturnType<EnvironmentSecretResolver["resolve"]> | null = null
    let repositoryCredential: string | undefined
    if (session.workspace.type === "repository" && session.workspace.credentialRef) {
      repositorySecrets = this.#secrets.resolve(
        { MEANWHILE_REPOSITORY_CREDENTIAL: session.workspace.credentialRef },
        { ownerId: session.ownerId, purpose: "repository" },
      )
      repositoryCredential = repositorySecrets.environment["MEANWHILE_REPOSITORY_CREDENTIAL"]
    }
    try {
      await this.#workspace.prepare({
        ownerId: session.ownerId,
        runId: session.id,
        source: session.workspace,
        provider,
        runtime,
        ...(repositoryCredential === undefined ? {} : { repositoryCredential }),
        timeoutMs: PROVISION_TIMEOUT_MS,
        terminationGraceMs: PROCESS_TERMINATION_GRACE_MS,
        signal: this.#observation?.signal ?? AbortSignal.abort(),
        emit: async (event) => {
          const data = repositorySecrets?.redactor.redactString(event.data) ?? event.data
          this.#store.appendSessionDiagnostic({
            ownerId: session.ownerId,
            sessionId: session.id,
            payload: { event: event.event, stream: event.stream, data },
            createdAt: event.timestamp,
          })
        },
      })
    } finally {
      repositorySecrets?.dispose()
    }
  }

  async #dispatchCommands(
    sessionId: string,
    provider: RuntimeProvider,
    process: ProcessHandle,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      if (this.#store.timeoutActiveSessionTurn(sessionId, this.#now())) {
        this.#logger.warn("session.turn_timed_out", "Agent session turn exceeded its deadline", {
          sessionId,
        })
        this.#telemetry?.metrics.increment("meanwhile.session.turn.outcomes", 1, {
          status: "timed_out",
        })
      }
      for (const command of this.#store.listPendingSessionCommands(sessionId)) {
        await (provider.send as NonNullable<RuntimeProvider["send"]>)(process, {
          sequence: command.sequence,
          id: command.id,
          data: JSON.stringify(command.data),
        })
        this.#store.markSessionCommandSent(sessionId, command.sequence, this.#now())
      }
      await abortableDelay(this.#pollMs, signal)
    }
  }

  #acceptFrame(
    session: AgentSession,
    frame: SessionRunnerFrame,
    cursor: string,
    redactor: SecretRedactor,
  ): void {
    const turnId =
      "turnId" in frame.payload && typeof frame.payload.turnId === "string"
        ? frame.payload.turnId
        : null
    const openTurn =
      frame.type === "turn.terminal" && turnId !== null
        ? this.#store.getSessionTurn(session.ownerId, session.id, turnId)
        : null
    const accepted = this.#store.acceptSessionFrame({
      ownerId: session.ownerId,
      sessionId: session.id,
      runnerSequence: frame.sequence,
      providerCursor: cursor,
      type: frame.type,
      turnId,
      payload: sanitizeSessionRunnerPayload(frame, redactor),
      createdAt: this.#now(),
    })
    if (
      accepted &&
      frame.type === "turn.terminal" &&
      openTurn !== null &&
      (openTurn.status === "queued" || openTurn.status === "running")
    ) {
      const outcome = frame.payload.result.outcome
      this.#telemetry?.metrics.increment("meanwhile.session.turn.outcomes", 1, {
        status: outcome === "cancelled" ? "interrupted" : outcome,
      })
    }
  }

  async #cleanup(sessionId: string, provider: RuntimeProvider): Promise<void> {
    const lease = this.#store.claimSessionRuntimeCleanup(sessionId, this.#now())
    if (!lease) return
    let error: StructuredError | null = null
    try {
      await provider.destroy(restoreRuntimeHandle(lease.runtimeHandle))
    } catch (cause) {
      error = normalizeError(cause).toStructuredError()
    }
    this.#store.finishSessionRuntimeCleanup(sessionId, error, this.#now())
  }

  #recordRuntimeStarted(
    session: AgentSession,
    runtimeId: string,
    provider: RuntimeProvider,
    reconciled: boolean,
  ): void {
    this.#store.ensureRuntimeStartedAudit({
      id: crypto.randomUUID(),
      ownerId: session.ownerId,
      actorApiKeyId: null,
      action: "runtime.start",
      resourceType: "runtime",
      resourceId: runtimeId,
      requestId: `executor:${session.id}`,
      traceId: null,
      metadata: { sessionId: session.id, provider: provider.name, reconciled },
      createdAt: this.#now(),
    })
  }

  async #handleFailure(sessionId: string, error: unknown): Promise<void> {
    if (!this.#running && this.#observation?.signal.aborted) return
    const normalized = normalizeError(error)
    this.#lastFailure = normalized.code
    this.#logger.error("session.execution_failed", "Agent session execution failed", {
      sessionId,
      code: normalized.code,
    })
    this.#telemetry?.metrics.increment("meanwhile.session.outcomes", 1, { status: "failed" })
    this.#store.failAgentSession(sessionId, normalized.toStructuredError(), this.#now())
    const session = this.#store.getAgentSessionInternal(sessionId)
    const lease = this.#store.getSessionRuntimeLease(sessionId)
    if (session && lease) {
      try {
        await this.#cleanup(sessionId, this.#providers.get(session.provider))
      } catch (cleanupError) {
        const cleanupFailure = normalizeError(cleanupError)
        this.#lastFailure = cleanupFailure.code
        this.#logger.error(
          "session.cleanup_failed",
          "Agent session cleanup could not be recorded",
          { sessionId, code: cleanupFailure.code },
        )
      }
    }
  }

  #now(): string {
    return this.#clock().toISOString()
  }
}

const jsonObject = (value: object): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject

const continuityLost = (component: string): StructuredError => ({
  code: "SESSION_CONTINUITY_LOST",
  message: "The live ACP session can no longer be recovered",
  retryable: false,
  details: { component },
})

const abortableDelay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, milliseconds)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
