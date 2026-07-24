import type { z } from "zod"
import {
  AddProjectMemberRequestSchema,
  type AgentConnection,
  AgentConnectionResponseSchema,
  type AgentSession,
  type AgentSessionPage,
  AgentSessionPageSchema,
  AgentSessionResponseSchema,
  type ApiKey,
  ApiKeyPageSchema,
  ApiKeyResponseSchema,
  type Artifact,
  type ArtifactDetail,
  ArtifactDetailSchema,
  ArtifactIdentifierSchema,
  ArtifactPageSchema,
  type AuditPage,
  AuditPageSchema,
  BindProjectRepositoryRequestSchema,
  type Brief,
  type BriefPage,
  BriefPageSchema,
  BriefResponseSchema,
  ConnectAgentRequestSchema,
  type ConnectedOnboarding,
  ConnectedOnboardingResponseSchema,
  CreateApiKeyRequestSchema,
  type CreateBriefRequest,
  CreateBriefRequestSchema,
  type CreateDeploymentRequest,
  CreateDeploymentRequestSchema,
  CreatedApiKeyResponseSchema,
  CreatedPrincipalInvitationResponseSchema,
  type CreatePrincipalRequest,
  CreatePrincipalRequestSchema,
  type CreateProjectRequest,
  CreateProjectRequestSchema,
  type CreateRunRequest,
  CreateRunRequestSchema,
  type CreateSessionRequest,
  CreateSessionRequestSchema,
  type CreateSessionTurnRequest,
  CreateSessionTurnRequestSchema,
  type CreateTaskAnnotationRequest,
  CreateTaskAnnotationRequestSchema,
  type CreateTaskRelayRequest,
  CreateTaskRelayRequestSchema,
  type Deployment,
  type DeploymentLogPage,
  DeploymentLogPageSchema,
  type DeploymentPage,
  DeploymentPageSchema,
  DeploymentResponseSchema,
  ErrorEnvelopeSchema,
  IdentifierSchema,
  type ImportedProjectRepository,
  ImportedProjectRepositoryResponseSchema,
  ImportProjectRepositoryRequestSchema,
  MeResponseSchema,
  type PresenceLease,
  PresenceLeasePageSchema,
  PresenceLeaseResponseSchema,
  type Principal,
  type PrincipalInvitation,
  PrincipalInvitationPageSchema,
  PrincipalInvitationResponseSchema,
  PrincipalPageSchema,
  PrincipalResponseSchema,
  type Project,
  type ProjectMember,
  ProjectMemberPageSchema,
  ProjectMemberResponseSchema,
  ProjectPageSchema,
  type ProjectParticipant,
  ProjectParticipantPageSchema,
  type ProjectRepositoryBinding,
  ProjectRepositoryBindingResponseSchema,
  ProjectResponseSchema,
  type ProjectSelection,
  ProjectSelectionResponseSchema,
  type ProjectWorkItem,
  ProjectWorkPageSchema,
  type ProviderDiagnostics,
  ProviderDiagnosticsSchema,
  ProviderTestRequestSchema,
  type Run,
  type RunEvent,
  type RunEventPage,
  RunEventPageSchema,
  RunEventSchema,
  type RunLog,
  type RunLogPage,
  RunLogPageSchema,
  RunLogSchema,
  type RunPage,
  RunPageSchema,
  RunResponseSchema,
  type SessionEvent,
  type SessionEventPage,
  SessionEventPageSchema,
  SessionEventSchema,
  type SessionTurn,
  type SessionTurnPage,
  SessionTurnPageSchema,
  SessionTurnResponseSchema,
  SetProjectSelectionRequestSchema,
  type TaskAnnotation,
  TaskAnnotationPageSchema,
  TaskAnnotationResponseSchema,
  type TaskRelay,
  TaskRelayPageSchema,
  TaskRelayResponseSchema,
} from "./api/contracts"

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_SSE_EVENT_BYTES = 2 * 1024 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_WAIT_TIMEOUT_MS = 60 * 60_000
const DEFAULT_POLL_INTERVAL_MS = 250
const DEFAULT_SSE_RETRY_MS = 1_000
const MIN_SSE_RETRY_MS = 100
const MAX_SSE_RETRY_MS = 10_000
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"])
const TERMINAL_SESSION_STATUSES = new Set(["closed", "failed", "continuity_lost"])
const TERMINAL_DEPLOYMENT_STATUSES = new Set(["succeeded", "failed"])
const TERMINAL_TURN_STATUSES = new Set(["succeeded", "failed", "interrupted", "timed_out"])

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export type Wait = (milliseconds: number, signal: AbortSignal) => Promise<void>

export interface ClientResponseEvidence {
  readonly method: "GET" | "POST" | "PUT" | "DELETE"
  readonly path: string
  readonly status: number
  readonly requestId: string
}

export interface MeanwhileOptions {
  readonly baseUrl: string | URL
  readonly apiKey?: string
  /** Opaque, short-lived credential intended for a trusted browser BFF. */
  readonly browserSession?: string
  readonly fetch?: Fetch
  readonly requestTimeoutMs?: number
  readonly wait?: Wait
  readonly onResponse?: (evidence: ClientResponseEvidence) => void
  readonly dangerouslyAllowBrowser?: boolean
}

export interface RequestOptions {
  readonly signal?: AbortSignal
}

export interface CreateRunOptions extends RequestOptions {
  readonly idempotencyKey?: string
}

export interface CreateDeploymentOptions extends RequestOptions {
  readonly idempotencyKey: string
}

export interface ListCreatedOptions extends RequestOptions {
  readonly limit?: number
  readonly before?: string
}

export interface ListRunsOptions extends ListCreatedOptions {}

export interface ListSequenceOptions extends RequestOptions {
  readonly after?: number
  readonly limit?: number
}

export interface ListLogsOptions extends ListSequenceOptions {}
export interface FollowLogsOptions extends ListLogsOptions {}
export interface FollowEventsOptions extends ListSequenceOptions {}

export interface WaitOptions extends RequestOptions {
  readonly timeoutMs?: number
  readonly pollIntervalMs?: number
}

export interface SendSessionTurnOptions extends CreateRunOptions {
  readonly timeoutMs?: number
  readonly conflictPolicy?: "reject" | "enqueue" | "interrupt_and_send"
  readonly briefIds?: readonly string[]
}

export interface RunsClient {
  create(input: CreateRunRequest, options?: CreateRunOptions): Promise<Run>
  list(options?: ListRunsOptions): Promise<RunPage>
  get(id: string, options?: RequestOptions): Promise<Run>
  cancel(id: string, options?: RequestOptions): Promise<Run>
  logs(id: string, options?: ListLogsOptions): Promise<RunLogPage>
  followLogs(id: string, options?: FollowLogsOptions): AsyncIterable<RunLog>
  events(id: string, options?: ListSequenceOptions): Promise<RunEventPage>
  followEvents(id: string, options?: FollowEventsOptions): AsyncIterable<RunEvent>
  wait(id: string, options?: WaitOptions): Promise<Run>
}

