// G10 — `krimto verify-connection`: the missing diagnostic for "is my agent actually calling
// Krimto right now?" Reads the data-dir lockfile (is a Krimto process running, since when, in
// which mode?) and the activity JSONL (last 5 tool calls). Both are written by the running server
// and survive across processes, so this CLI works from any terminal regardless of how Krimto was
// launched (Cursor's stdio launch, a separate `serve`, or Docker).

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { ActivityLog, type ActivityEntry } from "../server/activity";
import { isProcessAlive, type LockInfo } from "../server/lock";

export interface VerifyConnectionResult {
  /** "running" — a live Krimto holds the lock; "stale" — lock file but holder is dead; "none" — no lock. */
  status: "running" | "stale" | "none";
  /** Human-formatted report to print to stdout. */
  message: string;
  /** Most recent activity entries (oldest-first). Empty when none. */
  recent: ActivityEntry[];
}

function humanAgo(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const secs = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export async function runVerifyConnection(dataDir: string, now: Date = new Date()): Promise<VerifyConnectionResult> {
  const lockPath = path.join(dataDir, ".krimto", "lock.json");
  let lock: LockInfo | null = null;
  let lockMalformed = false;
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof parsed.pid === "number" && typeof parsed.started === "string" && (parsed.mode === "stdio" || parsed.mode === "http")) {
      lock = { pid: parsed.pid, started: parsed.started, mode: parsed.mode };
    } else {
      lockMalformed = true;
    }
  } catch {
    /* no lock file or unreadable — treat as not running */
  }

  const log = new ActivityLog(dataDir);
  const recent = await log.tail(5);
  // Gap #5 — recall-without-write detection over the last 5 minutes.
  const stats = await log.stats();

  let status: VerifyConnectionResult["status"];
  let header: string;
  if (lock && isProcessAlive(lock.pid)) {
    status = "running";
    header =
      `\n🟢 Krimto running\n` +
      `   PID:     ${lock.pid}\n` +
      `   Mode:    ${lock.mode}\n` +
      `   Started: ${humanAgo(lock.started, now)}\n` +
      `   Data:    ${dataDir}\n`;
  } else if (lock) {
    status = "stale";
    header =
      `\n⚠️  Stale lock — Krimto crashed without cleanup\n` +
      `   Holder PID ${lock.pid} is gone. Next \`serve\` / stdio start will\n` +
      `   auto-replace the lock — nothing for you to do.\n` +
      `   Data: ${dataDir}\n`;
  } else {
    status = "none";
    header =
      `\n🔴 No Krimto running on this data dir${lockMalformed ? " (lock file present but malformed)" : ""}\n` +
      `   Data: ${dataDir}\n` +
      `\n` +
      `   Start one: $ npx @krimto-labs/krimto serve\n` +
      `   (Or launch via your MCP client — that boots the stdio server.)\n`;
  }

  let activitySection: string;
  if (recent.length === 0) {
    activitySection =
      `\n━━ Recent activity ━━\n` +
      `\n` +
      `   Nothing yet.\n` +
      `\n` +
      `   Likely causes:\n` +
      `   • Your agent hasn't called Krimto at all.\n` +
      `   • DEFAULT mode: you must say "use krimto to ..." for the tools to fire.\n` +
      `\n` +
      `   Try this in your editor:\n` +
      `     "Use krimto to list the scopes I can see."\n` +
      `   Then re-run this command — the call should appear here.\n`;
  } else {
    const rows = [...recent]
      .reverse() // newest first
      .map((e) => `   ${humanAgo(e.timestamp, now).padEnd(10)} ${e.tool.padEnd(20)} ${e.detail ?? "—"}`)
      .join("\n");
    activitySection = `\n━━ Recent activity (newest first) ━━\n\n${rows}\n`;
  }

  // Gap #5 — recall-without-write warning.
  let hijackSection = "";
  if (stats.recalls >= 3 && stats.writes === 0) {
    hijackSection =
      `\n━━ ⚠️  Hijack suspected ━━\n` +
      `\n` +
      `   ${stats.recalls} recalls, 0 writes in the last 5 min.\n` +
      `\n` +
      `   Your agent is querying Krimto but never writing to it. Most likely\n` +
      `   cause: another memory system is intercepting "remember X" — usually\n` +
      `   Claude Code's per-session auto-memory at\n` +
      `   ~/.claude/projects/<slug>/memory/ — invisible to teammates.\n` +
      `\n` +
      `   Fix:\n` +
      `     $ cd <your project>\n` +
      `     $ npx @krimto-labs/krimto init      # refresh the always-use rule\n` +
      `     Then restart your editor.\n`;
  }

  return { status, message: header + activitySection + hijackSection + "\n", recent };
}
