// `krimto supersede <id>` — replace a fact with a new version. The old fact stays in git history
// (and stays in the index too — but is excluded from recall by FactIndex's supersededIds filter).
//
// Flow: load the old fact, open its body in $EDITOR (the user replaces it with the new version),
// then call the existing `krimtoSupersede` MCP-tool function with the result. Reuses everything
// from the canonical write pipeline — no new write logic.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { canWrite } from "../access/membership";
import { krimtoSupersede } from "../server/tools";
import { buildCliContext, getLockHolder } from "./cliRuntime";
import { KrimtoError } from "../server/errors";

export interface SupersedeOptions {
  dataDir: string;
  identity: string;
  id: string;
  /** Editor binary. Defaults to $EDITOR then `vi`. */
  editor?: string;
  /** Override the editor invocation entirely with a callback (tests use this). */
  editorImpl?: (filePath: string) => Promise<void>;
  /** Optional new title (defaults to the old fact's title). */
  newTitle?: string;
  /** Optional human reason recorded in the commit message. Defaults to a stock string. */
  reason?: string;
  /** Pass the new body directly, skipping the $EDITOR step. Tests / scripts use this. */
  newBody?: string;
}

export interface SupersedeResult {
  status: "ok" | "lock_held" | "not_found" | "forbidden" | "no-change" | "error";
  message: string;
}

export async function runSupersede(opts: SupersedeOptions): Promise<SupersedeResult> {
  const heldBy = await getLockHolder(opts.dataDir);
  if (heldBy) {
    return {
      status: "lock_held",
      message:
        `\n🔴 Cannot supersede while a Krimto server is running (PID ${heldBy.pid}).\n`,
    };
  }

  const { ctx, close } = await buildCliContext({
    dataDir: opts.dataDir,
    identity: opts.identity,
  });
  try {
    const old = ctx.index.getFact(opts.id);
    if (!old) {
      return {
        status: "not_found",
        message: `\n🔴 Fact ${opts.id} not found.\n`,
      };
    }
    if (!canWrite(ctx.membership, opts.identity, old.frontmatter.scope)) {
      return {
        status: "forbidden",
        message: `\n🔴 Not allowed to supersede in ${old.frontmatter.scope}.\n`,
      };
    }

    // Collect the new body — either from --newBody (tests/scripts) or by spawning $EDITOR with
    // the old body pre-loaded.
    let newBody = opts.newBody;
    if (newBody === undefined) {
      newBody = await editInTempFile(
        old.body,
        opts.editor ?? process.env.EDITOR ?? "vi",
        opts.editorImpl,
      );
    }

    if (newBody.trim() === "" || newBody.trim() === old.body.trim()) {
      return { status: "no-change", message: `\n(No changes saved.)\n` };
    }

    try {
      const res = await krimtoSupersede(ctx, {
        id: opts.id,
        new_title: opts.newTitle ?? old.frontmatter.title,
        new_body: newBody,
        reason: opts.reason ?? `Edited via krimto supersede`,
      });
      return {
        status: "ok",
        message:
          `\n✅ Superseded ${res.old_id}\n` +
          `\n   New id: ${res.new_id}\n` +
          `   File:   ${res.absolute_path}\n` +
          `\n   The old version stays in git history — \`git log -- ${res.absolute_path}\`\n` +
          `   surfaces both versions.\n`,
      };
    } catch (e) {
      if (e instanceof KrimtoError) {
        return { status: "error", message: `\n🔴 ${e.message}\n` };
      }
      return {
        status: "error",
        message: `\n🔴 Supersede failed: ${e instanceof Error ? e.message : String(e)}\n`,
      };
    }
  } finally {
    await close();
  }
}

async function editInTempFile(
  initialBody: string,
  editor: string,
  editorImpl?: (filePath: string) => Promise<void>,
): Promise<string> {
  const tmpFile = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "krimto-supersede-")),
    "new-version.md",
  );
  await fs.writeFile(tmpFile, initialBody, "utf8");

  if (editorImpl) {
    await editorImpl(tmpFile);
  } else {
    const [cmd, ...args] = editor.split(/\s+/);
    if (!cmd) throw new Error(`Empty $EDITOR command`);
    // `spawn` (not `execFile`) so `stdio: "inherit"` actually takes effect — the child editor
    // needs the parent's TTY for its UI. Resolve on exit regardless of exit code (vim's `:cq`).
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, [...args, tmpFile], { stdio: "inherit" });
      child.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          reject(new Error(`Editor "${cmd}" not found on PATH. Set $EDITOR or pass --editor=...`));
          return;
        }
        reject(err);
      });
      child.on("exit", () => resolve());
    });
  }

  const body = await fs.readFile(tmpFile, "utf8");
  // Best-effort cleanup; ignore if the tempdir is already gone.
  await fs.rm(path.dirname(tmpFile), { recursive: true, force: true }).catch(() => undefined);
  return body;
}
