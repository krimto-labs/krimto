// Gap 09 — inbound sync. Periodically `git pull --rebase` and, when files changed, trigger a
// re-index. Holds no lock — `pullOnce` runs through the write Serializer (like the batcher), so a
// pull never overlaps a stage/commit/push.

import { type GitRepo, type PullResult } from "./git";

export interface SyncConfig {
  intervalMs: number;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = { intervalMs: 60_000 };

/** Parse sync config from env; missing/invalid → default. */
export function syncConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SyncConfig {
  const raw = env.KRIMTO_PULL_INTERVAL_MS;
  const n = raw === undefined ? NaN : Number(raw);
  return { intervalMs: Number.isInteger(n) && n >= 1 ? n : DEFAULT_SYNC_CONFIG.intervalMs };
}

/** Runs a task with exclusive access (the write serializer in production). */
export type RunExclusive = (task: () => Promise<unknown>) => Promise<unknown>;

export class RemoteSync {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastPull: PullResult["status"] | "none" = "none";

  constructor(
    private readonly repo: GitRepo,
    private readonly onPulledChanges: () => Promise<void>,
    private readonly config: SyncConfig = DEFAULT_SYNC_CONFIG,
  ) {}

  lastPullStatus(): PullResult["status"] | "none" {
    return this.lastPull;
  }

  /** Pull once; re-index when files changed. Best-effort — logs conflict/error, never throws. */
  async pullOnce(): Promise<PullResult> {
    try {
      const res = await this.repo.pull();
      this.lastPull = res.status;
      if (res.status === "ok" && res.changedFiles && res.changedFiles.length > 0) {
        await this.onPulledChanges();
      } else if (res.status === "conflict" || res.status === "error") {
        process.stderr.write(
          `krimto: git pull ${res.status} (local state preserved, will retry next cycle): ${res.detail ?? ""}\n`,
        );
      }
      return res;
    } catch (e) {
      this.lastPull = "error";
      const detail = e instanceof Error ? e.message : String(e);
      process.stderr.write(`krimto: pull/re-index failed (will retry next cycle): ${detail}\n`);
      return { status: "error", detail };
    }
  }

  start(runExclusive: RunExclusive): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void runExclusive(() => this.pullOnce());
    }, this.config.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
