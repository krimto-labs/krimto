// Gap 17 — Health checks. Liveness is minimal (process up); readiness checks
// dependencies. A temporarily unreachable git remote does NOT block readiness:
// reads still work from local state and writes can queue.

export interface CheckResult {
  status: "ok" | "building" | "error";
  [detail: string]: unknown;
}

export interface ReadyChecks {
  sqlite: CheckResult;
  index: CheckResult;
  git_remote: CheckResult;
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
