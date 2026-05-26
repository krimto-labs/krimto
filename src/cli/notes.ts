// `krimto notes [query]` — the read-only daily-flow command. Two modes:
//   • no query  → list every readable note grouped by plain-English scope label
//   • with query → run `krimtoRecall` and print ranked results with the same grouping
//
// Read-only: doesn't go through the lock-holder check, doesn't open the git repo. SQLite WAL
// allows concurrent readers, so this is safe to run while a Krimto server is running.

import { canRead, type Membership } from "../access/membership";
import { krimtoRecall, type RecallHit } from "../server/tools";
import { buildCliContext, scopeLabel, scopeSortKey } from "./cliRuntime";

export interface NotesOptions {
  dataDir: string;
  identity: string;
  /** Search query. When undefined or blank, lists all readable notes. */
  query?: string;
  /** Cap the number of rows displayed. Defaults to 50 (matches FactIndex.listFacts default). */
  limit?: number;
}

export interface NotesResult {
  status: "ok";
  message: string;
}

/** Entry point. Builds a read-only context, runs the query (or list), and renders the result. */
export async function runNotes(opts: NotesOptions): Promise<NotesResult> {
  const { ctx, close } = await buildCliContext({
    dataDir: opts.dataDir,
    identity: opts.identity,
    readOnly: true,
  });
  try {
    if (opts.query && opts.query.trim() !== "") {
      const { results } = await krimtoRecall(ctx, {
        query: opts.query,
        limit: opts.limit ?? 50,
      });
      return {
        status: "ok",
        message: renderSearch(opts.query, results, ctx.membership, opts.identity),
      };
    }
    const readableScopes = ctx.index
      .allScopes()
      .filter((s) => canRead(ctx.membership, opts.identity, s));
    const rows = ctx.index.listFacts(readableScopes, opts.limit ?? 50);
    return {
      status: "ok",
      message: renderList(rows, ctx.membership, opts.identity),
    };
  } finally {
    await close();
  }
}

interface ListRow {
  id: string;
  scope: string;
  title: string;
  author: string;
  updated: string;
}

function renderList(rows: ListRow[], membership: Membership, viewer: string): string {
  if (rows.length === 0) {
    return (
      `\nNo notes yet.\n` +
      `\nIn any AI chat, say "remember <something>" and a fact lands here.\n`
    );
  }
  // Group by scope, sort scopes by precedence (user/team/org), then notes within each by recency.
  const byScope = new Map<string, ListRow[]>();
  for (const r of rows) {
    const list = byScope.get(r.scope) ?? [];
    list.push(r);
    byScope.set(r.scope, list);
  }
  const scopes = [...byScope.keys()].sort((a, b) => {
    const k = scopeSortKey(a) - scopeSortKey(b);
    return k !== 0 ? k : a.localeCompare(b);
  });

  let out = `\nKrimto — your AI memory · ${rows.length} note${rows.length === 1 ? "" : "s"}\n`;
  for (const scope of scopes) {
    const inScope = byScope.get(scope)!;
    inScope.sort((a, b) => b.updated.localeCompare(a.updated)); // newest first
    out += `\n━━ ${scopeLabel(scope, viewer, membership)} (${inScope.length} note${
      inScope.length === 1 ? "" : "s"
    }) ━━\n\n`;
    for (const r of inScope) {
      out += `  ●  ${r.title}\n`;
      out += `     ${humanAgo(r.updated)} · saved by ${r.author === viewer ? "you" : r.author}  (id: ${r.id})\n`;
    }
  }
  out += `\nDaily commands:  edit <id> · mv <id> <scope> · supersede <id> · tag <id> +new -old\n`;
  return out;
}

function renderSearch(
  query: string,
  hits: RecallHit[],
  membership: Membership,
  viewer: string,
): string {
  if (hits.length === 0) {
    return (
      `\nNo matches for "${query}".\n` +
      `\nHints:\n` +
      `  • Try different words — recall is keyword-based unless you turned on semantic search.\n` +
      `  • Run \`krimto notes\` with no query to see what's in there.\n`
    );
  }
  let out = `\nSearch: "${query}" — ${hits.length} match${hits.length === 1 ? "" : "es"}\n\n`;
  for (const h of hits) {
    out += `  ●  ${h.title}  (score ${h.score.toFixed(2)})\n`;
    out += `     in ${scopeLabel(h.scope, viewer, membership)} · ${humanAgo(h.updated)} · by ${
      h.author === viewer ? "you" : h.author
    }  (id: ${h.id})\n`;
  }
  return out;
}

function humanAgo(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const secs = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
