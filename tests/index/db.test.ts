import { describe, it, expect } from "vitest";
import { openIndexDb, embeddingSpaceChanged } from "../../src/index/db";

describe("openIndexDb", () => {
  it("opens in WAL mode with fts5 + sqlite-vec available and records schema_meta", () => {
    const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
    expect(db.pragma("journal_mode", { simple: true })).toBe("memory"); // :memory: reports 'memory'
    expect(db.prepare("select vec_version() v").get()).toBeTruthy();
    const tables = db
      .prepare("select name from sqlite_master where type in ('table','view') order by name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(["facts", "embedding_cache", "schema_meta"]));
    const ver = db
      .prepare("select value from schema_meta where key='schema_version'")
      .get() as { value: string };
    expect(Number(ver.value)).toBe(1);
    db.close();
  });

  it("creates facts_vec only when a provider with dimensions is configured", () => {
    const lexical = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
    const hasVec = (d: ReturnType<typeof openIndexDb>) =>
      (
        d
          .prepare("select count(*) c from sqlite_master where name='facts_vec'")
          .get() as { c: number }
      ).c > 0;
    expect(hasVec(lexical)).toBe(false);
    const vector = openIndexDb(":memory:", { provider: "openai", dimensions: 8 });
    expect(hasVec(vector)).toBe(true);
    lexical.close();
    vector.close();
  });
});

describe("embeddingSpaceChanged", () => {
  it("returns false when provider and dimensions match what was bootstrapped", () => {
    const db = openIndexDb(":memory:", { provider: "openai", dimensions: 8 });
    expect(embeddingSpaceChanged(db, { provider: "openai", dimensions: 8 })).toBe(false);
    db.close();
  });

  it("returns true when the provider changes", () => {
    const db = openIndexDb(":memory:", { provider: "openai", dimensions: 8 });
    expect(embeddingSpaceChanged(db, { provider: "voyage", dimensions: 8 })).toBe(true);
    db.close();
  });

  it("returns true when the dimensions change", () => {
    const db = openIndexDb(":memory:", { provider: "openai", dimensions: 8 });
    expect(embeddingSpaceChanged(db, { provider: "openai", dimensions: 16 })).toBe(true);
    db.close();
  });
});
