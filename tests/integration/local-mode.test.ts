// Local mode (no auth): the documented Stage-2 trial — connect with no key, no login.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";

import { FactStore } from "../../src/storage/store";
import { openIndexDb } from "../../src/index/db";
import { FactIndex } from "../../src/index/factIndex";
import { Serializer } from "../../src/index/serialize";
import { ApiKeyStore } from "../../src/access/auth";
import { emptyMembership, type Membership } from "../../src/access/membership";
import { buildHttpApp } from "../../src/server/http";
import { type ToolContext } from "../../src/server/tools";

let root: string;
let server: Server;
let port: number;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-local-"));
  const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
  const index = new FactIndex(db);
  const membership: Membership = emptyMembership("acme");
  const ctx: ToolContext = {
    store: new FactStore(root),
    index,
    writeQueue: new Serializer(),
    membership,
    requester: { identity: "you@local", teams: [] },
  };
  const app = buildHttpApp({
    ctx,
    keys: new ApiKeyStore(path.join(root, "keys.json")),
    membership: () => membership,
    db,
    index,
    version: "0.2.3",
    startedAt: Date.now(),
    isBuilding: () => false,
    gitRemoteStatus: () => "none",
    requireAuth: false,
  });
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  port = (server.address() as { port: number }).port;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await fs.rm(root, { recursive: true, force: true });
});

const base = (): string => `http://localhost:${port}`;

describe("local mode (no auth)", () => {
  it("POST /mcp works with no bearer token", async () => {
    const r = await fetch(`${base()}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).not.toBe(401); // would be 401 in team mode
  });

  it("GET /ui/facts shows the dashboard with no login redirect", async () => {
    const r = await fetch(`${base()}/ui/facts`, { redirect: "manual" });
    expect(r.status).toBe(200);
  });

  it("GET / redirects to /ui", async () => {
    const r = await fetch(`${base()}/`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("/ui");
  });

  it("/admin is not mounted in local mode", async () => {
    const r = await fetch(`${base()}/admin/members`, { redirect: "manual" });
    expect(r.status).toBe(404);
  });
});
