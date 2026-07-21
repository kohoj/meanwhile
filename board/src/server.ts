import { Meanwhile, MeanwhileError } from "@kohoz/meanwhile";
import type {
  Principal,
  Project,
  ProjectMember,
  ProjectWorkItem,
  RunEvent,
  SessionEvent,
} from "@kohoz/meanwhile/contracts";

export interface BoardServerOptions {
  readonly baseUrl: string;
  /** Optional single-user credential for a local private board. Omit it for team login. */
  readonly apiKey?: string;
  readonly hostname?: string;
  readonly port?: number;
  readonly assetsDir: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface BoardRow extends ProjectWorkItem {
  readonly section: "attention" | "active" | "ready" | "completed";
}

interface BoardSnapshot {
  readonly principal: Principal;
  readonly project: Project;
  readonly projects: readonly Project[];
  readonly members: readonly ProjectMember[];
  readonly rows: readonly BoardRow[];
  readonly updatedAt: string;
}

type TaskKind = "run" | "session";

const SESSION_COOKIE = "mw_board_session";
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

const uiHeaders = (): Headers =>
  new Headers({
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });

const jsonHeaders = (): Headers => {
  const headers = uiHeaders();
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "private, no-store");
  return headers;
};

export class BoardServer {
  readonly #baseUrl: URL;
  readonly #staticClient: Meanwhile | null;
  readonly #hostname: string;
  readonly #port: number;
  readonly #assetsDir: string;
  readonly #fetch: typeof globalThis.fetch;
  #server: ReturnType<typeof Bun.serve> | null = null;

  constructor(options: BoardServerOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    this.#staticClient =
      options.apiKey === undefined
        ? null
        : new Meanwhile({ baseUrl: this.#baseUrl, apiKey: options.apiKey });
    this.#hostname = options.hostname ?? "127.0.0.1";
    this.#port = options.port ?? 7333;
    this.#assetsDir = options.assetsDir;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  start(): { readonly url: string } {
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
    if (request.method === "POST" && url.pathname === "/login") return this.#login(request);
    if (request.method === "POST" && url.pathname === "/logout") return this.#logout(request);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: uiHeaders() });
    }

    if (url.pathname === "/session") return this.#session(request);
    if (url.pathname === "/board") return this.#board(request, url.searchParams.get("projectId"));
    const history = url.pathname.match(/^\/task\/(run|session)\/([\w-]+)\/events$/);
    if (history !== null) {
      return this.#history(
        request,
        history[1] as TaskKind,
        history[2] ?? "",
        request.signal,
      );
    }
    return this.#asset(url.pathname);
  }

