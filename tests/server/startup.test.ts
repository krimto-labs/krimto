import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FactStore } from "../../src/storage/store";
import { openIndexDb } from "../../src/index/db";
import { FactIndex } from "../../src/index/factIndex";
import { buildIndexIfNeeded, resolveIdentity } from "../../src/server/index";

let root: string;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("buildIndexIfNeeded", () => {
  it("builds an empty index from existing markdown facts", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-startup-"));
    const store = new FactStore(root);
    await store.writeFact({ scope: "org/acme", title: "Stripe", body: "idempotency keys", author: "a@x.com" });
    await store.writeFact({ scope: "org/acme", title: "Deploy", body: "kubernetes", author: "a@x.com" });
    const cfg = { provider: "none", dimensions: 0 };
    const db = openIndexDb(":memory:", cfg);
    const index = new FactIndex(db);
    expect(index.factCount()).toBe(0);
    await buildIndexIfNeeded(index, store, db, cfg);
    expect(index.factCount()).toBe(2);
    const cands = await index.searchCandidates("stripe", { readableScopes: ["org/acme"] });
    expect(cands.map((c) => c.title)).toContain("Stripe");
    db.close();
  });

  it("does not rebuild when the index is already populated and config matches", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-startup2-"));
    const store = new FactStore(root);
    const cfg = { provider: "none", dimensions: 0 };
    const db = openIndexDb(":memory:", cfg);
    const index = new FactIndex(db);
    await index.upsertFact((await import("../../src/storage/fact")).createFact({ scope: "org/acme", title: "x", body: "y", author: "a@x.com" }));
    expect(index.factCount()).toBe(1);
    await buildIndexIfNeeded(index, store, db, cfg); // store is empty; must NOT wipe the index
    expect(index.factCount()).toBe(1);
    db.close();
  });
});

describe("resolveIdentity", () => {
  // Smoke-6 UX gap: a plain-terminal `krimto notes` resolved to `user@localhost` and couldn't
  // see facts the editor saved under the wizard-configured identity. The fix layers a fallback
  // to global git user.email so the CLI infers the same identity the wizard would have captured.
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.KRIMTO_IDENTITY;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.KRIMTO_IDENTITY;
    else process.env.KRIMTO_IDENTITY = savedEnv;
  });

  it("returns KRIMTO_IDENTITY when it's a valid email", async () => {
    process.env.KRIMTO_IDENTITY = "alice@example.com";
    expect(await resolveIdentity()).toBe("alice@example.com");
  });

  it("ignores a malformed KRIMTO_IDENTITY and falls through to git or placeholder", async () => {
    process.env.KRIMTO_IDENTITY = "not-an-email";
    const result = await resolveIdentity();
    // Either the git fallback or the placeholder — but never the malformed value we set.
    expect(result).not.toBe("not-an-email");
    expect(result).toMatch(/^[^@\s]+@[^@\s]+$/);
  });
});
