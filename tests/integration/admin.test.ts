// Integration tests for the admin-only membership/key API (BUG-5).
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
import { loadMembership, type Membership } from "../../src/access/membership";
import { addUser, setOrgAdmin } from "../../src/access/membershipStore";
import { buildHttpApp } from "../../src/server/http";
import { type ToolContext } from "../../src/server/tools";

let root: string;
let server: Server;
let port: number;
let keys: ApiKeyStore;
let aliceKey: string;
let carolKey: string;
let membership: Membership;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-admin-"));
  await setOrgAdmin(root, "alice@x.com", true); // alice = org admin
  await addUser(root, "carol@x.com"); // carol = non-admin member
  membership = await loadMembership(root);
  keys = new ApiKeyStore(path.join(root, "keys.json"));
  aliceKey = (await keys.issue("alice@x.com")).key;
  carolKey = (await keys.issue("carol@x.com")).key;

  const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
  const index = new FactIndex(db);
  const ctx: ToolContext = {
    store: new FactStore(root),
    index,
    writeQueue: new Serializer(),
    membership,
    requester: { identity: "unused", teams: [] },
  };
  const admin = {
    dataDir: root,
    keys,
    membership: () => membership,
    applyChange: async (mutate: () => Promise<void>) => {
      await mutate();
      membership = await loadMembership(root); // reflect the change for subsequent reads
    },
  };
  const app = buildHttpApp({
    ctx,
    keys,
    membership: () => membership,
    db,
    index,
    version: "0.2.2",
    startedAt: Date.now(),
    isBuilding: () => false,
    gitRemoteStatus: () => "none",
    admin,
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
const hdr = (key: string): Record<string, string> => ({
  authorization: `Bearer ${key}`,
  "content-type": "application/json",
});

describe("admin API (/admin)", () => {
  it("requires org admin: non-admin → 403, admin → 200", async () => {
    expect((await fetch(`${base()}/admin/members`, { headers: hdr(carolKey) })).status).toBe(403);
    expect((await fetch(`${base()}/admin/members`, { headers: hdr(aliceKey) })).status).toBe(200);
  });

  it("adds a member and issues a resolvable key (invite, no restart)", async () => {
    const add = await fetch(`${base()}/admin/members`, {
      method: "POST",
      headers: hdr(aliceKey),
      body: JSON.stringify({ email: "dan@x.com", team: "payments" }),
    });
    expect(add.status).toBe(201);
    const listed = (await (await fetch(`${base()}/admin/members`, { headers: hdr(aliceKey) })).json()) as {
      users: { email: string }[];
    };
    expect(listed.users.map((u) => u.email)).toContain("dan@x.com");

    const issued = await fetch(`${base()}/admin/keys`, {
      method: "POST",
      headers: hdr(aliceKey),
      body: JSON.stringify({ email: "dan@x.com" }),
    });
    expect(issued.status).toBe(201);
    const { key } = (await issued.json()) as { key: string };
    expect(await keys.resolveIdentity(key)).toBe("dan@x.com");
  });

  it("refuses to revoke a user's only key (409) and to remove the last org admin (409)", async () => {
    const danKey = (await keys.issue("dan@x.com")).key;
    const rec = (await keys.list()).find((k) => k.identity === "dan@x.com");
    const revoke = await fetch(`${base()}/admin/keys/${rec!.hash}`, { method: "DELETE", headers: hdr(aliceKey) });
    expect(revoke.status).toBe(409);
    expect(await keys.resolveIdentity(danKey)).toBe("dan@x.com");

    const removeAdmin = await fetch(`${base()}/admin/members/alice@x.com`, { method: "DELETE", headers: hdr(aliceKey) });
    expect(removeAdmin.status).toBe(409);
  });

  it("non-admin cannot mutate", async () => {
    const r = await fetch(`${base()}/admin/members`, {
      method: "POST",
      headers: hdr(carolKey),
      body: JSON.stringify({ email: "eve@x.com" }),
    });
    expect(r.status).toBe(403);
  });
});

async function loginCookie(key: string): Promise<string> {
  const res = await fetch(`${base()}/ui/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key }).toString(),
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!.trim();
}

describe("/ui/admin", () => {
  it("non-admin gets 403; admin sees the member list + add form", async () => {
    const carol = await loginCookie(carolKey);
    expect((await fetch(`${base()}/ui/admin`, { headers: { cookie: carol } })).status).toBe(403);

    const alice = await loginCookie(aliceKey);
    const res = await fetch(`${base()}/ui/admin`, { headers: { cookie: alice } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Add member");
    expect(body).toContain("carol@x.com");
  });

  it("admin adds a member via the form", async () => {
    const alice = await loginCookie(aliceKey);
    const add = await fetch(`${base()}/ui/admin/members`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: alice, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "frank@x.com", team: "ops" }).toString(),
    });
    expect(add.status).toBe(302);
    const listed = (await (await fetch(`${base()}/admin/members`, { headers: hdr(aliceKey) })).json()) as {
      users: { email: string }[];
    };
    expect(listed.users.map((u) => u.email)).toContain("frank@x.com");
  });

  it("escapes member emails on the admin page", async () => {
    await fetch(`${base()}/admin/members`, {
      method: "POST",
      headers: hdr(aliceKey),
      body: JSON.stringify({ email: "<script>x</script>@x.com" }),
    });
    const alice = await loginCookie(aliceKey);
    const body = await (await fetch(`${base()}/ui/admin`, { headers: { cookie: alice } })).text();
    expect(body).toContain("&lt;script&gt;");
    expect(body).not.toContain("<script>x</script>");
  });
});
