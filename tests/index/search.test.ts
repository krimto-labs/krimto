import { describe, it, expect, vi } from "vitest";
import { openIndexDb } from "../../src/index/db";
import { FactIndex } from "../../src/index/factIndex";
import { createFact } from "../../src/storage/fact";
import type { EmbeddingProvider } from "../../src/index/embeddings";

const READABLE = ["org/acme", "user/a@x.com", "team/payments"];

describe("FactIndex.searchCandidates (lexical-only)", () => {
  it("returns keyword matches scored in [0,1], best first", async () => {
    const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
    const idx = new FactIndex(db);
    await idx.upsertFact(createFact({ scope: "org/acme", title: "Stripe webhooks", body: "verify idempotency keys", author: "a@x.com" }));
    await idx.upsertFact(createFact({ scope: "org/acme", title: "Deploy runbook", body: "kubernetes rollout", author: "a@x.com" }));
    const cands = await idx.searchCandidates("stripe idempotency", { readableScopes: READABLE });
    expect(cands.length).toBeGreaterThan(0);
    expect(cands[0]!.title).toBe("Stripe webhooks");
    for (const c of cands) {
      expect(c.bm25Score).toBeGreaterThanOrEqual(0);
      expect(c.bm25Score).toBeLessThanOrEqual(1);
    }
    db.close();
  });

  it("does not throw on queries with punctuation", async () => {
    const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
    const idx = new FactIndex(db);
    await idx.upsertFact(createFact({ scope: "org/acme", title: "Stripe webhooks", body: "idempotency", author: "a@x.com" }));
    const cands = await idx.searchCandidates("what's the stripe webhook?", { readableScopes: READABLE });
    expect(cands.map((c) => c.title)).toContain("Stripe webhooks");
    db.close();
  });

  it("excludes unreadable scopes, expired facts, and superseded facts", async () => {
    const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
    const idx = new FactIndex(db);
    await idx.upsertFact(createFact({ scope: "user/other@x.com", title: "secret stripe", body: "stripe", author: "other@x.com" })); // unreadable
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const expired = createFact({ scope: "org/acme", title: "old stripe", body: "stripe", author: "a@x.com" });
    expired.frontmatter.expires = past;
    await idx.upsertFact(expired);
    const old = createFact({ scope: "org/acme", title: "stripe legacy", body: "stripe", author: "a@x.com" });
    await idx.upsertFact(old);
    const replacement = createFact({ scope: "org/acme", title: "stripe current", body: "stripe", author: "a@x.com", supersedes: [old.frontmatter.id] });
    await idx.upsertFact(replacement);
    const cands = await idx.searchCandidates("stripe", { readableScopes: READABLE });
    const ids = cands.map((c) => c.id);
    expect(ids).not.toContain(expired.frontmatter.id);
    expect(ids).not.toContain(old.frontmatter.id);
    expect(ids).toContain(replacement.frontmatter.id);
    db.close();
  });
});