export interface SessionsClient {
  create(input: CreateSessionRequest, options?: CreateRunOptions): Promise<AgentSession>
  list(options?: ListCreatedOptions): Promise<AgentSessionPage>
  get(id: string, options?: RequestOptions): Promise<AgentSession>
  waitForStatus(
    id: string,
    status: AgentSession["status"],
    options?: WaitOptions,
  ): Promise<AgentSession>
  send(id: string, prompt: string, options?: SendSessionTurnOptions): Promise<SessionTurn>
  send(
    id: string,
    input: CreateSessionTurnRequest,
    options?: CreateRunOptions,
  ): Promise<SessionTurn>
  turns(id: string, options?: ListSequenceOptions): Promise<SessionTurnPage>
  getTurn(id: string, turnId: string, options?: RequestOptions): Promise<SessionTurn>
  waitForTurn(id: string, turnId: string, options?: WaitOptions): Promise<SessionTurn>
  events(id: string, options?: ListSequenceOptions): Promise<SessionEventPage>
  followEvents(id: string, options?: FollowEventsOptions): AsyncIterable<SessionEvent>
  interrupt(id: string, options?: RequestOptions): Promise<AgentSession>
  close(id: string, options?: RequestOptions): Promise<AgentSession>
}

export interface ArtifactDownload {
  readonly body: ReadableStream<Uint8Array>
  readonly digest: string
  readonly mediaType: string
  readonly byteSize: number
}

export interface ArtifactsClient {
  list(runId: string, options?: RequestOptions): Promise<readonly Artifact[]>
  get(id: string, options?: RequestOptions): Promise<ArtifactDetail>
  download(
    id: string,
    options?: RequestOptions & { readonly path?: string },
  ): Promise<ArtifactDownload>
}

export interface BriefsClient {
  create(input: CreateBriefRequest, options?: RequestOptions): Promise<Brief>
  list(options?: ListCreatedOptions): Promise<BriefPage>
  get(id: string, options?: RequestOptions): Promise<Brief>
}

export interface DeploymentsClient {
  create(input: CreateDeploymentRequest, options: CreateDeploymentOptions): Promise<Deployment>
  list(options?: ListCreatedOptions): Promise<DeploymentPage>
  get(id: string, options?: RequestOptions): Promise<Deployment>
  logs(id: string, options?: ListLogsOptions): Promise<DeploymentLogPage>
  wait(id: string, options?: WaitOptions): Promise<Deployment>
}

export interface AuditClient {
  list(
    options?: ListCreatedOptions & {
      readonly resourceType?:
        | "owner"
        | "principal"
        | "project"
        | "project_membership"
        | "principal_invitation"
        | "task_relay"
        | "task_annotation"
        | "api_key"
        | "browser_session"
        | "run"
        | "session"
        | "turn"
        | "runtime"
        | "artifact"
        | "brief"
        | "deployment"
      readonly resourceId?: string
      readonly action?: string
    },
  ): Promise<AuditPage>
}

export interface ApiKeysClient {
  create(
    name: string,
    options?: RequestOptions & { readonly principalId?: string },
  ): Promise<{ readonly key: ApiKey; readonly secret: string }>
  list(options?: RequestOptions): Promise<readonly ApiKey[]>
  revoke(id: string, options?: RequestOptions): Promise<ApiKey>
}

export interface PrincipalInvitationsClient {
  create(
    principalId: string,
    options?: RequestOptions & { readonly expiresInSeconds?: number },
  ): Promise<{ readonly invitation: PrincipalInvitation; readonly secret: string }>
  list(options?: RequestOptions): Promise<readonly PrincipalInvitation[]>
  revoke(id: string, options?: RequestOptions): Promise<PrincipalInvitation>
}

export interface ProvidersClient {
  test(name: string, options?: RequestOptions): Promise<ProviderDiagnostics>
}

export interface ProjectsClient {
  me(options?: RequestOptions): Promise<{
    readonly principal: Principal
    readonly projects: readonly Project[]
  }>
  list(options?: RequestOptions): Promise<readonly Project[]>
  get(id: string, options?: RequestOptions): Promise<Project>
  create(input: CreateProjectRequest, options?: RequestOptions): Promise<Project>
  members(id: string, options?: RequestOptions): Promise<readonly ProjectMember[]>
  participants(id: string, options?: RequestOptions): Promise<readonly ProjectParticipant[]>
  addMember(
    id: string,
    principalId: string,
    role: "maintainer" | "member",
    options?: RequestOptions,
  ): Promise<ProjectMember>
  removeMember(id: string, principalId: string, options?: RequestOptions): Promise<void>
  work(id: string, options?: RequestOptions): Promise<readonly ProjectWorkItem[]>
  presence(id: string, options?: RequestOptions): Promise<readonly PresenceLease[]>
  heartbeatPresence(id: string, clientId: string, options?: RequestOptions): Promise<PresenceLease>
  releasePresence(id: string, clientId: string, options?: RequestOptions): Promise<void>
  principals(options?: RequestOptions): Promise<readonly Principal[]>
  createPrincipal(input: CreatePrincipalRequest, options?: RequestOptions): Promise<Principal>
}

export interface ConnectedOnboardingClient {
  get(options?: RequestOptions): Promise<ConnectedOnboarding>
  connectAgent(agentType: string, options?: RequestOptions): Promise<AgentConnection>
  revokeAgent(connectionId: string, options?: RequestOptions): Promise<AgentConnection>
  selectProject(
    projectId: string,
    selected: boolean,
    options?: RequestOptions,
  ): Promise<ProjectSelection>
  bindRepository(
    projectId: string,
    grantId: string,
    options?: RequestOptions,
  ): Promise<ProjectRepositoryBinding>
  importRepository(grantId: string, options?: RequestOptions): Promise<ImportedProjectRepository>
}

export interface TaskRelaysClient {
  create(
    projectId: string,
    input: CreateTaskRelayRequest,
    options?: RequestOptions,
  ): Promise<TaskRelay>
  list(
    projectId: string,
    task: { readonly kind: "run" | "session"; readonly id: string },
    options?: RequestOptions,
  ): Promise<readonly TaskRelay[]>
  inbox(projectId: string, options?: RequestOptions): Promise<readonly TaskRelay[]>
  recent(projectId: string, limit?: number, options?: RequestOptions): Promise<readonly TaskRelay[]>
  acknowledge(projectId: string, relayId: string, options?: RequestOptions): Promise<TaskRelay>
}

export interface TaskAnnotationsClient {
  create(
    projectId: string,
    input: CreateTaskAnnotationRequest,
    options?: RequestOptions,
  ): Promise<TaskAnnotation>
  list(
    projectId: string,
    task: { readonly kind: "run" | "session"; readonly id: string },
    options?: RequestOptions,
  ): Promise<readonly TaskAnnotation[]>
  resolve(
    projectId: string,
    annotationId: string,
    options?: RequestOptions,
  ): Promise<TaskAnnotation>
}

interface MeanwhileErrorInput {
  readonly code: string
  readonly message: string
  readonly status?: number
  readonly requestId?: string
  readonly details?: Readonly<Record<string, unknown>>
}

/** The only public failure type: safe, structured, and free of credentials and response bodies. */
export class MeanwhileError extends Error {
  readonly code: string
  readonly status: number | undefined
  readonly requestId: string | undefined
  readonly details: Readonly<Record<string, unknown>>

  constructor(input: MeanwhileErrorInput, options?: ErrorOptions) {
    super(input.message, options)
    this.name = "MeanwhileError"
    this.code = input.code
    this.status = input.status
    this.requestId = input.requestId
    this.details = input.details ?? {}
  }
}

