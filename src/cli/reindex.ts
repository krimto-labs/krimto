// `krimto reindex` — rebuild `index.db` from the markdown source-of-truth on disk.
//
// Use cases:
//   • You manually deleted a .md file — the index still has the orphan entry. Reindex drops it.
//   • You manually edited a .md file (changed body/title) — the index still has the old version.
//   • index.db got corrupted or someone deleted it. Reindex regenerates it.
//
// Like `rm`, refuses if a server is running (the running server's open SQLite handle could see
// inconsistent state mid-rebuild). User stops the server first, then runs this.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { FactStore } from "../storage/store";
import { isProcessAlive, type LockInfo } from "../server/lock";
import { openCliIndex } from "./cliIndex";

export interface ReindexResult {
  status: "ok" | "lock_held" | "error";
  message: string;
}

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
        launchedBy: parsed.launchedBy === "service" ? "service" : "ad-hoc",
      };
    }
  } catch {
    /* no lock */
  }
  return null;
}

export async function runReindex(dataDir: string): Promise<ReindexResult> {
  const heldBy = await checkLock(dataDir);
  if (heldBy) {
    return {
      status: "lock_held",
      message:
        `\n🔴 Cannot reindex while a Krimto server is running\n` +
        `\n   Held by PID ${heldBy.pid} (mode ${heldBy.mode}, started ${heldBy.started})\n` +
        `\n   Stop the server first, then re-run:\n` +
        `     $ kill ${heldBy.pid}             # or Ctrl-C in the server's terminal\n` +
        `     $ npx @krimto-labs/krimto reindex\n`,
    };
  }

  try {
    const { index } = openCliIndex(dataDir);
    const store = new FactStore(dataDir);

    const before = index.factCount();
    const facts = await store.allFacts();
    await index.rebuild(facts);
    const after = index.factCount();
    const delta = after - before;

    let summary: string;
    if (delta === 0) {
      summary = `   No changes — index already matched the markdown (${after} fact${after === 1 ? "" : "s"}).`;
    } else if (delta > 0) {
      summary = `   ${after} fact${after === 1 ? "" : "s"} now indexed (was ${before}, +${delta}).\n   The index picked up markdown files it didn't know about.`;
    } else {
      summary = `   ${after} fact${after === 1 ? "" : "s"} now indexed (was ${before}, ${delta}).\n   The index dropped ${-delta} orphan entr${-delta === 1 ? "y" : "ies"} whose .md file was gone.`;
    }
    return {
      status: "ok",
      message: `\n✅ Reindexed from markdown\n\n   Data: ${dataDir}\n${summary}\n`,
    };
  } catch (e) {
    return {
      status: "error",
      message: `\n🔴 Reindex failed: ${e instanceof Error ? e.message : String(e)}\n`,
    };
  }
}
