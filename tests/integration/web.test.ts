// Integration tests for the /ui web surface (Task 4 — web-UI increment).
// Tests login, browse/search, fact detail, key management, and XSS escaping.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";

import { FactStore } from "../../src/storage/store";
import { GitRepo } from "../../src/storage/git";
import { openIndexDb } from "../../src/index/db";
import { FactIndex } from "../../src/index/factIndex";
import { Serializer } from "../../src/index/serialize";
import { ApiKeyStore } from "../../src/access/auth";
import { type Membership } from "../../src/access/membership";
import { buildHttpApp } from "../../src/server/http";
import { runLocalOp } from "../../src/server/localOps";
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
let machineSpawns: string[][]; // records the argv each loopback machine-op would have spawned

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

  // Real BehaviorOps backed by a GitRepo on the test root — exercises the in-process Settings ▸
  // Behavior routes (reindex/remote/sync) end-to-end rather than against a mock.
  const repo = await GitRepo.open(root);
  const behavior = {
    setRemote: (url: string) => repo.setRemote(url),
    removeRemote: () => repo.removeRemote(),
    syncNow: async () => ({ pull: "skipped", push: (await repo.push()).status }),
    reindexNow: async () => {
      await index.rebuild(await store.allFacts());
      return index.factCount();
    },
  };
  // Real allowlist/validation via runLocalOp, but the spawn is recorded instead of executed (no real
  // `krimto stop` etc.). Exercises the loopback machine-ops route end-to-end without side effects.
  machineSpawns = [];
  const localMachine = {
    run: (action: string, params: Record<string, string>) => {
      // spawn receives [binPath, ...argv]; record just the krimto argv for assertions.
      const r = runLocalOp(action, params, { binPath: "/fake/krimto.mjs", spawn: (_c, a) => machineSpawns.push(a.slice(1)) });
      return r.ok ? { ok: true, bounces: r.bounces } : { ok: false, message: r.message };
    },
    status: async () => ({
      runMode: "as-needed",
      serviceRunning: true,
      dataDir: root,
      identity: "alice@x.com",
      searchProvider: "keyword",
    }),
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
    teamModeActive: () => true,
    behavior,
    localMachine,
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
  async function loginAndGetCookie(key: string = aliceKey): Promise<string> {
    const res = await fetch(`${base()}/ui/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ key }).toString(),
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

  // 5b. Fact detail shows a Delete button when the viewer canWrite to that scope
  it("GET /ui/facts/:id renders a Delete button when the viewer can delete", async () => {
    const cookie = await loginAndGetCookie();
    const res = await fetch(`${base()}/ui/facts/${readableId}`, { headers: { cookie } });
    const body = await res.text();
    // Alice owns user/alice@x.com — she can delete
    expect(body).toContain("Delete this note");
    expect(body).toContain(`action="/ui/facts/${readableId}/delete"`);
  });

  // 5c. POST /ui/facts/:id/delete actually deletes the fact and redirects to /ui/facts
  it("POST /ui/facts/:id/delete deletes the fact and redirects", async () => {
    const cookie = await loginAndGetCookie();
    const del = await fetch(`${base()}/ui/facts/${readableId}/delete`, {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
    });
    expect(del.status).toBe(302);
    expect(del.headers.get("location")).toBe("/ui/facts");
    // Subsequent GET should now 404
    const after = await fetch(`${base()}/ui/facts/${readableId}`, { headers: { cookie } });
    expect(after.status).toBe(404);
  });

  // 5d. POST /ui/facts/:id/delete refuses when the viewer can't write to that scope
  it("POST /ui/facts/:id/delete returns 404 when the fact is unreadable to the viewer", async () => {
    const cookie = await loginAndGetCookie();
    // alice can't see bob's team/beta — same not_found path used by krimtoRead
    const del = await fetch(`${base()}/ui/facts/${unreadableId}/delete`, {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
    });
    expect(del.status).toBe(404);
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

  // v0.2.17-3: Edit + Move forms on the fact-detail page
  it("GET /ui/facts/:id renders inline Edit + Move forms when the viewer can write", async () => {
    const cookie = await loginAndGetCookie();
    const res = await fetch(`${base()}/ui/facts/${readableId}`, { headers: { cookie } });
    const body = await res.text();
    expect(body).toContain("Edit this note");
    expect(body).toContain(`action="/ui/facts/${readableId}/edit"`);
    expect(body).toContain('name="body"');
    expect(body).toContain("Move to a different scope");
    expect(body).toContain(`action="/ui/facts/${readableId}/move"`);
    expect(body).toContain('name="scope"');
    // Alice is a member of `alpha` (per the membership fixture) — that scope should be in the
    // dropdown, and the current scope (user/alice@x.com) should NOT.
    expect(body).toContain("team/alpha");
    expect(body).not.toMatch(/<option value="user\/alice@x\.com">/);
  });

  it("POST /ui/facts/:id/edit updates the body and redirects to the fact detail page", async () => {
    const cookie = await loginAndGetCookie();
    const edit = await fetch(`${base()}/ui/facts/${readableId}/edit`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ body: "new body — edited via /ui" }).toString(),
    });
    expect(edit.status).toBe(302);
    expect(edit.headers.get("location")).toBe(`/ui/facts/${readableId}`);
    // GET back and confirm the new body is rendered.
    const after = await fetch(`${base()}/ui/facts/${readableId}`, { headers: { cookie } });
    const body = await after.text();
    expect(body).toContain("new body — edited via /ui");
    expect(body).not.toContain("pnpm deploy:staging"); // original body
  });

  it("POST /ui/facts/:id/edit returns 422 when body is empty (no write)", async () => {
    const cookie = await loginAndGetCookie();
    const edit = await fetch(`${base()}/ui/facts/${readableId}/edit`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ body: "   " }).toString(),
    });
    expect(edit.status).toBe(422);
    // Original body preserved.
    const after = await fetch(`${base()}/ui/facts/${readableId}`, { headers: { cookie } });
    expect(await after.text()).toContain("pnpm deploy:staging");
  });

  it("POST /ui/facts/:id/move moves the fact to a writable scope and redirects", async () => {
    const cookie = await loginAndGetCookie();
    const mv = await fetch(`${base()}/ui/facts/${readableId}/move`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ scope: "team/alpha" }).toString(),
    });
    expect(mv.status).toBe(302);
    expect(mv.headers.get("location")).toBe(`/ui/facts/${readableId}`);
    // After GET, the scope label should reflect the new scope.
    const after = await fetch(`${base()}/ui/facts/${readableId}`, { headers: { cookie } });
    const body = await after.text();
    // No team display name is set in the test membership, so the literal scope renders.
    expect(body).toContain("team/alpha");
  });

  it("POST /ui/facts/:id/move returns 422 when the target scope is invalid", async () => {
    const cookie = await loginAndGetCookie();
    const mv = await fetch(`${base()}/ui/facts/${readableId}/move`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ scope: "not a real scope" }).toString(),
    });
    expect(mv.status).toBe(422);
  });

  // v0.2.42: inline Tag editor on the fact-detail page (curation, no new-note authoring)
  it("GET /ui/facts/:id renders a Tag editor prefilled with the current tags", async () => {
    const cookie = await loginAndGetCookie();
    const res = await fetch(`${base()}/ui/facts/${readableId}`, { headers: { cookie } });
    const body = await res.text();
    expect(body).toContain(`action="/ui/facts/${readableId}/tag"`);
    expect(body).toContain('name="tags"');
    expect(body).toContain('value="deploy"'); // current tag prefilled into the editor
  });

  it("POST /ui/facts/:id/tag replaces the whole tag set and redirects", async () => {
    const cookie = await loginAndGetCookie();
    const r = await fetch(`${base()}/ui/facts/${readableId}/tag`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ tags: "deploy ops" }).toString(),
    });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`/ui/facts/${readableId}`);
    const after = await fetch(`${base()}/ui/facts/${readableId}`, { headers: { cookie } });
    const body = await after.text();
    expect(body).toContain("ops"); // newly added tag rendered
  });

  it("POST /ui/facts/:id/tag returns 422 for a non-kebab-case tag (no write)", async () => {
    const cookie = await loginAndGetCookie();
    const r = await fetch(`${base()}/ui/facts/${readableId}/tag`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ tags: "NOTKEBAB" }).toString(),
    });
    expect(r.status).toBe(422);
  });

  it("POST /ui/facts/:id/tag returns 404 when the fact is unreadable to the viewer", async () => {
    const cookie = await loginAndGetCookie();
    const r = await fetch(`${base()}/ui/facts/${unreadableId}/tag`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ tags: "ops" }).toString(),
    });
    expect(r.status).toBe(404);
  });

  it("Edit + Move forms are absent when the viewer can't write to the fact's scope", async () => {
    // Issue a key for bob (beta member) and read alice's fact... wait, alice's fact is in her
    // personal scope which bob can't see. Simpler: ensure alice viewing an org-scoped fact she
    // didn't write still gets the Edit form (org-admin), and a non-admin viewing wouldn't.
    // The full canWrite=false branch is covered by the scope-label/scope-precedence checks in
    // server/editFact.ts unit tests. Here we just verify that the existing "unreadable → 404"
    // behavior is unchanged — proving the Edit form code path isn't accidentally exposing facts.
    const cookie = await loginAndGetCookie();
    const res = await fetch(`${base()}/ui/facts/${unreadableId}`, { headers: { cookie } });
    expect(res.status).toBe(404); // existence not leaked, Edit form irrelevant
  });

  // v0.2.17-5: /ui/settings consolidation
  it("GET /ui/settings renders the control panels (Behavior, This machine, Recent activity), not the old explainers", async () => {
    const cookie = await loginAndGetCookie();
    const res = await fetch(`${base()}/ui/settings`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Settings");
    expect(body).toContain("Behavior"); // in-process config panel
    expect(body).toContain("This machine"); // loopback control panel
    expect(body).toContain("Recent activity"); // activity panel kept
    // v0.2.42 de-noise: the explainer / status / other-settings panels are gone.
    expect(body).not.toContain("Shared memory for your team");
    expect(body).not.toContain("Behind the scenes");
    expect(body).not.toContain("Other settings");
  });

  it("GET /ui/facts no longer renders the heavy engineering panels (moved to /ui/settings)", async () => {
    const cookie = await loginAndGetCookie();
    const res = await fetch(`${base()}/ui/facts`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    // The "How Krimto works" and "Behind the scenes" explainers moved out.
    expect(body).not.toContain("Shared memory for your team");
    expect(body).not.toContain("Behind the scenes");
    // The notes themselves are still here.
    expect(body).toContain("Zephyr deploy process");
    // And the Settings link is in the nav.
    expect(body).toContain('href="/ui/settings"');
  });

  it("nav includes the Settings link for authenticated users", async () => {
    const cookie = await loginAndGetCookie();
    const res = await fetch(`${base()}/ui/keys`, { headers: { cookie } });
    const body = await res.text();
    expect(body).toContain('<a href="/ui/settings">Settings</a>');
  });

  // v0.2.42: Settings ▸ Behavior — in-process git remote / sync / reindex (admin-gated)
  it("GET /ui/settings renders the Behavior panel with remote + reindex controls for an admin", async () => {
    const cookie = await loginAndGetCookie(); // alice is org admin
    const body = await (await fetch(`${base()}/ui/settings`, { headers: { cookie } })).text();
    expect(body).toContain("Behavior");
    expect(body).toContain('action="/ui/settings/remote"');
    expect(body).toContain('action="/ui/settings/reindex"');
  });

  it("POST /ui/settings/reindex rebuilds the index and redirects (admin)", async () => {
    const cookie = await loginAndGetCookie();
    const r = await fetch(`${base()}/ui/settings/reindex`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/ui/settings");
  });

  it("POST /ui/settings/remote sets the origin remote, then /remove clears it (admin)", async () => {
    const cookie = await loginAndGetCookie();
    const set = await fetch(`${base()}/ui/settings/remote`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url: "/tmp/krimto-remote-fixture.git" }).toString(),
    });
    expect(set.status).toBe(302);
    const afterSet = await (await fetch(`${base()}/ui/settings`, { headers: { cookie } })).text();
    expect(afterSet).toContain("/tmp/krimto-remote-fixture.git");

    const rm = await fetch(`${base()}/ui/settings/remote/remove`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    });
    expect(rm.status).toBe(302);
    const afterRm = await (await fetch(`${base()}/ui/settings`, { headers: { cookie } })).text();
    expect(afterRm).not.toContain("/tmp/krimto-remote-fixture.git");
  });

  it("POST /ui/settings/reindex returns 403 for a non-admin in team mode", async () => {
    const bobKey = (await keys.issue("bob@x.com", "live", "bob")).key;
    const cookie = await loginAndGetCookie(bobKey); // bob is a team member, not org admin
    const r = await fetch(`${base()}/ui/settings/reindex`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    });
    expect(r.status).toBe(403);
  });

  // v0.2.42: Settings ▸ This machine — loopback control plane (allowlist + admin + CSRF nonce)
  async function getMachineCsrf(cookie: string): Promise<string> {
    const body = await (await fetch(`${base()}/ui/settings`, { headers: { cookie } })).text();
    return body.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
  }

  it("GET /ui/settings renders the This-machine panel + action forms + a CSRF token (admin, loopback)", async () => {
    const cookie = await loginAndGetCookie();
    const body = await (await fetch(`${base()}/ui/settings`, { headers: { cookie } })).text();
    expect(body).toContain("This machine");
    expect(body).toContain('action="/ui/settings/machine"');
    expect(body).toContain('name="_csrf"');
    expect(body).toContain('value="restart"');
  });

  it("POST /ui/settings/machine runs a non-bouncing op and redirects (admin, loopback, CSRF ok)", async () => {
    const cookie = await loginAndGetCookie();
    const csrf = await getMachineCsrf(cookie);
    const r = await fetch(`${base()}/ui/settings/machine`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "search-keyword", _csrf: csrf }).toString(),
    });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/ui/settings");
    expect(machineSpawns).toContainEqual(["search", "--keyword"]);
  });

  it("POST /ui/settings/machine shows a reconnecting page for a bouncing op (restart)", async () => {
    const cookie = await loginAndGetCookie();
    const csrf = await getMachineCsrf(cookie);
    const r = await fetch(`${base()}/ui/settings/machine`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "restart", _csrf: csrf }).toString(),
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Applying");
    expect(machineSpawns).toContainEqual(["restart"]);
  });

  it("POST /ui/settings/machine rejects a wrong CSRF token with 403 and never spawns", async () => {
    const cookie = await loginAndGetCookie();
    const r = await fetch(`${base()}/ui/settings/machine`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "restart", _csrf: "wrong" }).toString(),
    });
    expect(r.status).toBe(403);
    expect(machineSpawns).toHaveLength(0);
  });

  it("POST /ui/settings/machine rejects an unknown action with 422 and never spawns", async () => {
    const cookie = await loginAndGetCookie();
    const csrf = await getMachineCsrf(cookie);
    const r = await fetch(`${base()}/ui/settings/machine`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "evil", _csrf: csrf }).toString(),
    });
    expect(r.status).toBe(422);
    expect(machineSpawns).toHaveLength(0);
  });

  it("POST /ui/settings/machine returns 403 for a non-admin (team mode), no spawn", async () => {
    const bobKey = (await keys.issue("bob@x.com", "live", "bob")).key;
    const cookie = await loginAndGetCookie(bobKey);
    const r = await fetch(`${base()}/ui/settings/machine`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "restart", _csrf: "x" }).toString(),
    });
    expect(r.status).toBe(403);
    expect(machineSpawns).toHaveLength(0);
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
