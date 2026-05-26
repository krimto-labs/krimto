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

  let status: VerifyConnectionResult["status"];
  let header: string;
  if (lock && isProcessAlive(lock.pid)) {
    status = "running";
    header =
      `🟢 Krimto is running (PID ${lock.pid}, mode ${lock.mode}, started ${humanAgo(lock.started, now)}).\n` +
      `   Data: ${dataDir}\n`;
  } else if (lock) {
    status = "stale";
    header =
      `⚠️  Found a stale lock file (PID ${lock.pid} is no longer running). A previous Krimto\n` +
      `   crashed without releasing it. The next \`serve\` / stdio launch will auto-replace it.\n` +
      `   Data: ${dataDir}\n`;
  } else {
    status = "none";
    header =
      `🔴 No Krimto process running on this data dir.${lockMalformed ? " (Lock file present but malformed.)" : ""}\n` +
      `   Data: ${dataDir}\n` +
      `   Start one: \`npx @krimto-labs/krimto serve\` (or launch via your MCP client).\n`;
  }

  let activitySection: string;
  if (recent.length === 0) {
    activitySection =
      `\nRecent activity: nothing yet.\n` +
      `\n` +
      `Likely causes:\n` +
      `  • Your agent hasn't called Krimto at all.\n` +
      `  • DEFAULT mode: you must say "use krimto to ..." for the tools to fire.\n` +
      `  • Try a test in your editor: "Use krimto to list the scopes I can see."\n` +
      `    Then re-run \`krimto verify-connection\` — that call should appear.\n`;
  } else {
    const rows = [...recent]
      .reverse() // newest first for display
      .map((e) => `  ${humanAgo(e.timestamp, now).padEnd(10)} ${e.tool.padEnd(20)} ${e.detail ?? "—"}   [${e.identity}]`)
      .join("\n");
    activitySection = `\nRecent activity (newest first):\n${rows}\n`;
  }

  return { status, message: header + activitySection, recent };
}
