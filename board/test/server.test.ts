import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API_OWNER_ID,
  API_RUN_ID,
  API_SESSION_ID,
  API_TIMESTAMP,
  apiRun,
  apiSession,
  apiTurn,
} from "../../test/fixtures/api";
import { BoardServer } from "../src/server";

// Existing task lifecycle is structurally read-only. These tests pin the route
// guard without a live control plane; the two allowed writes create new task or
// brief intent and are tested through the root integration surface.
let server: BoardServer;
let base: string;

beforeAll(() => {
  const assets = mkdtempSync(join(tmpdir(), "board-assets-"));
  writeFileSync(join(assets, "index.html"), "<!doctype html><div id=root></div>");
  server = new BoardServer({
    baseUrl: "http://127.0.0.1:59999", // intentionally no live upstream
    apiKey: "mwk_test_key_only_for_route_guards_000",
    assetsDir: assets,
    port: 0,
  });
  base = server.start().url;
});

afterAll(async () => {
  await server.stop();
});

describe("task-lifecycle boundary", () => {
  test("mutating methods are rejected everywhere", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of ["/board", "/stream", "/", "/anything"]) {
        const res = await fetch(`${base}${path}`, { method });
        expect(res.status).toBe(405);
      }
    }
  });

  test("serves the SPA shell on GET /", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("ships defensive headers on every response", async () => {
    const res = await fetch(`${base}/`);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  test("rejects path traversal in asset names", async () => {
    const res = await fetch(`${base}/..%2f..%2fpackage.json`);
    // Either a 404 or the SPA fallback, never the traversed file.
    const body = await res.text();
    expect(body).not.toContain("dependencies");
  });
});

describe("new-intent boundary", () => {
  test("forwards selected briefs into a new run and promotes immutable output", async () => {
    const briefId = "b".repeat(64);
    const artifactId = "a".repeat(64);
    const brief = {
      id: briefId,
      ownerId: API_OWNER_ID,
      title: "Authentication findings",
      artifactId,
      sourceRunId: API_RUN_ID,
      sourceWorkspace: { type: "bundle" as const, artifactId: "d".repeat(64) },
      path: "findings.md",
      digest: "c".repeat(64),
      mediaType: "text/markdown; charset=utf-8",
      byteSize: 42,
      createdAt: API_TIMESTAMP,
    };
    const upstreamBodies: unknown[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "POST") upstreamBodies.push(await request.json());
        if (url.pathname === "/runs") return Response.json({ run: apiRun() }, { status: 201 });
        if (url.pathname === "/sessions") {
          return Response.json({ session: apiSession("queued") }, { status: 201 });
        }
        if (url.pathname === `/sessions/${API_SESSION_ID}/turns`) {
          return Response.json({ turn: apiTurn() }, { status: 201 });
        }
        if (url.pathname === "/briefs" && request.method === "POST") {
          return Response.json({ brief }, { status: 201 });
        }
        if (url.pathname === "/briefs") {
          return Response.json({ items: [brief], nextCursor: null });
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    const assets = mkdtempSync(join(tmpdir(), "board-intent-assets-"));
    writeFileSync(join(assets, "index.html"), "<!doctype html><div id=root></div>");
    const intentServer = new BoardServer({
      baseUrl: upstream.url.origin,
      apiKey: "test-key",
      assetsDir: assets,
      port: 0,
    });
    const intentBase = intentServer.start().url;

    try {
      const delegated = await fetch(`${intentBase}/delegate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "run",
          agentType: "demo",
          prompt: "Use the accepted finding",
          briefIds: [briefId],
        }),
      });
      expect(delegated.status).toBe(201);
      expect(upstreamBodies[0]).toMatchObject({ briefIds: [briefId] });

      const promoted = await fetch(`${intentBase}/briefs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: brief.title,
          artifactId: brief.artifactId,
          path: brief.path,
        }),
      });
      expect(promoted.status).toBe(201);
      expect(upstreamBodies[1]).toEqual({
        title: brief.title,
        artifactId: brief.artifactId,
        path: brief.path,
      });

      const delegatedSession = await fetch(`${intentBase}/delegate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "session",
          agentType: "demo",
          prompt: "Continue with the accepted finding",
          briefIds: [briefId],
        }),
      });
      expect(delegatedSession.status).toBe(201);
      expect(upstreamBodies[3]).toMatchObject({ briefIds: [briefId] });

      const listed = await fetch(`${intentBase}/briefs`);
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({ items: [brief], nextCursor: null });
    } finally {
      await intentServer.stop();
      await upstream.stop(true);
      rmSync(assets, { recursive: true, force: true });
    }
  });
});
