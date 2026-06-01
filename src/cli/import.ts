// `krimto import <path>` — batch-import facts from a markdown file into the caller's personal
// scope. Every fact is written through the canonical `krimtoWrite` pipeline (src/server/tools.ts)
// so id + timestamps stay server-generated and the SQLite index, markdown store, and git stage
// all stay consistent — the import never reimplements persistence.
//
// The file is parsed deterministically (no LLM): split on H1 (`# `) headers, each header is a
// fact title and the text until the next header is its body. Krimto's own injected rule block
// (the `<!-- krimto:start -->` ... `<!-- krimto:end -->` markers it writes into CLAUDE.md /
// AGENTS.md during `krimto init`) is stripped first, so importing a project's own rules file
// never re-imports the standing rule — which would otherwise break idempotency on every run.
//
// Idempotent: each fact is keyed by a content hash of (title + body). Before writing, the caller's
// existing personal facts are hashed once into a set; any incoming fact whose hash is already
// present is skipped. A second run of the same file therefore imports zero new facts.
//
// Refuses to run while a live Krimto server holds the data-dir lock — the running server owns the
// markdown directory and the git index, and a concurrent CLI write here would race over both
// (same guard the other write-path CLI commands use: edit / mv / rm).

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { krimtoWrite } from "../server/tools";
import { buildCliContext, getLockHolder } from "./cliRuntime";

// Strip every marker-delimited Krimto rule block (`<!-- krimto:start -->` ... `<!-- krimto:end -->`
// — the markers from src/agentRule.ts). Normally there's one, but be tolerant of repeats.
const RULE_BLOCK_RE = /<!-- krimto:start -->[\s\S]*?<!-- krimto:end -->/g;

export interface ImportOptions {
  dataDir: string;
  identity: string;
  /** Path to the markdown file to import (e.g. ./CLAUDE.md). */
  filePath: string;
}

export interface ImportResult {
  status: "ok" | "not_found" | "lock_held" | "error";
  message: string;
  /** Facts written on this run. Present for status "ok". */
  imported?: number;
  /** Facts skipped as already-present duplicates. Present for status "ok". */
  skipped?: number;
}

export interface ParsedFact {
  title: string;
  body: string;
}

/**
 * Parse a markdown document into facts. Krimto's own rule block is stripped first, then the
 * document is split on H1 (`# `) headers: each header line is a fact title and the lines until
 * the next H1 (or EOF) are its body. Headers with an empty body are dropped — a bare title is
 * not a fact.
 */
export function parseFacts(markdown: string): ParsedFact[] {
  const cleaned = markdown.replace(RULE_BLOCK_RE, "");
  const facts: ParsedFact[] = [];
  const lines = cleaned.split(/\r?\n/);

  let title: string | null = null;
  let bodyLines: string[] = [];

  const flush = (): void => {
    if (title !== null) {
      const body = bodyLines.join("\n").trim();
      if (body !== "") facts.push({ title, body });
    }
    title = null;
    bodyLines = [];
  };

  for (const line of lines) {
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    if (h1) {
      flush();
      title = (h1[1] ?? "").trim();
    } else if (title !== null) {
      bodyLines.push(line);
    }
  }
  flush();
  return facts;
}

/** Stable dedup key for a fact: SHA-256 of `${title}\n${body}`. */
export function hashFact(title: string, body: string): string {
  return createHash("sha256").update(`${title}\n${body}`).digest("hex");
}

export async function runImport(opts: ImportOptions): Promise<ImportResult> {
  const heldBy = await getLockHolder(opts.dataDir);
  if (heldBy) {
    return {
      status: "lock_held",
      message:
        `\n🔴 Cannot import while a Krimto server is running\n` +
        `\n   PID ${heldBy.pid} (${heldBy.mode}). Stop it first:  $ kill ${heldBy.pid}\n`,
    };
  }

  let raw: string;
  try {
    raw = await fs.readFile(opts.filePath, "utf8");
  } catch {
    return {
      status: "not_found",
      message:
        `\n🔴 File not found: ${opts.filePath}\n` +
        `\n   Usage: krimto import <path>   e.g. krimto import ./CLAUDE.md\n`,
    };
  }

  const parsed = parseFacts(raw);
  if (parsed.length === 0) {
    return {
      status: "ok",
      imported: 0,
      skipped: 0,
      message:
        `\nNothing to import from ${opts.filePath}\n` +
        `\n   No facts found. Each fact is an "# H1 Title" header followed by body text.\n`,
    };
  }

  // A user may run `krimto import` before any server write has created the data dir; the SQLite
  // index can't open against a missing directory. Create it the same way `main()` does.
  await fs.mkdir(opts.dataDir, { recursive: true });

  const { ctx, close } = await buildCliContext({
    dataDir: opts.dataDir,
    identity: opts.identity,
  });
  try {
    const scope = `user/${opts.identity}`;

    // Seed the dedup set from the caller's existing personal facts so a re-run is a no-op.
    const seen = new Set<string>();
    for (const fact of await ctx.store.allFacts()) {
      if (fact.frontmatter.scope === scope) {
        seen.add(hashFact(fact.frontmatter.title, fact.body));
      }
    }

    let imported = 0;
    let skipped = 0;
    for (const fact of parsed) {
      const key = hashFact(fact.title, fact.body);
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      // Canonical write path: id + timestamps server-generated, index + markdown + git all in
      // one Serializer-coordinated step. source tags these as import-origin facts.
      await krimtoWrite(ctx, {
        scope: "user/me", // krimtoWrite resolves this to the caller's own user scope
        title: fact.title,
        body: fact.body,
        source: `import:${opts.filePath}`,
      });
      seen.add(key); // guard against duplicate facts within the same file
      imported++;
    }

    return {
      status: "ok",
      imported,
      skipped,
      message:
        `\n✅ Imported ${imported} fact${imported === 1 ? "" : "s"} from ${opts.filePath}` +
        (skipped > 0 ? ` (${skipped} already present, skipped)` : "") +
        `\n\n   Saved to ${scope}. Git stages each one; a commit lands within 30s.\n`,
    };
  } finally {
    await close();
  }
}
