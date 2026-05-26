// `krimto rm <id>` — hard-delete a fact: markdown file unlinked, index entry dropped, git records
// the deletion. Refuses if a Krimto server is running on this data dir (would race over the .git/
// index); the user must stop the server first.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { FactStore } from "../storage/store";
import { openIndexDb, type IndexConfig } from "../index/db";
import { FactIndex } from "../index/factIndex";
import { Serializer } from "../index/serialize";
import { GitRepo } from "../storage/git";
import { CommitBatcher, batcherConfigFromEnv } from "../storage/batcher";
import { ActivityLog } from "../server/activity";
import { isProcessAlive, type LockInfo } from "../server/lock";
import { loadMembership, requesterFor } from "../access/membership";
import { deleteFact } from "../server/deleteFact";
import { type ToolContext } from "../server/tools";
import { KrimtoError } from "../server/errors";
import { embeddingConfigFromEnv } from "../index/providers";

export interface DeleteCliResult {
  status: "ok" | "orphan_index" | "lock_held" | "not_found" | "forbidden" | "error";
  message: string;
}

/** Check whether a live Krimto server holds the data-dir lock. Returns lock info or null. */
async function checkLock(dataDir: string): Promise<LockInfo | null> {
  const lockFile = path.join(dataDir, ".krimto", "lock.json");
  try {
    const raw = await fs.readFile(lockFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof parsed.pid === "number" && isProcessAlive(parsed.pid) && parsed.pid !== process.pid) {
      return {
        pid: parsed.pid,
        started: typeof parsed.started === "string" ? parsed.started : "unknown",
        mode: (parsed.mode as LockInfo["mode"]) ?? "stdio",
      };
    }
  } catch {
    /* no lock file or unreadable — not running */
  }
  return null;
}

export async function runDeleteFact(dataDir: string, identity: string, id: string): Promise<DeleteCliResult> {
  const heldBy = await checkLock(dataDir);
  if (heldBy) {
    return {
      status: "lock_held",
      message:
        `\n🔴 Cannot delete while a Krimto server is running\n` +
        `\n   Held by PID ${heldBy.pid} (mode ${heldBy.mode}, started ${heldBy.started})\n` +
        `\n   Deleting bypasses the running server's write coordination and could leave the\n` +
        `   git index in a bad state. Stop the server first, then re-run:\n` +
        `\n     $ kill ${heldBy.pid}             # or Ctrl-C in the server's terminal\n` +
        `     $ npx @krimto-labs/krimto rm ${id}\n`,
    };
  }

  const embedCfg = embeddingConfigFromEnv();
  const indexConfig: IndexConfig = { provider: embedCfg.provider ?? "none", dimensions: 0 };
  const db = openIndexDb(path.join(dataDir, "index.db"), indexConfig);
  const store = new FactStore(dataDir);
  const index = new FactIndex(db);
  const membership = await loadMembership(dataDir);
  const repo = await GitRepo.open(dataDir);
  const batcher = new CommitBatcher(repo, batcherConfigFromEnv());
  const ctx: ToolContext = {
    store,
    index,
    writeQueue: new Serializer(),
    membership,
    requester: requesterFor(membership, identity),
    git: batcher,
    activity: new ActivityLog(dataDir),
  };

  try {
    const res = await deleteFact(ctx, id);
    const noteIfOrphan =
      res.status === "orphan_index"
        ? `\n   (Index entry was orphaned — the .md file was already missing.)`
        : res.status === "orphan_file"
          ? `\n   (Markdown file was found but the index didn't have an entry.)`
          : "";
    return {
      status: res.status === "ok" || res.status === "orphan_index" || res.status === "orphan_file" ? "ok" : "error",
      message:
        `\n✅ Deleted fact ${res.id}\n` +
        `\n   Title: ${res.title}\n` +
        `   Scope: ${res.scope}\n` +
        (res.path ? `   File:  ${res.path}\n` : "") +
        noteIfOrphan +
        `\n   Git has recorded the deletion as a commit — the fact lives on in\n` +
        `   \`git log\` even though the working-tree file is gone.\n`,
    };
  } catch (e) {
    if (e instanceof KrimtoError) {
      if (e.code === "not_found") {
        return {
          status: "not_found",
          message:
            `\n🔴 Fact ${id} not found\n` +
            `\n   Not in the index and not on disk. Tip:\n` +
            `     $ npx @krimto-labs/krimto reindex     # rebuild index from .md files\n` +
            `     $ npx @krimto-labs/krimto serve       # then browse /ui/facts to find the right id\n`,
        };
      }
      if (e.code === "forbidden") {
        return {
          status: "forbidden",
          message: `\n🔴 Not allowed to delete from ${(e.data as { scope?: string } | undefined)?.scope ?? "this scope"}.\n`,
        };
      }
    }
    return {
      status: "error",
      message: `\n🔴 Delete failed: ${e instanceof Error ? e.message : String(e)}\n`,
    };
  }
}
