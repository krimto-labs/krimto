import { describe, it, expect, vi } from "vitest";
import { openIndexDb } from "../../src/index/db";
import { FactIndex } from "../../src/index/factIndex";
import type { EmbeddingProvider } from "../../src/index/embeddings";
import { createFact } from "../../src/storage/fact";

function stubProvider(dim = 8): EmbeddingProvider & { embed: ReturnType<typeof vi.fn> } {
  const embed = vi.fn(async (texts: string[]) =>
    texts.map((t) => Array.from({ length: dim }, (_, i) => ((t.charCodeAt(i % t.length) || 1) % 7) / 7)),
  );
  return { name: "stub", dimensions: dim, embed };
}

function fact(over: Partial<Parameters<typeof createFact>[0]> = {}) {
  return createFact({ scope: "org/acme", title: "Stripe webhooks", body: "use idempotency keys", author: "a@x.com", ...over });
}

describe("FactIndex upsert/get/remove", () => {
  it("upserts then reads back a fact", async () => {
    const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
    const idx = new FactIndex(db);
    const f = fact();
    await idx.upsertFact(f);
    expect(idx.getFact(f.frontmatter.id)?.frontmatter.title).toBe("Stripe webhooks");
    db.close();
  });

  it("reuses the cached embedding when the body is unchanged", async () => {
    const provider = stubProvider();
    const db = openIndexDb(":memory:", { provider: "stub", dimensions: 8 });
    const idx = new FactIndex(db, provider);
    const f = fact();
    await idx.upsertFact(f);
    await idx.upsertFact({ ...f, frontmatter: { ...f.frontmatter, title: "Stripe webhooks v2" } });
    expect(provider.embed).toHaveBeenCalledTimes(1); // body unchanged -> cache hit
    db.close();
  });

  it("re-embeds when the body changes", async () => {
    const provider = stubProvider();
    const db = openIndexDb(":memory:", { provider: "stub", dimensions: 8 });
    const idx = new FactIndex(db, provider);
    const f = fact();
    await idx.upsertFact(f);
    await idx.upsertFact({ ...f, body: "use webhook signing secret" });
    expect(provider.embed).toHaveBeenCalledTimes(2);
    db.close();
  });

  it("removes a fact from all tables", async () => {
    const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
    const idx = new FactIndex(db);
    const f = fact();
    await idx.upsertFact(f);
    idx.removeFact(f.frontmatter.id);
    expect(idx.getFact(f.frontmatter.id)).toBeNull();
    db.close();
  });

  it("removes fact from facts_vec on provider path", async () => {
    const provider = stubProvider(8);
    const db = openIndexDb(":memory:", { provider: "stub", dimensions: 8 });
    const idx = new FactIndex(db, provider);
    const f = fact();
    const id = f.frontmatter.id;
    await idx.upsertFact(f);
    const before = db
      .prepare("SELECT count(*) AS c FROM facts_vec WHERE fact_id=?")
      .get(id) as { c: number };
    expect(before.c).toBe(1);
    idx.removeFact(id);
    const after = db
      .prepare("SELECT count(*) AS c FROM facts_vec WHERE fact_id=?")
      .get(id) as { c: number };
    expect(after.c).toBe(0);
    db.close();
  });
});

describe("FactIndex.rebuild (atomic)", () => {
  it("replaces the index with the new fact set, vectors included", async () => {
    const dim = 4;
    const embed = vi.fn(async (texts: string[]) =>
      texts.map((t) => Array.from({ length: dim }, (_, i) => ((t.charCodeAt(i % t.length) || 1) % 7) / 7)),
    );
    const provider = { name: "stub", dimensions: dim, embed };
    const db = openIndexDb(":memory:", { provider: "stub", dimensions: dim });
    const idx = new FactIndex(db, provider);
    await idx.upsertFact(createFact({ scope: "org/acme", title: "old", body: "obsolete", author: "a@x.com" }));
    const fresh = createFact({ scope: "org/acme", title: "stripe", body: "idempotency keys", author: "a@x.com" });
    await idx.rebuild([fresh]);
    expect(idx.factCount()).toBe(1);
    expect(idx.getFact(fresh.frontmatter.id)?.frontmatter.title).toBe("stripe");
    const [qv] = await provider.embed(["idempotency keys"]);
    const cands = await idx.searchCandidates("idempotency keys", {
      readableScopes: ["org/acme"],
      queryVector: Float32Array.from(qv!),
    });
    expect(cands.map((c) => c.id)).toContain(fresh.frontmatter.id);
    db.close();
  });
});

// H4 — the vector KNN must be scope-aware. With a global top-k=50 truncation, an in-scope fact can be
// pushed out by 50+ nearer out-of-scope vectors and silently dropped. We isolate the vector path by
// using a query term that matches NO fact (so BM25 can't rescue the in-scope fact).
function angleProvider(dim = 4): EmbeddingProvider {
  // Encodes a unit vector [cos a, sin a, 0…] from "a=<n>" in the text. Smaller a ⇒ closer to the
  // query at a=0 ([1,0,…]). Lets a test place many out-of-scope facts nearer than one in-scope fact.
  return {
    name: "angle",
    dimensions: dim,
    embed: async (texts: string[]) =>
      texts.map((t) => {
        const m = /a=([0-9.]+)/.exec(t);
        const a = m ? Number(m[1]) : 0;
        const v = new Array<number>(dim).fill(0);
        v[0] = Math.cos(a);
        v[1] = Math.sin(a);
        return v;
      }),
  };
}

describe("FactIndex vector KNN scope filtering (H4)", () => {
  it("returns an in-scope fact even when 50+ nearer vectors live in unreadable scopes", async () => {
    const provider = angleProvider(4);
    const db = openIndexDb(":memory:", { provider: "angle", dimensions: 4 });
    const idx = new FactIndex(db, provider);

    // 60 out-of-scope facts crowd the global top-50 (angles 0.001…0.060, all very near a=0).
    for (let i = 1; i <= 60; i++) {
      await idx.upsertFact(
        createFact({ scope: "org/secret", title: `secret ${i}`, body: `a=${(i / 1000).toFixed(3)}`, author: "z@x.com" }),
      );
    }
    // One readable fact, farther from the query (a=0.2) so it ranks ~61st globally.
    const mine = createFact({ scope: "user/me@x.com", title: "mine", body: "a=0.200", author: "me@x.com" });
    await idx.upsertFact(mine);

    // Query term matches no fact ⇒ BM25 contributes nothing; only the (scope-aware) KNN can surface it.
    const cands = await idx.searchCandidates("zzznomatchzzz", {
      readableScopes: ["user/me@x.com"],
      queryVector: Float32Array.from([1, 0, 0, 0]),
    });
    expect(cands.map((c) => c.id)).toContain(mine.frontmatter.id);
    db.close();
  });
});
