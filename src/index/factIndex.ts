// Gap 09 (part 2) — Fact upsert/get/remove with SQLite-backed embedding cache.
// The FTS5 index (facts_fts) is kept in sync by triggers from schema.ts — never
// write to it directly. The vec table (facts_vec) is maintained explicitly here.

import type { Database as Db } from "better-sqlite3";

import { type Fact, type FactFrontmatter } from "../storage/fact";
import { type EmbeddingProvider, hashText } from "./embeddings";

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
    const [vec] = await this.provider.embed([body]);
    const f32 = Float32Array.from(vec ?? []);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO embedding_cache(body_hash, embedding, created) VALUES (?, ?, ?)",
      )
      .run(hash, Buffer.from(f32.buffer), new Date().toISOString());
    return f32;
  }

  /**
   * Insert or update a fact in `facts` (FTS5 follows via trigger) and `facts_vec`.
   */
  async upsertFact(fact: Fact): Promise<void> {
    const fm = fact.frontmatter;
    const hash = hashText(fact.body);
    const vec = await this.embedBody(fact.body, hash);
    this.writeFactTx(fm, fact.body, hash, vec);
  }

  private writeFactTx(
    fm: FactFrontmatter,
    body: string,
    hash: string,
    vec: Float32Array | null,
  ): void {
    const tx = this.db.transaction(() => {
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
          body,
          author: fm.author,
          created: fm.created,
          updated: fm.updated,
          tags: fm.tags ? JSON.stringify(fm.tags) : null,
          source: fm.source ?? null,
          supersedes: fm.supersedes ? JSON.stringify(fm.supersedes) : null,
          expires: fm.expires ?? null,
          body_hash: hash,
        });
      if (vec) {
        this.db.prepare("DELETE FROM facts_vec WHERE fact_id=?").run(fm.id);
        this.db
          .prepare("INSERT INTO facts_vec(fact_id, embedding) VALUES (?, ?)")
          .run(fm.id, Buffer.from(vec.buffer));
      }
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
}
