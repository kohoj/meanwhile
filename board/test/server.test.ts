import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API_OWNER_ID,
  API_PRINCIPAL_ID,
  API_PROJECT_ID,
  API_RUN_ID,
  API_TIMESTAMP,
  apiRun,
} from "../../test/fixtures/api";
import { BoardServer } from "../src/server";

let server: BoardServer;
let base: string;
let assets: string;

beforeAll(() => {
  assets = mkdtempSync(join(tmpdir(), "board-assets-"));
  writeFileSync(join(assets, "index.html"), "<!doctype html><div id=root></div>");
  server = new BoardServer({
    baseUrl: "http://127.0.0.1:59999",
    apiKey: "mwk_test_key_only_for_route_guards_000",
    assetsDir: assets,
    port: 0,
  });
  base = server.start().url;
});

afterAll(async () => {
  await server.stop();
  rmSync(assets, { recursive: true, force: true });
});

describe("Project Watch boundary", () => {
  test("rejects lifecycle mutations and serves the SPA shell", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of ["/lobby", "/board", "/", "/anything"]) {
        const response = await fetch(`${base}${path}`, { method });
        expect(response.status).toBe(405);
      }
    }
    const shell = await fetch(`${base}/`);
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-type")).toContain("text/html");
  });

  test("ships defensive headers and never traverses assets", async () => {
    const shell = await fetch(`${base}/`);
    expect(shell.headers.get("x-frame-options")).toBe("DENY");
    expect(shell.headers.get("x-content-type-options")).toBe("nosniff");
    expect(shell.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const traversal = await fetch(`${base}/..%2f..%2fpackage.json`);
    expect(await traversal.text()).not.toContain("dependencies");
  });

  test("does not turn an upstream outage into an authentication failure", async () => {
    const response = await fetch(`${base}/session`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "The control plane is unavailable." });
    const providers = await fetch(`${base}/auth/providers`);
    expect(providers.status).toBe(200);
    expect(await providers.json()).toEqual({
      providers: [],
      registration: "closed",
      invitationReady: false,
    });
  });
});

