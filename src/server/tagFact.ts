// Add/remove tags on a fact — used by the web UI's inline "Edit tags" form. Mirrors editFact.ts:
// the file write + index upsert + git stage run through ctx.writeQueue so a web tag edit goes through
// the same atomic critical section as an MCP write. The tag-set math + validation are shared with
// `krimto tag` via applyTagChanges (src/storage/fact.ts).

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { canWrite } from "../access/membership";
import { applyTagChanges, serializeFact, toIsoUtc, type Fact, type TagChange } from "../storage/fact";
import { type ToolContext } from "./tools";
import { KrimtoError } from "./errors";

export interface TagFactResult {
  id: string;
  scope: string;
  /** The resulting (sorted) tag set. */
  tags: string[];
  /** Absolute path to the markdown file on disk after the write. */
  absolute_path: string;
}

/**
 * Apply a {@link TagChange} to a fact. Throws `KrimtoError`:
 *   • `not_found`      when the id doesn't exist (or the caller can't see it)
 *   • `forbidden`      when the caller lacks `canWrite` on the fact's scope
 *   • `invalid_params` when a resulting tag fails the kebab-case rule
 *
 * A no-op change (resulting set equals the current one) returns the current tags without writing.
 */
export async function tagFact(ctx: ToolContext, id: string, change: TagChange): Promise<TagFactResult> {
  const stored = await ctx.store.readFact(id);
  if (!stored) {
    throw new KrimtoError("not_found", `Fact ${id} not found`, { id });
  }
  const scope = stored.fact.frontmatter.scope;
  if (!canWrite(ctx.membership, ctx.requester.identity, scope)) {
    throw new KrimtoError("forbidden", `Not allowed to edit ${scope}`, { scope });
  }
  const absPath = path.join(ctx.store.dataDir(), stored.path);

  const result = applyTagChanges(stored.fact.frontmatter, change);
  if (result.status === "no-change") {
    return { id, scope, tags: result.tags, absolute_path: absPath };
  }
  if (result.status === "invalid") {
    throw new KrimtoError("invalid_params", result.issues.map((i) => i.message).join("; "), {
      field: "tags",
    });
  }

  const next: Fact = {
    frontmatter: { ...result.frontmatter, updated: toIsoUtc(new Date()) },
    body: stored.fact.body,
  };
  await ctx.writeQueue.run(async () => {
    await fs.writeFile(absPath, serializeFact(next), "utf8");
    await ctx.index.upsertFact(next);
    if (ctx.git) await ctx.git.stage(stored.path, next);
  });
  if (ctx.activity) {
    await ctx.activity.record(
      "krimto_tag",
      ctx.requester.identity,
      `${scope}: ${next.frontmatter.title} (${id}) → ${result.after.join(", ") || "(none)"}`,
    );
  }
  return { id, scope, tags: result.after, absolute_path: absPath };
}

/**
 * Parse a free-text tag field (the web editor submits the whole set, space- or comma-separated)
 * into a deduped token list. Validation (kebab-case) happens downstream in applyTagChanges.
 */
export function parseTagInput(raw: string): string[] {
  const seen = new Set<string>();
  for (const token of raw.split(/[\s,]+/)) {
    const t = token.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

/** Diff a desired full tag set against the current one into the add/remove shape applyTagChanges wants. */
export function diffTags(current: string[], desired: string[]): TagChange {
  const cur = new Set(current);
  const des = new Set(desired);
  return {
    add: [...des].filter((t) => !cur.has(t)),
    remove: [...cur].filter((t) => !des.has(t)),
  };
}
