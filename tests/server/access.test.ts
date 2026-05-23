import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FactStore } from "../../src/storage/store";
import { openIndexDb } from "../../src/index/db";
import { FactIndex } from "../../src/index/factIndex";
import { Serializer } from "../../src/index/serialize";
import {
  krimtoListScopes,
  krimtoRead,
  krimtoRecall,
  krimtoWrite,
  type ToolContext,
} from "../../src/server/tools";
import { type Membership } from "../../src/access/membership";

const membership: Membership = {
  org: { slug: "acme", admins: ["admin@acme.com"] },
  teams: [
    { slug: "payments", members: ["alice@acme.com"], leads: [] },
    { slug: "infra", members: ["bob@acme.com"], leads: [] },
  ],
  users: [],
};

// Membership with admin@acme.com as the requester (for seeding org-scope facts).
const adminMembership: Membership = {
  org: { slug: "acme", admins: ["admin@acme.com"] },
  teams: [
    { slug: "payments", members: ["alice@acme.com"], leads: [] },
    { slug: "infra", members: ["bob@acme.com"], leads: [] },
  ],
  users: [],
};

let root: string;
let store: FactStore;
let index: FactIndex;
let writeQueue: Serializer;
let alice: ToolContext;
let bob: ToolContext;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-access-"));
  store = new FactStore(root);
  const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
  index = new FactIndex(db);
  writeQueue = new Serializer();
  alice = { store, index, writeQueue, membership, requester: { identity: "alice@acme.com", teams: ["payments"] } };
  bob = { store, index, writeQueue, membership, requester: { identity: "bob@acme.com", teams: ["infra"] } };
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("write access", () => {
  it("allows own user and own team, forbids other team and org for a non-admin", async () => {
    await expect(
      krimtoWrite(alice, { scope: "user/alice@acme.com", title: "Mine", body: "deploy with my flags" }),
    ).resolves.toBeTruthy();
    await expect(
      krimtoWrite(alice, { scope: "team/payments", title: "Pay", body: "deploy via stripe" }),
    ).resolves.toBeTruthy();
    await expect(
      krimtoWrite(alice, { scope: "team/infra", title: "X", body: "y" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      krimtoWrite(alice, { scope: "org/acme", title: "X", body: "y" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("read access", () => {
  beforeEach(async () => {
    // org fact seeded via admin context (admin@acme.com can write org/acme)
    const admin: ToolContext = {
      store,
      index,
      writeQueue,
      membership: adminMembership,
      requester: { identity: "admin@acme.com", teams: [] },
    };
    await krimtoWrite(admin, { scope: "org/acme", title: "Deploy policy", body: "deploy only in windows" });
    await krimtoWrite(alice, { scope: "user/alice@acme.com", title: "Alice deploy", body: "deploy with my flags" });
    await krimtoWrite(alice, { scope: "team/payments", title: "Payments deploy", body: "deploy via stripe pipeline" });
    await krimtoWrite(bob, { scope: "team/infra", title: "Infra deploy", body: "deploy via kubernetes" });
  });

  it("recall returns only scopes the requester can read", async () => {
    const { results } = await krimtoRecall(bob, { query: "deploy" });
    const scopes = new Set(results.map((r) => r.scope));
    expect(scopes.has("org/acme")).toBe(true);
    expect(scopes.has("team/infra")).toBe(true);
    expect(scopes.has("team/payments")).toBe(false);
    expect(scopes.has("user/alice@acme.com")).toBe(false);
  });

  it("read of another user's fact returns not_found (no existence leak)", async () => {
    // Find alice's user-scope fact via the index (alice's context can read it)
    const { results } = await krimtoRecall(alice, { query: "deploy with my flags", scopes: ["user/alice@acme.com"] });
    expect(results.length).toBeGreaterThan(0);
    const aliceFact = results[0]!;
    await expect(krimtoRead(bob, aliceFact.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("list_scopes hides scopes the requester cannot read", async () => {
    const { scopes } = await krimtoListScopes(bob);
    const paths = scopes.map((s) => s.path);
    expect(paths).toContain("org/acme");
    expect(paths).toContain("team/infra");
    expect(paths).not.toContain("team/payments");
    expect(paths).not.toContain("user/alice@acme.com");
  });
});