describe("team browser session", () => {
  test("keeps OAuth tokens behind the BFF while completing provider redirects into a session cookie", async () => {
    const requests: Array<{ method: string; path: string; authorization: string }> = [];
    const sessionSecret = `mws_${"s".repeat(12)}_${"t".repeat(43)}`;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        requests.push({
          method: request.method,
          path: url.pathname,
          authorization: request.headers.get("Authorization") ?? "",
        });
        if (request.method === "GET" && url.pathname === "/external-auth/providers") {
          return Response.json({
            providers: [{ provider: "github", label: "GitHub" }],
            registration: "closed",
          });
        }
        if (
          request.method === "POST" &&
          [
            "/external-auth/github/login",
            "/external-auth/github/link",
            "/external-auth/github/invite",
          ].includes(url.pathname)
        ) {
          if (url.pathname.endsWith("/invite")) {
            expect(await request.json()).toEqual({
              secret: `mwi_${"i".repeat(12)}_${"j".repeat(43)}`,
            });
          }
          return Response.json({
            authorizationUrl:
              "https://github.com/login/oauth/authorize?state=sealed&code_challenge=challenge",
          });
        }
        if (
          request.method === "POST" &&
          [
            "/external-auth/github/callback",
            "/external-auth/github/link-callback",
            "/external-auth/github/invite-callback",
          ].includes(url.pathname)
        ) {
          expect(await request.json()).toEqual({
            state: "sealed",
            code: "provider-code",
            error: null,
          });
          return Response.json(
            {
              identity: { id: API_PRINCIPAL_ID },
              repositoryGrants: [],
              session: { id: API_PRINCIPAL_ID },
              secret: sessionSecret,
              intent: url.pathname.endsWith("link-callback")
                ? "link"
                : url.pathname.endsWith("invite-callback")
                  ? "invite"
                  : "login",
            },
            { status: 201 },
          );
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    const teamAssets = mkdtempSync(join(tmpdir(), "board-auth-assets-"));
    writeFileSync(join(teamAssets, "index.html"), "<!doctype html><div id=root></div>");
    const team = new BoardServer({ baseUrl: upstream.url.origin, assetsDir: teamAssets, port: 0 });
    const teamBase = team.start().url;
    try {
      const providers = await fetch(`${teamBase}/auth/providers`);
      expect(await providers.json()).toEqual({
        providers: [{ provider: "github", label: "GitHub" }],
        registration: "closed",
        invitationReady: false,
      });
      expect(
        (
          await fetch(`${teamBase}/auth/github/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ intent: "login" }),
          })
        ).status,
      ).toBe(403);
      const started = await fetch(`${teamBase}/auth/github/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: teamBase },
        body: JSON.stringify({ intent: "login" }),
      });
      expect(started.status).toBe(200);
      expect(await started.json()).toMatchObject({
        authorizationUrl: expect.stringContaining("https://github.com/login/oauth/authorize"),
      });
      const authCookie = started.headers.get("set-cookie") ?? "";
      expect(authCookie).toContain("HttpOnly");
      expect(authCookie).toContain("SameSite=Lax");
      const authCookiePair = authCookie.split(";", 1)[0] ?? "";
      expect(
        (
          await fetch(`${teamBase}/auth/github/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: teamBase },
            body: JSON.stringify({ intent: "link" }),
          })
        ).status,
      ).toBe(401);
      const linked = await fetch(`${teamBase}/auth/github/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: teamBase,
          Cookie: `mw_board_session=${sessionSecret}`,
        },
        body: JSON.stringify({ intent: "link" }),
      });
      expect(linked.status).toBe(200);
      expect(requests.at(-1)).toMatchObject({
        path: "/external-auth/github/link",
        authorization: `Session ${sessionSecret}`,
      });
      const linkedAuthCookie = linked.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

      const linkCallback = await fetch(
        `${teamBase}/auth/github/callback?state=sealed&code=provider-code`,
        {
          redirect: "manual",
          headers: {
            Cookie: `${linkedAuthCookie}; mw_board_session=${sessionSecret}`,
          },
        },
      );
      expect(linkCallback.status).toBe(303);
      expect(requests.at(-1)).toMatchObject({
        path: "/external-auth/github/link-callback",
        authorization: `Session ${sessionSecret}`,
      });

      const callback = await fetch(
        `${teamBase}/auth/github/callback?state=sealed&code=provider-code`,
        { redirect: "manual", headers: { Cookie: authCookiePair } },
      );
      expect(callback.status).toBe(303);
      expect(callback.headers.get("location")).toBe("/");
      expect(callback.headers.get("set-cookie")).toContain("HttpOnly");
      expect(callback.headers.get("set-cookie")).toContain("SameSite=Lax");
      const unboundCallback = await fetch(
        `${teamBase}/auth/github/callback?state=sealed&code=provider-code`,
        { redirect: "manual" },
      );
      expect(unboundCallback.status).toBe(303);
      expect(unboundCallback.headers.get("location")).toBe("/?auth_error=transaction_invalid");

      const invitationSecret = `mwi_${"i".repeat(12)}_${"j".repeat(43)}`;
      const acceptedInvitation = await fetch(`${teamBase}/join/${invitationSecret}`, {
        redirect: "manual",
      });
      expect(acceptedInvitation.status).toBe(303);
      expect(acceptedInvitation.headers.get("location")).toBe("/");
      expect(acceptedInvitation.headers.get("cache-control")).toBe("no-store");
      const invitationCookie = acceptedInvitation.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      expect(acceptedInvitation.headers.get("set-cookie")).toContain("HttpOnly");
      const invitedProviders = await fetch(`${teamBase}/auth/providers`, {
        headers: { Cookie: invitationCookie },
      });
      expect(await invitedProviders.json()).toEqual({
        providers: [{ provider: "github", label: "GitHub" }],
        registration: "closed",
        invitationReady: true,
      });
      expect(
        (
          await fetch(`${teamBase}/auth/invitation/cancel`, {
            method: "POST",
            headers: { Cookie: invitationCookie },
          })
        ).status,
      ).toBe(403);
      const cancelledInvitation = await fetch(`${teamBase}/auth/invitation/cancel`, {
        method: "POST",
        headers: { Origin: teamBase, Cookie: invitationCookie },
      });
      expect(cancelledInvitation.status).toBe(200);
      expect(await cancelledInvitation.json()).toEqual({ invitationReady: false });
      expect(cancelledInvitation.headers.get("set-cookie")).toContain("mw_board_invitation=");
      expect(cancelledInvitation.headers.get("set-cookie")).toContain("Max-Age=0");
      const invited = await fetch(`${teamBase}/auth/github/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: teamBase,
          Cookie: invitationCookie,
        },
        body: JSON.stringify({ intent: "invite" }),
      });
      expect(invited.status).toBe(200);
      expect(requests.at(-1)).toMatchObject({
        path: "/external-auth/github/invite",
        authorization: "",
      });
      const invitedAuthCookie = invited.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      const invitedCallback = await fetch(
        `${teamBase}/auth/github/callback?state=sealed&code=provider-code`,
        {
          redirect: "manual",
          headers: { Cookie: `${invitedAuthCookie}; ${invitationCookie}` },
        },
      );
      expect(invitedCallback.status).toBe(303);
      expect(requests.at(-1)).toMatchObject({
        path: "/external-auth/github/invite-callback",
        authorization: "",
      });
      expect(invitedCallback.headers.get("set-cookie")).toContain("mw_board_invitation=");
    } finally {
      await team.stop();
      await upstream.stop(true);
      rmSync(teamAssets, { recursive: true, force: true });
    }
  });

  test("exchanges an API key once and uses only the opaque session for Project reads and collaboration", async () => {
    const authorizations: string[] = [];
    const runRequests: unknown[] = [];
    const onboardingWrites: Array<{ method: string; path: string; body: unknown }> = [];
    const connectionId = "00000000-0000-4000-8000-000000000071";
    const grantId = "00000000-0000-4000-8000-000000000072";
    const presenceClientId = "00000000-0000-4000-8000-000000000074";
    const presenceLease = {
      ownerId: API_OWNER_ID,
      projectId: API_PROJECT_ID,
      clientId: presenceClientId,
      principal: { id: API_PRINCIPAL_ID, kind: "person" as const, displayName: "Bob Li" },
      connectedAt: API_TIMESTAMP,
      lastSeenAt: API_TIMESTAMP,
      expiresAt: "2026-07-13T00:00:45.000Z",
    };
    const binding = {
      id: "00000000-0000-4000-8000-000000000073",
      projectId: API_PROJECT_ID,
      ownerId: API_OWNER_ID,
      grantId,
      provider: "github" as const,
      accountId: "42",
      accountName: "kohoz",
      installationId: "84",
      repositoryId: "126",
      repositoryName: "meanwhile",
      repositoryFullName: "kohoz/meanwhile",
      repositoryUrl: "https://github.com/kohoz/meanwhile",
      private: true,
      boundByPrincipalId: API_PRINCIPAL_ID,
      createdAt: API_TIMESTAMP,
      revokedAt: null,
    };
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        authorizations.push(request.headers.get("Authorization") ?? "");
        if (request.method === "POST" && url.pathname === "/browser-sessions") {
          return Response.json(
            {
              session: {
                id: "00000000-0000-4000-8000-000000000099",
                ownerId: API_OWNER_ID,
                principalId: API_PRINCIPAL_ID,
                createdAt: API_TIMESTAMP,
                expiresAt: "2026-07-13T12:00:00.000Z",
                lastUsedAt: null,
                revokedAt: null,
              },
              secret: `mws_${"a".repeat(12)}_${"b".repeat(43)}`,
            },
            { status: 201 },
          );
        }
        if (request.method === "DELETE" && url.pathname === "/browser-sessions/current") {
          return Response.json({ session: { id: "00000000-0000-4000-8000-000000000099" } });
        }
        if (request.method === "GET" && url.pathname === "/onboarding") {
          return Response.json({
            principal: {
              id: API_PRINCIPAL_ID,
              ownerId: API_OWNER_ID,
              kind: "person",
              displayName: "Bob Li",
              ownerRole: "member",
              createdAt: API_TIMESTAMP,
              disabledAt: null,
            },
            identities: [],
            repositoryGrants: [],
            repositoryBindings: [binding],
            agentConnections: [
              {
                id: connectionId,
                ownerId: API_OWNER_ID,
                principalId: API_PRINCIPAL_ID,
                agentType: "demo",
                label: "Demo",
                capabilities: {
                  oneShotRuns: true,
                  durableSessions: true,
                  runtimeProviders: ["local"],
                },
                createdAt: API_TIMESTAMP,
                lastVerifiedAt: API_TIMESTAMP,
                revokedAt: null,
              },
            ],
            availableAgents: [
              {
                agentType: "demo",
                label: "Demo",
                capabilities: {
                  oneShotRuns: true,
                  durableSessions: true,
                  runtimeProviders: ["local"],
                },
              },
            ],
            projects: [
              {
                project: {
                  id: API_PROJECT_ID,
                  ownerId: API_OWNER_ID,
                  name: "Project Northstar",
                  slug: "northstar",
                  createdAt: API_TIMESTAMP,
                  archivedAt: null,
                },
                access: "participate",
                source: "membership",
                selected: true,
              },
            ],
          });
        }
        if (
          request.method === "POST" &&
          url.pathname === "/onboarding/agent-connections"
        ) {
          const body = await request.json();
          onboardingWrites.push({ method: request.method, path: url.pathname, body });
          return Response.json({
            connection: {
              id: connectionId,
              ownerId: API_OWNER_ID,
              principalId: API_PRINCIPAL_ID,
              agentType: "demo",
              label: "Demo",
              capabilities: {
                oneShotRuns: true,
                durableSessions: true,
                runtimeProviders: ["local"],
              },
              createdAt: API_TIMESTAMP,
              lastVerifiedAt: API_TIMESTAMP,
              revokedAt: null,
            },
          });
        }
        if (
          request.method === "DELETE" &&
          url.pathname === `/onboarding/agent-connections/${connectionId}`
        ) {
          onboardingWrites.push({ method: request.method, path: url.pathname, body: null });
          return Response.json({
            connection: {
              id: connectionId,
              ownerId: API_OWNER_ID,
              principalId: API_PRINCIPAL_ID,
              agentType: "demo",
              label: "Demo",
              capabilities: {
                oneShotRuns: true,
                durableSessions: true,
                runtimeProviders: ["local"],
              },
              createdAt: API_TIMESTAMP,
              lastVerifiedAt: API_TIMESTAMP,
              revokedAt: API_TIMESTAMP,
            },
          });
        }
        if (
          request.method === "PUT" &&
          url.pathname === `/onboarding/projects/${API_PROJECT_ID}/selection`
        ) {
          const body = await request.json();
          onboardingWrites.push({ method: request.method, path: url.pathname, body });
          return Response.json({
            selection: {
              ownerId: API_OWNER_ID,
              principalId: API_PRINCIPAL_ID,
              projectId: API_PROJECT_ID,
              selectedAt: API_TIMESTAMP,
              hiddenAt: null,
            },
          });
        }
        if (request.method === "POST" && url.pathname === "/onboarding/projects") {
          const body = await request.json();
          onboardingWrites.push({ method: request.method, path: url.pathname, body });
          return Response.json({
            project: {
              id: API_PROJECT_ID,
              ownerId: API_OWNER_ID,
              name: "Project Northstar",
              slug: "northstar",
              createdAt: API_TIMESTAMP,
              archivedAt: null,
            },
            binding,
            selection: {
              ownerId: API_OWNER_ID,
              principalId: API_PRINCIPAL_ID,
              projectId: API_PROJECT_ID,
              selectedAt: API_TIMESTAMP,
              hiddenAt: null,
            },
            created: false,
          });
        }
        if (
          request.method === "PUT" &&
          url.pathname === `/onboarding/projects/${API_PROJECT_ID}/repository`
        ) {
          const body = await request.json();
          onboardingWrites.push({ method: request.method, path: url.pathname, body });
          return Response.json({ binding });
        }
        if (url.pathname === "/me") {
          return Response.json({
            principal: {
              id: API_PRINCIPAL_ID,
              ownerId: API_OWNER_ID,
              kind: "person",
              displayName: "Bob Li",
              ownerRole: "member",
              createdAt: API_TIMESTAMP,
              disabledAt: null,
            },
            projects: [
              {
                id: API_PROJECT_ID,
                ownerId: API_OWNER_ID,
                name: "Project Northstar",
                slug: "northstar",
                createdAt: API_TIMESTAMP,
                archivedAt: null,
              },
            ],
          });
        }
        if (url.pathname === `/projects/${API_PROJECT_ID}/participants`) {
          return Response.json({
            items: [
              {
                projectId: API_PROJECT_ID,
                principal: { id: API_PRINCIPAL_ID, kind: "person", displayName: "Bob Li" },
                access: "participate",
                source: "membership",
                since: API_TIMESTAMP,
              },
            ],
          });
        }
        if (url.pathname === `/projects/${API_PROJECT_ID}/presence`) {
          return Response.json({ items: [presenceLease] });
        }
        if (
          request.method === "PUT" &&
          url.pathname === `/projects/${API_PROJECT_ID}/presence/${presenceClientId}`
        ) {
          return Response.json({ lease: presenceLease });
        }
        if (
          request.method === "DELETE" &&
          url.pathname === `/projects/${API_PROJECT_ID}/presence/${presenceClientId}`
        ) {
          return new Response(null, { status: 204 });
        }
        if (url.pathname === `/projects/${API_PROJECT_ID}/work`) {
          return Response.json({
            items: [
              {
                kind: "run",
                id: API_RUN_ID,
                projectId: API_PROJECT_ID,
                delegatedBy: { id: API_PRINCIPAL_ID, kind: "person", displayName: "Bob Li" },
                title: "Audit the migration plan",
                agentType: "codex",
                status: "running",
                createdAt: API_TIMESTAMP,
                updatedAt: API_TIMESTAMP,
              },
            ],
          });
        }
        if (url.pathname === `/projects/${API_PROJECT_ID}/relay-inbox`) {
          return Response.json({ items: [] });
        }
        if (url.pathname === `/projects/${API_PROJECT_ID}/recent-relays`) {
          expect(url.searchParams.get("limit")).toBe("3");
          return Response.json({ items: [] });
        }
        if (request.method === "GET" && url.pathname === `/projects/${API_PROJECT_ID}/annotations`) {
          expect(url.searchParams.get("taskKind")).toBe("run");
          expect(url.searchParams.get("taskId")).toBe(API_RUN_ID);
          return Response.json({ items: [] });
        }
        if (request.method === "POST" && url.pathname === "/runs") {
          runRequests.push(await request.json());
          return Response.json({ run: apiRun() }, { status: 201 });
        }
        if (request.method === "POST" && url.pathname === `/runs/${API_RUN_ID}/cancel`) {
          return Response.json({ run: apiRun("cancelled") }, { status: 202 });
        }
        if (request.method === "POST" && url.pathname === `/projects/${API_PROJECT_ID}/relays`) {
          return Response.json(
            {
              relay: {
                id: "00000000-0000-4000-8000-000000000088",
                ownerId: API_OWNER_ID,
                projectId: API_PROJECT_ID,
                task: { kind: "run", id: API_RUN_ID },
                anchorSequence: 4,
                author: { id: API_PRINCIPAL_ID, kind: "person", displayName: "Bob Li" },
                recipient: {
                  id: "00000000-0000-4000-8000-000000000077",
                  kind: "person",
                  displayName: "Alice",
                },
                body: "Carry this moment forward.",
                createdAt: API_TIMESTAMP,
                acknowledgedAt: null,
              },
            },
            { status: 201 },
          );
        }
        if (
          request.method === "POST" &&
          url.pathname ===
            `/projects/${API_PROJECT_ID}/relays/00000000-0000-4000-8000-000000000088/acknowledge`
        ) {
          return Response.json({
            relay: {
              id: "00000000-0000-4000-8000-000000000088",
              ownerId: API_OWNER_ID,
              projectId: API_PROJECT_ID,
              task: { kind: "run", id: API_RUN_ID },
              anchorSequence: 4,
              author: { id: API_PRINCIPAL_ID, kind: "person", displayName: "Bob Li" },
              recipient: {
                id: "00000000-0000-4000-8000-000000000077",
                kind: "person",
                displayName: "Alice",
              },
              body: "Carry this moment forward.",
              createdAt: API_TIMESTAMP,
              acknowledgedAt: API_TIMESTAMP,
            },
          });
        }
        if (request.method === "POST" && url.pathname === `/projects/${API_PROJECT_ID}/annotations`) {
          return Response.json(
            {
              annotation: {
                id: "00000000-0000-4000-8000-000000000066",
                ownerId: API_OWNER_ID,
                projectId: API_PROJECT_ID,
                task: { kind: "run", id: API_RUN_ID },
                anchor: {
                  sequence: 4,
                  blockId: "event.4",
                  startOffset: 0,
                  endOffset: 5,
                  quote: "token",
                  prefix: "",
                  suffix: " race",
                  contentDigest: "a".repeat(64),
                },
                author: { id: API_PRINCIPAL_ID, kind: "person", displayName: "Bob Li" },
                body: "Keep this exact invariant visible.",
                createdAt: API_TIMESTAMP,
                resolvedAt: null,
                resolvedBy: null,
              },
            },
            { status: 201 },
          );
        }
        if (
          request.method === "POST" &&
          url.pathname ===
            `/projects/${API_PROJECT_ID}/annotations/00000000-0000-4000-8000-000000000066/resolve`
        ) {
          return Response.json({
            annotation: {
              id: "00000000-0000-4000-8000-000000000066",
              ownerId: API_OWNER_ID,
              projectId: API_PROJECT_ID,
              task: { kind: "run", id: API_RUN_ID },
              anchor: {
                sequence: 4,
                blockId: "event.4",
                startOffset: 0,
                endOffset: 5,
                quote: "token",
                prefix: "",
                suffix: " race",
                contentDigest: "a".repeat(64),
              },
              author: { id: API_PRINCIPAL_ID, kind: "person", displayName: "Bob Li" },
              body: "Keep this exact invariant visible.",
              createdAt: API_TIMESTAMP,
              resolvedAt: API_TIMESTAMP,
              resolvedBy: { id: API_PRINCIPAL_ID, kind: "person", displayName: "Bob Li" },
            },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    const teamAssets = mkdtempSync(join(tmpdir(), "board-team-assets-"));
    writeFileSync(join(teamAssets, "index.html"), "<!doctype html><div id=root></div>");
    const team = new BoardServer({ baseUrl: upstream.url.origin, assetsDir: teamAssets, port: 0 });
    const teamBase = team.start().url;
    try {
      expect(
        (
          await fetch(`${teamBase}/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ apiKey: `mwk_${"c".repeat(12)}_${"d".repeat(43)}` }),
          })
        ).status,
      ).toBe(403);
      const login = await fetch(`${teamBase}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: teamBase },
        body: JSON.stringify({ apiKey: `mwk_${"c".repeat(12)}_${"d".repeat(43)}` }),
      });
      expect(login.status).toBe(201);
      const cookie = login.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      const sessionCookie = cookie.split(";", 1)[0] ?? "";
      const onboarding = await fetch(`${teamBase}/onboarding`, {
        headers: { Cookie: sessionCookie },
      });
      expect(onboarding.status).toBe(200);
      expect(await onboarding.json()).toMatchObject({
        repositoryBindings: [{ repositoryFullName: "kohoz/meanwhile", private: true }],
        agentConnections: [{ agentType: "demo" }],
      });
      expect(
        (
          await fetch(`${teamBase}/onboarding/agent-connections`, {
            method: "POST",
            headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
            body: JSON.stringify({ agentType: "demo" }),
          })
        ).status,
      ).toBe(403);
      const onboardingHeaders = {
        Cookie: sessionCookie,
        "Content-Type": "application/json",
        Origin: teamBase,
      };
      expect(
        (
          await fetch(`${teamBase}/onboarding/agent-connections`, {
            method: "POST",
            headers: onboardingHeaders,
            body: JSON.stringify({ agentType: "demo" }),
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await fetch(`${teamBase}/onboarding/projects`, {
            method: "POST",
            headers: onboardingHeaders,
            body: JSON.stringify({ grantId }),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${teamBase}/onboarding/projects/${API_PROJECT_ID}/selection`, {
            method: "PUT",
            headers: onboardingHeaders,
            body: JSON.stringify({ selected: true }),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${teamBase}/onboarding/projects/${API_PROJECT_ID}/repository`, {
            method: "PUT",
            headers: onboardingHeaders,
            body: JSON.stringify({ grantId }),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${teamBase}/onboarding/agent-connections/${connectionId}`, {
            method: "DELETE",
            headers: { Cookie: sessionCookie, Origin: teamBase },
          })
        ).status,
      ).toBe(200);
      expect(onboardingWrites).toEqual([
        { method: "POST", path: "/onboarding/agent-connections", body: { agentType: "demo" } },
        { method: "POST", path: "/onboarding/projects", body: { grantId } },
        {
          method: "PUT",
          path: `/onboarding/projects/${API_PROJECT_ID}/selection`,
          body: { selected: true },
        },
        {
          method: "PUT",
          path: `/onboarding/projects/${API_PROJECT_ID}/repository`,
          body: { grantId },
        },
        { method: "DELETE", path: `/onboarding/agent-connections/${connectionId}`, body: null },
      ]);
      const presence = await fetch(
        `${teamBase}/projects/${API_PROJECT_ID}/presence/${presenceClientId}`,
        { method: "PUT", headers: { Cookie: sessionCookie, Origin: teamBase } },
      );
      expect(presence.status).toBe(200);
      expect(await presence.json()).toMatchObject({
        lease: { clientId: presenceClientId, principal: { displayName: "Bob Li" } },
      });
      const board = await fetch(`${teamBase}/board`, { headers: { Cookie: cookie.split(";", 1)[0] ?? "" } });
      expect(board.status).toBe(200);
      expect(await board.json()).toMatchObject({
        principal: { displayName: "Bob Li" },
        project: { name: "Project Northstar" },
        presence: [{ clientId: presenceClientId }],
        rows: [{ title: "Audit the migration plan", delegatedBy: { displayName: "Bob Li" } }],
      });
      const lobby = await fetch(`${teamBase}/lobby`, {
        headers: { Cookie: cookie.split(";", 1)[0] ?? "" },
      });
      expect(lobby.status).toBe(200);
      expect(await lobby.json()).toMatchObject({
        principal: { displayName: "Bob Li" },
        spaces: [
          {
            source: { provider: "github", accountName: "kohoz" },
            tables: [
              {
                project: { name: "Project Northstar" },
                access: "participate",
                accessSource: "membership",
                work: { total: 1, active: 1, attention: 0 },
                pendingRelayCount: 0,
              },
            ],
          },
        ],
      });
      const delegated = await fetch(`${teamBase}/projects/${API_PROJECT_ID}/runs`, {
        method: "POST",
        headers: {
          Cookie: cookie.split(";", 1)[0] ?? "",
          "Content-Type": "application/json",
          Origin: teamBase,
        },
        body: JSON.stringify({
          prompt: "Audit the first-task journey",
          repositoryUrl: "https://github.com/untrusted/browser-input",
          revision: "main",
          agentType: "demo",
          idempotencyKey: "board-first-task",
        }),
      });
      expect(delegated.status).toBe(201);
      expect(await delegated.json()).toMatchObject({ run: { id: API_RUN_ID } });
      expect(runRequests[0]).toMatchObject({
        projectId: API_PROJECT_ID,
        agentType: "demo",
        prompt: "Audit the first-task journey",
        workspace: {
          type: "repository",
          url: "https://github.com/kohoz/meanwhile",
          revision: "main",
        },
      });
      const cancelled = await fetch(`${teamBase}/task/run/${API_RUN_ID}/cancel`, {
        method: "POST",
        headers: { Cookie: cookie.split(";", 1)[0] ?? "", Origin: teamBase },
      });
      expect(cancelled.status).toBe(202);
      expect(await cancelled.json()).toMatchObject({ run: { status: "cancelled" } });
      const relay = await fetch(`${teamBase}/projects/${API_PROJECT_ID}/relays`, {
        method: "POST",
        headers: {
          Cookie: cookie.split(";", 1)[0] ?? "",
          "Content-Type": "application/json",
          Origin: teamBase,
        },
        body: JSON.stringify({
          task: { kind: "run", id: API_RUN_ID },
          anchorSequence: 4,
          recipientPrincipalId: "00000000-0000-4000-8000-000000000077",
          body: "Carry this moment forward.",
        }),
      });
      expect(relay.status).toBe(201);
      const acknowledged = await fetch(
        `${teamBase}/projects/${API_PROJECT_ID}/relays/00000000-0000-4000-8000-000000000088/acknowledge`,
        {
          method: "POST",
          headers: { Cookie: cookie.split(";", 1)[0] ?? "", Origin: teamBase },
        },
      );
      expect(acknowledged.status).toBe(200);
      const annotation = await fetch(`${teamBase}/projects/${API_PROJECT_ID}/annotations`, {
        method: "POST",
        headers: {
          Cookie: cookie.split(";", 1)[0] ?? "",
          "Content-Type": "application/json",
          Origin: teamBase,
        },
        body: JSON.stringify({
          task: { kind: "run", id: API_RUN_ID },
          anchor: {
            sequence: 4,
            blockId: "event.4",
            startOffset: 0,
            endOffset: 5,
            quote: "token",
            prefix: "",
            suffix: " race",
            contentDigest: "a".repeat(64),
          },
          body: "Keep this exact invariant visible.",
        }),
      });
      expect(annotation.status).toBe(201);
      const annotations = await fetch(
        `${teamBase}/task/run/${API_RUN_ID}/annotations?projectId=${API_PROJECT_ID}`,
        { headers: { Cookie: cookie.split(";", 1)[0] ?? "" } },
      );
      expect(annotations.status).toBe(200);
      expect(await annotations.json()).toEqual({ annotations: [] });
      const resolved = await fetch(
        `${teamBase}/projects/${API_PROJECT_ID}/annotations/00000000-0000-4000-8000-000000000066/resolve`,
        {
          method: "POST",
          headers: { Cookie: cookie.split(";", 1)[0] ?? "", Origin: teamBase },
        },
      );
      expect(resolved.status).toBe(200);
      expect(
        (
          await fetch(`${teamBase}/projects/${API_PROJECT_ID}/presence/${presenceClientId}`, {
            method: "DELETE",
            headers: { Cookie: sessionCookie, Origin: teamBase },
          })
        ).status,
      ).toBe(204);
      expect(authorizations[0]).toStartWith("Bearer mwk_");
      expect(authorizations.slice(1).length).toBeGreaterThanOrEqual(15);
      expect(
        authorizations
          .slice(1)
          .every((authorization) => authorization === `Session mws_${"a".repeat(12)}_${"b".repeat(43)}`),
      ).toBe(true);
    } finally {
      await team.stop();
      await upstream.stop(true);
      rmSync(teamAssets, { recursive: true, force: true });
    }
  });
});
