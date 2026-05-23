import { describe, it, expect } from "vitest";
import { openIndexDb } from "../../src/index/db";
import { FactIndex } from "../../src/index/factIndex";
import { createFact } from "../../src/storage/fact";

describe("FactIndex listScopes + rebuild", () => {
  it("summarizes scopes the requester can read", async () => {
    const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
    const idx = new FactIndex(db);
    await idx.upsertFact(createFact({ scope: "org/acme", title: "a", body: "x", author: "a@x.com" }));
    await idx.upsertFact(createFact({ scope: "org/acme", title: "b", body: "y", author: "a@x.com" }));
    await idx.upsertFact(createFact({ scope: "user/secret@x.com", title: "c", body: "z", author: "secret@x.com" }));
    const scopes = idx.listScopes(["org/acme"]);
    expect(scopes).toEqual([{ path: "org/acme", factCount: 2, lastUpdated: expect.any(String) }]);
    db.close();
  });

  it("rebuilds the index from a set of facts", async () => {
    const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
    const idx = new FactIndex(db);
    const facts = [
      createFact({ scope: "org/acme", title: "stripe", body: "idempotency", author: "a@x.com" }),
      createFact({ scope: "org/acme", title: "deploy", body: "kubernetes", author: "a@x.com" }),
    ];
    await idx.rebuild(facts);
    const cands = await idx.searchCandidates("stripe", { readableScopes: ["org/acme"] });
    expect(cands.map((c) => c.title)).toContain("stripe");
    expect(idx.listScopes(["org/acme"])[0]!.factCount).toBe(2);
    db.close();
  });

  it("rebuild drops facts no longer present in the new set", async () => {
    const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
    const idx = new FactIndex(db);
    const stale = createFact({ scope: "org/acme", title: "stale", body: "obsolete stripe note", author: "a@x.com" });
    await idx.upsertFact(stale);
    expect(idx.factCount()).toBe(1);
    const fresh = createFact({ scope: "org/acme", title: "fresh", body: "kubernetes rollout", author: "a@x.com" });
    await idx.rebuild([fresh]); // stale is NOT in the new set
    expect(idx.getFact(stale.frontmatter.id)).toBeNull();
    expect(idx.factCount()).toBe(1);
    // the FTS index must also forget the removed fact
    const cands = await idx.searchCandidates("stripe", { readableScopes: ["org/acme"] });
    expect(cands.map((c) => c.id)).not.toContain(stale.frontmatter.id);
    db.close();
  });

  it("allScopes returns the distinct scopes present", async () => {
    const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
    const idx = new FactIndex(db);
    await idx.upsertFact(createFact({ scope: "org/acme", title: "a", body: "x", author: "a@x.com" }));
    await idx.upsertFact(createFact({ scope: "team/payments", title: "b", body: "y", author: "a@x.com" }));
    expect(idx.allScopes().sort()).toEqual(["org/acme", "team/payments"]);
    expect(idx.factCount()).toBe(2);
    db.close();
  });
});
