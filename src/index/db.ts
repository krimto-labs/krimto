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
    // A virtual table's tokenizer is fixed at CREATE; `CREATE ... IF NOT EXISTS` won't change an
    // existing facts_fts. So when an older index is opened, drop facts_fts + its sync triggers,
    // let SCHEMA_SQL recreate them with the current tokenizer, then rebuild the FTS index from the
    // (untouched) content table. The `facts` rows survive — only the derived FTS index is rebuilt.
    const prior = readStoredSchemaVersion(db);
    const ftsMigration = prior !== null && prior < SCHEMA_VERSION;
    if (ftsMigration) {
      db.exec(
        "DROP TRIGGER IF EXISTS facts_ai; DROP TRIGGER IF EXISTS facts_ad; DROP TRIGGER IF EXISTS facts_au; DROP TABLE IF EXISTS facts_fts;",
      );
    }
    db.exec(SCHEMA_SQL);
    if (ftsMigration) {
      db.exec("INSERT INTO facts_fts(facts_fts) VALUES('rebuild');");
    }
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

/** The schema_version stored in a pre-existing index, or null when the table isn't there yet. */
function readStoredSchemaVersion(db: Db): number | null {
  try {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : null;
  } catch {
    return null; // schema_meta doesn't exist yet (fresh database)
  }
}

/** True when the stored embedding space differs from the configured one (forces rebuild). */
export function embeddingSpaceChanged(db: Db, config: IndexConfig): boolean {
  const get = db.prepare("select value from schema_meta where key=?");
  const prov = (get.get("embed_provider") as { value: string } | undefined)?.value;
  const dim = (get.get("embed_dimensions") as { value: string } | undefined)?.value;
  return prov !== config.provider || dim !== String(config.dimensions);
}
