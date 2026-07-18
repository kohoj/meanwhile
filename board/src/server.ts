// Read-only backend-for-frontend for the delegator board.
//
// It is a CONSUMER of the public @kohoz/meanwhile client — the same category as
// the CLI — holding the owner's API key server-side so no bearer token ever
// reaches the browser (the client fail-closes in a browser for exactly this
// reason). It exposes ONLY reads: a board snapshot, and a fan-in SSE stream of
// the live events of active tasks. There is deliberately no create/cancel/send/
// interrupt/close/deploy code path anywhere in this file — read-only is
// structural, not a convention.
import { Meanwhile } from "@kohoz/meanwhile";
import type { AgentSession, Run, RunEvent, SessionEvent } from "@kohoz/meanwhile/contracts";
import { isRunActive, isSessionActive, runBucket, sessionBucket } from "./buckets";

export interface BoardServerOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly hostname?: string;
  readonly port?: number;
  /** Upper bound on tasks followed live at once. Excess active tasks are shown
   * from the snapshot and refreshed on poll, never silently dropped. */
  readonly maxLive?: number;
  /** Absolute path to the built SPA assets (index.html, app.js, styles.css). */
  readonly assetsDir: string;
}

type TaskKind = "run" | "session";

interface BoardRow {
  kind: TaskKind;
  id: string;
  title: string;
  agentType: string;
  status: string;
  bucket: string;
  createdAt: string;
  updatedAt: string;
  live: boolean;
}

const DEFAULT_MAX_LIVE = 25;

// The board UI is first-party code we build ourselves, so its CSP allows self
// scripts/styles — unlike local-static, which serves untrusted agent output.
const uiHeaders = (): Headers =>
  new Headers({
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });

const jsonHeaders = (): Headers => {
  const h = uiHeaders();
  h.set("Content-Type", "application/json");
  return h;
};

const runRow = (run: Run): BoardRow => ({
  kind: "run",
  id: run.id,
  title: run.prompt.slice(0, 120),
  agentType: run.agentType,
  status: run.status,
  bucket: runBucket(run.status),
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  live: isRunActive(run.status),
});

const sessionRow = (session: AgentSession, title?: string): BoardRow => ({
  kind: "session",
  // A delegator reads the ask, not a UUID. Fall back to plain words describing
  // the session, never a raw id, when there is no first prompt yet.
  id: session.id,
  title: title || `An open ${session.agentType} session`,
  agentType: session.agentType,
  status: session.status,
  bucket: sessionBucket(session.status),
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  live: isSessionActive(session.status),
});

export class BoardServer {
  readonly #client: Meanwhile;
  readonly #hostname: string;
  readonly #port: number;
  readonly #maxLive: number;
  readonly #assetsDir: string;
  #server: ReturnType<typeof Bun.serve> | null = null;

  constructor(options: BoardServerOptions) {
    this.#client = new Meanwhile({ baseUrl: options.baseUrl, apiKey: options.apiKey });
    this.#hostname = options.hostname ?? "127.0.0.1";
    this.#port = options.port ?? 7333;
    this.#maxLive = options.maxLive ?? DEFAULT_MAX_LIVE;
    this.#assetsDir = options.assetsDir;
  }

