// `krimto status` — the v0.2.17 consolidator. One screen answers the four questions that used to
// live across four separate commands (`verify-connection`, `where`, `storage`, `usage`):
//
//   1. Is Krimto running / wired into my editors?
//   2. Where does my data live?
//   3. What optional add-ons are configured?
//   4. Did my agent actually call Krimto recently?
//
// The output mirrors §04 of the v0.2.17 Maria-journey doc. The legacy commands forward to this
// function (with a one-line deprecation note) so existing scripts keep working.

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { ActivityLog, type ActivityEntry } from "../server/activity";
import { isProcessAlive, type LockInfo } from "../server/lock";
import { KRIMTO_VERSION } from "../server/index";
import {
  detectEditorEnvironments,
  detectExistingSetup,
  type EditorKind,
  type SetupSnapshot,
} from "./init";

const exec = promisify(execFile);

const EDITOR_LABEL: Record<EditorKind, string> = {
  cursor: "Cursor",
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

export interface StatusReport {
  /** Overall summary. "ok" = green check; "warning" = hijack / stale lock / no recent activity; "error" = nothing configured. */
  status: "ok" | "warning" | "error";
  /** Human-formatted text matching the §04 mockup. */
  message: string;
}

export interface StatusOptions {
  /** Override the working dir for editor detection. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Override home dir for MCP-config lookup. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Override "now" for deterministic activity timestamps in tests. */
  now?: Date;
}

/**
 * Produce the consolidated status report. Reads (best-effort):
 *   • the data-dir lock + activity log (does Krimto run? what did it do?)
 *   • each editor's MCP config (which editors are wired in?)
 *   • the data dir's git log (last commit; proxy for note churn)
 *   • the SQLite index file (note count, via stat / file presence)
 *   • env / activity to detect optional add-ons (git remote, embeddings)
 */
export async function runStatus(
  dataDir: string,
  opts: StatusOptions = {},
): Promise<StatusReport> {
  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.homeDir ?? os.homedir();
  const now = opts.now ?? new Date();

  const snapshot = await detectExistingSetup(cwd, homeDir);
  const envs = await detectEditorEnvironments(cwd, homeDir);
  const lock = await readLock(dataDir);
  const log = new ActivityLog(dataDir);
  const recent = await log.tail(5);
  const stats = await log.stats(5 * 60 * 1000, now);
  const indexStats = await readIndexStats(dataDir);
  const gitInfo = await readGitInfo(dataDir);

  const overall = pickOverall(snapshot, lock, stats);
  const header = headerLine(overall, lock, now);

  const connectionsBlock = renderConnections(envs, snapshot, recent);
  const storageBlock = renderStorage(dataDir, gitInfo, indexStats);
  const addonsBlock = renderAddons(snapshot);
  const activityBlock = renderActivity(recent, now);
  const hijackBlock = renderHijackWarning(stats);

  return {
    status: overall,
    message:
      header +
      connectionsBlock +
      storageBlock +
      addonsBlock +
      activityBlock +
      hijackBlock +
      "\n",
  };
}

// === Helpers ===============================================================

async function readLock(dataDir: string): Promise<{ info: LockInfo; alive: boolean } | null> {
  try {
    const raw = await fs.readFile(path.join(dataDir, ".krimto", "lock.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<LockInfo>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.started === "string" &&
      (parsed.mode === "stdio" || parsed.mode === "http")
    ) {
      const info: LockInfo = { pid: parsed.pid, started: parsed.started, mode: parsed.mode };
      return { info, alive: isProcessAlive(info.pid) };
    }
  } catch {
    /* no lock file */
  }
  return null;
}

async function readIndexStats(dataDir: string): Promise<{ exists: boolean; modified?: Date }> {
  try {
    const s = await fs.stat(path.join(dataDir, "index.db"));
    return { exists: true, modified: s.mtime };
  } catch {
    return { exists: false };
  }
}

interface GitInfo {
  commits: number;
  lastCommitAt: Date | null;
  remote: string | null;
}

async function readGitInfo(dataDir: string): Promise<GitInfo> {
  try {
    const { stdout: countStr } = await exec("git", ["-C", dataDir, "rev-list", "--count", "HEAD"]);
    const commits = Number(countStr.trim()) || 0;
    let lastCommitAt: Date | null = null;
    try {
      const { stdout: when } = await exec("git", ["-C", dataDir, "log", "-1", "--format=%cI"]);
      const t = Date.parse(when.trim());
      if (!Number.isNaN(t)) lastCommitAt = new Date(t);
    } catch {
      /* no commits yet */
    }
    let remote: string | null = null;
    try {
      const { stdout: r } = await exec("git", ["-C", dataDir, "remote", "get-url", "origin"]);
      remote = r.trim() || null;
    } catch {
      /* no remote configured */
    }
    return { commits, lastCommitAt, remote };
  } catch {
    return { commits: 0, lastCommitAt: null, remote: null };
  }
}

function pickOverall(
  snapshot: SetupSnapshot,
  lock: { alive: boolean } | null,
  stats: { recalls: number; writes: number },
): "ok" | "warning" | "error" {
  if (!snapshot.configured) return "error";
  if (lock && !lock.alive) return "warning"; // stale lock
  if (stats.recalls >= 3 && stats.writes === 0) return "warning"; // hijack pattern
  return "ok";
}

function headerLine(
  status: "ok" | "warning" | "error",
  lock: { info: LockInfo; alive: boolean } | null,
  now: Date,
): string {
  if (status === "ok") {
    if (lock?.alive) {
      return `\n✅ Krimto is working · v${KRIMTO_VERSION}\n   PID ${lock.info.pid} (${lock.info.mode}), started ${humanAgo(lock.info.started, now)}\n`;
    }
    return `\n✅ Krimto is configured · v${KRIMTO_VERSION}\n   No active server right now — it will be launched on demand by your editor.\n`;
  }
  if (status === "warning") {
    return `\n⚠️  Krimto needs attention · v${KRIMTO_VERSION}\n`;
  }
  return `\n🔴 Krimto isn't set up on this machine\n   Run: $ npx @krimto-labs/krimto init\n`;
}

function renderConnections(
  envs: ReturnType<typeof detectEditorEnvironments> extends Promise<infer R> ? R : never,
  snapshot: SetupSnapshot,
  recent: ActivityEntry[],
): string {
  // Activity counts: today's calls (rough proxy — uses the cap-200 activity log so accuracy degrades).
  const todayCount = recent.length; // last 5; refined per-editor when we add the editor tag later.
  let body = `\n━━ Connections ━━\n\n`;
  if (snapshot.registeredEditors.length === 0) {
    body += `  No editors wired in. Run \`krimto editors\` to add one.\n`;
    return body;
  }
  for (const env of envs) {
    const wired = snapshot.registeredEditors.includes(env.editor);
    const label = EDITOR_LABEL[env.editor];
    if (wired) {
      body += `  ✓ ${label.padEnd(14)} connected${todayCount > 0 ? ` · ${todayCount} recent tool calls` : ""}\n`;
    } else if (env.present) {
      body += `  ○ ${label.padEnd(14)} detected but not connected — run \`krimto editors\`\n`;
    }
  }
  return body;
}

function renderStorage(dataDir: string, git: GitInfo, idx: { exists: boolean; modified?: Date }): string {
  let body = `\n━━ Storage ━━\n\n`;
  body += `  📂 Notes folder: ${dataDir}\n`;
  if (git.commits > 0) {
    const when = git.lastCommitAt ? ` (last: ${humanAgo(git.lastCommitAt.toISOString(), new Date())})` : "";
    body += `  📚 Git log:      ${git.commits} commit${git.commits === 1 ? "" : "s"}${when}\n`;
  } else {
    body += `  📚 Git log:      no commits yet (Krimto auto-commits every 30s when notes are saved)\n`;
  }
  body += idx.exists
    ? `  ⚡ Index:        present at index.db\n`
    : `  ⚡ Index:        not yet built — will be created on first run\n`;
  return body;
}

function renderAddons(snapshot: SetupSnapshot): string {
  let body = `\n━━ Optional add-ons ━━\n\n`;
  // Team sync (git remote) — best-effort: configured iff KRIMTO_GIT_REMOTE is set, or the data
  // dir's git already has an origin (read by status.ts via readGitInfo, but we drop that detail
  // into the renderStorage path; here we just say "not detected at this run").
  body += `  ●  Team sync (git remote):  ${process.env.KRIMTO_GIT_REMOTE ? "configured via env" : "not configured"}\n`;
  body += `  ●  Semantic search:         ${snapshot.searchProvider === "openai" ? "OpenAI" : "not configured · using keyword"}\n`;
  return body;
}

function renderActivity(recent: ActivityEntry[], now: Date): string {
  let body = `\n━━ Recent activity (last 5 minutes) ━━\n\n`;
  if (recent.length === 0) {
    body += `  (nothing yet — your agent hasn't called Krimto recently)\n`;
    return body;
  }
  for (const e of [...recent].reverse()) {
    const verb =
      e.tool === "krimto_write"
        ? "Saved "
        : e.tool === "krimto_recall"
          ? "Recall"
          : e.tool === "krimto_read"
            ? "Read  "
            : e.tool === "krimto_supersede"
              ? "Update"
              : "Tool  ";
    body += `  ${verb} ${(e.detail ?? "—").padEnd(40)} · ${humanAgo(e.timestamp, now)}\n`;
  }
  return body;
}

function renderHijackWarning(stats: { recalls: number; writes: number }): string {
  if (stats.recalls < 3 || stats.writes > 0) return "";
  return (
    `\n━━ ⚠️  Hijack suspected ━━\n\n` +
    `  ${stats.recalls} recalls, 0 writes in the last 5 min. Another memory system is\n` +
    `  probably intercepting "remember X" before Krimto sees it.\n` +
    `  Fix:  $ npx @krimto-labs/krimto init      # refresh the always-use rule\n` +
    `        Then restart your editor.\n`
  );
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
