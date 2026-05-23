// Gap 09 — SQLite index bootstrap. Opens (and migrates) the persistent index database,
// loading sqlite-vec for vector search and FTS5 for lexical search.

import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import { SCHEMA_SQL, SCHEMA_VERSION, vecTableSql } from "./schema";

export interface IndexConfig {
  /** Embedding provider name ('none' = lexical-only). */
  provider: string;
  /** Vector dimension; 0/absent when lexical-only. */
  dimensions: number;
}

/** Open (and migrate) the SQLite index at `path` (':memory:' for tests). */
export function openIndexDb(path: string, config: IndexConfig): Db {
  const db = new Database(path);
  sqliteVec.load(db);
  if (path !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.transaction(() => {
    db.exec(SCHEMA_SQL);
    if (config.provider !== "none" && config.dimensions > 0) {
      db.exec(vecTableSql(config.dimensions));
    }
    const set = db.prepare(
      "INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    );
    set.run("schema_version", String(SCHEMA_VERSION));
    set.run("embed_provider", config.provider);
    set.run("embed_dimensions", String(config.dimensions));
  })();
  return db;
}

/** True when the stored embedding space differs from the configured one (forces rebuild). */
export function embeddingSpaceChanged(db: Db, config: IndexConfig): boolean {
  const get = db.prepare("select value from schema_meta where key=?");
  const prov = (get.get("embed_provider") as { value: string } | undefined)?.value;
  const dim = (get.get("embed_dimensions") as { value: string } | undefined)?.value;
  return prov !== config.provider || dim !== String(config.dimensions);
}