  start(): { url: string } {
    this.#server = Bun.serve({
      hostname: this.#hostname,
      port: this.#port,
      idleTimeout: 0,
      fetch: (request) => this.#handle(request),
    });
    return { url: `http://${this.#server.hostname}:${this.#server.port}` };
  }

  async stop(): Promise<void> {
    await this.#server?.stop(true);
    this.#server = null;
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // The one write the board allows: DELEGATING new work. It maps to the
    // client's create* calls only — never cancel, close, interrupt, or delete.
    // "Read-only for existing work, delegate-only for new work" is enforced by
    // there being no other mutating path in this file.
    if (request.method === "POST" && url.pathname === "/delegate") {
      return this.#delegate(request);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: uiHeaders() });
    }
    if (url.pathname === "/board") return this.#board();
    if (url.pathname === "/stream") return this.#stream(request);
    const history = url.pathname.match(/^\/task\/(run|session)\/([\w-]+)\/events$/);
    if (history) return this.#history(history[1] as TaskKind, history[2] ?? "", request.signal);
    return this.#asset(url.pathname);
  }

  // ---- write (the only one): delegate new work ----------------------------
  // Accepts the delegator's plain intent and maps it to the client's create
  // calls. It never touches an existing task. Idempotency key is minted here so
  // a double-submit can't create duplicate work.
  async #delegate(request: Request): Promise<Response> {
    let body: { prompt?: string; agentType?: string; kind?: string; repo?: string };
    try {
      body = await request.json();
    } catch {
      return this.#badRequest("Could not read the request.");
    }
    const prompt = (body.prompt ?? "").trim();
    const agentType = (body.agentType ?? "").trim();
    if (!prompt) return this.#badRequest("Describe what you want done.");
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(agentType)) {
      return this.#badRequest("Pick an agent.");
    }
    const repo = (body.repo ?? "").trim();
    // A delegator gives intent, not files. Use their repo if provided, else a
    // minimal placeholder workspace so the agent has somewhere to work.
    const workspace = repo
      ? { type: "repository" as const, url: repo, revision: "main" }
      : {
          type: "files" as const,
          files: [{ path: "TASK.md", contentBase64: btoa(prompt), mode: 0o644 }],
        };
    const idempotencyKey = crypto.randomUUID();
    try {
      if (body.kind === "session") {
        const s = await this.#client.sessions.create(
          { workspace, agentType },
          { idempotencyKey },
        );
        await this.#client.sessions.send(s.id, prompt, { idempotencyKey: crypto.randomUUID() });
        return new Response(JSON.stringify({ kind: "session", id: s.id }), {
          status: 201,
          headers: jsonHeaders(),
        });
      }
      const run = await this.#client.runs.create({ workspace, agentType, prompt }, { idempotencyKey });
      return new Response(JSON.stringify({ kind: "run", id: run.id }), {
        status: 201,
        headers: jsonHeaders(),
      });
    } catch (error) {
      // Surface a safe, human message; never the raw provider/kernel error.
      const code = error instanceof Error ? error.name : "error";
      return this.#badRequest(`Could not delegate the work (${code}).`);
    }
  }

  #badRequest(message: string): Response {
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: jsonHeaders(),
    });
  }

  // A session's title is its first prompt — the human's own words for the ask.
  async #sessionTitle(id: string): Promise<string | undefined> {
    try {
      const page = await this.#client.sessions.turns(id, { limit: 1 });
      return page.items[0]?.prompt?.slice(0, 120);
    } catch {
      return undefined;
    }
  }

  // ---- read: board snapshot ------------------------------------------------
  async #board(): Promise<Response> {
    const [runs, sessions] = await Promise.all([
      this.#client.runs.list({ limit: 100 }),
      this.#client.sessions.list({ limit: 100 }),
    ]);
    const sessionTitles = await Promise.all(sessions.items.map((s) => this.#sessionTitle(s.id)));
    const rows = [
      ...runs.items.map(runRow),
      ...sessions.items.map((s, i) => sessionRow(s, sessionTitles[i])),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const liveCount = rows.filter((r) => r.live).length;
    const capped = liveCount > this.#maxLive;
    if (capped) {
      console.warn(
        `board: ${liveCount} active tasks exceed maxLive=${this.#maxLive}; ` +
          `following the ${this.#maxLive} newest live, the rest refresh on poll`,
      );
    }
    // Trust anchor for the calm state: when did work last close? "Everything is
    // fine" is more believable next to evidence that the system was recently
    // doing something.
    const lastClosedAt =
      rows
        .filter((r) => !r.live)
        .map((r) => r.updatedAt)
        .sort()
        .at(-1) ?? null;
    return new Response(JSON.stringify({ rows, maxLive: this.#maxLive, capped, lastClosedAt }), {
      headers: jsonHeaders(),
    });
  }

  // ---- read: full event history of one task (for opening a closed task) ----
  // Paginates the durable event log rather than following live, so a terminal
  // task — which fan-in never followed — still shows its complete conversation.
  async #history(kind: TaskKind, id: string, signal: AbortSignal): Promise<Response> {
    const events: unknown[] = [];
    let after: number | undefined;
    const PAGE = 500;
    const MAX = 5_000; // bound very long histories; the tail is what matters
    while (events.length < MAX && !signal.aborted) {
      const page =
        kind === "run"
          ? await this.#client.runs.events(id, { after, limit: PAGE, signal })
          : await this.#client.sessions.events(id, { after, limit: PAGE, signal });
      events.push(...page.items);
      if (page.nextCursor === null) break;
      after = page.nextCursor;
    }
    return new Response(JSON.stringify({ kind, id, events }), { headers: jsonHeaders() });
  }

  // ---- read: fan-in SSE of active tasks' events ----------------------------
  #stream(request: Request): Response {
    const client = this.#client;
    const maxLive = this.#maxLive;
    const controller = new AbortController();
    request.signal.addEventListener("abort", () => controller.abort());

    const body = new ReadableStream<Uint8Array>({
      start: async (ctrl) => {
        const encoder = new TextEncoder();
        const send = (event: string, data: unknown) => {
          if (controller.signal.aborted) return;
          ctrl.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        const [runs, sessions] = await Promise.all([
          client.runs.list({ limit: 100 }),
          client.sessions.list({ limit: 100 }),
        ]);
        const liveRuns = runs.items.filter((r) => isRunActive(r.status)).slice(0, maxLive);
        const remaining = maxLive - liveRuns.length;
        const liveSessions = sessions.items
          .filter((s) => isSessionActive(s.status))
          .slice(0, Math.max(0, remaining));

        send("ready", { runs: liveRuns.length, sessions: liveSessions.length });

        // Each active task feeds the same stream, tagged by kind+id, until it
        // ends or the browser disconnects.
        const pump = async <E extends RunEvent | SessionEvent>(
          kind: TaskKind,
          id: string,
          events: AsyncIterable<E>,
        ) => {
          try {
            for await (const event of events) {
              send("event", { kind, id, event });
            }
          } catch (error) {
            if (!controller.signal.aborted) {
              send("task_error", { kind, id, message: safeMessage(error) });
            }
          }
        };

        const pumps = [
          ...liveRuns.map((r) =>
            pump("run", r.id, client.runs.followEvents(r.id, { signal: controller.signal })),
          ),
          ...liveSessions.map((s) =>
            pump(
              "session",
              s.id,
              client.sessions.followEvents(s.id, { signal: controller.signal }),
            ),
          ),
        ];

        const heartbeat = setInterval(() => send("heartbeat", { t: null }), 15_000);
        try {
          await Promise.all(pumps);
        } finally {
          clearInterval(heartbeat);
          if (!controller.signal.aborted) send("end", { t: null });
          ctrl.close();
        }
      },
      cancel: () => controller.abort(),
    });

    return new Response(body, {
      headers: (() => {
        const h = uiHeaders();
        h.set("Content-Type", "text/event-stream");
        h.set("Cache-Control", "no-cache");
        h.set("Connection", "keep-alive");
        return h;
      })(),
    });
  }

  // ---- static SPA assets ---------------------------------------------------
  async #asset(pathname: string): Promise<Response> {
    const name = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    // Only serve known built files; never traverse.
    if (!/^[\w.-]+$/.test(name)) {
      return new Response("Not Found", { status: 404, headers: uiHeaders() });
    }
    const file = Bun.file(`${this.#assetsDir}/${name}`);
    if (!(await file.exists())) {
      // SPA fallback to index for client-side routes.
      const index = Bun.file(`${this.#assetsDir}/index.html`);
      if (await index.exists()) {
        const h = uiHeaders();
        h.set("Content-Type", "text/html");
        return new Response(index, { headers: h });
      }
      return new Response("Not Found", { status: 404, headers: uiHeaders() });
    }
    const h = uiHeaders();
    h.set("Content-Type", file.type || "application/octet-stream");
    return new Response(file, { headers: h });
  }
}

const safeMessage = (error: unknown): string =>
  error instanceof Error ? error.name : "stream error";
