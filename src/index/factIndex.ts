// Gap 09 (part 2) — Fact upsert/get/remove with SQLite-backed embedding cache.
// The FTS5 index (facts_fts) is kept in sync by triggers from schema.ts — never
// write to it directly. The vec table (facts_vec) is maintained explicitly here.

import type { Database as Db } from "better-sqlite3";

import { type Fact, type FactFrontmatter } from "../storage/fact";
import { type EmbeddingProvider, hashText } from "./embeddings";
import { type Candidate } from "../retrieval/pipeline";
import { tokenize } from "../retrieval/lexical";

interface FactRow {
  id: string;
  scope: string;
  title: string;
  body: string;
  body_hash: string;
  author: string;
  created: string;
  updated: string;
  tags: string | null;
  source: string | null;
  supersedes: string | null;
  expires: string | null;
}

function rowToFact(r: FactRow): Fact {
  const fm: FactFrontmatter = {
    id: r.id,
    scope: r.scope,
    title: r.title,
    author: r.author,
    created: r.created,
    updated: r.updated,
  };
  if (r.tags) fm.tags = JSON.parse(r.tags) as string[];
  if (r.source) fm.source = r.source;
  if (r.supersedes) fm.supersedes = JSON.parse(r.supersedes) as string[];
  if (r.expires) fm.expires = r.expires;
  return { frontmatter: fm, body: r.body };
}

export class FactIndex {
  constructor(
    private readonly db: Db,
    private readonly provider?: EmbeddingProvider,
  ) {}

