// `krimto tag <id> +tag1 -tag2 ...` — add or remove tags on a fact. Each change is one argv item
// prefixed with `+` (add) or `-` (remove). New tags must match the lowercase-kebab-case rule
// enforced by `validateFrontmatter`; the command refuses the whole batch on the first invalid
// tag instead of half-applying.
//
// Path is the same as `edit`: rewrite frontmatter, write the file, reindex via the writeQueue,
// stage the change in git. Refuses while a Krimto server holds the lock.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { canWrite } from "../access/membership";
import {
  applyTagChanges,
  serializeFact,
  toIsoUtc,
  type Fact,
} from "../storage/fact";
import { buildCliContext, getLockHolder } from "./cliRuntime";

export interface TagOptions {
  dataDir: string;
  identity: string;
  id: string;
  /** Raw change specs (e.g. ["+rule", "+ci", "-deprecated"]). */
  changes: string[];
}

export interface TagResult {
  status: "ok" | "lock_held" | "not_found" | "forbidden" | "invalid_change" | "no-change" | "error";
  message: string;
}

/** Parse the +tag / -tag specs. Returns {add, remove} or throws on a malformed spec. */
export function parseTagChanges(specs: string[]): { add: string[]; remove: string[] } {
  const add: string[] = [];
  const remove: string[] = [];
  for (const raw of specs) {
    if (raw.startsWith("+")) add.push(raw.slice(1));
    else if (raw.startsWith("-")) remove.push(raw.slice(1));
    else throw new Error(`Tag spec must start with '+' or '-': "${raw}"`);
  }
  return { add, remove };
}

export async function runTag(opts: TagOptions): Promise<TagResult> {
  const heldBy = await getLockHolder(opts.dataDir);
  if (heldBy) {
    return {
      status: "lock_held",
      message: `\n🔴 Cannot tag while a Krimto server is running (PID ${heldBy.pid}).\n`,
    };
  }

  let changes: { add: string[]; remove: string[] };
  try {
    changes = parseTagChanges(opts.changes);
  } catch (e) {
    return {
      status: "invalid_change",
      message:
        `\n🔴 ${e instanceof Error ? e.message : String(e)}\n` +
        `\n   Usage:  krimto tag <id> +new-tag -old-tag ...\n`,
    };
  }
  if (changes.add.length === 0 && changes.remove.length === 0) {
    return {
      status: "no-change",
      message: `\n(No tag changes given — usage: krimto tag <id> +new -old)\n`,
    };
  }

  const { ctx, close } = await buildCliContext({
    dataDir: opts.dataDir,
    identity: opts.identity,
  });
  try {
    const found = await ctx.store.readFact(opts.id);
    if (!found) {
      return { status: "not_found", message: `\n🔴 Fact ${opts.id} not found.\n` };
    }
    if (!canWrite(ctx.membership, opts.identity, found.fact.frontmatter.scope)) {
      return {
        status: "forbidden",
        message: `\n🔴 Not allowed to edit ${found.fact.frontmatter.scope}.\n`,
      };
    }

    const result = applyTagChanges(found.fact.frontmatter, changes);
    if (result.status === "no-change") {
      return { status: "no-change", message: `\nNo change — tags already as requested.\n` };
    }
    if (result.status === "invalid") {
      return {
        status: "invalid_change",
        message:
          `\n🔴 Tag validation failed:\n` +
          result.issues.map((v) => `   • ${v.field}: ${v.message}`).join("\n") +
          `\n\n   Tags must be lowercase kebab-case (a-z, 0-9, dashes).\n`,
      };
    }

    const fm = { ...result.frontmatter, updated: toIsoUtc(new Date()) };
    const next: Fact = { frontmatter: fm, body: found.fact.body };
    const absPath = path.join(ctx.store.dataDir(), found.path);

    await ctx.writeQueue.run(async () => {
      await fs.writeFile(absPath, serializeFact(next), "utf8");
      await ctx.index.upsertFact(next);
      if (ctx.git) await ctx.git.stage(found.path, next);
    });
    if (ctx.activity) {
      const summary = [
        ...changes.add.map((t) => `+${t}`),
        ...changes.remove.map((t) => `-${t}`),
      ].join(" ");
      await ctx.activity.record(
        "krimto_tag",
        opts.identity,
        `${fm.scope}: ${fm.title} (${fm.id}) ${summary}`,
      );
    }

    return {
      status: "ok",
      message:
        `\n✅ Tags updated on ${opts.id}\n` +
        `\n   Before: ${result.before.join(", ") || "(none)"}\n` +
        `   After:  ${result.after.join(", ") || "(none)"}\n`,
    };
  } finally {
    await close();
  }
}
