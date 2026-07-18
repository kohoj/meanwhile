import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardServer } from "../src/server";

// The board is structurally read-only; these tests pin that boundary without a
// live control plane, because the method/route guards answer before any upstream
// call is made.
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

describe("read-only boundary", () => {
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
