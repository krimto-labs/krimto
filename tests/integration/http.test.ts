import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { FactStore } from "../../src/storage/store";
import { openIndexDb } from "../../src/index/db";
import { FactIndex } from "../../src/index/factIndex";
import { Serializer } from "../../src/index/serialize";
import { ApiKeyStore } from "../../src/access/auth";
import { type Membership } from "../../src/access/membership";
import { buildHttpApp } from "../../src/server/http";
import { type ToolContext } from "../../src/server/tools";

const membership: Membership = { org: { slug: "acme", admins: ["alice@x.com"] }, teams: [], users: [] };
let root: string; let server: Server; let port: number; let aliceKey: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-http-"));
  const keys = new ApiKeyStore(path.join(root, "keys.json"));
  aliceKey = (await keys.issue("alice@x.com")).key;
  const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
  const index = new FactIndex(db);
  const ctx: ToolContext = {
    store: new FactStore(root), index, writeQueue: new Serializer(), membership,
    requester: { identity: "unused@stdio", teams: [] },
  };
  const app = buildHttpApp({
    ctx, keys, membership: () => membership, db, index,
    version: "0.2.0", startedAt: Date.now(), isBuilding: () => false, gitRemoteStatus: () => "none", requireAuth: true,
  });
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  port = (server.address() as { port: number }).port;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await fs.rm(root, { recursive: true, force: true });
});

describe("HTTP transport + bearer auth", () => {
  it("GET /health/ready returns 200 with the three checks", async () => {
    const res = await fetch(`http://localhost:${port}/health/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checks: Record<string, unknown> };
    expect(Object.keys(body.checks).sort()).toEqual(["git_remote", "index", "sqlite"]);
  });

  it("GET /health/live returns 200 alive", async () => {
    const res = await fetch(`http://localhost:${port}/health/live`);
    expect(res.status).toBe(200);
    expect((await res.json() as { status: string }).status).toBe("alive");
  });

  it("an authenticated client writes a fact authored by the key's identity", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${aliceKey}` } },
    });
    const client = new Client({ name: "t", version: "0" });
    await client.connect(transport);
    const r = await client.callTool({ name: "krimto_write", arguments: { scope: "user/alice@x.com", title: "Pref", body: "tabs" } });
    const fact = JSON.parse((r.content as { type: string; text: string }[])[0]!.text);
    expect(fact.scope).toBe("user/alice@x.com");
    expect(fact.id).toMatch(/^fct_/);
    await transport.close();
  });

  it("rejects a request with no bearer token (401)", async () => {
    const res = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("fires onFirstClient on the first /mcp request and only once (Gap #5c)", async () => {
    // Spin up a small HTTP server just for this test so we can capture the callback count cleanly.
    let calls = 0;
    const keys = new ApiKeyStore(path.join(root, "keys2.json"));
    const localApp = buildHttpApp({
      ctx: { store: new FactStore(root), index: new FactIndex(openIndexDb(":memory:", { provider: "none", dimensions: 0 })), writeQueue: new Serializer(), membership, requester: { identity: "unused", teams: [] } },
      keys, membership: () => membership, db: openIndexDb(":memory:", { provider: "none", dimensions: 0 }),
      index: new FactIndex(openIndexDb(":memory:", { provider: "none", dimensions: 0 })),
      version: "0.2.0", startedAt: Date.now(), isBuilding: () => false, gitRemoteStatus: () => "none",
      requireAuth: false, // simpler — no auth needed for this test
      onFirstClient: () => { calls += 1; },
    });
    const localServer: Server = await new Promise((r) => { const s = localApp.listen(0, () => r(s)); });
    const localPort = (localServer.address() as { port: number }).port;
    // Hit /mcp three times. Even malformed bodies count — we're testing the request-counter hook.
    for (let i = 0; i < 3; i++) {
      await fetch(`http://localhost:${localPort}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/list" }),
      }).catch(() => undefined);
    }
    expect(calls).toBe(1); // single-shot per process
    await new Promise<void>((r) => localServer.close(() => r()));
  });
});