  /**
   * Embed-on-change with the SQLite embedding_cache.
   * Returns a Float32Array or null when no provider is configured.
   *
   * Node's Buffer can be a view into a shared pool, so we reconstruct the
   * Float32Array using byteOffset + (length / 4) rather than assuming the
   * buffer starts at byte 0.
   */
  private async embedBody(body: string, hash: string): Promise<Float32Array | null> {
    if (!this.provider) return null;
    const cached = this.db
      .prepare("SELECT embedding FROM embedding_cache WHERE body_hash=?")
      .get(hash) as { embedding: Buffer } | undefined;
    if (cached) {
      return new Float32Array(
        cached.embedding.buffer,
        cached.embedding.byteOffset,
        cached.embedding.length / 4,
      );
    }
    let vec: number[] | undefined;
    try {
      [vec] = await this.provider.embed([body]);
    } catch (e) {
      // Embedding is an optimization, never a gate on persistence. A provider failure (bad/expired
      // key, offline machine, misconfigured base URL) must NOT drop the write — store the fact with
      // no vector so it stays lexically searchable; the next `reindex` backfills the vector once the
      // provider is fixed. (Mirrors the query-side fail-soft in krimtoRecall.)
      process.stderr.write(
        `krimto: embedding failed (fact stored without a vector — keyword search still works): ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
      return null;
    }
    const f32 = Float32Array.from(vec ?? []);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO embedding_cache(body_hash, embedding, created) VALUES (?, ?, ?)",
      )
      .run(hash, Buffer.from(f32.buffer), new Date().toISOString());
    return f32;
  }

  /** Insert/update the facts row (FTS follows via trigger). Synchronous. */
  private insertFactRow(fact: Fact, hash: string): void {
    const fm = fact.frontmatter;
    this.db
      .prepare(
        `INSERT INTO facts (id, scope, title, body, author, created, updated, tags, source, supersedes, expires, body_hash)
         VALUES (@id, @scope, @title, @body, @author, @created, @updated, @tags, @source, @supersedes, @expires, @body_hash)
         ON CONFLICT(id) DO UPDATE SET
           scope=excluded.scope, title=excluded.title, body=excluded.body, author=excluded.author,
           updated=excluded.updated, tags=excluded.tags, source=excluded.source,
           supersedes=excluded.supersedes, expires=excluded.expires, body_hash=excluded.body_hash`,
      )
      .run({
        id: fm.id,
        scope: fm.scope,
        title: fm.title,
        body: fact.body,
        author: fm.author,
        created: fm.created,
        updated: fm.updated,
        tags: fm.tags ? JSON.stringify(fm.tags) : null,
        source: fm.source ?? null,
        supersedes: fm.supersedes ? JSON.stringify(fm.supersedes) : null,
        expires: fm.expires ?? null,
        body_hash: hash,
      });
  }

  /** Replace the facts_vec row for a fact. Synchronous. `scope` is stored so the KNN can filter by it. */
  private insertVecRow(id: string, scope: string, vec: Float32Array): void {
    this.db.prepare("DELETE FROM facts_vec WHERE fact_id=?").run(id);
    this.db
      .prepare("INSERT INTO facts_vec(fact_id, scope, embedding) VALUES (?, ?, ?)")
      .run(id, scope, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
  }

  /**
   * Insert or update a fact in `facts` (FTS5 follows via trigger) and `facts_vec`.
   */
  async upsertFact(fact: Fact): Promise<void> {
    const hash = hashText(fact.body);
    const vec = await this.embedBody(fact.body, hash);
    const tx = this.db.transaction(() => {
      this.insertFactRow(fact, hash);
      if (vec) this.insertVecRow(fact.frontmatter.id, fact.frontmatter.scope, vec);
    });
    tx();
  }

  removeFact(id: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM facts WHERE id=?").run(id);
      if (this.provider) {
        this.db.prepare("DELETE FROM facts_vec WHERE fact_id=?").run(id);
      }
    });
    tx();
  }

  getFact(id: string): Fact | null {
    const row = this.db
      .prepare("SELECT * FROM facts WHERE id=?")
      .get(id) as FactRow | undefined;
    return row ? rowToFact(row) : null;
  }

  /** Fact ids that some other fact supersedes (small set; excluded from recall). */
  private supersededIds(): Set<string> {
    const set = new Set<string>();
    for (const r of this.db.prepare("select supersedes from facts where supersedes is not null").all() as {
      supersedes: string;
    }[]) {
      for (const id of JSON.parse(r.supersedes) as string[]) set.add(id);
    }
    return set;
  }

  listScopes(readableScopes: string[]): { path: string; factCount: number; lastUpdated: string | null }[] {
    if (readableScopes.length === 0) return [];
    const placeholders = readableScopes.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT scope AS path, COUNT(*) AS factCount, MAX(updated) AS lastUpdated
           FROM facts WHERE scope IN (${placeholders})
          GROUP BY scope ORDER BY scope`,
      )
      .all(...readableScopes) as { path: string; factCount: number; lastUpdated: string | null }[];
  }

  /**
   * Flat list of facts the requester can read, newest-first, capped at `limit`. Used by the
   * `/ui/facts` overview that shows every readable fact (not just scope counts).
   * Excludes superseded entries — same as recall.
   */
  listFacts(
    readableScopes: string[],
    limit = 50,
  ): { id: string; scope: string; title: string; author: string; updated: string; source: string | null }[] {
    if (readableScopes.length === 0) return [];
    const placeholders = readableScopes.map(() => "?").join(",");
    const superseded = this.supersededIds();
    const rows = this.db
      .prepare(
        `SELECT id, scope, title, author, updated, source FROM facts
          WHERE scope IN (${placeholders})
            AND (expires IS NULL OR expires > ?)
          ORDER BY updated DESC
          LIMIT ?`,
      )
      .all(...readableScopes, new Date().toISOString(), limit) as {
      id: string; scope: string; title: string; author: string; updated: string; source: string | null;
    }[];
    return rows.filter((r) => !superseded.has(r.id));
  }

  /** All distinct scopes present in the index. */
  allScopes(): string[] {
    return (this.db.prepare("select distinct scope from facts order by scope").all() as { scope: string }[]).map(
      (r) => r.scope,
    );
  }

  /** Atomically rebuild the index from `facts`. embedding_cache is preserved. */
  async rebuild(facts: Fact[]): Promise<void> {
    const prepared: { fact: Fact; hash: string; vec: Float32Array | null }[] = [];
    for (const fact of facts) {
      const hash = hashText(fact.body);
      prepared.push({ fact, hash, vec: await this.embedBody(fact.body, hash) });
    }
    const swap = this.db.transaction(() => {
      this.db.exec("DELETE FROM facts;");
      if (this.provider) this.db.exec("DELETE FROM facts_vec;");
      for (const { fact, hash, vec } of prepared) {
        this.insertFactRow(fact, hash);
        if (vec) this.insertVecRow(fact.frontmatter.id, fact.frontmatter.scope, vec);
      }
    });
    swap();
  }

  factCount(): number {
    return (this.db.prepare("select count(*) c from facts").get() as { c: number }).c;
  }

  /**
   * Rows in facts_vec. 0 when the vector table is absent (lexical-only, or dropped pending a rebuild
   * after an embedding-space change). The rebuild trigger compares this to factCount() — a robust
   * signal that survives the schema_meta write-ordering, unlike embeddingSpaceChanged post-open.
   */
  vectorCount(): number {
    try {
      return (this.db.prepare("select count(*) c from facts_vec").get() as { c: number }).c;
    } catch {
      return 0; // facts_vec doesn't exist
    }
  }

  /**
   * Build ranking candidates: FTS5 BM25 (top 50) unioned with sqlite-vec cosine KNN (top 50),
   * scope-filtered, with expired + superseded excluded. Scores max-normalized to [0,1].
   * Lexical-only (no query vector) skips the vector half and mirrors bm25 into vectorScore.
   */
  async searchCandidates(
    query: string,
    opts: { readableScopes: string[]; now?: Date; queryVector?: Float32Array },
  ): Promise<Candidate[]> {
    const scopeList = opts.readableScopes;
    if (scopeList.length === 0) return [];
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];
    const ftsQuery = terms.join(" OR ");
    const now = (opts.now ?? new Date()).toISOString();
    const superseded = this.supersededIds();
    const placeholders = scopeList.map(() => "?").join(",");

    // Lexical (BM25). FTS5 bm25() is negative; smaller = better. Negate so larger = better.
    const lexical = this.db
      .prepare(
        `SELECT f.id AS id, -bm25(facts_fts) AS raw
           FROM facts_fts JOIN facts f ON f.rowid = facts_fts.rowid
          WHERE facts_fts MATCH ?
            AND f.scope IN (${placeholders})
            AND (f.expires IS NULL OR f.expires > ?)
          ORDER BY bm25(facts_fts) LIMIT 50`,
      )
      .all(ftsQuery, ...scopeList, now) as { id: string; raw: number }[];

    const bm25 = new Map<string, number>();
    const maxRaw = Math.max(0, ...lexical.map((r) => r.raw));
    for (const r of lexical) bm25.set(r.id, maxRaw > 0 ? r.raw / maxRaw : 0);

    // Vector (cosine) — only when a provider gave us a query vector (facts_vec exists then).
    const vector = new Map<string, number>();
    if (opts.queryVector && this.provider) {
      const queryBuf = Buffer.from(
        opts.queryVector.buffer,
        opts.queryVector.byteOffset,
        opts.queryVector.byteLength,
      );
      // H4 — filter by readable scope INSIDE the KNN so the 50 nearest are drawn from the readable
      // scopes, not globally (a global top-k would let unreadable scopes crowd out in-scope facts).
      const knn = this.db
        .prepare(
          `SELECT fact_id, distance FROM facts_vec WHERE embedding MATCH ? AND k = 50 AND scope IN (${placeholders}) ORDER BY distance`,
        )
        .all(queryBuf, ...scopeList) as { fact_id: string; distance: number }[];
      const sims = knn.map((r) => ({ id: r.fact_id, sim: Math.max(0, 1 - r.distance) }));
      const maxSim = Math.max(0, ...sims.map((s) => s.sim));
      for (const s of sims) vector.set(s.id, maxSim > 0 ? s.sim / maxSim : 0);
    }

    const ids = new Set<string>([...bm25.keys(), ...vector.keys()]);
    const lexicalOnly = !opts.queryVector;
    const out: Candidate[] = [];
    const getFactStmt = this.db.prepare("select * from facts where id=?");
    for (const id of ids) {
      if (superseded.has(id)) continue;
      const row = getFactStmt.get(id) as FactRow | undefined;
      if (!row) continue;
      if (!scopeList.includes(row.scope)) continue; // defense-in-depth: both halves are scope-filtered in-query (H4)
      if (row.expires && row.expires <= now) continue;
      const bm = bm25.get(id) ?? 0;
      out.push({
        id: row.id, scope: row.scope, title: row.title, body: row.body, author: row.author, updated: row.updated,
        bm25Score: bm,
        vectorScore: lexicalOnly ? bm : (vector.get(id) ?? 0),
      });
    }
    return out;
  }
}
