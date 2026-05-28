// Gap 09 schema, anchored to the Build Spec. facts_vec dimension is provider-driven
// (divergence: spec hardcodes float[1536]); FTS5 is an external-content table kept in
// sync by triggers (canonical sqlite.org pattern).

// Bumped to 2 in v0.2.38: facts_fts gains the Porter stemmer so a singular query ("favorite
// color") matches a plural-titled fact ("Favorite colors"). openIndexDb migrates older indexes
// by dropping + recreating facts_fts and rebuilding it from the content table.
export const SCHEMA_VERSION = 2;

/** Static DDL (everything except the dimension-parameterized vec table). */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS facts (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  author     TEXT NOT NULL,
  created    TEXT NOT NULL,
  updated    TEXT NOT NULL,
  tags       TEXT,
  source     TEXT,
  supersedes TEXT,
  expires    TEXT,
  body_hash  TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  title, body, tags, content='facts', content_rowid='rowid', tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, title, body, tags) VALUES('delete', old.rowid, old.title, old.body, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, title, body, tags) VALUES('delete', old.rowid, old.title, old.body, old.tags);
  INSERT INTO facts_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;

CREATE TABLE IF NOT EXISTS embedding_cache (
  body_hash TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  created   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Dimension-parameterized vec table (cosine distance). Skipped when no provider. */
export function vecTableSql(dimensions: number): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS facts_vec USING vec0(
  fact_id TEXT PRIMARY KEY,
  embedding FLOAT[${dimensions}] distance_metric=cosine
);`;
}