  async #login(request: Request): Promise<Response> {
    if (this.#staticClient !== null) {
      return new Response(JSON.stringify({ authenticated: true }), { headers: jsonHeaders() });
    }
    let apiKey = "";
    try {
      const body = (await request.json()) as { apiKey?: unknown };
      apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    } catch {
      return this.#badRequest("Could not read the API key.");
    }
    if (!/^mwk_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/.test(apiKey)) {
      return this.#badRequest("The API key is invalid.");
    }
    const upstream = await this.#fetch(new URL("browser-sessions", this.#baseUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    }).catch(() => null);
    if (upstream === null) {
      return new Response(JSON.stringify({ error: "The control plane is unavailable." }), {
        status: 502,
        headers: jsonHeaders(),
      });
    }
    if (!upstream.ok) {
      const status = upstream.status === 401 || upstream.status === 403 ? 401 : 502;
      await upstream.body?.cancel().catch(() => undefined);
      return new Response(JSON.stringify({ error: "Could not sign in." }), {
        status,
        headers: jsonHeaders(),
      });
    }
    const body = (await upstream.json().catch(() => null)) as { secret?: unknown } | null;
    const secret = typeof body?.secret === "string" ? body.secret : "";
    if (!/^mws_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/.test(secret)) {
      return new Response(JSON.stringify({ error: "The control plane returned an invalid session." }), {
        status: 502,
        headers: jsonHeaders(),
      });
    }
    const headers = jsonHeaders();
    headers.append("Set-Cookie", sessionCookie(secret, request, SESSION_MAX_AGE_SECONDS));
    return new Response(JSON.stringify({ authenticated: true }), { status: 201, headers });
  }

  async #logout(request: Request): Promise<Response> {
    const secret = sessionSecret(request);
    if (secret !== null) {
      await this.#fetch(new URL("browser-sessions/current", this.#baseUrl), {
        method: "DELETE",
        headers: { Authorization: `Session ${secret}`, Accept: "application/json" },
      }).catch(() => null);
    }
    const headers = jsonHeaders();
    headers.append("Set-Cookie", sessionCookie("", request, 0));
    return new Response(JSON.stringify({ authenticated: false }), { headers });
  }

  async #session(request: Request): Promise<Response> {
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    try {
      return new Response(JSON.stringify({ authenticated: true, ...(await client.projects.me()) }), {
        headers: jsonHeaders(),
      });
    } catch (error) {
      return this.#upstreamFailure(error);
    }
  }

  async #board(request: Request, requestedProjectId: string | null): Promise<Response> {
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    try {
      const me = await client.projects.me();
      const project =
        requestedProjectId === null
          ? me.projects[0]
          : me.projects.find((candidate) => candidate.id === requestedProjectId);
      if (project === undefined) {
        return new Response(JSON.stringify({ error: "Project not found." }), {
          status: 404,
          headers: jsonHeaders(),
        });
      }
      const [members, work] = await Promise.all([
        client.projects.members(project.id),
        client.projects.work(project.id),
      ]);
      const snapshot: BoardSnapshot = {
        principal: me.principal,
        project,
        projects: me.projects,
        members,
        rows: work.map((item) => ({ ...item, section: sectionFor(item) })),
        updatedAt: new Date().toISOString(),
      };
      return new Response(JSON.stringify(snapshot), { headers: jsonHeaders() });
    } catch (error) {
      return this.#upstreamFailure(error);
    }
  }

  async #history(
    request: Request,
    kind: TaskKind,
    id: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    const events: Array<RunEvent | SessionEvent> = [];
    let after: number | undefined;
    try {
      while (events.length < 5_000 && !signal.aborted) {
        const page =
          kind === "run"
            ? await client.runs.events(id, { after, limit: 500, signal })
            : await client.sessions.events(id, { after, limit: 500, signal });
        events.push(...page.items);
        if (page.nextCursor === null) break;
        after = page.nextCursor;
      }
      return new Response(JSON.stringify({ kind, id, events }), { headers: jsonHeaders() });
    } catch (error) {
      if (error instanceof MeanwhileError && error.status === 404) {
        return new Response(JSON.stringify({ error: "Task not found." }), {
          status: 404,
          headers: jsonHeaders(),
        });
      }
      return this.#upstreamFailure(error);
    }
  }

  #client(request: Request): Meanwhile | null {
    if (this.#staticClient !== null) return this.#staticClient;
    const secret = sessionSecret(request);
    return secret === null
      ? null
      : new Meanwhile({ baseUrl: this.#baseUrl, browserSession: secret });
  }

  #unauthenticated(): Response {
    return new Response(JSON.stringify({ authenticated: false }), {
      status: 401,
      headers: jsonHeaders(),
    });
  }

  #upstreamFailure(error: unknown): Response {
    if (
      error instanceof MeanwhileError &&
      (error.status === 401 || error.status === 403 || error.code === "UNAUTHENTICATED")
    ) {
      return this.#unauthenticated();
    }
    return new Response(JSON.stringify({ error: "The control plane is unavailable." }), {
      status: 502,
      headers: jsonHeaders(),
    });
  }

  #badRequest(message: string): Response {
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: jsonHeaders(),
    });
  }

  async #asset(pathname: string): Promise<Response> {
    const name = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    if (!/^[\w.-]+$/.test(name)) {
      return new Response("Not Found", { status: 404, headers: uiHeaders() });
    }
    const file = Bun.file(`${this.#assetsDir}/${name}`);
    if (!(await file.exists())) {
      const index = Bun.file(`${this.#assetsDir}/index.html`);
      if (await index.exists()) {
        const headers = uiHeaders();
        headers.set("Content-Type", "text/html");
        return new Response(index, { headers });
      }
      return new Response("Not Found", { status: 404, headers: uiHeaders() });
    }
    const headers = uiHeaders();
    headers.set("Content-Type", file.type || "application/octet-stream");
    return new Response(file, { headers });
  }
}

function sectionFor(item: ProjectWorkItem): BoardRow["section"] {
  if (["failed", "timed_out", "continuity_lost"].includes(item.status)) {
    return "attention";
  }
  if (item.status === "idle") return "ready";
  if (["queued", "provisioning", "running", "closing"].includes(item.status)) return "active";
  return "completed";
}

function sessionSecret(request: Request): string | null {
  const cookie = request.headers.get("Cookie");
  if (cookie === null) return null;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name !== SESSION_COOKIE) continue;
    const secret = decodeURIComponent(value.join("="));
    return /^mws_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/.test(secret) ? secret : null;
  }
  return null;
}

function sessionCookie(secret: string, request: Request, maxAge: number): string {
  const secure =
    new URL(request.url).protocol === "https:" ||
    request.headers.get("X-Forwarded-Proto")?.toLowerCase() === "https";
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(secret)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
