// `krimto edit <id>` — open a fact's markdown file in $EDITOR, re-read it on exit, validate, and
// push the changes through the same write pipeline (`FactIndex.upsertFact` + git stage) the MCP
// `krimtoWrite` tool uses. Immutable fields (id, scope, created, author) survive even if the
// user edits them in the file — they're restored from the pre-edit snapshot. Only `updated` is
// bumped to reflect the change.
//
// Refuses to run when another Krimto server holds the lock — the running server is the authority
// over both the markdown directory and the git index, and a CLI write here would race over both.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { canWrite } from "../access/membership";
import {
  parseFact,
  serializeFact,
  toIsoUtc,
  validateFrontmatter,
  type Fact,
} from "../storage/fact";
import { buildCliContext, getLockHolder } from "./cliRuntime";

export interface EditOptions {
  dataDir: string;
  identity: string;
  id: string;
  /** Editor binary to spawn. Defaults to `$EDITOR` then `vi`. */
  editor?: string;
  /**
   * Override the editor invocation entirely with a callback that receives the file path.
   * Tests use this to "edit" the file without spawning a real editor; production omits it.
   */
  editorImpl?: (filePath: string) => Promise<void>;
}

export interface EditResult {
  status: "ok" | "no-change" | "lock_held" | "not_found" | "forbidden" | "invalid_frontmatter" | "error";
  message: string;
}

export async function runEdit(opts: EditOptions): Promise<EditResult> {
  const heldBy = await getLockHolder(opts.dataDir);
  if (heldBy) {
    return {
      status: "lock_held",
      message:
        `\n🔴 Cannot edit while a Krimto server is running\n` +
        `\n   Held by PID ${heldBy.pid} (mode ${heldBy.mode}, started ${heldBy.started})\n` +
        `\n   Stop it first:  $ kill ${heldBy.pid}\n` +
        `   Then re-run:   $ krimto edit ${opts.id}\n`,
    };
  }

  const { ctx, close } = await buildCliContext({
    dataDir: opts.dataDir,
    identity: opts.identity,
  });
  try {
    const before = await ctx.store.readFact(opts.id);
    if (!before) {
      return {
        status: "not_found",
        message: `\n🔴 Fact ${opts.id} not found in the markdown store.\n`,
      };
    }
    if (!canWrite(ctx.membership, opts.identity, before.fact.frontmatter.scope)) {
      return {
        status: "forbidden",
        message: `\n🔴 Not allowed to edit ${before.fact.frontmatter.scope}.\n`,
      };
    }

    const absPath = path.join(ctx.store.dataDir(), before.path);
    if (opts.editorImpl) {
      await opts.editorImpl(absPath);
    } else {
      const editor = opts.editor ?? process.env.EDITOR ?? "vi";
      await spawnEditor(editor, absPath);
    }

    const afterText = await fs.readFile(absPath, "utf8");
    let after: Fact;
    try {
      after = parseFact(afterText);
    } catch (e) {
      return {
        status: "invalid_frontmatter",
        message:
          `\n🔴 The file's frontmatter is no longer valid YAML.\n` +
          `\n   ${e instanceof Error ? e.message : String(e)}\n` +
          `\n   The original is still on disk — re-open it and fix the markers:\n` +
          `     $ ${opts.editor ?? process.env.EDITOR ?? "vi"} ${absPath}\n`,
      };
    }

    // Restore immutable fields. They're server-controlled — if the user edited them in their
    // editor we silently restore so the index stays consistent. `updated` will be bumped below.
    const fm = { ...before.fact.frontmatter, ...after.frontmatter };
    fm.id = before.fact.frontmatter.id;
    fm.scope = before.fact.frontmatter.scope;
    fm.created = before.fact.frontmatter.created;
    fm.author = before.fact.frontmatter.author;

    const validation = validateFrontmatter(fm);
    if (validation.length > 0) {
      return {
        status: "invalid_frontmatter",
        message:
          `\n🔴 Validation errors after edit:\n` +
          validation.map((v) => `   • ${v.field}: ${v.message}`).join("\n") +
          `\n`,
      };
    }

    if (after.body === before.fact.body && jsonEqualFm(after.frontmatter, before.fact.frontmatter)) {
      return {
        status: "no-change",
        message: `\n(No changes saved.)\n`,
      };
    }

    fm.updated = toIsoUtc(new Date());
    const next: Fact = { frontmatter: fm, body: after.body };

    await ctx.writeQueue.run(async () => {
      await ctx.index.upsertFact(next);
      await fs.writeFile(absPath, serializeFact(next), "utf8");
      if (ctx.git) await ctx.git.stage(before.path, next);
    });
    if (ctx.activity) {
      await ctx.activity.record(
        "krimto_edit",
        opts.identity,
        `${fm.scope}: ${fm.title} (${fm.id})`,
      );
    }

    return {
      status: "ok",
      message:
        `\n✅ Saved ${opts.id}\n` +
        `\n   ${absPath}\n` +
        `\n   Git stages the change immediately; a commit lands within 30s once a flush runs.\n`,
    };
  } finally {
    await close();
  }
}

async function spawnEditor(editor: string, file: string): Promise<void> {
  // `child_process.execFile` runs the editor inheriting the parent's stdio so the user sees the
  // editor's TUI directly. Resolve when the editor exits, regardless of exit code (the user may
  // have :cq'd to discard — we still re-read the file).
  const [cmd, ...args] = editor.split(/\s+/);
  if (!cmd) throw new Error(`Empty $EDITOR command`);
  await new Promise<void>((resolve, reject) => {
    const child = execFile(cmd, [...args, file], { stdio: "inherit" } as unknown as object, (err) => {
      // Non-zero exit is normal for editors like vim (`:cq`). We swallow and resolve.
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`Editor "${cmd}" not found on PATH. Set $EDITOR or pass --editor=...`));
        return;
      }
      resolve();
    });
    // execFile with stdio: "inherit" requires us to also configure it explicitly via the child;
    // node's typings put `stdio` on options but it works at runtime. Belt-and-braces fallback:
    if (child.stdin) child.stdin.pipe(process.stdin); // no-op when inherit already wired it
  });
}

function jsonEqualFm(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
