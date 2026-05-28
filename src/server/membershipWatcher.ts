// Live team-mode trigger. `krimto team init` writes members.yaml from a SEPARATE CLI process, so
// the running server never learns about the new admin on its own. This watcher polls the file's
// mtime (~2s) and fires a reload when it changes — flipping the server into team mode without a
// restart. An mtime poll (not fs.watch) is deliberate: fs.watch is flaky with atomic-rename writes
// and varies across platforms; a poll matches the existing setInterval pattern (batcher/sync).

import { promises as fs } from "node:fs";

/** Runs a task with exclusive access (the write serializer in production). Mirrors RemoteSync. */
export type RunExclusive = (task: () => Promise<unknown>) => Promise<unknown>;

export const DEFAULT_MEMBERSHIP_WATCH_MS = 2000;

export class MembershipWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastMtime = 0;

  constructor(
    private readonly file: string,
    private readonly onChange: () => Promise<void>,
    private readonly intervalMs: number = DEFAULT_MEMBERSHIP_WATCH_MS,
  ) {}

  /**
   * One poll: fire `onChange` iff the file's mtime differs from the last seen value. An absent or
   * unreadable file is a no-op (solo stays solo). Exposed so tests can drive it deterministically.
   */
  async checkOnce(): Promise<void> {
    let mtime: number;
    try {
      mtime = (await fs.stat(this.file)).mtimeMs;
    } catch {
      return; // file not there yet — nothing to flip
    }
    if (mtime === this.lastMtime) return; // debounce: only react to a real change
    this.lastMtime = mtime;
    await this.onChange();
  }

  /** Begin polling. `runExclusive` serializes each reload against the batcher/sync write path. */
  start(runExclusive: RunExclusive): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void runExclusive(() => this.checkOnce());
    }, this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
