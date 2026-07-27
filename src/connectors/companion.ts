import { resolve } from "node:path"
import {
  AppendedMirrorEventsResponseSchema,
  ConnectorSetupResponseSchema,
  ConversationMirrorResponseSchema,
  MirrorCheckpointSchema,
} from "../api/contracts"
import type { ConnectorSource, ConversationMirror, MirrorEvent } from "../domain"
import { claudeCodeTranscriptNormalizer } from "./claude-code-transcript"
import { codexTranscriptNormalizer } from "./codex-transcript"
import { CompanionOutbox, type CompanionOutboxState } from "./companion-outbox"
import type { NormalizedMirrorEvent, TranscriptNormalizer } from "./external-transcript"
import {
  type JsonlTranscriptCursor,
  readTranscriptIncrement,
  type TranscriptReadIssue,
} from "./jsonl-transcript"
import { type LocalRepositoryCommand, requireConversationRepository } from "./local-repository"
import { inspectLocalConversation } from "./transcript-discovery"
import {
  redactNormalizedMirrorEvent,
  redactTranscriptText,
  type TranscriptRedactionOptions,
} from "./transcript-redaction"

export interface CompanionOptions {
  readonly baseUrl: string | URL
  readonly connectorSecret: string
  readonly projectId: string
  readonly source: ConnectorSource
  readonly transcriptPath: string
  readonly statePath: string
  readonly sourceConversationId: string
  readonly title?: string
  readonly once?: boolean
  readonly pollIntervalMs?: number
  readonly heartbeatIntervalMs?: number
  readonly signal?: AbortSignal
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  readonly onProgress?: (progress: CompanionProgress) => void | Promise<void>
  /** Test/embedding seam for device-local git identity inspection. */
  readonly repositoryCommand?: LocalRepositoryCommand
}

export interface CompanionProgress {
  readonly mirrorId: string
  readonly acceptedSequence: number
  readonly caughtUp: boolean
  readonly issues: readonly TranscriptReadIssue[]
}

/**
 * Tails one explicitly selected local transcript. Local path/session identity
 * stay in the local outbox; only normalized content and a pseudonymous key
 * cross the connector boundary.
 */
