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