/** A Web-standard client for the complete public Meanwhile control-plane contract. */
export class Meanwhile {
  readonly runs: RunsClient
  readonly sessions: SessionsClient
  readonly artifacts: ArtifactsClient
  readonly briefs: BriefsClient
  readonly deployments: DeploymentsClient
  readonly providers: ProvidersClient
  readonly audit: AuditClient
  readonly apiKeys: ApiKeysClient
  readonly invitations: PrincipalInvitationsClient
  readonly projects: ProjectsClient
  readonly onboarding: ConnectedOnboardingClient
  readonly taskAnnotations: TaskAnnotationsClient
  readonly taskRelays: TaskRelaysClient

  constructor(options: MeanwhileOptions) {
    const transport = new Transport(options)
    this.runs = new Runs(transport)
    this.sessions = new Sessions(transport)
    this.artifacts = new Artifacts(transport)
    this.briefs = new Briefs(transport)
    this.deployments = new Deployments(transport)
    this.providers = new Providers(transport)
    this.audit = new Audit(transport)
    this.apiKeys = new ApiKeys(transport)
    this.invitations = new PrincipalInvitations(transport)
    this.projects = new Projects(transport)
    this.onboarding = new Onboarding(transport)
    this.taskAnnotations = new TaskAnnotations(transport)
    this.taskRelays = new TaskRelays(transport)
  }
}

class Runs implements RunsClient {
  constructor(private readonly transport: Transport) {}

  async create(input: CreateRunRequest, options: CreateRunOptions = {}): Promise<Run> {
    const body = parseInput(CreateRunRequestSchema, input)
    const headers = new Headers()
    if (options.idempotencyKey !== undefined) {
      if (options.idempotencyKey.length < 1 || options.idempotencyKey.length > 255) {
        throw invalidArgument("Idempotency key must contain between 1 and 255 characters", {
          field: "idempotencyKey",
        })
      }
      headers.set("Idempotency-Key", options.idempotencyKey)
    }
    const result = await this.transport.json("runs", RunResponseSchema, {
      method: "POST",
      headers,
      body,
      ...signalInput(options.signal),
    })
    return result.run
  }

  async list(options: ListRunsOptions = {}): Promise<RunPage> {
    const limit = boundedInteger(options.limit ?? 50, 1, 100, "limit")
    const query = new URLSearchParams({ limit: String(limit) })
    if (options.before !== undefined) query.set("before", options.before)
    return this.transport.json(`runs?${query}`, RunPageSchema, signalInput(options.signal))
  }

  async get(id: string, options: RequestOptions = {}): Promise<Run> {
    const result = await this.transport.json(
      runPath(id),
      RunResponseSchema,
      signalInput(options.signal),
    )
    return result.run
  }

  async cancel(id: string, options: RequestOptions = {}): Promise<Run> {
    const result = await this.transport.json(`${runPath(id)}/cancel`, RunResponseSchema, {
      method: "POST",
      ...signalInput(options.signal),
    })
    return result.run
  }

  logs(id: string, options: ListLogsOptions = {}): Promise<RunLogPage> {
    return this.transport.json(logPath(id, options), RunLogPageSchema, signalInput(options.signal))
  }

  async *followLogs(id: string, options: FollowLogsOptions = {}): AsyncIterable<RunLog> {
    yield* followEventStream(
      this.transport,
      id,
      "logs",
      "log",
      RunLogSchema,
      "Invalid run log event",
      options,
    )
  }

  events(id: string, options: ListSequenceOptions = {}): Promise<RunEventPage> {
    return this.transport.json(
      eventPath(id, options),
      RunEventPageSchema,
      signalInput(options.signal),
    )
  }

  async *followEvents(id: string, options: FollowEventsOptions = {}): AsyncIterable<RunEvent> {
    yield* followEventStream(
      this.transport,
      id,
      "events",
      "event",
      RunEventSchema,
      "Invalid run event",
      options,
    )
  }

  wait(id: string, options: WaitOptions = {}): Promise<Run> {
    return waitForTerminal(
      "run",
      validId(id),
      () => this.get(id, signalInput(options.signal)),
      (run) => TERMINAL_RUN_STATUSES.has(run.status),
      this.transport,
      options,
    )
  }
}

class Sessions implements SessionsClient {
  constructor(private readonly transport: Transport) {}

  async create(input: CreateSessionRequest, options: CreateRunOptions = {}): Promise<AgentSession> {
    const body = parseInput(CreateSessionRequestSchema, input)
    const headers = idempotencyHeaders(options.idempotencyKey)
    const result = await this.transport.json("sessions", AgentSessionResponseSchema, {
      method: "POST",
      headers,
      body,
      ...signalInput(options.signal),
    })
    return result.session
  }

  list(options: ListCreatedOptions = {}): Promise<AgentSessionPage> {
    return this.transport.json(`sessions?${createdPageQuery(options)}`, AgentSessionPageSchema, {
      ...signalInput(options.signal),
    })
  }

  async get(id: string, options: RequestOptions = {}): Promise<AgentSession> {
    const result = await this.transport.json(
      sessionPath(id),
      AgentSessionResponseSchema,
      signalInput(options.signal),
    )
    return result.session
  }

  waitForStatus(
    id: string,
    status: AgentSession["status"],
    options: WaitOptions = {},
  ): Promise<AgentSession> {
    return waitForTerminal(
      "session",
      validId(id),
      () => this.get(id, signalInput(options.signal)),
      (session) => {
        if (session.status === status) return true
        if (TERMINAL_SESSION_STATUSES.has(session.status)) {
          throw new MeanwhileError({
            code: "SESSION_TERMINAL",
            message: "The session became terminal before reaching the requested status",
            details: { sessionId: session.id, requestedStatus: status, status: session.status },
          })
        }
        return false
      },
      this.transport,
      options,
      `status ${status}`,
    )
  }

  send(id: string, prompt: string, options?: SendSessionTurnOptions): Promise<SessionTurn>
  send(
    id: string,
    input: CreateSessionTurnRequest,
    options?: CreateRunOptions,
  ): Promise<SessionTurn>
  async send(
    id: string,
    input: string | CreateSessionTurnRequest,
    options: SendSessionTurnOptions = {},
  ): Promise<SessionTurn> {
    const body =
      typeof input === "string"
        ? {
            prompt: input,
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            ...(options.conflictPolicy === undefined
              ? {}
              : { conflictPolicy: options.conflictPolicy }),
            ...(options.briefIds === undefined ? {} : { briefIds: [...options.briefIds] }),
          }
        : input
    const result = await this.transport.json(
      `${sessionPath(id)}/turns`,
      SessionTurnResponseSchema,
      {
        method: "POST",
        headers: idempotencyHeaders(options.idempotencyKey),
        body: parseInput(CreateSessionTurnRequestSchema, body),
        ...signalInput(options.signal),
      },
    )
    return result.turn
  }

  turns(id: string, options: ListSequenceOptions = {}): Promise<SessionTurnPage> {
    return this.transport.json(
      `${sessionPath(id)}/turns?${cursorQuery(options)}`,
      SessionTurnPageSchema,
      signalInput(options.signal),
    )
  }

  async getTurn(id: string, turnId: string, options: RequestOptions = {}): Promise<SessionTurn> {
    const result = await this.transport.json(
      `${sessionPath(id)}/turns/${encodeURIComponent(validId(turnId))}`,
      SessionTurnResponseSchema,
      signalInput(options.signal),
    )
    return result.turn
  }

  async waitForTurn(id: string, turnId: string, options: WaitOptions = {}): Promise<SessionTurn> {
    const validTurnId = validId(turnId)
    const turn = await waitForTerminal(
      "turn",
      validTurnId,
      () => this.getTurn(id, validTurnId, signalInput(options.signal)),
      (candidate) => TERMINAL_TURN_STATUSES.has(candidate.status),
      this.transport,
      options,
    )
    return turn
  }

