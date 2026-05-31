import { afterEach, describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { openIndexDb, embeddingSpaceChanged } from "../../src/index/db";
import { SCHEMA_VERSION } from "../../src/index/schema";

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
    expect(Number(ver.value)).toBe(SCHEMA_VERSION);
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

describe("openIndexDb — schema v1 → v2 migration (Porter stemmer)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it("migrates a pre-existing non-stemming index so a singular query matches a plural fact", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-migrate-"));
    const dbPath = path.join(dir, "index.db");

    // Hand-build a v1 index: facts + a NON-stemming facts_fts + schema_meta version 1.
    const old = new Database(dbPath);
    old.exec(
      `CREATE TABLE facts (id TEXT PRIMARY KEY, scope TEXT NOT NULL, title TEXT NOT NULL,
         body TEXT NOT NULL, author TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL,
         tags TEXT, source TEXT, supersedes TEXT, expires TEXT, body_hash TEXT NOT NULL);
       CREATE VIRTUAL TABLE facts_fts USING fts5(title, body, tags, content='facts', content_rowid='rowid');
       CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
       INSERT INTO schema_meta(key, value) VALUES ('schema_version', '1');`,
    );
    old
      .prepare(
        `INSERT INTO facts (id, scope, title, body, author, created, updated, body_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("fct_x", "user/a@b.com", "Preferred colors", "Orange and pink.", "a@b.com", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "h");
    old.exec("INSERT INTO facts_fts(facts_fts) VALUES('rebuild');"); // populate the old FTS index

    // Sanity: under the old non-stemming tokenizer, the singular query does NOT match.
    const beforeRows = old
      .prepare("SELECT f.id FROM facts_fts JOIN facts f ON f.rowid = facts_fts.rowid WHERE facts_fts MATCH 'color'")
      .all() as { id: string }[];
    expect(beforeRows).toHaveLength(0);
    old.close();

    // Reopen through the real code path → migration drops + recreates facts_fts with Porter,
    // then rebuilds it from the surviving content table.
    const db = openIndexDb(dbPath, { provider: "none", dimensions: 0 });
    const afterRows = db
      .prepare("SELECT f.id FROM facts_fts JOIN facts f ON f.rowid = facts_fts.rowid WHERE facts_fts MATCH 'color'")
      .all() as { id: string }[];
    expect(afterRows.map((r) => r.id)).toContain("fct_x"); // singular query now finds the plural fact
    const ver = db.prepare("select value from schema_meta where key='schema_version'").get() as { value: string };
    expect(Number(ver.value)).toBe(SCHEMA_VERSION);
    db.close();
  });
});

describe("openIndexDb — embedding space change (H6)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it("re-dimensions facts_vec and clears embedding_cache when the embedding space changes", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-space-"));
    const dbPath = path.join(dir, "index.db");
    const vec = (a: number[]): Buffer => Buffer.from(Float32Array.from(a).buffer);

    const db1 = openIndexDb(dbPath, { provider: "openai", dimensions: 4 });
    db1.prepare("INSERT INTO embedding_cache(body_hash, embedding, created) VALUES (?,?,?)").run("h", vec([1, 0, 0, 0]), "t");
    db1.prepare("INSERT INTO facts_vec(fact_id, scope, embedding) VALUES (?,?,?)").run("f1", "user/a", vec([1, 0, 0, 0]));
    db1.close();

    // Reopen with a different dimension → the old cached vectors are in the wrong space and the
    // 4-dim facts_vec can't hold 8-dim rows.
    const db2 = openIndexDb(dbPath, { provider: "openai", dimensions: 8 });
    const cacheCount = (db2.prepare("select count(*) c from embedding_cache").get() as { c: number }).c;
    expect(cacheCount).toBe(0); // stale cache cleared
    expect(() =>
      db2.prepare("INSERT INTO facts_vec(fact_id, scope, embedding) VALUES (?,?,?)").run("f2", "user/a", vec([1, 0, 0, 0, 0, 0, 0, 0])),
    ).not.toThrow(); // facts_vec recreated at the new dimension
    db2.close();
  });

  it("does NOT drop facts_vec or clear the cache when reopened lexical-only (a CLI run without embed env)", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-noprov-"));
    const dbPath = path.join(dir, "index.db");
    const vec = (a: number[]): Buffer => Buffer.from(Float32Array.from(a).buffer);

    const db1 = openIndexDb(dbPath, { provider: "openai", dimensions: 4 });
    db1.prepare("INSERT INTO embedding_cache(body_hash, embedding, created) VALUES (?,?,?)").run("h", vec([1, 0, 0, 0]), "t");
    db1.prepare("INSERT INTO facts_vec(fact_id, scope, embedding) VALUES (?,?,?)").run("f1", "user/a", vec([1, 0, 0, 0]));
    db1.close();

    // `krimto rm/reindex/sync` in a shell without KRIMTO_EMBED_* resolves provider:none. That must NOT
    // destroy the vector space the server built — the server repopulates from the surviving cache.
    const db2 = openIndexDb(dbPath, { provider: "none", dimensions: 0 });
    const hasVec = (db2.prepare("select count(*) c from sqlite_master where name='facts_vec'").get() as { c: number }).c > 0;
    expect(hasVec).toBe(true);
    expect((db2.prepare("select count(*) c from facts_vec").get() as { c: number }).c).toBe(1);
    expect((db2.prepare("select count(*) c from embedding_cache").get() as { c: number }).c).toBe(1);
    db2.close();
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