describe("FactIndex.listFacts (flat browse)", () => {
  it("returns readable facts newest-first, capped at the limit", async () => {
    const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
    const idx = new FactIndex(db);
    // Insert in reverse-time order so the updated-DESC sort is meaningful.
    const older = createFact({ scope: "user/a@x.com", title: "Older", body: "x", author: "a@x.com" });
    older.frontmatter.updated = "2026-01-01T00:00:00Z";
    older.frontmatter.created = "2026-01-01T00:00:00Z";
    const newer = createFact({ scope: "user/a@x.com", title: "Newer", body: "y", author: "a@x.com" });
    newer.frontmatter.updated = "2026-05-01T00:00:00Z";
    newer.frontmatter.created = "2026-05-01T00:00:00Z";
    await idx.upsertFact(older);
    await idx.upsertFact(newer);

    const list = idx.listFacts(["user/a@x.com"], 50);
    expect(list.map((f) => f.title)).toEqual(["Newer", "Older"]);

    const capped = idx.listFacts(["user/a@x.com"], 1);
    expect(capped).toHaveLength(1);
    expect(capped[0]!.title).toBe("Newer");
    db.close();
  });

  it("respects scope filtering — unreadable scopes don't appear", async () => {
    const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
    const idx = new FactIndex(db);
    await idx.upsertFact(createFact({ scope: "user/a@x.com", title: "Mine", body: "x", author: "a@x.com" }));
    await idx.upsertFact(createFact({ scope: "user/other@x.com", title: "Theirs", body: "y", author: "other@x.com" }));
    const list = idx.listFacts(["user/a@x.com"], 50);
    expect(list.map((f) => f.title)).toEqual(["Mine"]);
    db.close();
  });

  it("excludes superseded and expired facts (same rules as recall)", async () => {
    const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
    const idx = new FactIndex(db);
    const old = createFact({ scope: "user/a@x.com", title: "old", body: "x", author: "a@x.com" });
    await idx.upsertFact(old);
    const replacement = createFact({ scope: "user/a@x.com", title: "new", body: "x", author: "a@x.com", supersedes: [old.frontmatter.id] });
    await idx.upsertFact(replacement);
    const expired = createFact({ scope: "user/a@x.com", title: "expired", body: "x", author: "a@x.com" });
    expired.frontmatter.expires = new Date(Date.now() - 86_400_000).toISOString();
    await idx.upsertFact(expired);

    const titles = idx.listFacts(["user/a@x.com"], 50).map((f) => f.title);
    expect(titles).toEqual(["new"]); // old superseded, expired excluded
    db.close();
  });

  it("returns [] for empty readableScopes", () => {
    const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
    const idx = new FactIndex(db);
    expect(idx.listFacts([], 50)).toEqual([]);
    db.close();
  });
});

describe("FactIndex.searchCandidates (guards)", () => {
  it("returns [] for empty readableScopes", async () => {
    const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
    const idx = new FactIndex(db);
    await idx.upsertFact(createFact({ scope: "org/acme", title: "x", body: "stripe", author: "a@x.com" }));
    expect(await idx.searchCandidates("stripe", { readableScopes: [] })).toEqual([]);
    db.close();
  });

  it("returns [] when the query has no usable terms", async () => {
    const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
    const idx = new FactIndex(db);
    await idx.upsertFact(createFact({ scope: "org/acme", title: "x", body: "stripe", author: "a@x.com" }));
    expect(await idx.searchCandidates("!!! ??? ...", { readableScopes: ["org/acme"] })).toEqual([]);
    db.close();
  });
});

describe("FactIndex.searchCandidates (vector path)", () => {
  it("ranks the nearest embedding and normalizes vectorScore to [0,1]", async () => {
    const dim = 4;
    const embed = vi.fn(async (texts: string[]) =>
      texts.map((t) => Array.from({ length: dim }, (_, i) => ((t.charCodeAt(i % t.length) || 1) % 7) / 7)),
    );
    const provider: EmbeddingProvider = { name: "stub", dimensions: dim, embed };
    const db = openIndexDb(":memory:", { provider: "stub", dimensions: dim });
    const idx = new FactIndex(db, provider);
    const a = createFact({ scope: "org/acme", title: "Stripe webhooks", body: "stripe idempotency keys", author: "a@x.com" });
    const b = createFact({ scope: "org/acme", title: "Deploy", body: "kubernetes rollout strategy", author: "a@x.com" });
    await idx.upsertFact(a);
    await idx.upsertFact(b);
    const [qv] = await provider.embed(["stripe idempotency keys"]);
    const queryVector = Float32Array.from(qv!);
    const cands = await idx.searchCandidates("stripe idempotency keys", {
      readableScopes: ["org/acme"],
      queryVector,
    });
    const fa = cands.find((c) => c.id === a.frontmatter.id);
    expect(fa).toBeDefined();
    // Identical embedding => nearest neighbour => max-normalized vectorScore == 1
    expect(fa!.vectorScore).toBeCloseTo(1, 5);
    for (const c of cands) {
      expect(c.vectorScore).toBeGreaterThanOrEqual(0);
      expect(c.vectorScore).toBeLessThanOrEqual(1);
    }
    db.close();
  });
});
