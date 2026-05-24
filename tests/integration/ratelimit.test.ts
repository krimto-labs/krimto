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
import { RateLimiter } from "../../src/server/ratelimit";
import { type Membership } from "../../src/access/membership";
import { buildHttpApp } from "../../src/server/http";
import { type ToolContext } from "../../src/server/tools";

const membership: Membership = { org: { slug: "acme", admins: [] }, teams: [], users: [] };
let root: string; let server: Server; let port: number; let key: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-rl-"));
  const keys = new ApiKeyStore(path.join(root, "keys.json"));
  key = (await keys.issue("alice@x.com")).key;
  const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
  const index = new FactIndex(db);
  const ctx: ToolContext = {
    store: new FactStore(root), index, writeQueue: new Serializer(), membership,
    requester: { identity: "unused", teams: [] },
  };
  const app = buildHttpApp({
    ctx, keys, membership: () => membership, db, index,
    version: "0.2.0", startedAt: Date.now(), isBuilding: () => false, gitRemoteStatus: () => "none",
    rateLimiter: new RateLimiter({ enabled: true, perKeyPerMinute: 2 }),
  });
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  port = (server.address() as { port: number }).port;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await fs.rm(root, { recursive: true, force: true });
});

async function hit(): Promise<Response> {
  return fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

describe("rate limiting (HTTP)", () => {
  it("allows up to the limit then returns 429 with Retry-After + headers", async () => {
    const r1 = await hit();
    const r2 = await hit();
    const r3 = await hit();
    expect(r1.status).not.toBe(429);
    expect(r2.status).not.toBe(429);
    expect(r3.status).toBe(429);
    expect(r3.headers.get("retry-after")).toBeTruthy();
    expect(r3.headers.get("x-ratelimit-limit")).toBe("2");
    expect(r3.headers.get("x-ratelimit-remaining")).toBe("0");
  });
});