export async function runTranscriptCompanion(
  options: CompanionOptions,
): Promise<CompanionProgress> {
  const signal = options.signal ?? new AbortController().signal
  const fetch_ = options.fetch ?? globalThis.fetch
  const wait = options.wait ?? abortableDelay
  const path = resolve(options.transcriptPath)
  const sourceConversationId = options.sourceConversationId
  const conversation = await inspectLocalConversation(options.source, path)
  if (conversation.sourceConversationId !== sourceConversationId) {
    throw new Error("Selected transcript no longer matches its frozen conversation identity")
  }
  const setup = ConnectorSetupResponseSchema.parse(
    await connectorJson<unknown>(
      fetch_,
      options.baseUrl,
      options.connectorSecret,
      "connector/v1/setup",
      { signal },
    ),
  )
  const repositories = setup.repositories.filter(
    (candidate) => candidate.projectId === options.projectId,
  )
  if (repositories.length !== 1) {
    throw new Error("Connector Project approval has no unique GitHub repository")
  }
  const repository = repositories[0] as (typeof repositories)[number]
  await requireConversationRepository(
    conversation,
    repository.repositoryFullName,
    options.repositoryCommand,
  )
  const sourceConversationKey = pseudonymousConversationKey(options.source, sourceConversationId)
  const identity = {
    source: options.source,
    projectId: options.projectId,
    transcriptPath: path,
    sourceConversationId,
    sourceConversationKey,
  }
  const outbox = await CompanionOutbox.open(options.statePath)
  try {
    const prior = outbox.state()
    if (prior !== null) outbox.assertIdentity(identity)
    const sourceNormalizer =
      options.source === "codex" ? codexTranscriptNormalizer : claudeCodeTranscriptNormalizer
    const redactionOptions: TranscriptRedactionOptions = {
      knownSecrets: [options.connectorSecret],
      homePaths: [conversation.workspacePath],
    }
    const normalizer = redactingNormalizer(sourceNormalizer, redactionOptions)
    const initialRead =
      prior === null
        ? await readTranscriptIncrement({ path, sourceConversationId, normalizer })
        : null
    const explicitTitle = options.title?.trim()
    const title =
      (explicitTitle === undefined
        ? undefined
        : redactTranscriptText(explicitTitle, redactionOptions).text) ||
      prior?.title ||
      initialRead?.events
        .find(
          (event): event is Extract<NormalizedMirrorEvent, { readonly type: "message" }> =>
            event.type === "message" && event.payload.role === "user",
        )
        ?.payload.markdown.split("\n")
        .find((line) => line.trim())
        ?.trim()
        .slice(0, 500) ||
      `${options.source === "codex" ? "Codex" : "Claude Code"} conversation`

    const mirror = ConversationMirrorResponseSchema.parse(
      await connectorJson<unknown>(
        fetch_,
        options.baseUrl,
        options.connectorSecret,
        "connector/v1/mirrors",
        {
          method: "POST",
          body: {
            projectId: options.projectId,
            repositoryId: repository.repositoryId,
            sourceConversationKey,
            title,
            status: "active",
          },
          signal,
        },
      ),
    ).mirror as ConversationMirror
    const checkpoint = MirrorCheckpointSchema.parse(
      await connectorJson<unknown>(
        fetch_,
        options.baseUrl,
        options.connectorSecret,
        `connector/v1/mirrors/${encodeURIComponent(mirror.id)}/checkpoint`,
        { signal },
      ),
    )
    if (prior === null && checkpoint.sequence > 0) {
      throw new Error(
        "Remote mirror exists but its local outbox is missing; refusing ambiguous replay",
      )
    }
    let state =
      prior ??
      outbox.initialize({
        ...identity,
        mirrorId: mirror.id,
        title,
      })
    if (state.mirrorId !== mirror.id) {
      throw new Error("Companion outbox resolves to a different remote mirror")
    }
    state = outbox.reconcileRemote(checkpoint.sequence, checkpoint.sourceCursor)
    state = await flushOutbox({
      outbox,
      fetch: fetch_,
      baseUrl: options.baseUrl,
      connectorSecret: options.connectorSecret,
      mirrorId: mirror.id,
      signal,
    })
    let pendingRead =
      initialRead ??
      (await readTranscriptIncrement({
        path,
        sourceConversationId,
        normalizer,
        ...(state.cursor === null ? {} : { cursor: state.cursor }),
      }))
    if (pendingRead.reset !== null && state.cursor !== null) {
      throw new Error(
        `Transcript ${pendingRead.reset}; explicit reattachment is required to avoid duplicate broadcast`,
      )
    }

    const pollIntervalMs = boundedInterval(options.pollIntervalMs ?? 500, "pollIntervalMs")
    const heartbeatIntervalMs = boundedInterval(
      options.heartbeatIntervalMs ?? 15_000,
      "heartbeatIntervalMs",
    )
    let lastHeartbeat = 0
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError")
      if (pendingRead.reset !== null && state.cursor !== null) {
        throw new Error(
          `Transcript ${pendingRead.reset}; explicit reattachment is required to avoid duplicate broadcast`,
        )
      }
      state = outbox.stage(pendingRead.events, pendingRead.cursor)
      state = await flushOutbox({
        outbox,
        fetch: fetch_,
        baseUrl: options.baseUrl,
        connectorSecret: options.connectorSecret,
        mirrorId: mirror.id,
        signal,
      })
      const progress: CompanionProgress = {
        mirrorId: mirror.id,
        acceptedSequence: state.acknowledgedSequence,
        caughtUp: pendingRead.caughtUp,
        issues: pendingRead.issues,
      }
      await options.onProgress?.(progress)
      if (pendingRead.issues.length > 0) return progress
      if (options.once === true && pendingRead.caughtUp) return progress
      if (performance.now() - lastHeartbeat >= heartbeatIntervalMs) {
        await connectorJson(
          fetch_,
          options.baseUrl,
          options.connectorSecret,
          "connector/v1/heartbeat",
          { method: "POST", signal },
        )
        lastHeartbeat = performance.now()
      }
      if (pendingRead.caughtUp) await wait(pollIntervalMs, signal)
      pendingRead = await readTranscriptIncrement({
        path,
        sourceConversationId,
        normalizer,
        cursor: state.cursor as JsonlTranscriptCursor,
      })
    }
  } finally {
    outbox.close()
  }
}

