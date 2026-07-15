import type { PreparedWorkspaceBundle } from "../artifacts/workspace-bundle"
import {
  type AgentSession,
  isSafeRepositoryRevision,
  type RequestContext,
  type SessionEvent,
  type SessionTurn,
  type TurnConflictPolicy,
  type WorkspaceSource,
} from "../domain"
import { AppError } from "../errors"
import { hashCanonical } from "../idempotency"
import type { Store } from "../persistence/store"
import type { SecretReferenceValidator } from "../secrets"
import type {
  RunAgentIntentResolver,
  RunExecutionProvenance,
  RunProviderNames,
  UploadedFilesWorkspaceSource,
  WorkspaceInputStore,
} from "./run-service"

export interface CreateSessionCommand {
  readonly workspace: WorkspaceSource | UploadedFilesWorkspaceSource
  readonly agentType: string
  readonly env: Readonly<Record<string, string>>
  readonly secretRefs: Readonly<Record<string, string>>
  readonly provider?: string
  readonly idleTimeoutMs: number
}

export interface SessionCommandSink {
  enqueue(sessionId: string): void
}

export interface SessionProviderCapabilities {
  supportsProcessInput(name: string): boolean
  supportsCredentialMediation(name: string): boolean
}

export interface SessionServiceOptions {
  readonly store: Store
  readonly commands: SessionCommandSink
  readonly workspaceInputs: WorkspaceInputStore
  readonly agentIntents: RunAgentIntentResolver
  readonly secretReferences: SecretReferenceValidator
  readonly providerNames: RunProviderNames
  readonly providerCapabilities: SessionProviderCapabilities
  readonly executionProvenance: RunExecutionProvenance
  readonly defaultProvider: string
  readonly clock?: () => Date
  readonly id?: () => string
  readonly followPollMs?: number
}

export class SessionService {
  readonly #store: Store
  readonly #commands: SessionCommandSink
  readonly #workspaceInputs: WorkspaceInputStore
  readonly #agentIntents: RunAgentIntentResolver
  readonly #secretReferences: SecretReferenceValidator
  readonly #providerNames: RunProviderNames
  readonly #providerCapabilities: SessionProviderCapabilities
  readonly #executionProvenance: RunExecutionProvenance
  readonly #defaultProvider: string
  readonly #clock: () => Date
  readonly #id: () => string
  readonly #followPollMs: number

  constructor(options: SessionServiceOptions) {
    this.#store = options.store
    this.#commands = options.commands
    this.#workspaceInputs = options.workspaceInputs
    this.#agentIntents = options.agentIntents
    this.#secretReferences = options.secretReferences
    this.#providerNames = options.providerNames
    this.#providerCapabilities = options.providerCapabilities
    this.#executionProvenance = options.executionProvenance
    this.#defaultProvider = options.defaultProvider
    this.#clock = options.clock ?? (() => new Date())
    this.#id = options.id ?? (() => crypto.randomUUID())
    this.#followPollMs = options.followPollMs ?? 1_000
  }