  events(id: string, options: ListSequenceOptions = {}): Promise<SessionEventPage> {
    return this.transport.json(
      `${sessionPath(id)}/events?${cursorQuery(options)}`,
      SessionEventPageSchema,
      signalInput(options.signal),
    )
  }

  async *followEvents(id: string, options: FollowEventsOptions = {}): AsyncIterable<SessionEvent> {
    yield* followEventStream(
      this.transport,
      id,
      "session-events",
      "event",
      SessionEventSchema,
      "Invalid session event",
      options,
    )
  }

  async interrupt(id: string, options: RequestOptions = {}): Promise<AgentSession> {
    const result = await this.transport.json(
      `${sessionPath(id)}/interrupt`,
      AgentSessionResponseSchema,
      { method: "POST", ...signalInput(options.signal) },
    )
    return result.session
  }

  async close(id: string, options: RequestOptions = {}): Promise<AgentSession> {
    const result = await this.transport.json(
      `${sessionPath(id)}/close`,
      AgentSessionResponseSchema,
      { method: "POST", ...signalInput(options.signal) },
    )
    return result.session
  }
}

async function* followEventStream<Value extends { readonly sequence: number }>(
  transport: Transport,
  id: string,
  resource: "logs" | "events" | "session-events",
  eventType: "log" | "event",
  schema: z.ZodType<Value>,
  invalidEventMessage: string,
  options: ListSequenceOptions,
): AsyncIterable<Value> {
  const signal = options.signal ?? new AbortController().signal
  const after = boundedInteger(options.after ?? 0, 0, Number.MAX_SAFE_INTEGER, "after")
  const limit = boundedInteger(options.limit ?? 100, 1, 1_000, "limit")
  const query = new URLSearchParams({ after: String(after), limit: String(limit), follow: "true" })
  const path =
    resource === "session-events"
      ? `${sessionPath(id)}/events?${query}`
      : `${runPath(id)}/${resource}?${query}`
  let cursor = after
  let retryMilliseconds = DEFAULT_SSE_RETRY_MS
  let consecutiveEmptyConnections = 0

  while (!signal.aborted) {
    let response: Response
    try {
      response = await transport.response(path, {
        headers: new Headers({ Accept: "text/event-stream", "Last-Event-ID": String(cursor) }),
        signal,
        timeout: false,
      })
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof MeanwhileError && error.code === "API_UNREACHABLE") {
        consecutiveEmptyConnections += 1
        const delay = Math.min(
          retryMilliseconds * 2 ** Math.min(consecutiveEmptyConnections - 1, 10),
          MAX_SSE_RETRY_MS,
        )
        await transport.delay(delay, signal)
        continue
      }
      throw error
    }
    if (!isEventStreamResponse(response)) {
      await response.body?.cancel().catch(() => undefined)
      throw protocolError("Event stream has an invalid content type", {
        path,
        status: response.status,
      })
    }
    if (response.body === null)
      throw protocolError("Event stream has no body", { path, status: response.status })

    let madeProgress = false
    for await (const event of sseEvents(response.body, signal)) {
      if (event.retryMilliseconds !== undefined)
        retryMilliseconds = boundedSseRetry(event.retryMilliseconds)
      if (event.type === "end") return
      if (event.type === "error") throw errorFromEnvelope(parseJson(event.data), response.status)
      if (event.type !== eventType) continue
      const sequence = parseSseSequence(event.id)
      const value = parseProtocol(schema, parseJson(event.data), invalidEventMessage)
      if (value.sequence !== sequence) throw protocolError("Event stream identity is inconsistent")
      if (sequence <= cursor) continue
      if (sequence !== cursor + 1) {
        throw protocolError("Event stream sequence is not contiguous", {
          expected: cursor + 1,
          received: sequence,
        })
      }
      cursor = sequence
      madeProgress = true
      yield value
    }
    if (signal.aborted) return
    consecutiveEmptyConnections = madeProgress ? 0 : consecutiveEmptyConnections + 1
    const delay = Math.min(
      retryMilliseconds * 2 ** Math.min(Math.max(consecutiveEmptyConnections - 1, 0), 10),
      MAX_SSE_RETRY_MS,
    )
    await transport.delay(delay, signal)
  }
}

class Artifacts implements ArtifactsClient {
  constructor(private readonly transport: Transport) {}

  async list(id: string, options: RequestOptions = {}): Promise<readonly Artifact[]> {
    const result = await this.transport.json(
      `${runPath(id)}/artifacts`,
      ArtifactPageSchema,
      signalInput(options.signal),
    )
    return result.items
  }

  get(id: string, options: RequestOptions = {}): Promise<ArtifactDetail> {
    return this.transport.json(artifactPath(id), ArtifactDetailSchema, signalInput(options.signal))
  }

  async download(
    id: string,
    options: RequestOptions & { readonly path?: string } = {},
  ): Promise<ArtifactDownload> {
    const query = new URLSearchParams()
    if (options.path !== undefined) query.set("path", options.path)
    const response = await this.transport.response(
      `${artifactPath(id)}/content${query.size === 0 ? "" : `?${query}`}`,
      signalInput(options.signal),
    )
    if (response.headers.get("Content-Type")?.split(";", 1)[0] !== "application/octet-stream") {
      await response.body?.cancel().catch(() => undefined)
      throw protocolError("Artifact download has an invalid content type")
    }
    const digest = response.headers.get("X-Meanwhile-Artifact-Digest")
    if (digest === null || !/^[a-f0-9]{64}$/.test(digest)) {
      await response.body?.cancel().catch(() => undefined)
      throw protocolError("Artifact download has an invalid digest")
    }
    const contentLength = response.headers.get("Content-Length")
    const byteSize = contentLength === null ? Number.NaN : Number(contentLength)
    if (!Number.isSafeInteger(byteSize) || byteSize < 0 || response.body === null) {
      await response.body?.cancel().catch(() => undefined)
      throw protocolError("Artifact download has invalid length metadata")
    }
    return {
      body: response.body,
      digest,
      mediaType: response.headers.get("X-Meanwhile-Media-Type") ?? "application/octet-stream",
      byteSize,
    }
  }
}

class Briefs implements BriefsClient {
  constructor(private readonly transport: Transport) {}

  async create(input: CreateBriefRequest, options: RequestOptions = {}): Promise<Brief> {
    const result = await this.transport.json("briefs", BriefResponseSchema, {
      method: "POST",
      body: parseInput(CreateBriefRequestSchema, input),
      ...signalInput(options.signal),
    })
    return result.brief
  }

  list(options: ListCreatedOptions = {}): Promise<BriefPage> {
    return this.transport.json(`briefs?${createdPageQuery(options)}`, BriefPageSchema, {
      ...signalInput(options.signal),
    })
  }

  async get(id: string, options: RequestOptions = {}): Promise<Brief> {
    const result = await this.transport.json(briefPath(id), BriefResponseSchema, {
      ...signalInput(options.signal),
    })
    return result.brief
  }
}

class Deployments implements DeploymentsClient {
  constructor(private readonly transport: Transport) {}

