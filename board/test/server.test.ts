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
      for (const path of ["/board", "/", "/anything"]) {
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
  });
});

describe("team browser session", () => {
  test("exchanges an API key once and uses only the opaque session for Project reads", async () => {
    const authorizations: string[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
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
        if (url.pathname === `/projects/${API_PROJECT_ID}/members`) {
          return Response.json({
            items: [
              {
                projectId: API_PROJECT_ID,
                principal: { id: API_PRINCIPAL_ID, kind: "person", displayName: "Bob Li" },
                role: "member",
                joinedAt: API_TIMESTAMP,
              },
            ],
          });
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
        return new Response("Not Found", { status: 404 });
      },
    });
    const teamAssets = mkdtempSync(join(tmpdir(), "board-team-assets-"));
    writeFileSync(join(teamAssets, "index.html"), "<!doctype html><div id=root></div>");
    const team = new BoardServer({ baseUrl: upstream.url.origin, assetsDir: teamAssets, port: 0 });
    const teamBase = team.start().url;
    try {
      const login = await fetch(`${teamBase}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: `mwk_${"c".repeat(12)}_${"d".repeat(43)}` }),
      });
      expect(login.status).toBe(201);
      const cookie = login.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      const board = await fetch(`${teamBase}/board`, { headers: { Cookie: cookie.split(";", 1)[0] ?? "" } });
      expect(board.status).toBe(200);
      expect(await board.json()).toMatchObject({
        principal: { displayName: "Bob Li" },
        project: { name: "Project Northstar" },
        rows: [{ title: "Audit the migration plan", delegatedBy: { displayName: "Bob Li" } }],
      });
      expect(authorizations[0]).toStartWith("Bearer mwk_");
      expect(authorizations.slice(1)).toEqual([
        `Session mws_${"a".repeat(12)}_${"b".repeat(43)}`,
        `Session mws_${"a".repeat(12)}_${"b".repeat(43)}`,
        `Session mws_${"a".repeat(12)}_${"b".repeat(43)}`,
      ]);
    } finally {
      await team.stop();
      await upstream.stop(true);
      rmSync(teamAssets, { recursive: true, force: true });
    }
  });
});
