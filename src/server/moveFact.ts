// Move a fact between scopes — used by the web UI's "Move" dropdown. Same atomic write
// pipeline as `editFact` + the per-note CLI `mv`: writeQueue → write new file → unlink old →
// index upsert (same id, new scope row) → stage both file changes in git.
//
// Distinguished from `src/cli/mv.ts` only by the entry shape (takes ctx + scope strings instead
// of building its own context). Could be a shared core later — leaving as parallel implementations
// to keep the v0.2.17-3 surgical.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { canWrite } from "../access/membership";
import { isValidScope } from "../access/scope";
import { toIsoUtc, type Fact } from "../storage/fact";
import { type ToolContext } from "./tools";
import { KrimtoError } from "./errors";

export interface MoveFactResult {
  id: string;
  oldScope: string;
  newScope: string;
  /** Project-relative path of the new file (where it lives after the move). */
  newPath: string;
}

const PERSONAL_ALIASES = new Set(["user/me", "user/self", "me", "self"]);

/**
 * Move `id` to `newScope`. The fact's id is preserved; `updated` is bumped.
 *
 * Throws `KrimtoError`:
 *   • `not_found` when the id doesn't exist
 *   • `forbidden` when the caller lacks `canWrite` on either side
 *   • `invalid_params` when `newScope` doesn't parse OR when the source equals the target
 */
export async function moveFact(
  ctx: ToolContext,
  id: string,
  newScopeRaw: string,
): Promise<MoveFactResult> {
  const newScope = PERSONAL_ALIASES.has(newScopeRaw.trim().toLowerCase())
    ? `user/${ctx.requester.identity}`
    : newScopeRaw.trim();
  if (!isValidScope(newScope)) {
    throw new KrimtoError("invalid_params", `Invalid scope: ${newScopeRaw}`, { field: "scope" });
  }
  const stored = await ctx.store.readFact(id);
  if (!stored) throw new KrimtoError("not_found", `Fact ${id} not found`, { id });
  const oldScope = stored.fact.frontmatter.scope;
  if (oldScope === newScope) {
    throw new KrimtoError("invalid_params", `Already in ${oldScope}`, { scope: oldScope });
  }
  if (!canWrite(ctx.membership, ctx.requester.identity, oldScope)) {
    throw new KrimtoError("forbidden", `Not allowed to remove from ${oldScope}`, { scope: oldScope });
  }
  if (!canWrite(ctx.membership, ctx.requester.identity, newScope)) {
    throw new KrimtoError("forbidden", `Not allowed to write to ${newScope}`, { scope: newScope });
  }

  const next: Fact = {
    frontmatter: { ...stored.fact.frontmatter, scope: newScope, updated: toIsoUtc(new Date()) },
    body: stored.fact.body,
  };

  const oldRelPath = stored.path;
  const oldAbsPath = path.join(ctx.store.dataDir(), oldRelPath);
  let newRelPath: string = oldRelPath; // overwritten by writeFactExact below

  await ctx.writeQueue.run(async () => {
    const written = await ctx.store.writeFactExact(next);
    newRelPath = written.path;
    try {
      await fs.unlink(oldAbsPath);
    } catch (e) {
      process.stderr.write(
        `krimto: old file unlink failed during move (ignored): ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
    await ctx.index.upsertFact(next); // same id → row updated in place
    if (ctx.git) {
      await ctx.git.stage(written.path, next);
      // Stage the deletion. `git add -- <path>` errors when the file was never tracked (e.g.
      // we wrote and moved within one batcher window). Swallow that case — see src/cli/mv.ts
      // for the same handling.
      try {
        await ctx.git.stage(oldRelPath, stored.fact);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/did not match any files/.test(msg)) throw e;
      }
    }
  });

  if (ctx.activity) {
    await ctx.activity.record(
      "krimto_move",
      ctx.requester.identity,
      `${id}: ${oldScope} → ${newScope}`,
    );
  }

  return { id, oldScope, newScope, newPath: newRelPath };
}
