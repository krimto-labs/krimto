// `krimto sync` (alias `pull`) — on-demand two-way git sync for the data dir.
//
// Krimto already auto-commits + auto-pushes (CommitBatcher) and, once a remote is configured,
// auto-pulls every ~60s (RemoteSync). `sync` is the manual "do it right now" verb: pull the
// team's pushed notes (git pull --rebase), re-index any markdown that changed, then push any
// local commits. It's the answer to "how does a new teammate pull the team's memory?" — after
// `krimto remote --set <shared-url>`, `krimto sync` brings the existing history down.
//
// Like `reindex` / `rm`, it refuses while a live server holds the data-dir lock: the running
// server has the SQLite handle + its own git serializer, and a CLI pull would race it on the
// `.git` index. Stop the server (or let its built-in 60s sync handle it) first.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { FactStore } from "../storage/store";
import { GitRepo } from "../storage/git";
import { openIndexDb, type IndexConfig } from "../index/db";
import { FactIndex } from "../index/factIndex";
import { embeddingConfigFromEnv } from "../index/providers";
import { isProcessAlive, type LockInfo } from "../server/lock";

export interface SyncResult {
  status: "ok" | "up_to_date" | "conflict" | "no_remote" | "lock_held" | "error";
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

/** Rebuild index.db from the markdown source of truth (mirrors `runReindex`'s core). */
async function reindexFromMarkdown(dataDir: string): Promise<void> {
  const embedCfg = embeddingConfigFromEnv();
  const indexConfig: IndexConfig = { provider: embedCfg.provider ?? "none", dimensions: 0 };
  const db = openIndexDb(path.join(dataDir, "index.db"), indexConfig);
  const index = new FactIndex(db);
  await index.rebuild(await new FactStore(dataDir).allFacts());
}

export async function runSync(dataDir: string): Promise<SyncResult> {
  const heldBy = await checkLock(dataDir);
  if (heldBy) {
    return {
      status: "lock_held",
      message:
        `\n🔴 Cannot sync while a Krimto server is running\n` +
        `\n   Held by PID ${heldBy.pid} (mode ${heldBy.mode}, started ${heldBy.started})\n` +
        `\n   A running server already auto-pulls every ~60s. To sync by hand, stop it first:\n` +
        `     $ npx @krimto-labs/krimto stop\n` +
        `     $ npx @krimto-labs/krimto sync\n`,
    };
  }

  const repo = await GitRepo.open(dataDir);
  if (!(await repo.hasRemote())) {
    return {
      status: "no_remote",
      message:
        `\n🔴 No git remote configured — nothing to sync with\n` +
        `\n   Point this data dir at your team's shared repo, then sync:\n` +
        `     $ npx @krimto-labs/krimto remote --set git@github.com:acme/krimto-data.git\n` +
        `     $ npx @krimto-labs/krimto sync\n`,
    };
  }

  const pull = await repo.pull();
  if (pull.status === "conflict") {
    return {
      status: "conflict",
      message:
        `\n🔴 Pull hit a conflict — your local notes are untouched (the rebase was aborted)\n` +
        `\n   Resolve it by hand in the data dir, then re-run sync:\n` +
        `     $ cd ${dataDir} && git status\n` +
        `\n   Git said: ${pull.detail ?? "(no detail)"}\n`,
    };
  }
  if (pull.status === "error") {
    return {
      status: "error",
      message: `\n🔴 Pull failed: ${pull.detail ?? "(no detail)"}\n   Your local notes are unchanged.\n`,
    };
  }

  let pulledMd = 0;
  if (pull.status === "ok" && pull.changedFiles) {
    pulledMd = pull.changedFiles.filter((f) => f.endsWith(".md")).length;
    await reindexFromMarkdown(dataDir); // bring the index in line with the pulled markdown
  }

  // Send any local commits up. Best-effort — a push failure doesn't undo a successful pull.
  const push = await repo.push();
  const pushNote =
    push.status === "ok"
      ? "   ✓ Pushed your local commits.\n"
      : push.status === "skipped"
        ? ""
        : `   ⚠ Push failed (${push.detail ?? "no detail"}) — commits stay local, retry next sync.\n`;

  if (pull.status === "up-to-date") {
    return {
      status: "up_to_date",
      message: `\n✅ Already up to date — no new team notes to pull.\n${pushNote}`,
    };
  }
  return {
    status: "ok",
    message:
      `\n✅ Synced.\n` +
      `   ⬇ Pulled ${pulledMd} note${pulledMd === 1 ? "" : "s"} from the team and re-indexed.\n` +
      pushNote,
  };
}