  async create(
    input: CreateDeploymentRequest,
    options?: CreateDeploymentOptions,
  ): Promise<Deployment> {
    const body = parseInput(CreateDeploymentRequestSchema, input)
    const idempotencyKey = options?.idempotencyKey
    if (
      typeof idempotencyKey !== "string" ||
      idempotencyKey.length < 1 ||
      idempotencyKey.length > 255
    ) {
      throw invalidArgument("Idempotency key must contain between 1 and 255 characters", {
        field: "idempotencyKey",
      })
    }
    const headers = new Headers({ "Idempotency-Key": idempotencyKey })
    const result = await this.transport.json("deployments", DeploymentResponseSchema, {
      method: "POST",
      body,
      headers,
      ...signalInput(options?.signal),
    })
    return result.deployment
  }

  list(options: ListCreatedOptions = {}): Promise<DeploymentPage> {
    return this.transport.json(
      `deployments?${createdPageQuery(options)}`,
      DeploymentPageSchema,
      signalInput(options.signal),
    )
  }

  async get(id: string, options: RequestOptions = {}): Promise<Deployment> {
    const result = await this.transport.json(
      deploymentPath(id),
      DeploymentResponseSchema,
      signalInput(options.signal),
    )
    return result.deployment
  }

  logs(id: string, options: ListLogsOptions = {}): Promise<DeploymentLogPage> {
    const query = cursorQuery(options)
    return this.transport.json(
      `${deploymentPath(id)}/logs?${query}`,
      DeploymentLogPageSchema,
      signalInput(options.signal),
    )
  }

  wait(id: string, options: WaitOptions = {}): Promise<Deployment> {
    return waitForTerminal(
      "deployment",
      validId(id),
      () => this.get(id, signalInput(options.signal)),
      (deployment) => TERMINAL_DEPLOYMENT_STATUSES.has(deployment.status),
      this.transport,
      options,
    )
  }
}

class Audit implements AuditClient {
  constructor(private readonly transport: Transport) {}

  list(options: Parameters<AuditClient["list"]>[0] = {}): Promise<AuditPage> {
    const query = createdPageQuery(options)
    if (options.resourceType !== undefined) query.set("resourceType", options.resourceType)
    if (options.resourceId !== undefined) query.set("resourceId", options.resourceId)
    if (options.action !== undefined) query.set("action", options.action)
    return this.transport.json(`audit?${query}`, AuditPageSchema, signalInput(options.signal))
  }
}

class ApiKeys implements ApiKeysClient {
  constructor(private readonly transport: Transport) {}

  create(name: string, options: RequestOptions & { readonly principalId?: string } = {}) {
    const { principalId } = options
    const body = parseInput(CreateApiKeyRequestSchema, {
      name,
      ...(principalId === undefined ? {} : { principalId }),
    })
    return this.transport.json("api-keys", CreatedApiKeyResponseSchema, {
      method: "POST",
      body,
      ...signalInput(options.signal),
    })
  }

  async list(options: RequestOptions = {}): Promise<readonly ApiKey[]> {
    const result = await this.transport.json(
      "api-keys",
      ApiKeyPageSchema,
      signalInput(options.signal),
    )
    return result.items
  }

  async revoke(id: string, options: RequestOptions = {}): Promise<ApiKey> {
    const result = await this.transport.json(
      `api-keys/${encodeURIComponent(validId(id))}`,
      ApiKeyResponseSchema,
      { method: "DELETE", ...signalInput(options.signal) },
    )
    return result.key
  }
}

class PrincipalInvitations implements PrincipalInvitationsClient {
  constructor(private readonly transport: Transport) {}

  create(
    principalId: string,
    options: RequestOptions & { readonly expiresInSeconds?: number } = {},
  ) {
    return this.transport.json("principal-invitations", CreatedPrincipalInvitationResponseSchema, {
      method: "POST",
      body: {
        principalId: validId(principalId),
        ...(options.expiresInSeconds === undefined
          ? {}
          : { expiresInSeconds: options.expiresInSeconds }),
      },
      ...signalInput(options.signal),
    })
  }

  async list(options: RequestOptions = {}): Promise<readonly PrincipalInvitation[]> {
    const result = await this.transport.json(
      "principal-invitations",
      PrincipalInvitationPageSchema,
      signalInput(options.signal),
    )
    return result.items
  }

  async revoke(id: string, options: RequestOptions = {}): Promise<PrincipalInvitation> {
    const result = await this.transport.json(
      `principal-invitations/${encodeURIComponent(validId(id))}`,
      PrincipalInvitationResponseSchema,
      { method: "DELETE", ...signalInput(options.signal) },
    )
    return result.invitation
  }
}

class Projects implements ProjectsClient {
  constructor(private readonly transport: Transport) {}

  me(options: RequestOptions = {}) {
    return this.transport.json("me", MeResponseSchema, signalInput(options.signal))
  }

  async list(options: RequestOptions = {}): Promise<readonly Project[]> {
    const result = await this.transport.json(
      "projects",
      ProjectPageSchema,
      signalInput(options.signal),
    )
    return result.items
  }

  async get(id: string, options: RequestOptions = {}): Promise<Project> {
    const result = await this.transport.json(
      `projects/${encodeURIComponent(validId(id))}`,
      ProjectResponseSchema,
      signalInput(options.signal),
    )
    return result.project
  }

  async create(input: CreateProjectRequest, options: RequestOptions = {}): Promise<Project> {
    const result = await this.transport.json("projects", ProjectResponseSchema, {
      method: "POST",
      body: parseInput(CreateProjectRequestSchema, input),
      ...signalInput(options.signal),
    })
    return result.project
  }

  async members(id: string, options: RequestOptions = {}): Promise<readonly ProjectMember[]> {
    const result = await this.transport.json(
      `projects/${encodeURIComponent(validId(id))}/members`,
      ProjectMemberPageSchema,
      signalInput(options.signal),
    )
    return result.items
  }

  async participants(
    id: string,
    options: RequestOptions = {},
  ): Promise<readonly ProjectParticipant[]> {
    const result = await this.transport.json(
      `projects/${encodeURIComponent(validId(id))}/participants`,
      ProjectParticipantPageSchema,
      signalInput(options.signal),
    )
    return result.items
  }

  async addMember(
    id: string,
    principalId: string,
    role: "maintainer" | "member",
    options: RequestOptions = {},
  ): Promise<ProjectMember> {
    const result = await this.transport.json(
      `projects/${encodeURIComponent(validId(id))}/members`,
      ProjectMemberResponseSchema,
      {
        method: "POST",
        body: parseInput(AddProjectMemberRequestSchema, { principalId, role }),
        ...signalInput(options.signal),
      },
    )
    return result.member
  }

  async removeMember(id: string, principalId: string, options: RequestOptions = {}): Promise<void> {
    await this.transport.empty(
      `projects/${encodeURIComponent(validId(id))}/members/${encodeURIComponent(validId(principalId))}`,
      { method: "DELETE", ...signalInput(options.signal) },
    )
  }

  async work(id: string, options: RequestOptions = {}): Promise<readonly ProjectWorkItem[]> {
    const result = await this.transport.json(
      `projects/${encodeURIComponent(validId(id))}/work`,
      ProjectWorkPageSchema,
      signalInput(options.signal),
    )
    return result.items
  }

  async presence(id: string, options: RequestOptions = {}): Promise<readonly PresenceLease[]> {
    const result = await this.transport.json(
      `projects/${encodeURIComponent(validId(id))}/presence`,
      PresenceLeasePageSchema,
      signalInput(options.signal),
    )
    return result.items
  }