function redactingNormalizer(
  normalizer: TranscriptNormalizer,
  options: TranscriptRedactionOptions,
): TranscriptNormalizer {
  return {
    source: normalizer.source,
    normalize(record, context) {
      return normalizer
        .normalize(record, context)
        .map((event) => redactNormalizedMirrorEvent(event, options).event)
    },
  }
}

async function flushOutbox(input: {
  readonly outbox: CompanionOutbox
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  readonly baseUrl: string | URL
  readonly connectorSecret: string
  readonly mirrorId: string
  readonly signal: AbortSignal
}): Promise<CompanionOutboxState> {
  let state = input.outbox.state()
  if (state === null) throw new Error("Companion outbox is not initialized")
  for (;;) {
    const batch = input.outbox.pending(100)
    if (batch.length === 0) return state
    const response = AppendedMirrorEventsResponseSchema.parse(
      await connectorJson<unknown>(
        input.fetch,
        input.baseUrl,
        input.connectorSecret,
        `connector/v1/mirrors/${encodeURIComponent(input.mirrorId)}/events`,
        { method: "POST", body: { events: batch }, signal: input.signal },
      ),
    )
    const acknowledged = response.items.at(-1)
    if (
      response.items.length !== batch.length ||
      acknowledged === undefined ||
      response.items.some(
        (item: MirrorEvent, index: number) =>
          item.sequence !== batch[index]?.sequence ||
          item.sourceCursor !== batch[index]?.sourceCursor ||
          item.digest !== batch[index]?.digest,
      )
    ) {
      throw new Error("Connector returned an invalid outbox acknowledgement")
    }
    state = input.outbox.acknowledge(acknowledged.sequence, acknowledged.sourceCursor)
  }
}

export async function detectSourceConversationId(
  path: string,
  source: ConnectorSource,
): Promise<string> {
  return (await inspectLocalConversation(source, path)).sourceConversationId
}

export function pseudonymousConversationKey(
  source: ConnectorSource,
  sourceConversationId: string,
): string {
  return new Bun.CryptoHasher("sha256").update(`${source}\0${sourceConversationId}`).digest("hex")
}

async function connectorJson<Value>(
  fetch_: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  baseUrl: string | URL,
  secret: string,
  path: string,
  input: {
    readonly method?: "GET" | "POST"
    readonly body?: unknown
    readonly signal?: AbortSignal
  },
): Promise<Value> {
  const base = new URL(baseUrl)
  if (!base.pathname.endsWith("/")) base.pathname += "/"
  const response = await fetch_(new URL(path, base), {
    method: input.method ?? "GET",
    headers: {
      Authorization: `Connector ${secret}`,
      Accept: "application/json",
      ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  const text = await response.text()
  if (!response.ok) {
    let code = `HTTP_${response.status}`
    try {
      const envelope = JSON.parse(text) as { error?: { code?: unknown } }
      if (typeof envelope.error?.code === "string") code = envelope.error.code
    } catch {}
    throw new Error(`Connector request failed: ${code}`)
  }
  return JSON.parse(text) as Value
}

function boundedInterval(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 60_000) {
    throw new TypeError(`${name} must be between 100 and 60000 milliseconds`)
  }
  return value
}

const abortableDelay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
    const timer = setTimeout(finish, milliseconds)
    function finish() {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      resolve()
    }
    function abort() {
      clearTimeout(timer)
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
    }
    signal.addEventListener("abort", abort, { once: true })
  })
