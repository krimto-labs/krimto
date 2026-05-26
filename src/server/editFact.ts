// Edit a fact's body in place — used by the web UI's "Edit" form. Mirrors the per-note write
// pipeline (write Serializer → markdown → index → git stage) so a web edit goes through the same
// atomic critical section as an MCP write.
//
// Scope is narrow on purpose: the web form only lets the user replace the body. Title, scope,
// tags, etc. are unchanged. The frontmatter `updated` timestamp is bumped to reflect the change.
//
// Separate from `src/cli/edit.ts` (which adds $EDITOR + lock check + immutable-field restoration
// for the case where the user might hand-edit the markdown). Same eventual outcome, different
// entry path.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { canWrite } from "../access/membership";
import { serializeFact, toIsoUtc, type Fact } from "../storage/fact";
import { type ToolContext } from "./tools";
import { KrimtoError } from "./errors";

export interface EditFactResult {
  id: string;
  scope: string;
  /** Absolute path to the markdown file on disk after the write. */
  absolute_path: string;
}

/**
 * Replace `fact.body` with `newBody`. Throws `KrimtoError`:
 *   • `not_found` when the id doesn't exist (or the caller can't see it)
 *   • `forbidden` when the caller lacks `canWrite` on the fact's scope
 *   • `invalid_params` when `newBody` is empty
 *
 * Goes through `ctx.writeQueue` so the file write + index upsert + git stage are atomic.
 */
export async function editFact(ctx: ToolContext, id: string, newBody: string): Promise<EditFactResult> {
  const trimmed = newBody.trim();
  if (trimmed === "") {
    throw new KrimtoError("invalid_params", "Body cannot be empty", { field: "body" });
  }
  const stored = await ctx.store.readFact(id);
  if (!stored) {
    throw new KrimtoError("not_found", `Fact ${id} not found`, { id });
  }
  if (!canWrite(ctx.membership, ctx.requester.identity, stored.fact.frontmatter.scope)) {
    throw new KrimtoError("forbidden", `Not allowed to edit ${stored.fact.frontmatter.scope}`, {
      scope: stored.fact.frontmatter.scope,
    });
  }
  const next: Fact = {
    frontmatter: { ...stored.fact.frontmatter, updated: toIsoUtc(new Date()) },
    body: newBody,
  };
  const absPath = path.join(ctx.store.dataDir(), stored.path);
  await ctx.writeQueue.run(async () => {
    await fs.writeFile(absPath, serializeFact(next), "utf8");
    await ctx.index.upsertFact(next);
    if (ctx.git) await ctx.git.stage(stored.path, next);
  });
  if (ctx.activity) {
    await ctx.activity.record(
      "krimto_edit",
      ctx.requester.identity,
      `${next.frontmatter.scope}: ${next.frontmatter.title} (${id})`,
    );
  }
  return { id, scope: next.frontmatter.scope, absolute_path: absPath };
}