  async heartbeatPresence(
    id: string,
    clientId: string,
    options: RequestOptions = {},
  ): Promise<PresenceLease> {
    const result = await this.transport.json(
      `projects/${encodeURIComponent(validId(id))}/presence/${encodeURIComponent(validId(clientId))}`,
      PresenceLeaseResponseSchema,
      { method: "PUT", ...signalInput(options.signal) },
    )
    return result.lease
  }

  async releasePresence(id: string, clientId: string, options: RequestOptions = {}): Promise<void> {
    await this.transport.empty(
      `projects/${encodeURIComponent(validId(id))}/presence/${encodeURIComponent(validId(clientId))}`,
      { method: "DELETE", ...signalInput(options.signal) },
    )
  }

  async principals(options: RequestOptions = {}): Promise<readonly Principal[]> {
    const result = await this.transport.json(
      "principals",
      PrincipalPageSchema,
      signalInput(options.signal),
    )
    return result.items
  }

  async createPrincipal(
    input: CreatePrincipalRequest,
    options: RequestOptions = {},
  ): Promise<Principal> {
    const result = await this.transport.json("principals", PrincipalResponseSchema, {
      method: "POST",
      body: parseInput(CreatePrincipalRequestSchema, input),
      ...signalInput(options.signal),
    })
    return result.principal
  }
}

class Onboarding implements ConnectedOnboardingClient {
  constructor(private readonly transport: Transport) {}

  get(options: RequestOptions = {}): Promise<ConnectedOnboarding> {
    return this.transport.json(
      "onboarding",
      ConnectedOnboardingResponseSchema,
      signalInput(options.signal),
    )
  }

  async connectAgent(agentType: string, options: RequestOptions = {}): Promise<AgentConnection> {
    const result = await this.transport.json(
      "onboarding/agent-connections",
      AgentConnectionResponseSchema,
      {
        method: "POST",
        body: parseInput(ConnectAgentRequestSchema, { agentType }),
        ...signalInput(options.signal),
      },
    )
    return result.connection
  }

  async revokeAgent(connectionId: string, options: RequestOptions = {}): Promise<AgentConnection> {
    const result = await this.transport.json(
      `onboarding/agent-connections/${encodeURIComponent(validId(connectionId))}`,
      AgentConnectionResponseSchema,
      { method: "DELETE", ...signalInput(options.signal) },
    )
    return result.connection
  }

  async selectProject(
    projectId: string,
    selected: boolean,
    options: RequestOptions = {},
  ): Promise<ProjectSelection> {
    const result = await this.transport.json(
      `onboarding/projects/${encodeURIComponent(validId(projectId))}/selection`,
      ProjectSelectionResponseSchema,
      {
        method: "PUT",
        body: parseInput(SetProjectSelectionRequestSchema, { selected }),
        ...signalInput(options.signal),
      },
    )
    return result.selection
  }

  async bindRepository(
    projectId: string,
    grantId: string,
    options: RequestOptions = {},
  ): Promise<ProjectRepositoryBinding> {
    const result = await this.transport.json(
      `onboarding/projects/${encodeURIComponent(validId(projectId))}/repository`,
      ProjectRepositoryBindingResponseSchema,
      {
        method: "PUT",
        body: parseInput(BindProjectRepositoryRequestSchema, { grantId }),
        ...signalInput(options.signal),
      },
    )
    return result.binding
  }

  importRepository(
    grantId: string,
    options: RequestOptions = {},
  ): Promise<ImportedProjectRepository> {
    return this.transport.json("onboarding/projects", ImportedProjectRepositoryResponseSchema, {
      method: "POST",
      body: parseInput(ImportProjectRepositoryRequestSchema, { grantId }),
      ...signalInput(options.signal),
    })
  }
}

class TaskAnnotations implements TaskAnnotationsClient {
  constructor(private readonly transport: Transport) {}

  async create(
    projectId: string,
    input: CreateTaskAnnotationRequest,
    options: RequestOptions = {},
  ): Promise<TaskAnnotation> {
    const result = await this.transport.json(
      `projects/${encodeURIComponent(validId(projectId))}/annotations`,
      TaskAnnotationResponseSchema,
      {
        method: "POST",
        body: parseInput(CreateTaskAnnotationRequestSchema, input),
        ...signalInput(options.signal),
      },
    )
    return result.annotation
  }

  async list(
    projectId: string,
    task: { readonly kind: "run" | "session"; readonly id: string },
    options: RequestOptions = {},
  ): Promise<readonly TaskAnnotation[]> {
    const query = new URLSearchParams({ taskKind: task.kind, taskId: validId(task.id) })
    const result = await this.transport.json(
      `projects/${encodeURIComponent(validId(projectId))}/annotations?${query}`,
      TaskAnnotationPageSchema,
      signalInput(options.signal),
    )
    return result.items
  }

  async resolve(
    projectId: string,
    annotationId: string,
    options: RequestOptions = {},
  ): Promise<TaskAnnotation> {
    const result = await this.transport.json(
      `projects/${encodeURIComponent(validId(projectId))}/annotations/${encodeURIComponent(validId(annotationId))}/resolve`,
      TaskAnnotationResponseSchema,
      { method: "POST", ...signalInput(options.signal) },
    )
    return result.annotation
  }
}

class TaskRelays implements TaskRelaysClient {
  constructor(private readonly transport: Transport) {}

  async create(
    projectId: string,
    input: CreateTaskRelayRequest,
    options: RequestOptions = {},
  ): Promise<TaskRelay> {
    const result = await this.transport.json(
      `projects/${encodeURIComponent(validId(projectId))}/relays`,
      TaskRelayResponseSchema,
      {
        method: "POST",
        body: parseInput(CreateTaskRelayRequestSchema, input),
        ...signalInput(options.signal),
      },
    )
    return result.relay
  }

  async list(
    projectId: string,
    task: { readonly kind: "run" | "session"; readonly id: string },
    options: RequestOptions = {},
  ): Promise<readonly TaskRelay[]> {
    const query = new URLSearchParams({ taskKind: task.kind, taskId: validId(task.id) })
    const result = await this.transport.json(
      `projects/${encodeURIComponent(validId(projectId))}/relays?${query}`,
      TaskRelayPageSchema,
      signalInput(options.signal),
    )
    return result.items
  }

  async inbox(projectId: string, options: RequestOptions = {}): Promise<readonly TaskRelay[]> {
    const result = await this.transport.json(
      `projects/${encodeURIComponent(validId(projectId))}/relay-inbox`,
      TaskRelayPageSchema,
      signalInput(options.signal),
    )
    return result.items
  }

  async recent(
    projectId: string,
    limit = 3,
    options: RequestOptions = {},
  ): Promise<readonly TaskRelay[]> {
    const query = new URLSearchParams({ limit: String(limit) })
    const result = await this.transport.json(
      `projects/${encodeURIComponent(validId(projectId))}/recent-relays?${query}`,
      TaskRelayPageSchema,
      signalInput(options.signal),
    )
    return result.items
  }

  async acknowledge(
    projectId: string,
    relayId: string,
    options: RequestOptions = {},
  ): Promise<TaskRelay> {
    const result = await this.transport.json(
      `projects/${encodeURIComponent(validId(projectId))}/relays/${encodeURIComponent(validId(relayId))}/acknowledge`,
      TaskRelayResponseSchema,
      { method: "POST", ...signalInput(options.signal) },
    )
    return result.relay
  }
}

class Providers implements ProvidersClient {
  constructor(private readonly transport: Transport) {}

