import { Meanwhile, MeanwhileError } from "@kohoz/meanwhile";
import type {
  AgentConnection,
  Principal,
  PresenceLease,
  Project,
  ProjectParticipant,
  ProjectRepositoryBinding,
  ProjectWorkItem,
  Run,
  RunEvent,
  SessionEvent,
  TaskAnnotation,
  TaskRelay,
} from "@kohoz/meanwhile/contracts";

export interface BoardServerOptions {
  readonly baseUrl: string;
  /** Optional single-user credential for a local private board. Omit it for team login. */
  readonly apiKey?: string;
  readonly hostname?: string;
  readonly port?: number;
  readonly assetsDir: string;
  /** Agent selected for the Board's deliberately narrow one-shot delegation surface. */
  readonly defaultAgentType?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface BoardRow extends ProjectWorkItem {
  readonly section: "attention" | "active" | "ready" | "completed";
}

interface BoardSnapshot {
  readonly principal: Principal;
  readonly project: Project;
  readonly projects: readonly Project[];
  readonly members: readonly ProjectParticipant[];
  readonly rows: readonly BoardRow[];
  readonly pendingRelays: readonly TaskRelay[];
  readonly recentRelays: readonly TaskRelay[];
  readonly presence: readonly PresenceLease[];
  readonly delegation: {
    readonly agents: readonly AgentConnection[];
    readonly repository: ProjectRepositoryBinding | null;
  };
  readonly updatedAt: string;
}

export interface LobbyTableSnapshot {
  readonly project: Project;
  readonly access: "watch" | "participate" | "administer";
  readonly accessSource: "membership" | "github";
  readonly members: readonly ProjectParticipant[];
  readonly work: {
    readonly total: number;
    readonly attention: number;
    readonly active: number;
    readonly ready: number;
    readonly completed: number;
  };
  readonly latestWork: ProjectWorkItem | null;
  readonly pendingRelayCount: number;
  readonly presence: readonly PresenceLease[];
}

export interface LobbySpaceSnapshot {
  readonly source: {
    readonly provider: "meanwhile" | "github";
    readonly accountId: string;
    readonly accountName: string;
  };
  readonly tables: readonly LobbyTableSnapshot[];
}

interface LobbySnapshot {
  readonly principal: Principal;
  readonly spaces: readonly LobbySpaceSnapshot[];
  readonly updatedAt: string;
}

type TaskKind = "run" | "session";

const SESSION_COOKIE = "mw_board_session";
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const AUTH_TRANSACTION_COOKIE = "mw_board_auth";
const AUTH_TRANSACTION_MAX_AGE_SECONDS = 10 * 60;
const INVITATION_COOKIE = "mw_board_invitation";
const INVITATION_MAX_AGE_SECONDS = 10 * 60;

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
  readonly #staticApiKey: string | null;
  readonly #hostname: string;
  readonly #port: number;
  readonly #assetsDir: string;
  readonly #defaultAgentType: string;
  readonly #fetch: typeof globalThis.fetch;
  #server: ReturnType<typeof Bun.serve> | null = null;

