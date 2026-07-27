import { Database } from "bun:sqlite"
import { chmod, mkdir, stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { MirrorEventInputSchema } from "../api/contracts"
import type { ConnectorSource, MirrorEventInput } from "../domain"
import type { NormalizedMirrorEvent } from "./external-transcript"
import type { JsonlTranscriptCursor } from "./jsonl-transcript"

const OUTBOX_SCHEMA_VERSION = 1
const DEFAULT_MAX_EVENTS = 10_000
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

const OUTBOX_SCHEMA_SQL = `
  CREATE TABLE companion_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    source TEXT NOT NULL CHECK(source IN ('codex', 'claude-code')),
    project_id TEXT NOT NULL,
    transcript_path TEXT NOT NULL,
    source_conversation_id TEXT NOT NULL,
    source_conversation_key TEXT NOT NULL,
    mirror_id TEXT NOT NULL,
    title TEXT NOT NULL,
    next_sequence INTEGER NOT NULL CHECK(next_sequence >= 1),
    acknowledged_sequence INTEGER NOT NULL CHECK(acknowledged_sequence >= 0),
    acknowledged_source_cursor TEXT,
    cursor_json TEXT CHECK(cursor_json IS NULL OR json_valid(cursor_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(acknowledged_sequence < next_sequence),
    CHECK(
      (acknowledged_sequence = 0 AND acknowledged_source_cursor IS NULL) OR
      (acknowledged_sequence > 0 AND acknowledged_source_cursor IS NOT NULL)
    )
  ) STRICT;

  CREATE TABLE companion_outbox (
    sequence INTEGER PRIMARY KEY CHECK(sequence >= 1),
    event_json TEXT NOT NULL CHECK(json_valid(event_json)),
    source_cursor TEXT NOT NULL UNIQUE,
    byte_size INTEGER NOT NULL CHECK(byte_size > 0),
    created_at TEXT NOT NULL
  ) STRICT;
`

export interface CompanionOutboxIdentity {
  readonly source: ConnectorSource
  readonly projectId: string
  readonly transcriptPath: string
  readonly sourceConversationId: string
  readonly sourceConversationKey: string
}

export interface CompanionOutboxState extends CompanionOutboxIdentity {
  readonly mirrorId: string
  readonly title: string
  readonly nextSequence: number
  readonly acknowledgedSequence: number
  readonly acknowledgedSourceCursor: string | null
  readonly cursor: JsonlTranscriptCursor | null
}

interface CompanionStateRow {
  readonly source: ConnectorSource
  readonly project_id: string
  readonly transcript_path: string
  readonly source_conversation_id: string
  readonly source_conversation_key: string
  readonly mirror_id: string
  readonly title: string
  readonly next_sequence: number
  readonly acknowledged_sequence: number
  readonly acknowledged_source_cursor: string | null
  readonly cursor_json: string | null
}

interface OutboxRow {
  readonly sequence: number
  readonly event_json: string
  readonly source_cursor: string
}

/**
 * Owns the Companion's crash boundary. A transcript cursor may advance only in
 * the same SQLite transaction that durably stages every normalized event it
 * produced. A staged prefix is removed only after an exact server checkpoint.
 */
export class CompanionOutbox {
  readonly path: string
  private constructor(
    path: string,
    private readonly database: Database,
    private readonly maxEvents: number,
    private readonly maxBytes: number,
  ) {
    this.path = path
    this.database = database
  }

  static async open(
    path: string,
    options: { readonly maxEvents?: number; readonly maxBytes?: number } = {},
  ): Promise<CompanionOutbox> {
    const resolved = resolve(path)
    await mkdir(dirname(resolved), { recursive: true, mode: 0o700 })
    let initialize = false
    try {
      initialize = (await stat(resolved)).size === 0
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      initialize = true
    }
    const maxEvents = boundedLimit(options.maxEvents ?? DEFAULT_MAX_EVENTS, "maxEvents")
    const maxBytes = boundedLimit(options.maxBytes ?? DEFAULT_MAX_BYTES, "maxBytes")
    const database = new Database(resolved, { create: true, strict: true })
    try {
      database.exec("PRAGMA foreign_keys = ON")
      database.exec("PRAGMA busy_timeout = 5000")
      database.exec("PRAGMA journal_mode = DELETE")
      database.exec("PRAGMA synchronous = FULL")
      if (initialize) {
        database.exec(OUTBOX_SCHEMA_SQL)
        database.exec(`PRAGMA user_version = ${OUTBOX_SCHEMA_VERSION}`)
      } else {
        const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get()
        if (version?.user_version !== OUTBOX_SCHEMA_VERSION) {
          throw new Error(
            "Companion state is not a supported SQLite outbox; choose a new --state path",
          )
        }
        const integrity = database.query<{ quick_check: string }, []>("PRAGMA quick_check").get()
        if (integrity?.quick_check !== "ok")
          throw new Error("Companion outbox integrity check failed")
        database.query("SELECT singleton FROM companion_state LIMIT 1").get()
        database.query("SELECT sequence FROM companion_outbox LIMIT 1").get()
      }
      await chmod(resolved, 0o600)
      return new CompanionOutbox(resolved, database, maxEvents, maxBytes)
    } catch (error) {
      database.close()
      throw error
    }
  }

  close(): void {
    this.database.close()
  }

  state(): CompanionOutboxState | null {
    const row = this.database
      .query<CompanionStateRow, []>("SELECT * FROM companion_state WHERE singleton=1")
      .get()
    return row === null ? null : stateFromRow(row)
  }

  initialize(
    input: CompanionOutboxIdentity & { readonly mirrorId: string; readonly title: string },
    at = new Date().toISOString(),
  ): CompanionOutboxState {
    this.database
      .query(`
        INSERT INTO companion_state(
          singleton,source,project_id,transcript_path,source_conversation_id,
          source_conversation_key,mirror_id,title,next_sequence,
          acknowledged_sequence,acknowledged_source_cursor,cursor_json,created_at,updated_at
        ) VALUES (1,?,?,?,?,?,?,?,1,0,NULL,NULL,?,?)
      `)
      .run(
        input.source,
        input.projectId,
        input.transcriptPath,
        input.sourceConversationId,
        input.sourceConversationKey,
        input.mirrorId,
        input.title,
        at,
        at,
      )
    return requiredState(this.state())
  }

  assertIdentity(identity: CompanionOutboxIdentity): CompanionOutboxState {
    const state = requiredState(this.state())
    if (
      state.source !== identity.source ||
      state.projectId !== identity.projectId ||
      state.transcriptPath !== identity.transcriptPath ||
      state.sourceConversationId !== identity.sourceConversationId ||
      state.sourceConversationKey !== identity.sourceConversationKey
    ) {
      throw new Error("Companion state belongs to a different transcript or Project")
    }
    return state
  }

  stage(
    events: readonly NormalizedMirrorEvent[],
    cursor: JsonlTranscriptCursor,
    at = new Date().toISOString(),
  ): CompanionOutboxState {
    return this.database
      .transaction(() => {
        const state = requiredState(this.state())
        if (
          cursor.source !== state.source ||
          cursor.sourceConversationId !== state.sourceConversationId
        ) {
          throw new Error("Transcript cursor belongs to a different Companion source")
        }
        if (events.some((event) => event.source !== state.source)) {
          throw new Error("Normalized event belongs to a different Companion source")
        }
        const current = this.database
          .query<{ count: number; bytes: number }, []>(`
            SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes FROM companion_outbox
          `)
          .get()
        const encoded = events.map((event, index) => {
          const sequenced = sequenceEvent(event, state.nextSequence + index)
          const json = JSON.stringify(sequenced)
          return {
            event: sequenced,
            json,
            bytes: new TextEncoder().encode(json).byteLength,
          }
        })
        const addedBytes = encoded.reduce((total, item) => total + item.bytes, 0)
        if (
          (current?.count ?? 0) + encoded.length > this.maxEvents ||
          (current?.bytes ?? 0) + addedBytes > this.maxBytes
        ) {
          throw new Error(
            "Companion outbox capacity reached; sharing is paused until pending events are accepted",
          )
        }
        const insert = this.database.query(`
          INSERT INTO companion_outbox(sequence,event_json,source_cursor,byte_size,created_at)
          VALUES (?,?,?,?,?)
        `)
        for (const item of encoded) {
          insert.run(item.event.sequence, item.json, item.event.sourceCursor, item.bytes, at)
        }
        this.database
          .query(`
            UPDATE companion_state SET next_sequence=?,cursor_json=?,updated_at=? WHERE singleton=1
          `)
          .run(state.nextSequence + encoded.length, JSON.stringify(cursor), at)
        return requiredState(this.state())
      })
      .immediate()
  }

  pending(limit = 100): readonly MirrorEventInput[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Outbox batch limit must be between 1 and 100")
    }
    return this.database
      .query<OutboxRow, [number]>(`
        SELECT sequence,event_json,source_cursor
        FROM companion_outbox ORDER BY sequence LIMIT ?
      `)
      .all(limit)
      .map((row) => parseEvent(row.event_json, row.sequence, row.source_cursor))
  }

  acknowledge(
    sequence: number,
    sourceCursor: string | null,
    at = new Date().toISOString(),
  ): CompanionOutboxState {
    return this.#acceptCheckpoint(sequence, sourceCursor, at)
  }

  reconcileRemote(
    sequence: number,
    sourceCursor: string | null,
    at = new Date().toISOString(),
  ): CompanionOutboxState {
    return this.#acceptCheckpoint(sequence, sourceCursor, at)
  }

  #acceptCheckpoint(
    sequence: number,
    sourceCursor: string | null,
    at: string,
  ): CompanionOutboxState {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error("Remote mirror checkpoint is invalid")
    }
    return this.database
      .transaction(() => {
        const state = requiredState(this.state())
        if (sequence < state.acknowledgedSequence) {
          throw new Error("Remote mirror checkpoint is behind local durable state")
        }
        if (sequence >= state.nextSequence) {
          throw new Error("Remote mirror checkpoint is ahead of the local durable outbox")
        }
        if (sequence === state.acknowledgedSequence) {
          if (sourceCursor !== state.acknowledgedSourceCursor) {
            throw new Error("Remote mirror checkpoint conflicts with local durable state")
          }
          return state
        }
        const row = this.database
          .query<{ source_cursor: string }, [number]>(
            "SELECT source_cursor FROM companion_outbox WHERE sequence=?",
          )
          .get(sequence)
        if (row === null || sourceCursor === null || row.source_cursor !== sourceCursor) {
          throw new Error("Remote mirror checkpoint does not identify a local staged event")
        }
        this.database.query("DELETE FROM companion_outbox WHERE sequence<=?").run(sequence)
        this.database
          .query(`
            UPDATE companion_state
            SET acknowledged_sequence=?,acknowledged_source_cursor=?,updated_at=?
            WHERE singleton=1
          `)
          .run(sequence, sourceCursor, at)
        return requiredState(this.state())
      })
      .immediate()
  }
}

