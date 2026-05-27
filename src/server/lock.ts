// G1 — Cross-process lock on the data directory.
//
// Two Krimto processes running on the same KRIMTO_DATA would race on git commits, the SQLite write
// queue (single-process only), and embedding-space bookkeeping. Today there's no cross-process
// coordination, so a user who runs `npx krimto serve` while Cursor already has a stdio Krimto
// pointed at ~/.krimto silently sets up a footgun.
//
// The lock is a small JSON file under `<dataDir>/.krimto/lock.json` carrying our PID + start time.
// On boot we refuse if an existing lock is held by a live PID; we replace it if the holder is dead
// (stale lock — process crashed without releasing). On graceful shutdown we delete the file.
//
// Scope: this is opt-in via the server entrypoint only. Info commands (`krimto where`, `storage`,
// etc.) don't acquire the lock — they don't write to the data dir.

import { promises as fs } from "node:fs";
import * as path from "node:path";

export type LockMode = "stdio" | "http";
/**
 * How this Krimto process was launched. "service" = via launchd / systemd / schtasks (the
 * always-running setup); "ad-hoc" = direct invocation (`krimto serve`, editor-spawned stdio,
 * tests). The service installers inject KRIMTO_LAUNCHED_BY=service into the unit env, so this
 * field is just `process.env.KRIMTO_LAUNCHED_BY` at acquire time with a safe default.
 */
export type LaunchedBy = "service" | "ad-hoc";

export interface LockInfo {
  pid: number;
  started: string;
  mode: LockMode;
  launchedBy: LaunchedBy;
}

export interface LockHandle {
  /** Release the lock (delete the file). Idempotent. Safe to call when never acquired. */
  release: () => Promise<void>;
}

export class LockHeldError extends Error {
  constructor(public readonly holder: LockInfo, public readonly lockPath: string) {
    super(
      `Another Krimto is already running on this data dir (PID ${holder.pid}, started ${holder.started}, mode ${holder.mode}).\n` +
        `Stop it first, or set KRIMTO_DATA=<different path>.\n` +
        `If you're sure that process is gone, delete ${lockPath} and try again.`,
    );
    this.name = "LockHeldError";
  }
}

/** Returns true if `pid` looks alive on this OS. `kill(pid, 0)` is a permission-less existence probe. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we can't signal it (different user) — count it as alive.
    if ((e as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

function lockPathFor(dataDir: string): string {
  return path.join(dataDir, ".krimto", "lock.json");
}

/**
 * Acquire the data-dir lock. Refuses if an existing lock is held by a live PID; replaces it if the
 * holder is dead. Returns a handle whose `release()` deletes the file.
 */
export async function acquireLock(dataDir: string, mode: LockMode): Promise<LockHandle> {
  const file = lockPathFor(dataDir);
  await fs.mkdir(path.dirname(file), { recursive: true });

  try {
    const existing = JSON.parse(await fs.readFile(file, "utf8")) as Partial<LockInfo>;
    if (typeof existing.pid === "number" && isProcessAlive(existing.pid) && existing.pid !== process.pid) {
      // Held by a live, different process — refuse.
      throw new LockHeldError(
        {
          pid: existing.pid,
          started: typeof existing.started === "string" ? existing.started : "unknown",
          mode: (existing.mode as LockMode) ?? "stdio",
          launchedBy: existing.launchedBy === "service" ? "service" : "ad-hoc",
        },
        file,
      );
    }
    // Stale (holder is gone or it's us) — fall through and replace.
  } catch (e) {
    if (e instanceof LockHeldError) throw e;
    // File missing / unreadable / malformed — treat as no lock and continue.
  }

  const launchedBy: LaunchedBy = process.env.KRIMTO_LAUNCHED_BY === "service" ? "service" : "ad-hoc";
  const info: LockInfo = { pid: process.pid, started: new Date().toISOString(), mode, launchedBy };
  await fs.writeFile(file, JSON.stringify(info, null, 2), "utf8");

  return {
    release: async (): Promise<void> => {
      try {
        const raw = await fs.readFile(file, "utf8");
        const current = JSON.parse(raw) as Partial<LockInfo>;
        // Only delete if it's still ours — defensive against another process having taken over.
        if (current.pid === process.pid) await fs.unlink(file);
      } catch {
        /* file already gone — that's fine */
      }
    },
  };
}
