// `krimto mv <id> <new-scope>` — move a fact between scopes while preserving its id.
//
// Implementation: load the fact, rewrite its `scope` + `updated` fields, write to the new scope
// directory (which lives at <dataDir>/<kind>/<id>/<slug>.md), delete the old `.md`, and let the
// index upsert overwrite the existing row (same id key). Goes through the write Serializer so
// the file move + index update + git stage are atomic from the perspective of any concurrent
// reader.
//
// Refuses if the caller lacks `canWrite` on EITHER side — moving requires permission to remove
// the source and add the destination.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { canWrite } from "../access/membership";
import { isValidScope } from "../access/scope";
import { toIsoUtc, type Fact } from "../storage/fact";
import { buildCliContext, getLockHolder } from "./cliRuntime";

export interface MvOptions {
  dataDir: string;
  identity: string;
  id: string;
  /** Target scope (e.g. "team/backend", "user/me"). `user/me` resolves to the caller's identity. */
  newScope: string;
}

export interface MvResult {
  status: "ok" | "lock_held" | "not_found" | "forbidden" | "invalid_scope" | "no-change" | "error";
  message: string;
}

const PERSONAL_ALIASES = new Set(["user/me", "user/self", "me", "self"]);

export async function runMv(opts: MvOptions): Promise<MvResult> {
  const heldBy = await getLockHolder(opts.dataDir);
  if (heldBy) {
    return {
      status: "lock_held",
      message:
        `\n🔴 Cannot move while a Krimto server is running\n` +
        `\n   PID ${heldBy.pid} (${heldBy.mode}). Stop it first:  $ kill ${heldBy.pid}\n`,
    };
  }

  // Resolve the personal alias and validate.
  const newScope = PERSONAL_ALIASES.has(opts.newScope.trim().toLowerCase())
    ? `user/${opts.identity}`
    : opts.newScope.trim();
  if (!isValidScope(newScope)) {
    return {
      status: "invalid_scope",
      message:
        `\n🔴 Invalid scope: "${opts.newScope}"\n` +
        `\n   Expected one of:\n` +
        `     user/me       (or user/<your-email>)\n` +
        `     team/<slug>   (e.g. team/backend)\n` +
        `     org/<slug>    (org admins only)\n`,
    };
  }

  const { ctx, close } = await buildCliContext({
    dataDir: opts.dataDir,
    identity: opts.identity,
  });
  try {
    const found = await ctx.store.readFact(opts.id);
    if (!found) {
      return {
        status: "not_found",
        message: `\n🔴 Fact ${opts.id} not found in the markdown store.\n`,
      };
    }
    const oldScope = found.fact.frontmatter.scope;
    if (oldScope === newScope) {
      return { status: "no-change", message: `\nAlready in ${oldScope} — nothing to do.\n` };
    }
    if (!canWrite(ctx.membership, opts.identity, oldScope)) {
      return {
        status: "forbidden",
        message: `\n🔴 Not allowed to remove from ${oldScope}.\n`,
      };
    }
    if (!canWrite(ctx.membership, opts.identity, newScope)) {
      return {
        status: "forbidden",
        message: `\n🔴 Not allowed to write to ${newScope}.\n`,
      };
    }

    const next: Fact = {
      frontmatter: {
        ...found.fact.frontmatter,
        scope: newScope,
        updated: toIsoUtc(new Date()),
      },
      body: found.fact.body,
    };

    const oldRelPath = found.path;
    const oldAbsPath = path.join(ctx.store.dataDir(), oldRelPath);
    let newRelPath: string | null = null;

    await ctx.writeQueue.run(async () => {
      // Write to the new scope dir first (writeFactExact handles slug collisions).
      const written = await ctx.store.writeFactExact(next);
      newRelPath = written.path;
      // Remove the old file. If the unlink fails (file already gone), continue — the index
      // upsert is the authoritative state.
      try {
        await fs.unlink(oldAbsPath);
      } catch (e) {
        process.stderr.write(
          `krimto: old file unlink failed (ignored): ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
      await ctx.index.upsertFact(next); // same id → replaces the existing index row
      if (ctx.git) {
        // Stage the new file. The CommitBatcher pushes `next` onto its pending list — the
        // commit message will mention the destination.
        await ctx.git.stage(written.path, next);
        // Stage the deletion of the old file. `git add -- <path>` picks up a removed file as a
        // staged deletion AS LONG AS the file was previously committed. For a fact that was
        // written in the same batcher window as the move (so never committed yet), `git add`
        // errors with "did not match any files" — harmless because there's nothing for git to
        // track. Swallow that case; rethrow anything unexpected.
        try {
          await ctx.git.stage(oldRelPath, found.fact);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!/did not match any files/.test(msg)) throw e;
        }
      }
    });

    if (ctx.activity) {
      await ctx.activity.record(
        "krimto_move",
        opts.identity,
        `${opts.id}: ${oldScope} → ${newScope}`,
      );
    }

    return {
      status: "ok",
      message:
        `\n✅ Moved ${opts.id}\n` +
        `\n   From: ${oldScope}  (${oldRelPath})\n` +
        `   To:   ${newScope}  (${newRelPath ?? "<pending>"})\n` +
        `\n   Git stages both the removal and the new file; a commit lands within 30s.\n`,
    };
  } finally {
    await close();
  }
}
