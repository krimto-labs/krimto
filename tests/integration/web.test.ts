// Integration tests for the /ui web surface (Task 4 — web-UI increment).
// Tests login, browse/search, fact detail, key management, and XSS escaping.

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
import { type Membership } from "../../src/access/membership";
import { buildHttpApp } from "../../src/server/http";
import { krimtoWrite, type ToolContext } from "../../src/server/tools";

// Membership: alice@x.com is an org admin (reads org/* scope) and member of "alpha" team.
// bob@x.com is a member of "beta" team only — his team/beta facts are unreadable by alice.
const membership: Membership = {
  org: { slug: "acme", admins: ["alice@x.com"] },
  teams: [
    { slug: "alpha", members: ["alice@x.com"], leads: [] },
    { slug: "beta", members: ["bob@x.com"], leads: [] },
  ],
  users: [],
};

let root: string;
let server: Server;
let port: number;
let aliceKey: string;
let readableId: string;
let unreadableId: string;
let xssId: string;
let keys: ApiKeyStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-web-"));
  keys = new ApiKeyStore(path.join(root, "keys.json"));
  aliceKey = (await keys.issue("alice@x.com", "live", "alice-initial")).key;

  const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
  const index = new FactIndex(db);
  const store = new FactStore(root);
  const writeQueue = new Serializer();

  // Write context for alice (org admin — can write to org/ and user/alice@x.com)
  const aliceCtx: ToolContext = {
    store, index, writeQueue, membership,
    requester: { identity: "alice@x.com", teams: ["alpha"] },
  };
  // Write context for bob (beta team member — can write to team/beta)
  const bobCtx: ToolContext = {
    store, index, writeQueue, membership,
    requester: { identity: "bob@x.com", teams: ["beta"] },
  };

  // Readable fact: alice writes to user/alice@x.com — alice can always read her own scope
  const r = await krimtoWrite(aliceCtx, {
    scope: "user/alice@x.com",
    title: "Zephyr deploy process",
    body: "Run pnpm deploy:staging before promoting to prod.",
    tags: ["deploy"],
    source: "wiki",
  });
  readableId = r.id;

  // Unreadable fact: bob writes to team/beta — alice is NOT a beta member
  const u = await krimtoWrite(bobCtx, {
    scope: "team/beta",
    title: "Beta secret config",
    body: "Bob's private config notes.",
  });
  unreadableId = u.id;

  // XSS fact: alice writes a fact with an XSS title in her own scope
  const x = await krimtoWrite(aliceCtx, {
    scope: "user/alice@x.com",
    title: "<script>alert(1)</script>",
    body: "XSS test body content with xss-marker term.",
  });
  xssId = x.id;

  const baseCtx: ToolContext = {
    store, index, writeQueue, membership,
    requester: { identity: "unused", teams: [] },
  };

  const app = buildHttpApp({
    ctx: baseCtx,
    keys,
    membership: () => membership,
    db,
    index,
    version: "0.2.0",
    startedAt: Date.now(),
    isBuilding: () => false,
    gitRemoteStatus: () => "none",
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

describe("/ui web surface", () => {
  // 1. Unauthenticated redirect
  it("GET /ui/facts without a cookie redirects to /ui/login", async () => {
    const res = await fetch(`${base()}/ui/facts`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/ui/login");
  });

  // 2. Login with bad key → 401, no set-cookie
  it("POST /ui/login with a bad key returns 401 and no set-cookie", async () => {
    const res = await fetch(`${base()}/ui/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ key: "bad" }).toString(),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  // 3. Login with real key → 302 + set-cookie
  it("POST /ui/login with alice's key returns 302 and sets krimto_session cookie", async () => {
    const res = await fetch(`${base()}/ui/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ key: aliceKey }).toString(),
    });
    expect(res.status).toBe(302);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain("krimto_session=");
    // location goes to /ui/facts
    expect(res.headers.get("location")).toContain("/ui/facts");
  });

  // Helper: log in and return the raw cookie value (name=value before first ";")
  async function loginAndGetCookie(): Promise<string> {
    const res = await fetch(`${base()}/ui/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ key: aliceKey }).toString(),
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    // "krimto_session=<value>; Path=/; ..."  → we need "krimto_session=<value>"
    const cookiePair = setCookie.split(";")[0]!.trim();
    return cookiePair; // e.g. "krimto_session=abc.xyz"
  }

  // 4. Search returns readable fact, not unreadable
  it("GET /ui/facts?q=<term> returns readable fact title but not unreadable one", async () => {
    const cookie = await loginAndGetCookie();
    const res = await fetch(`${base()}/ui/facts?q=deploy`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Zephyr deploy process");
    expect(body).not.toContain("Beta secret config");
  });

  // 5. Fact detail — readable returns 200, unreadable returns 404
  it("GET /ui/facts/:id returns 200 for readable, 404 for unreadable", async () => {
    const cookie = await loginAndGetCookie();

    const readableRes = await fetch(`${base()}/ui/facts/${readableId}`, {
      headers: { cookie },
    });
    expect(readableRes.status).toBe(200);
    const readableBody = await readableRes.text();
    expect(readableBody).toContain("Zephyr deploy process");

    const unreadableRes = await fetch(`${base()}/ui/facts/${unreadableId}`, {
      headers: { cookie },
    });
    expect(unreadableRes.status).toBe(404);
  });

  // 6. Key management: issue, revoke
  it("POST /ui/keys issues a new key shown once; POST /ui/keys/revoke revokes it", async () => {
    const cookie = await loginAndGetCookie();

    // Issue a new key
    const issueRes = await fetch(`${base()}/ui/keys`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ label: "ui-made" }).toString(),
    });
    expect(issueRes.status).toBe(200);
    const issueBody = await issueRes.text();
    expect(issueBody).toContain("krm_live_");

    // Extract the key from the <pre> block
    const preMatch = /<pre>(krm_live_[^<]+)<\/pre>/.exec(issueBody);
    expect(preMatch).toBeTruthy();
    const capturedKey = preMatch![1]!.trim();
    expect(capturedKey).toMatch(/^krm_live_/);

    // Find its hash via keys.list()
    const allKeys = await keys.list();
    const record = allKeys.find((k) => k.identity === "alice@x.com" && k.label === "ui-made");
    expect(record).toBeTruthy();
    const hash = record!.hash;

    // Revoke via the UI
    const revokeRes = await fetch(`${base()}/ui/keys/revoke`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ hash }).toString(),
    });
    expect(revokeRes.status).toBe(302);
    expect(revokeRes.headers.get("location")).toContain("/ui/keys");

    // Verify the key is gone
    const resolved = await keys.resolveIdentity(capturedKey);
    expect(resolved).toBeNull();
  });

  // 8. Last-key guard: cannot revoke your only remaining key (BUG-1)
  it("POST /ui/keys/revoke refuses to revoke the caller's only key", async () => {
    const cookie = await loginAndGetCookie();
    const mine = (await keys.list()).filter((k) => k.identity === "alice@x.com");
    expect(mine.length).toBe(1); // only alice-initial
    const hash = mine[0]!.hash;
    const res = await fetch(`${base()}/ui/keys/revoke`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ hash }).toString(),
    });
    expect(res.status).toBe(409); // refused, not redirected
    expect(await keys.resolveIdentity(aliceKey)).toBe("alice@x.com"); // key still works
  });

  // 7. XSS escaping: title with <script>alert(1)</script> is escaped in search results
  it("XSS: fact titles are HTML-escaped and raw script tags never appear in output", async () => {
    const cookie = await loginAndGetCookie();

    // Search for the XSS fact by a term in its body (xss-marker)
    const res = await fetch(`${base()}/ui/facts?q=xss-marker`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.text();

    // The escaped version must appear
    expect(body).toContain("&lt;script&gt;");
    // The raw tag must NOT appear
    expect(body).not.toContain("<script>alert(1)");

    // Also verify via the fact detail page
    const detailRes = await fetch(`${base()}/ui/facts/${xssId}`, {
      headers: { cookie },
    });
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.text();
    expect(detailBody).toContain("&lt;script&gt;");
    expect(detailBody).not.toContain("<script>alert(1)");
  });
});