  test(name: string, options: RequestOptions = {}): Promise<ProviderDiagnostics> {
    const body = parseInput(ProviderTestRequestSchema, { provider: name })
    return this.transport.json("providers/test", ProviderDiagnosticsSchema, {
      method: "POST",
      body,
      ...signalInput(options.signal),
    })
  }
}

interface TransportRequest {
  readonly method?: "GET" | "POST" | "PUT" | "DELETE"
  readonly headers?: Headers
  readonly body?: unknown
  readonly signal?: AbortSignal
  readonly timeout?: boolean
}

class Transport {
  readonly baseUrl: URL
  readonly authorization: string
  readonly fetch: Fetch
  readonly requestTimeoutMs: number
  readonly wait: Wait
  readonly onResponse: ((evidence: ClientResponseEvidence) => void) | undefined

  constructor(options: MeanwhileOptions) {
    if (isBrowser() && options.dangerouslyAllowBrowser !== true) {
      throw invalidArgument(
        "Browser use is disabled because it exposes a Meanwhile credential; use a trusted BFF",
      )
    }
    const hasApiKey = options.apiKey !== undefined
    const hasBrowserSession = options.browserSession !== undefined
    if (hasApiKey === hasBrowserSession) {
      throw invalidArgument("Provide exactly one API key or browser session")
    }
    const credential = options.apiKey ?? options.browserSession
    if (credential === undefined || credential.length === 0) {
      throw invalidArgument("Meanwhile credential must not be empty")
    }
    this.baseUrl = parseBaseUrl(options.baseUrl)
    this.authorization = `${hasApiKey ? "Bearer" : "Session"} ${credential}`
    this.fetch = options.fetch ?? globalThis.fetch
    this.requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      1,
      24 * 60 * 60_000,
      "requestTimeoutMs",
    )
    this.wait = options.wait ?? abortableDelay
    this.onResponse = options.onResponse
  }

  async json<Schema extends z.ZodType>(
    path: string,
    schema: Schema,
    options: TransportRequest = {},
  ): Promise<z.output<Schema>> {
    const response = await this.response(path, options)
    const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase()
    if (contentType !== "application/json") {
      await response.body?.cancel().catch(() => undefined)
      throw protocolError("Meanwhile returned a non-JSON response", {
        path,
        status: response.status,
      })
    }
    const content = await readBoundedBody(response, MAX_RESPONSE_BYTES)
    const value = parseJson(content)
    return parseProtocol(
      schema,
      value,
      "Meanwhile returned a response that violates its contract",
      {
        path,
        status: response.status,
      },
    )
  }

  async empty(path: string, options: TransportRequest = {}): Promise<void> {
    const response = await this.response(path, options)
    if (response.status !== 204) {
      await response.body?.cancel().catch(() => undefined)
      throw protocolError("Meanwhile returned a non-empty response", {
        path,
        status: response.status,
      })
    }
    await response.body?.cancel().catch(() => undefined)
  }

  async response(path: string, options: TransportRequest = {}): Promise<Response> {
    const method = options.method ?? "GET"
    const requestId = crypto.randomUUID()
    const headers = new Headers(options.headers)
    headers.set("Authorization", this.authorization)
    headers.set("X-Request-ID", requestId)
    if (!headers.has("Accept")) headers.set("Accept", "application/json")
    if (options.body !== undefined) headers.set("Content-Type", "application/json")

    const timeoutSignal =
      options.timeout === false ? undefined : AbortSignal.timeout(this.requestTimeoutMs)
    const signal = combineSignals(options.signal, timeoutSignal)
    let response: Response
    try {
      response = await this.fetch(new URL(path, this.baseUrl), {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (options.signal?.aborted) {
        throw new MeanwhileError(
          { code: "REQUEST_ABORTED", message: "Meanwhile request was aborted", requestId },
          { cause: error },
        )
      }
      if (timeoutSignal?.aborted) {
        throw new MeanwhileError(
          { code: "REQUEST_TIMEOUT", message: "Meanwhile request timed out", requestId },
          { cause: error },
        )
      }
      throw new MeanwhileError(
        { code: "API_UNREACHABLE", message: "Meanwhile control plane is unreachable", requestId },
        { cause: error },
      )
    }

    const responseRequestId = response.headers.get("X-Request-ID") ?? requestId
    this.onResponse?.({ method, path, status: response.status, requestId: responseRequestId })
    if (!response.ok) {
      const contentType = response.headers
        .get("Content-Type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase()
      if (contentType !== "application/json") {
        await response.body?.cancel().catch(() => undefined)
        throw protocolError("Meanwhile returned a non-structured error", {
          path,
          status: response.status,
        })
      }
      const content = await readBoundedBody(response, MAX_RESPONSE_BYTES)
      throw errorFromEnvelope(parseJson(content), response.status)
    }
    return response
  }

  delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return this.wait(milliseconds, signal)
  }
}

async function waitForTerminal<Value>(
  resource: "run" | "session" | "deployment" | "turn",
  id: string,
  read: () => Promise<Value>,
  terminal: (value: Value) => boolean,
  transport: Transport,
  options: WaitOptions,
  condition = "terminal",
): Promise<Value> {
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
    1,
    24 * 60 * 60_000,
    "timeoutMs",
  )
  const pollIntervalMs = boundedInteger(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    1,
    60_000,
    "pollIntervalMs",
  )
  const signal = options.signal ?? new AbortController().signal
  const deadline = performance.now() + timeoutMs
  for (;;) {
    if (signal.aborted) throw abortedError()
    const value = await read()
    if (terminal(value)) return value
    const remaining = deadline - performance.now()
    if (remaining <= 0) {
      throw new MeanwhileError({
        code: "CLIENT_WAIT_TIMEOUT",
        message: `The ${resource} did not reach ${condition} before the client deadline`,
        details: { resource, id, timeoutMs, condition },
      })
    }
    await transport.delay(Math.min(pollIntervalMs, remaining), signal)
  }
}

function parseInput<Schema extends z.ZodType>(
  schema: Schema,
  value: z.input<Schema>,
): z.output<Schema> {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  throw invalidArgument("Client input violates the Meanwhile API contract", {
    issues: result.error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map(String),
      message: issue.message,
    })),
  })
}

function parseProtocol<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): z.output<Schema> {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  throw protocolError(message, {
    ...details,
    issues: result.error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map(String),
    })),
  })
}

function errorFromEnvelope(value: unknown, status?: number): MeanwhileError {
  const result = ErrorEnvelopeSchema.safeParse(value)
  if (!result.success) {
    return protocolError("Meanwhile returned an invalid error envelope", {
      ...(status === undefined ? {} : { status }),
    })
  }
  return new MeanwhileError({
    code: result.data.error.code,
    message: result.data.error.message,
    ...(status === undefined ? {} : { status }),
    requestId: result.data.error.requestId,
    details: result.data.error.details,
  })
}

function parseBaseUrl(value: string | URL): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalidArgument("baseUrl must be an absolute HTTP URL", { field: "baseUrl" })
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw invalidArgument("baseUrl must be an origin without credentials, query, or path", {
      field: "baseUrl",
    })
  }
  url.pathname = "/"
  return url
}

function runPath(id: string): string {
  return `runs/${encodeURIComponent(validId(id))}`
}

function sessionPath(id: string): string {
  return `sessions/${encodeURIComponent(validId(id))}`
}

