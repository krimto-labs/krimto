// Hard delete of a fact — removes the .md file, drops the index entry, and stages a git deletion.
// Not exposed as an MCP tool (the agent surface stays at 5 by design); reached only through the
// CLI (`krimto rm <id>`) and the `/ui` Delete button.
//
// Handles three failure modes gracefully:
//   • file present + index entry present → normal delete
//   • index entry present, file missing  → drop index entry, log a note (orphaned)
//   • file present, index entry missing  → delete file by scanning, log a note (orphaned)
//
// Audit trail is automatic: git tracks the deletion as a commit, so the fact lives on in
// `git log -- <path>` even after the working-tree file is gone.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { canWrite } from "../access/membership";
import { type Fact } from "../storage/fact";
import { KrimtoError } from "./errors";
import { type ToolContext } from "./tools";

export interface DeleteFactResult {
  id: string;
  scope: string;
  title: string;
  /** Relative path of the deleted .md, or null if the file was already missing (orphan in index). */
  path: string | null;
  /** "ok" — file removed; "orphan_index" — only the index entry existed; "orphan_file" — only the file. */
  status: "ok" | "orphan_index" | "orphan_file";
}

/**
 * Delete a fact by id. Goes through the write Serializer. Index update happens BEFORE the file
 * unlink — symmetric with `krimtoWrite`'s "index first" ordering, so a partial failure leaves
 * the markdown as the surviving source of truth (it can be re-indexed).
 */
export async function deleteFact(ctx: ToolContext, id: string): Promise<DeleteFactResult> {
  return ctx.writeQueue.run(async () => {
    const indexed = ctx.index.getFact(id);
    // Also try the markdown store — supports recovering "file present, index missing" orphans.
    const stored = await ctx.store.readFact(id).catch(() => null);
    if (!indexed && !stored) {
      throw new KrimtoError("not_found", `Fact ${id} not found in either index or markdown store`, { id });
    }
    const fact: Fact = (indexed ?? stored!.fact);
    if (!canWrite(ctx.membership, ctx.requester.identity, fact.frontmatter.scope)) {
      throw new KrimtoError("forbidden", `Not allowed to delete from ${fact.frontmatter.scope}`, {
        scope: fact.frontmatter.scope,
      });
    }

    // Drop the index entry first (safe — if the file unlink fails, a reindex can restore it).
    if (indexed) ctx.index.removeFact(id);

    let relPath: string | null = null;
    let status: DeleteFactResult["status"];
    if (stored) {
      relPath = stored.path;
      try {
        await fs.unlink(path.join(ctx.store.dataDir(), stored.path));
      } catch (e) {
        process.stderr.write(
          `krimto: file unlink failed (index entry already removed): ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
      status = indexed ? "ok" : "orphan_file";
    } else {
      status = "orphan_index";
    }

    if (ctx.git && relPath) {
      try {
        await ctx.git.commitDeletion(relPath, fact); // immediate commit (not batched)
      } catch (e) {
        process.stderr.write(
          `krimto: git commit of deletion failed (file is removed locally): ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }

    if (ctx.activity) await ctx.activity.record("krimto_delete", ctx.requester.identity, `${fact.frontmatter.scope}: ${fact.frontmatter.title} (${id}) — ${status}`);

    return {
      id,
      scope: fact.frontmatter.scope,
      title: fact.frontmatter.title,
      path: relPath,
      status,
    };
  });
}
