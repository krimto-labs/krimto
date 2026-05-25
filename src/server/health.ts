// Gap 17 — Health checks. Liveness is minimal (process up); readiness checks
// dependencies. A temporarily unreachable git remote does NOT block readiness:
// reads still work from local state and writes can queue.

import type { Database as Db } from "better-sqlite3";
import type { FactIndex } from "../index/factIndex";
import type { CommitBatcher } from "../storage/batcher";

export interface CheckResult {
  status: "ok" | "building" | "error";
  [detail: string]: unknown;
}

export interface ReadyChecks {
  sqlite: CheckResult;
  index: CheckResult;
  git_remote: CheckResult;
  /** Inbound pull status — surfaced for observability so a stuck sync isn't invisible (BUG-3). */
  git_sync?: CheckResult;
}

export interface LiveResponse {
  status: "alive";
  version: string;
  uptime_seconds: number;
}

export function healthLive(version: string, uptimeSeconds: number): LiveResponse {
  return { status: "alive", version, uptime_seconds: Math.max(0, Math.floor(uptimeSeconds)) };
}

export interface ReadyResponse {
  http: 200 | 503;
  body: { status: "ready" | "not_ready"; version: string; checks: ReadyChecks };
}

export function healthReady(version: string, checks: ReadyChecks): ReadyResponse {
  // Ready when SQLite is reachable and the index is loaded. git_remote is reported
  // for observability but never toggles readiness.
  const ready = checks.sqlite.status === "ok" && checks.index.status === "ok";
  return {
    http: ready ? 200 : 503,
    body: { status: ready ? "ready" : "not_ready", version, checks },
  };
}

export function sqliteHealth(db: Db): CheckResult {
  try {
    db.prepare("select 1").get();
    return { status: "ok" };
  } catch (e) {
    return { status: "error", detail: e instanceof Error ? e.message : String(e) };
  }
}

export function indexHealth(index: FactIndex, building: boolean): CheckResult {
  if (building) return { status: "building" };
  return { status: "ok", fact_count: index.factCount() };
}

/** Maps a push status to a git_remote CheckResult. Single source of truth (used by the HTTP layer too). */
export function gitRemoteCheck(status: "ok" | "skipped" | "error" | "none"): CheckResult {
  if (status === "error") return { status: "error", detail: "last push to the remote failed" };
  const detail =
    status === "ok" ? "last push ok" : status === "none" ? "no push yet" : "no remote configured";
  return { status: "ok", detail };
}

/** Reports the last push status (observability only — never toggles readiness). */
export function gitRemoteHealth(batcher: CommitBatcher): CheckResult {
  return gitRemoteCheck(batcher.lastPushStatus());
}

/** Maps the last inbound-pull status to a git_sync CheckResult. Visible but never blocks readiness. */
export function gitSyncCheck(
  status: "ok" | "skipped" | "up-to-date" | "conflict" | "error" | "none",
): CheckResult {
  if (status === "error") return { status: "error", detail: "last pull from the remote failed" };
  if (status === "conflict") return { status: "error", detail: "last pull hit a conflict (local state kept)" };
  const detail =
    status === "ok"
      ? "last pull ok"
      : status === "up-to-date"
        ? "up to date"
        : status === "none"
          ? "no pull yet"
          : "no remote configured";
  return { status: "ok", detail };
}