function idempotencyHeaders(key: string | undefined): Headers {
  const headers = new Headers()
  if (key === undefined) return headers
  if (key.length < 1 || key.length > 255) {
    throw invalidArgument("Idempotency key must contain between 1 and 255 characters", {
      field: "idempotencyKey",
    })
  }
  headers.set("Idempotency-Key", key)
  return headers
}

function deploymentPath(id: string): string {
  return `deployments/${encodeURIComponent(validId(id))}`
}

function artifactPath(id: string): string {
  const result = ArtifactIdentifierSchema.safeParse(id)
  if (!result.success)
    throw invalidArgument("Artifact id must be a SHA-256 digest", { field: "id" })
  return `artifacts/${encodeURIComponent(result.data)}`
}

function briefPath(id: string): string {
  const result = ArtifactIdentifierSchema.safeParse(id)
  if (!result.success) throw invalidArgument("Brief id must be a SHA-256 digest", { field: "id" })
  return `briefs/${encodeURIComponent(result.data)}`
}

function validId(id: string): string {
  const result = IdentifierSchema.safeParse(id)
  if (!result.success) throw invalidArgument("Resource id must be a UUID", { field: "id" })
  return result.data
}

function logPath(id: string, options: ListLogsOptions): string {
  return `${runPath(id)}/logs?${cursorQuery(options)}`
}

function eventPath(id: string, options: ListSequenceOptions): string {
  return `${runPath(id)}/events?${cursorQuery(options)}`
}

function cursorQuery(options: ListSequenceOptions): URLSearchParams {
  return new URLSearchParams({
    after: String(boundedInteger(options.after ?? 0, 0, Number.MAX_SAFE_INTEGER, "after")),
    limit: String(boundedInteger(options.limit ?? 100, 1, 1_000, "limit")),
  })
}

function createdPageQuery(options: ListCreatedOptions): URLSearchParams {
  const query = new URLSearchParams({
    limit: String(boundedInteger(options.limit ?? 50, 1, 100, "limit")),
  })
  if (options.before !== undefined) query.set("before", options.before)
  return query
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidArgument(`${field} must be an integer between ${minimum} and ${maximum}`, {
      field,
    })
  }
  return value
}

function invalidArgument(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): MeanwhileError {
  return new MeanwhileError({ code: "INVALID_ARGUMENT", message, details })
}

function protocolError(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): MeanwhileError {
  return new MeanwhileError({ code: "API_PROTOCOL_ERROR", message, details })
}

function abortedError(): MeanwhileError {
  return new MeanwhileError({ code: "REQUEST_ABORTED", message: "Meanwhile request was aborted" })
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string> {
  if (response.body === null) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let result = ""
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value === undefined) continue
      bytes += value.byteLength
      if (bytes > maximumBytes) throw protocolError("API response is too large")
      result += decoder.decode(value, { stream: true })
    }
    result += decoder.decode()
    return result
  } finally {
    reader.releaseLock()
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (error) {
    throw new MeanwhileError(
      { code: "API_PROTOCOL_ERROR", message: "Meanwhile returned invalid JSON" },
      { cause: error },
    )
  }
}

interface ParsedSseEvent {
  readonly type: string
  readonly data: string
  readonly id?: string
  readonly retryMilliseconds?: number
}

async function* sseEvents(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<ParsedSseEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let lineParts: string[] = []
  let lineBytes = 0
  let eventType = "message"
  let data: string[] = []
  let eventId: string | undefined
  let retryMilliseconds: number | undefined
  let eventBytes = 0
  let finished = false

  const appendLinePart = (value: string) => {
    if (value.length === 0) return
    lineParts.push(value)
    if (lineParts.length >= 64) lineParts = [lineParts.join("")]
  }
  const dispatch = (): ParsedSseEvent | undefined => {
    const shouldDispatch = data.length > 0 || eventType === "end" || retryMilliseconds !== undefined
    const event = shouldDispatch
      ? {
          type: eventType,
          data: data.join("\n"),
          ...(eventId === undefined ? {} : { id: eventId }),
          ...(retryMilliseconds === undefined ? {} : { retryMilliseconds }),
        }
      : undefined
    eventType = "message"
    data = []
    eventId = undefined
    retryMilliseconds = undefined
    eventBytes = 0
    return event
  }
  const processLine = (raw: string, rawBytes: number): ParsedSseEvent | undefined => {
    eventBytes += rawBytes + 1
    if (eventBytes > MAX_SSE_EVENT_BYTES) throw protocolError("Log stream event is too large")
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (line.length === 0) return dispatch()
    if (line.startsWith(":")) return
    const separator = line.indexOf(":")
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? "" : line.slice(separator + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") eventType = value
    if (field === "data") data.push(value)
    if (field === "id" && !value.includes("\0")) eventId = value
    if (field === "retry" && /^\d+$/.test(value)) {
      const parsed = Number(value)
      if (Number.isSafeInteger(parsed)) retryMilliseconds = parsed
    }
  }
  const cancel = () => reader.cancel().catch(() => undefined)
  const abort = () => {
    void cancel()
  }
  signal.addEventListener("abort", abort, { once: true })

  try {
    if (signal.aborted) return
    for (;;) {
      let read: Awaited<ReturnType<typeof reader.read>>
      try {
        read = await reader.read()
      } catch {
        return
      }
      if (signal.aborted) return
      if (read.done) {
        finished = true
        return
      }
      const value = read.value
      if (value.byteLength === 0) continue
      let start = 0
      for (let index = 0; index < value.byteLength; index += 1) {
        if (value[index] !== 10) continue
        const part = value.subarray(start, index)
        lineBytes += part.byteLength
        if (lineBytes > MAX_SSE_EVENT_BYTES) throw protocolError("Log stream event is too large")
        try {
          appendLinePart(decoder.decode(part, { stream: true }))
          appendLinePart(decoder.decode())
        } catch {
          throw protocolError("Log stream is not valid UTF-8")
        }
        const event = processLine(lineParts.join(""), lineBytes)
        lineParts = []
        lineBytes = 0
        start = index + 1
        if (event !== undefined) yield event
      }
      const remainder = value.subarray(start)
      lineBytes += remainder.byteLength
      if (lineBytes > MAX_SSE_EVENT_BYTES) throw protocolError("Log stream event is too large")
      if (remainder.byteLength > 0) {
        try {
          appendLinePart(decoder.decode(remainder, { stream: true }))
        } catch {
          throw protocolError("Log stream is not valid UTF-8")
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", abort)
    if (!finished) await cancel()
    reader.releaseLock()
  }
}

function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get("Content-Type")
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream"
}

function parseSseSequence(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    throw protocolError("Log stream event has an invalid id")
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw protocolError("Log stream event id is out of range")
  return parsed
}

function boundedSseRetry(milliseconds: number): number {
  return Math.min(Math.max(milliseconds, MIN_SSE_RETRY_MS), MAX_SSE_RETRY_MS)
}

function combineSignals(
  caller: AbortSignal | undefined,
  timeout: AbortSignal | undefined,
): AbortSignal | undefined {
  if (caller === undefined) return timeout
  if (timeout === undefined) return caller
  return AbortSignal.any([caller, timeout])
}

function signalInput(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortedError())
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", abort)
      resolve()
    }
    const abort = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", abort)
      reject(abortedError())
    }
    const timeout = setTimeout(finish, milliseconds)
    signal.addEventListener("abort", abort, { once: true })
  })
}

function isBrowser(): boolean {
  return typeof globalThis === "object" && "window" in globalThis && "document" in globalThis
}