function stateFromRow(row: CompanionStateRow): CompanionOutboxState {
  return {
    source: row.source,
    projectId: row.project_id,
    transcriptPath: row.transcript_path,
    sourceConversationId: row.source_conversation_id,
    sourceConversationKey: row.source_conversation_key,
    mirrorId: row.mirror_id,
    title: row.title,
    nextSequence: row.next_sequence,
    acknowledgedSequence: row.acknowledged_sequence,
    acknowledgedSourceCursor: row.acknowledged_source_cursor,
    cursor:
      row.cursor_json === null ? null : (JSON.parse(row.cursor_json) as JsonlTranscriptCursor),
  }
}

function parseEvent(json: string, sequence: number, sourceCursor: string): MirrorEventInput {
  const event = MirrorEventInputSchema.parse(JSON.parse(json)) as MirrorEventInput
  if (event.sequence !== sequence || event.sourceCursor !== sourceCursor) {
    throw new Error("Companion outbox event identity is corrupt")
  }
  return event
}

function sequenceEvent(event: NormalizedMirrorEvent, sequence: number): MirrorEventInput {
  switch (event.type) {
    case "message":
      return { ...event, sequence }
    case "work":
      return { ...event, sequence }
    case "source_status":
      return { ...event, sequence }
  }
}

function requiredState(state: CompanionOutboxState | null): CompanionOutboxState {
  if (state === null) throw new Error("Companion outbox is not initialized")
  return state
}

function boundedLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be positive`)
  return value
}