  constructor(options: BoardServerOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    this.#staticClient =
      options.apiKey === undefined
        ? null
        : new Meanwhile({ baseUrl: this.#baseUrl, apiKey: options.apiKey });
    this.#staticApiKey = options.apiKey ?? null;
    this.#hostname = options.hostname ?? "127.0.0.1";
    this.#port = options.port ?? 7333;
    this.#assetsDir = options.assetsDir;
    this.#defaultAgentType = options.defaultAgentType ?? "demo";
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
    const invitation = url.pathname.match(/^\/join\/(mwi_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43})$/);
    if (request.method === "GET" && invitation !== null) {
      return this.#acceptInvitation(request, invitation[1] ?? "");
    }
    if (request.method === "GET" && url.pathname === "/auth/providers") {
      return this.#externalAuthProviders(request);
    }
    if (request.method === "POST" && url.pathname === "/auth/invitation/cancel") {
      return this.#cancelInvitation(request);
    }
    const startExternalAuth = url.pathname.match(/^\/auth\/(github|google)\/start$/);
    if (request.method === "POST" && startExternalAuth !== null) {
      return this.#startExternalAuth(request, startExternalAuth[1] as "github" | "google");
    }
    const externalAuthCallback = url.pathname.match(/^\/auth\/(github|google)\/callback$/);
    if (request.method === "GET" && externalAuthCallback !== null) {
      return this.#externalAuthCallback(
        request,
        externalAuthCallback[1] as "github" | "google",
        url.searchParams,
      );
    }
    const presenceLease = url.pathname.match(/^\/projects\/([\w-]+)\/presence\/([\w-]+)$/);
    if (request.method === "PUT" && presenceLease !== null) {
      return this.#heartbeatPresence(
        request,
        presenceLease[1] ?? "",
        presenceLease[2] ?? "",
      );
    }
    if (request.method === "DELETE" && presenceLease !== null) {
      return this.#releasePresence(request, presenceLease[1] ?? "", presenceLease[2] ?? "");
    }
    if (request.method === "POST" && url.pathname === "/onboarding/agent-connections") {
      return this.#connectAgent(request);
    }
    const revokeAgentConnection = url.pathname.match(
      /^\/onboarding\/agent-connections\/([\w-]+)$/,
    );
    if (request.method === "DELETE" && revokeAgentConnection !== null) {
      return this.#revokeAgentConnection(request, revokeAgentConnection[1] ?? "");
    }
    if (request.method === "POST" && url.pathname === "/onboarding/projects") {
      return this.#importOnboardingRepository(request);
    }
    const selectOnboardingProject = url.pathname.match(
      /^\/onboarding\/projects\/([\w-]+)\/selection$/,
    );
    if (request.method === "PUT" && selectOnboardingProject !== null) {
      return this.#selectOnboardingProject(request, selectOnboardingProject[1] ?? "");
    }
    const bindOnboardingRepository = url.pathname.match(
      /^\/onboarding\/projects\/([\w-]+)\/repository$/,
    );
    if (request.method === "PUT" && bindOnboardingRepository !== null) {
      return this.#bindOnboardingRepository(request, bindOnboardingRepository[1] ?? "");
    }
    const createRun = url.pathname.match(/^\/projects\/([\w-]+)\/runs$/);
    if (request.method === "POST" && createRun !== null) {
      return this.#createRun(request, createRun[1] ?? "");
    }
    const cancelRun = url.pathname.match(/^\/task\/run\/([\w-]+)\/cancel$/);
    if (request.method === "POST" && cancelRun !== null) {
      return this.#cancelRun(request, cancelRun[1] ?? "");
    }
    const createRelay = url.pathname.match(/^\/projects\/([\w-]+)\/relays$/);
    if (request.method === "POST" && createRelay !== null) {
      return this.#createRelay(request, createRelay[1] ?? "");
    }
    const createAnnotation = url.pathname.match(/^\/projects\/([\w-]+)\/annotations$/);
    if (request.method === "POST" && createAnnotation !== null) {
      return this.#createAnnotation(request, createAnnotation[1] ?? "");
    }
    const resolveAnnotation = url.pathname.match(
      /^\/projects\/([\w-]+)\/annotations\/([\w-]+)\/resolve$/,
    );
    if (request.method === "POST" && resolveAnnotation !== null) {
      return this.#resolveAnnotation(
        request,
        resolveAnnotation[1] ?? "",
        resolveAnnotation[2] ?? "",
      );
    }
    const acknowledgeRelay = url.pathname.match(
      /^\/projects\/([\w-]+)\/relays\/([\w-]+)\/acknowledge$/,
    );
    if (request.method === "POST" && acknowledgeRelay !== null) {
      return this.#acknowledgeRelay(
        request,
        acknowledgeRelay[1] ?? "",
        acknowledgeRelay[2] ?? "",
      );
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: uiHeaders() });
    }

    if (url.pathname === "/session") return this.#session(request);
    if (url.pathname === "/onboarding") return this.#onboarding(request);
    if (url.pathname === "/lobby") return this.#lobby(request);
    if (url.pathname === "/board") return this.#board(request, url.searchParams.get("projectId"));
    const projectPresence = url.pathname.match(/^\/projects\/([\w-]+)\/presence$/);
    if (projectPresence !== null) return this.#presence(request, projectPresence[1] ?? "");
    const taskRelays = url.pathname.match(/^\/task\/(run|session)\/([\w-]+)\/relays$/);
    if (taskRelays !== null) {
      return this.#taskRelays(
        request,
        taskRelays[1] as TaskKind,
        taskRelays[2] ?? "",
        url.searchParams.get("projectId") ?? "",
        request.signal,
      );
    }
    const taskAnnotations = url.pathname.match(
      /^\/task\/(run|session)\/([\w-]+)\/annotations$/,
    );
    if (taskAnnotations !== null) {
      return this.#taskAnnotations(
        request,
        taskAnnotations[1] as TaskKind,
        taskAnnotations[2] ?? "",
        url.searchParams.get("projectId") ?? "",
        request.signal,
      );
    }
    const history = url.pathname.match(/^\/task\/(run|session)\/([\w-]+)\/events$/);
    if (history !== null) {
      return this.#history(
        request,
        history[1] as TaskKind,
        history[2] ?? "",
        url.searchParams.get("projectId") ?? "",
        request.signal,
      );
    }
    const follow = url.pathname.match(/^\/task\/(run|session)\/([\w-]+)\/follow$/);
    if (follow !== null) {
      return this.#follow(
        request,
        follow[1] as TaskKind,
        follow[2] ?? "",
        Number(url.searchParams.get("after") ?? "0"),
        request.signal,
      );
    }
    return this.#asset(url.pathname);
  }

  async #login(request: Request): Promise<Response> {
    if (!sameOriginWrite(request)) return this.#forbidden("Cross-origin sign-in is not allowed.");
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

  #acceptInvitation(request: Request, secret: string): Response {
    const headers = uiHeaders();
    headers.set("Cache-Control", "no-store");
    headers.set("Location", "/");
    headers.append(
      "Set-Cookie",
      invitationCookie(secret, request, INVITATION_MAX_AGE_SECONDS),
    );
    return new Response(null, { status: 303, headers });
  }

  #cancelInvitation(request: Request): Response {
    if (!sameOriginWrite(request)) {
      return this.#forbidden("Cross-origin invitation changes are not allowed.");
    }
    const headers = jsonHeaders();
    headers.append("Set-Cookie", invitationCookie("", request, 0));
    return new Response(JSON.stringify({ invitationReady: false }), { headers });
  }

  async #externalAuthProviders(request: Request): Promise<Response> {
    const upstream = await this.#fetch(new URL("external-auth/providers", this.#baseUrl), {
      headers: { Accept: "application/json" },
    }).catch(() => null);
    if (upstream === null) {
      return new Response(
        JSON.stringify({
          providers: [],
          registration: "closed",
          invitationReady: invitationSecret(request) !== null,
        }),
        { headers: jsonHeaders() },
      );
    }
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => undefined);
      return new Response(
        JSON.stringify({
          providers: [],
          registration: "closed",
          invitationReady: invitationSecret(request) !== null,
        }),
        { headers: jsonHeaders() },
      );
    }
    const body = (await upstream.json().catch(() => null)) as {
      providers?: unknown;
      registration?: unknown;
    } | null;
    const providers = Array.isArray(body?.providers)
      ? body.providers.flatMap((entry) => {
          if (
            typeof entry !== "object" ||
            entry === null ||
            !("provider" in entry) ||
            !("label" in entry) ||
            !["github", "google"].includes(String(entry.provider)) ||
            typeof entry.label !== "string"
          ) {
            return [];
          }
          return [{ provider: entry.provider, label: entry.label }];
        })
      : [];
    return new Response(
      JSON.stringify({
        providers,
        registration: body?.registration === "open" ? "open" : "closed",
        invitationReady: invitationSecret(request) !== null,
      }),
      { headers: jsonHeaders() },
    );
  }

  async #startExternalAuth(
    request: Request,
    provider: "github" | "google",
  ): Promise<Response> {
    if (!sameOriginWrite(request)) {
      return this.#forbidden("Cross-origin sign-in is not allowed.");
    }
    let intent: "login" | "link" | "invite" = "login";
    try {
      const body = (await request.json()) as { intent?: unknown };
      if (body.intent === "link" || body.intent === "invite") intent = body.intent;
      else if (body.intent !== undefined && body.intent !== "login") {
        return this.#badRequest("Authentication intent is invalid.");
      }
    } catch {
      return this.#badRequest("Could not start authentication.");
    }
    const existingSession = sessionSecret(request);
    const invitation = invitationSecret(request);
    if (intent === "link" && existingSession === null && this.#staticClient === null) {
      return this.#unauthenticated();
    }
    if (intent === "invite" && invitation === null) {
      return new Response(JSON.stringify({ error: "Invitation is invalid or expired." }), {
        status: 401,
        headers: jsonHeaders(),
      });
    }
    const upstream = await this.#fetch(
      new URL(`external-auth/${provider}/${intent}`, this.#baseUrl),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          ...(intent === "link"
            ? {
                Authorization:
                  existingSession === null
                    ? `Bearer ${this.#staticApiKey ?? ""}`
                    : `Session ${existingSession}`,
              }
            : {}),
          ...(intent === "invite" ? { "Content-Type": "application/json" } : {}),
        },
        ...(intent === "invite" ? { body: JSON.stringify({ secret: invitation }) } : {}),
      },
    ).catch(() => null);
    if (upstream === null) {
      return new Response(JSON.stringify({ error: "The control plane is unavailable." }), {
        status: 502,
        headers: jsonHeaders(),
      });
    }
    if (!upstream.ok) {
      const status = upstream.status === 401 || upstream.status === 403 ? upstream.status : 502;
      await upstream.body?.cancel().catch(() => undefined);
      return new Response(JSON.stringify({ error: "Could not start authentication." }), {
        status,
        headers: jsonHeaders(),
      });
    }
    const body = (await upstream.json().catch(() => null)) as {
      authorizationUrl?: unknown;
    } | null;
    if (
      typeof body?.authorizationUrl !== "string" ||
      !isProviderAuthorizationUrl(body.authorizationUrl)
    ) {
      return new Response(JSON.stringify({ error: "The control plane returned an invalid authorization URL." }), {
        status: 502,
        headers: jsonHeaders(),
      });
    }
    const authorization = new URL(body.authorizationUrl);
    const state = authorization.searchParams.get("state");
    if (state === null || state.length === 0 || state.length > 32_768) {
      return new Response(JSON.stringify({ error: "The control plane returned an invalid authorization URL." }), {
        status: 502,
        headers: jsonHeaders(),
      });
    }
    const headers = jsonHeaders();
    headers.append(
      "Set-Cookie",
      authTransactionCookie(
        `${provider}.${intent}.${await sha256Base64Url(state)}`,
        request,
        AUTH_TRANSACTION_MAX_AGE_SECONDS,
      ),
    );
    return new Response(JSON.stringify({ authorizationUrl: body.authorizationUrl }), {
      headers,
    });
  }

  async #externalAuthCallback(
    request: Request,
    provider: "github" | "google",
    parameters: URLSearchParams,
  ): Promise<Response> {
    const state = parameters.get("state") ?? "";
    const code = parameters.get("code");
    const providerError = parameters.get("error");
    if (state.length === 0 || state.length > 32_768) {
      return externalAuthRedirect(request, "transaction_invalid");
    }
    const correlation = authTransactionSecret(request);
    const parts = correlation?.split(".") ?? [];
    const intent = parts[0] === provider &&
      (parts[1] === "login" || parts[1] === "link" || parts[1] === "invite")
      ? parts[1]
      : null;
    const expectedCorrelation = `${provider}.${intent ?? "invalid"}.${await sha256Base64Url(state)}`;
    if (correlation === null || intent === null || !constantTimeEqual(correlation, expectedCorrelation)) {
      return externalAuthRedirect(request, "transaction_invalid");
    }
    const existingSession = sessionSecret(request);
    if (intent === "link" && existingSession === null && this.#staticClient === null) {
      return externalAuthRedirect(request, "transaction_invalid");
    }
    const upstream = await this.#fetch(new URL(
      `external-auth/${provider}/${
        intent === "link" ? "link-callback" : intent === "invite" ? "invite-callback" : "callback"
      }`,
      this.#baseUrl,
    ), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(intent === "link"
          ? {
              Authorization:
                existingSession === null
                  ? `Bearer ${this.#staticApiKey ?? ""}`
                  : `Session ${existingSession}`,
            }
          : {}),
      },
      body: JSON.stringify({ state, code, error: providerError }),
      signal: request.signal,
    }).catch(() => null);
    if (upstream === null) return externalAuthRedirect(request, "provider_unavailable");
    if (!upstream.ok) {
      const body = (await upstream.json().catch(() => null)) as {
        error?: { code?: unknown };
      } | null;
      await upstream.body?.cancel().catch(() => undefined);
      return externalAuthRedirect(request, publicExternalAuthError(body?.error?.code));
    }
    const body = (await upstream.json().catch(() => null)) as { secret?: unknown } | null;
    const issuedSecret = typeof body?.secret === "string" ? body.secret : "";
    if (!/^mws_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/.test(issuedSecret)) {
      return externalAuthRedirect(request, "provider_unavailable");
    }
    const headers = uiHeaders();
    headers.set("Cache-Control", "no-store");
    headers.set("Location", "/");
    headers.append("Set-Cookie", sessionCookie(issuedSecret, request, SESSION_MAX_AGE_SECONDS));
    headers.append("Set-Cookie", authTransactionCookie("", request, 0));
    headers.append("Set-Cookie", invitationCookie("", request, 0));
    return new Response(null, { status: 303, headers });
  }

  async #logout(request: Request): Promise<Response> {
    if (!sameOriginWrite(request)) return this.#forbidden("Cross-origin sign-out is not allowed.");
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

  async #onboarding(request: Request): Promise<Response> {
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    try {
      return new Response(JSON.stringify(await client.onboarding.get()), {
        headers: jsonHeaders(),
      });
    } catch (error) {
      return this.#upstreamFailure(error);
    }
  }

  async #presence(request: Request, projectId: string): Promise<Response> {
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    try {
      return new Response(JSON.stringify({ items: await client.projects.presence(projectId) }), {
        headers: jsonHeaders(),
      });
    } catch (error) {
      return this.#upstreamFailure(error);
    }
  }

  async #heartbeatPresence(
    request: Request,
    projectId: string,
    clientId: string,
  ): Promise<Response> {
    if (!sameOriginWrite(request)) return this.#forbidden("Cross-origin writes are not allowed.");
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    try {
      const lease = await client.projects.heartbeatPresence(projectId, clientId);
      return new Response(JSON.stringify({ lease }), { headers: jsonHeaders() });
    } catch (error) {
      return this.#upstreamFailure(error);
    }
  }

  async #releasePresence(
    request: Request,
    projectId: string,
    clientId: string,
  ): Promise<Response> {
    if (!sameOriginWrite(request)) return this.#forbidden("Cross-origin writes are not allowed.");
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    try {
      await client.projects.releasePresence(projectId, clientId);
      return new Response(null, { status: 204, headers: uiHeaders() });
    } catch (error) {
      return this.#upstreamFailure(error);
    }
  }

  async #connectAgent(request: Request): Promise<Response> {
    if (!sameOriginWrite(request)) return this.#forbidden("Cross-origin writes are not allowed.");
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    try {
      const body = (await request.json()) as { agentType?: unknown };
      const agentType = typeof body.agentType === "string" ? body.agentType : "";
      const connection = await client.onboarding.connectAgent(agentType);
      return new Response(JSON.stringify({ connection }), { status: 201, headers: jsonHeaders() });
    } catch (error) {
      return this.#upstreamFailure(error);
    }
  }

  async #revokeAgentConnection(request: Request, connectionId: string): Promise<Response> {
    if (!sameOriginWrite(request)) return this.#forbidden("Cross-origin writes are not allowed.");
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    try {
      const connection = await client.onboarding.revokeAgent(connectionId);
      return new Response(JSON.stringify({ connection }), { headers: jsonHeaders() });
    } catch (error) {
      return this.#upstreamFailure(error);
    }
  }

  async #selectOnboardingProject(request: Request, projectId: string): Promise<Response> {
    if (!sameOriginWrite(request)) return this.#forbidden("Cross-origin writes are not allowed.");
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    try {
      const body = (await request.json()) as { selected?: unknown };
      if (typeof body.selected !== "boolean") return this.#badRequest("Project selection is invalid.");
      const selection = await client.onboarding.selectProject(projectId, body.selected);
      return new Response(JSON.stringify({ selection }), { headers: jsonHeaders() });
    } catch (error) {
      return this.#upstreamFailure(error);
    }
  }

  async #importOnboardingRepository(request: Request): Promise<Response> {
    if (!sameOriginWrite(request)) return this.#forbidden("Cross-origin writes are not allowed.");
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    try {
      const body = (await request.json()) as { grantId?: unknown };
      const grantId = typeof body.grantId === "string" ? body.grantId : "";
      const imported = await client.onboarding.importRepository(grantId);
      return new Response(JSON.stringify(imported), { headers: jsonHeaders() });
    } catch (error) {
      return this.#upstreamFailure(error);
    }
  }

  async #bindOnboardingRepository(request: Request, projectId: string): Promise<Response> {
    if (!sameOriginWrite(request)) return this.#forbidden("Cross-origin writes are not allowed.");
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    try {
      const body = (await request.json()) as { grantId?: unknown };
      const grantId = typeof body.grantId === "string" ? body.grantId : "";
      const binding = await client.onboarding.bindRepository(projectId, grantId);
      return new Response(JSON.stringify({ binding }), { headers: jsonHeaders() });
    } catch (error) {
      return this.#upstreamFailure(error);
    }
  }

  async #board(request: Request, requestedProjectId: string | null): Promise<Response> {
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    try {
      const [me, onboarding] = await Promise.all([
        client.projects.me(),
        client.onboarding.get(),
      ]);
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
      const [members, work, pendingRelays, recentRelays, presence] = await Promise.all([
        client.projects.participants(project.id),
        client.projects.work(project.id),
        client.taskRelays.inbox(project.id),
        client.taskRelays.recent(project.id, 3),
        client.projects.presence(project.id),
      ]);
      const snapshot: BoardSnapshot = {
        principal: me.principal,
        project,
        projects: me.projects,
        members,
        rows: work.map((item) => ({ ...item, section: sectionFor(item) })),
        pendingRelays,
        recentRelays,
        presence,
        delegation: {
          agents: onboarding.agentConnections.filter((connection) => connection.revokedAt === null),
          repository:
            onboarding.repositoryBindings.find((binding) => binding.projectId === project.id) ??
            null,
        },
        updatedAt: new Date().toISOString(),
      };
      return new Response(JSON.stringify(snapshot), { headers: jsonHeaders() });
    } catch (error) {
      return this.#upstreamFailure(error);
    }
  }

  async #lobby(request: Request): Promise<Response> {
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    try {
      const [me, onboarding] = await Promise.all([
        client.projects.me(),
        client.onboarding.get(),
      ]);
      const selectedIds = new Set(
        onboarding.projects.filter((entry) => entry.selected).map((entry) => entry.project.id),
      );
      const visibleProjects = me.projects.filter((project) => selectedIds.has(project.id));
      const tables = await mapWithConcurrency(visibleProjects, 6, async (project) => {
        const [members, work, pendingRelays, presence] = await Promise.all([
          client.projects.participants(project.id),
          client.projects.work(project.id),
          client.taskRelays.inbox(project.id),
          client.projects.presence(project.id),
        ]);
        const projectAccess = onboarding.projects.find(
          (entry) => entry.project.id === project.id,
        );
        if (projectAccess === undefined) {
          throw new MeanwhileError({
            code: "PROJECT_ACCESS_CHANGED",
            message: "Project access changed",
            status: 404,
          });
        }
        const rows = work.map((item) => ({ ...item, section: sectionFor(item) }));
        const latestWork = [...work].sort(
          (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
        )[0] ?? null;
        return {
          project,
          access: projectAccess.access,
          accessSource: projectAccess.source,
          members,
          work: {
            total: rows.length,
            attention: rows.filter((row) => row.section === "attention").length,
            active: rows.filter((row) => row.section === "active").length,
            ready: rows.filter((row) => row.section === "ready").length,
            completed: rows.filter((row) => row.section === "completed").length,
          },
          latestWork,
          pendingRelayCount: pendingRelays.length,
          presence,
        } satisfies LobbyTableSnapshot;
      });
      const bindings = new Map(
        onboarding.repositoryBindings.map((binding) => [binding.projectId, binding]),
      );
      const grouped = new Map<string, LobbySpaceSnapshot>();
      for (const table of tables) {
        const binding = bindings.get(table.project.id);
        const source =
          binding === undefined
            ? {
                provider: "meanwhile" as const,
                accountId: me.principal.ownerId,
                accountName: "Local installation",
              }
            : {
                provider: "github" as const,
                accountId: binding.accountId,
                accountName: binding.accountName,
              };
        const key = `${source.provider}:${source.accountId}`;
        const current = grouped.get(key);
        grouped.set(key, {
          source,
          tables: [...(current?.tables ?? []), table].sort(compareLobbyTables),
        });
      }
      const snapshot: LobbySnapshot = {
        principal: me.principal,
        spaces: [...grouped.values()],
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
    projectId: string,
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
      const [relays, annotations] = await Promise.all([
        client.taskRelays.list(projectId, { kind, id }, { signal }),
        client.taskAnnotations.list(projectId, { kind, id }, { signal }),
      ]);
      return new Response(JSON.stringify({ kind, id, events, relays, annotations }), {
        headers: jsonHeaders(),
      });
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

  async #taskRelays(
    request: Request,
    kind: TaskKind,
    id: string,
    projectId: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    try {
      const relays = await client.taskRelays.list(projectId, { kind, id }, { signal });
      return new Response(JSON.stringify({ relays }), { headers: jsonHeaders() });
    } catch (error) {
      return this.#upstreamFailure(error);
    }
  }

  async #taskAnnotations(
    request: Request,
    kind: TaskKind,
    id: string,
    projectId: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    try {
      const annotations = await client.taskAnnotations.list(projectId, { kind, id }, { signal });
      return new Response(JSON.stringify({ annotations }), { headers: jsonHeaders() });
    } catch (error) {
      return this.#upstreamFailure(error);
    }
  }

  async #follow(
    request: Request,
    kind: TaskKind,
    id: string,
    after: number,
    signal: AbortSignal,
  ): Promise<Response> {
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    if (!Number.isSafeInteger(after) || after < 0) return this.#badRequest("Invalid event cursor.");
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: ready\ndata: {}\n\n"));
        void (async () => {
          try {
            const events =
              kind === "run"
                ? client.runs.followEvents(id, { after, signal })
                : client.sessions.followEvents(id, { after, signal });
            for await (const event of events) {
              controller.enqueue(encoder.encode(`event: task\ndata: ${JSON.stringify(event)}\n\n`));
            }
            controller.close();
          } catch (error) {
            if (!signal.aborted) {
              const code = error instanceof MeanwhileError ? error.code : "STREAM_UNAVAILABLE";
              controller.enqueue(encoder.encode(`event: stream-error\ndata: ${JSON.stringify({ code })}\n\n`));
              controller.close();
            }
          }
        })();
      },
      cancel() {},
    });
    const headers = uiHeaders();
    headers.set("Content-Type", "text/event-stream");
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Accel-Buffering", "no");
    return new Response(stream, { headers });
  }

  async #createRelay(request: Request, projectId: string): Promise<Response> {
    if (!sameOriginWrite(request)) return this.#forbidden("Cross-origin writes are not allowed.");
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    try {
      const input = (await request.json()) as Parameters<typeof client.taskRelays.create>[1];
      const relay = await client.taskRelays.create(projectId, input);
      return new Response(JSON.stringify({ relay }), { status: 201, headers: jsonHeaders() });
    } catch (error) {
      return this.#upstreamFailure(error);
    }
  }

  async #createAnnotation(request: Request, projectId: string): Promise<Response> {
    if (!sameOriginWrite(request)) return this.#forbidden("Cross-origin writes are not allowed.");
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    try {
      const input = (await request.json()) as Parameters<typeof client.taskAnnotations.create>[1];
      const annotation = await client.taskAnnotations.create(projectId, input);
      return new Response(JSON.stringify({ annotation } satisfies { annotation: TaskAnnotation }), {
        status: 201,
        headers: jsonHeaders(),
      });
    } catch (error) {
      return this.#upstreamFailure(error);
    }
  }

  async #createRun(request: Request, projectId: string): Promise<Response> {
    if (!sameOriginWrite(request)) return this.#forbidden("Cross-origin writes are not allowed.");
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    let input: {
      prompt?: unknown;
      repositoryUrl?: unknown;
      revision?: unknown;
      idempotencyKey?: unknown;
      agentType?: unknown;
    };
    try {
      input = (await request.json()) as typeof input;
    } catch {
      return this.#badRequest("Could not read the task.");
    }
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    const requestedRepositoryUrl =
      typeof input.repositoryUrl === "string" ? input.repositoryUrl.trim() : "";
    const revision = typeof input.revision === "string" ? input.revision.trim() : "";
    const idempotencyKey =
      typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
    const requestedAgentType = typeof input.agentType === "string" ? input.agentType.trim() : "";
    if (prompt.length === 0 || prompt.length > 262_144) {
      return this.#badRequest("The task must contain between 1 and 262144 characters.");
    }
    if (!/^[A-Za-z0-9._:-]{1,255}$/.test(idempotencyKey)) {
      return this.#badRequest("The task identity is invalid.");
    }
    let onboarding: Awaited<ReturnType<typeof client.onboarding.get>>;
    try {
      onboarding = await client.onboarding.get();
    } catch (error) {
      return this.#upstreamFailure(error);
    }
    const binding = onboarding.repositoryBindings.find((candidate) => candidate.projectId === projectId);
    const repositoryUrl = binding?.repositoryUrl ?? requestedRepositoryUrl;
    const connection =
      onboarding.agentConnections.find(
        (candidate) => candidate.agentType === requestedAgentType && candidate.revokedAt === null,
      ) ?? onboarding.agentConnections.find((candidate) => candidate.revokedAt === null);
    if (connection === undefined) {
      return new Response(JSON.stringify({ error: "Authorize an agent before delegating work." }), {
        status: 409,
        headers: jsonHeaders(),
      });
    }
    let repository: URL;
    try {
      repository = new URL(repositoryUrl);
    } catch {
      return this.#badRequest("Enter a valid HTTPS repository URL.");
    }
    if (
      repository.protocol !== "https:" ||
      repository.username !== "" ||
      repository.password !== "" ||
      repository.search !== "" ||
      repository.hash !== ""
    ) {
      return this.#badRequest("Use an HTTPS repository URL without credentials or query data.");
    }
    try {
      const run = await client.runs.create(
        {
          projectId,
          workspace: {
            type: "repository",
            url: repository.href,
            ...(revision === "" ? {} : { revision }),
          },
          agentType: connection.agentType,
          prompt,
          env: {},
          secretRefs: {},
          briefIds: [],
          artifactPaths: [],
          timeoutMs: 3_600_000,
        },
        { idempotencyKey },
      );
      return new Response(JSON.stringify({ run } satisfies { run: Run }), {
        status: 201,
        headers: jsonHeaders(),
      });
    } catch (error) {
      return this.#upstreamFailure(error);
    }
  }

  async #cancelRun(request: Request, runId: string): Promise<Response> {
    if (!sameOriginWrite(request)) return this.#forbidden("Cross-origin writes are not allowed.");
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    try {
      return new Response(JSON.stringify({ run: await client.runs.cancel(runId) }), {
        status: 202,
        headers: jsonHeaders(),
      });
    } catch (error) {
      return this.#upstreamFailure(error);
    }
  }

  async #acknowledgeRelay(request: Request, projectId: string, relayId: string): Promise<Response> {
    if (!sameOriginWrite(request)) return this.#forbidden("Cross-origin writes are not allowed.");
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    try {
      const relay = await client.taskRelays.acknowledge(projectId, relayId);
      return new Response(JSON.stringify({ relay }), { headers: jsonHeaders() });
    } catch (error) {
      return this.#upstreamFailure(error);
    }
  }

  async #resolveAnnotation(
    request: Request,
    projectId: string,
    annotationId: string,
  ): Promise<Response> {
    if (!sameOriginWrite(request)) return this.#forbidden("Cross-origin writes are not allowed.");
    const client = this.#client(request);
    if (client === null) return this.#unauthenticated();
    try {
      const annotation = await client.taskAnnotations.resolve(projectId, annotationId);
      return new Response(JSON.stringify({ annotation }), { headers: jsonHeaders() });
    } catch (error) {
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
    if (error instanceof MeanwhileError && [400, 404, 409, 422].includes(error.status ?? 0)) {
      return new Response(JSON.stringify({ error: error.message, code: error.code }), {
        status: error.status,
        headers: jsonHeaders(),
      });
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

  #forbidden(message: string): Response {
    return new Response(JSON.stringify({ error: message }), {
      status: 403,
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

function compareLobbyTables(left: LobbyTableSnapshot, right: LobbyTableSnapshot): number {
  if (left.pendingRelayCount !== right.pendingRelayCount) {
    return right.pendingRelayCount - left.pendingRelayCount;
  }
  if (left.work.attention !== right.work.attention) {
    return right.work.attention - left.work.attention;
  }
  if (left.work.active !== right.work.active) return right.work.active - left.work.active;
  const leftUpdated = left.latestWork === null ? 0 : Date.parse(left.latestWork.updatedAt);
  const rightUpdated = right.latestWork === null ? 0 : Date.parse(right.latestWork.updatedAt);
  return rightUpdated - leftUpdated || left.project.name.localeCompare(right.project.name);
}

async function mapWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  mapper: (input: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  const output = new Array<Output>(inputs.length);
  let next = 0;
  const worker = async () => {
    while (next < inputs.length) {
      const index = next;
      next += 1;
      const input = inputs[index];
      if (input !== undefined) output[index] = await mapper(input);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()),
  );
  return output;
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

function authTransactionSecret(request: Request): string | null {
  const cookie = request.headers.get("Cookie");
  if (cookie === null) return null;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name !== AUTH_TRANSACTION_COOKIE) continue;
    const secret = decodeURIComponent(value.join("="));
    return /^(github|google)\.(login|link|invite)\.[A-Za-z0-9_-]{43}$/.test(secret)
      ? secret
      : null;
  }
  return null;
}

function invitationSecret(request: Request): string | null {
  const cookie = request.headers.get("Cookie");
  if (cookie === null) return null;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name !== INVITATION_COOKIE) continue;
    const secret = decodeURIComponent(value.join("="));
    return /^mwi_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/.test(secret) ? secret : null;
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
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function authTransactionCookie(value: string, request: Request, maxAge: number): string {
  const secure =
    new URL(request.url).protocol === "https:" ||
    request.headers.get("X-Forwarded-Proto")?.toLowerCase() === "https";
  return [
    `${AUTH_TRANSACTION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/auth",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function invitationCookie(value: string, request: Request, maxAge: number): string {
  const secure =
    new URL(request.url).protocol === "https:" ||
    request.headers.get("X-Forwarded-Proto")?.toLowerCase() === "https";
  return [
    `${INVITATION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function sameOriginWrite(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin === null) return false;
  const target = new URL(request.url);
  const forwardedProtocol = request.headers.get("X-Forwarded-Proto")?.trim().toLowerCase();
  if (forwardedProtocol === "http" || forwardedProtocol === "https") {
    target.protocol = `${forwardedProtocol}:`;
  }
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  return origin === target.origin && (fetchSite === null || fetchSite === "same-origin");
}

function isProviderAuthorizationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["github.com", "accounts.google.com"].includes(url.hostname) &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

function publicExternalAuthError(value: unknown): string {
  switch (value) {
    case "EXTERNAL_AUTH_REJECTED":
      return "authorization_rejected";
    case "EXTERNAL_IDENTITY_NOT_LINKED":
      return "identity_not_linked";
    case "EXTERNAL_IDENTITY_CONFLICT":
      return "identity_conflict";
    case "PRINCIPAL_INVITATION_INVALID":
      return "invitation_invalid";
    case "EXTERNAL_AUTH_TRANSACTION_INVALID":
      return "transaction_invalid";
    default:
      return "provider_unavailable";
  }
}

function externalAuthRedirect(request: Request, error: string): Response {
  const target = new URL("/", request.url);
  target.searchParams.set("auth_error", error);
  const headers = uiHeaders();
  headers.set("Cache-Control", "no-store");
  headers.set("Location", `${target.pathname}${target.search}`);
  headers.append("Set-Cookie", authTransactionCookie("", request, 0));
  if (error === "invitation_invalid") {
    headers.append("Set-Cookie", invitationCookie("", request, 0));
  }
  return new Response(null, { status: 303, headers });
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest).toBase64({ alphabet: "base64url", omitPadding: true });
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let mismatch = leftBytes.byteLength ^ rightBytes.byteLength;
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}