  async create(
    context: RequestContext,
    input: CreateSessionCommand,
    idempotencyKey?: string,
  ): Promise<{ readonly session: AgentSession; readonly replayed: boolean }> {
    this.#validateInput(context.ownerId, input)
    const agentIntent = this.#agentIntents.resolveIntent(
      input.agentType,
      input.env,
      input.secretRefs,
    )
    const provider = input.provider ?? this.#defaultProvider
    if (!this.#providerNames.has(provider)) {
      throw new AppError({ code: "INVALID_REQUEST", message: "Runtime provider is not configured" })
    }
    if (!this.#providerCapabilities.supportsProcessInput(provider)) {
      throw new AppError({
        code: "PROVIDER_CAPABILITY_UNAVAILABLE",
        status: 422,
        message: "Runtime provider does not support durable agent sessions",
        details: { capability: "processInput" },
      })
    }
    if (
      Object.keys(input.secretRefs).length > 0 &&
      !this.#providerCapabilities.supportsCredentialMediation(provider)
    ) {
      throw new AppError({
        code: "PROVIDER_CAPABILITY_UNAVAILABLE",
        status: 422,
        message: "Runtime provider cannot keep agent credentials outside the runtime",
        details: { provider, capability: "credentialMediation" },
      })
    }
    const executionProvenance = this.#executionProvenance.capture({
      provider,
      agentSpec: agentIntent.agentSpec,
      agentCatalogDigest: agentIntent.agentCatalogDigest,
    })
    let prepared: PreparedWorkspaceBundle | null = null
    let workspace: WorkspaceSource
    if (input.workspace.type === "files") {
      prepared = this.#workspaceInputs.prepare(input.workspace.files)
      workspace = prepared.source
    } else {
      workspace = input.workspace
    }
    const requestHash =
      idempotencyKey === undefined
        ? undefined
        : hashCanonical({ ...input, workspace, provider, ...agentIntent, executionProvenance })
    if (idempotencyKey !== undefined) {
      const existing = this.#store.getIdempotentAgentSession(context.ownerId, idempotencyKey)
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new AppError({
            code: "IDEMPOTENCY_CONFLICT",
            status: 409,
            message: "Idempotency key is already bound to different session input",
          })
        }
        return { session: existing.session, replayed: true }
      }
    }
    if (prepared) await this.#workspaceInputs.publish(context.ownerId, prepared)
    else if (workspace.type === "bundle") {
      await this.#workspaceInputs.require(context.ownerId, workspace.artifactId)
    }

    const id = this.#id()
    const createdAt = this.#clock().toISOString()
    const created = this.#store.createAgentSession({
      id,
      ownerId: context.ownerId,
      workspace,
      agentType: input.agentType,
      agentSpec: agentIntent.agentSpec,
      agentCatalogDigest: agentIntent.agentCatalogDigest,
      executionProvenance,
      env: input.env,
      secretRefs: input.secretRefs,
      provider,
      idleTimeoutMs: input.idleTimeoutMs,
      createdAt,
      ...(idempotencyKey === undefined || requestHash === undefined
        ? {}
        : { idempotencyKey, requestHash }),
      audit: {
        actorApiKeyId: context.apiKeyId,
        requestId: context.requestId,
        traceId: context.traceId,
        metadata: { agentType: input.agentType, provider },
      },
    })
    const session =
      created || idempotencyKey === undefined
        ? this.#requireSession(context.ownerId, id)
        : (this.#store.getIdempotentAgentSession(context.ownerId, idempotencyKey)?.session ??
          this.#requireSession(context.ownerId, id))
    if (created) this.#commands.enqueue(session.id)
    return { session, replayed: !created }
  }

  list(
    ownerId: string,
    options: { readonly limit: number; readonly before?: string },
  ): { readonly items: readonly AgentSession[]; readonly nextCursor: string | null } {
    return this.#store.listAgentSessions(ownerId, options)
  }

  get(ownerId: string, sessionId: string): AgentSession {
    return this.#requireSession(ownerId, sessionId)
  }

  getTurn(ownerId: string, sessionId: string, turnId: string): SessionTurn {
    this.#requireSession(ownerId, sessionId)
    const turn = this.#store.getSessionTurn(ownerId, sessionId, turnId)
    if (turn === null) throw new AppError({ code: "NOT_FOUND", message: "Turn not found" })
    return turn
  }

  turns(
    ownerId: string,
    sessionId: string,
    options: { readonly after: number; readonly limit: number },
  ): { readonly items: readonly SessionTurn[]; readonly nextCursor: number | null } {
    this.#requireSession(ownerId, sessionId)
    return this.#store.listSessionTurns(ownerId, sessionId, options.after, options.limit)
  }

  send(
    context: RequestContext,
    sessionId: string,
    input: {
      readonly prompt: string
      readonly timeoutMs: number
      readonly conflictPolicy: TurnConflictPolicy
    },
    idempotencyKey?: string,
  ): { readonly turn: SessionTurn; readonly replayed: boolean } {
    this.#requireSession(context.ownerId, sessionId)
    const requestHash = idempotencyKey === undefined ? undefined : hashCanonical(input)
    const result = this.#store.createSessionTurn({
      id: this.#id(),
      ownerId: context.ownerId,
      sessionId,
      ...input,
      createdAt: this.#clock().toISOString(),
      ...(idempotencyKey === undefined || requestHash === undefined
        ? {}
        : { idempotencyKey, requestHash }),
      audit: {
        actorApiKeyId: context.apiKeyId,
        requestId: context.requestId,
        traceId: context.traceId,
        metadata: {},
      },
    })
    this.#commands.enqueue(sessionId)
    return result
  }

  interrupt(context: RequestContext, sessionId: string): AgentSession {
    const session = this.#store.requestSessionInterrupt({
      ownerId: context.ownerId,
      sessionId,
      at: this.#clock().toISOString(),
      audit: {
        actorApiKeyId: context.apiKeyId,
        requestId: context.requestId,
        traceId: context.traceId,
        metadata: {},
      },
    })
    this.#commands.enqueue(sessionId)
    return session
  }

  close(context: RequestContext, sessionId: string): AgentSession {
    const session = this.#store.requestSessionClose({
      ownerId: context.ownerId,
      sessionId,
      at: this.#clock().toISOString(),
      audit: {
        actorApiKeyId: context.apiKeyId,
        requestId: context.requestId,
        traceId: context.traceId,
        metadata: {},
      },
    })
    this.#commands.enqueue(sessionId)
    return session
  }

  events(
    ownerId: string,
    sessionId: string,
    options: { readonly after: number; readonly limit: number },
  ): { readonly items: readonly SessionEvent[]; readonly nextCursor: number | null } {
    this.#requireSession(ownerId, sessionId)
    const items = this.#store.listSessionEvents(ownerId, sessionId, options.after, options.limit)
    return { items, nextCursor: items.at(-1)?.sequence ?? null }
  }

  async *followEvents(
    ownerId: string,
    sessionId: string,
    after: number,
    signal: AbortSignal,
  ): AsyncIterable<SessionEvent | null> {
    this.#requireSession(ownerId, sessionId)
    let cursor = after
    while (!signal.aborted) {
      const items = this.#store.listSessionEvents(ownerId, sessionId, cursor, 1_000)
      for (const item of items) {
        cursor = item.sequence
        yield item
      }
      const session = this.#requireSession(ownerId, sessionId)
      if (["closed", "failed", "continuity_lost"].includes(session.status)) {
        for (;;) {
          const tail = this.#store.listSessionEvents(ownerId, sessionId, cursor, 1_000)
          for (const item of tail) {
            cursor = item.sequence
            yield item
          }
          if (tail.length < 1_000) break
        }
        return
      }
      await abortableDelay(this.#followPollMs, signal)
      if (!signal.aborted) yield null
    }
  }

  #validateInput(ownerId: string, input: CreateSessionCommand): void {
    this.#secretReferences.validate(input.secretRefs, { ownerId, purpose: "agent" })
    if (input.workspace.type !== "repository") return
    if (
      input.workspace.revision !== undefined &&
      !isSafeRepositoryRevision(input.workspace.revision)
    ) {
      throw new AppError({ code: "INVALID_REQUEST", message: "Repository revision is invalid" })
    }
    if (input.workspace.credentialRef !== undefined) {
      if (!input.workspace.url.startsWith("https://")) {
        throw new AppError({
          code: "INVALID_REQUEST",
          message: "Repository credentials are supported only for HTTPS repositories",
        })
      }
      this.#secretReferences.validate(
        { MEANWHILE_REPOSITORY_CREDENTIAL: input.workspace.credentialRef },
        { ownerId, purpose: "repository" },
      )
    }
  }

  #requireSession(ownerId: string, sessionId: string): AgentSession {
    const session = this.#store.getAgentSession(ownerId, sessionId)
    if (!session) throw new AppError({ code: "NOT_FOUND", message: "Session not found" })
    return session
  }
}

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
