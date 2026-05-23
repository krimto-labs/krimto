// Gap 08 — commit batcher. Replaces per-write commits: stage each fact's file immediately,
// then commit the staged batch as ONE commit every `intervalMs` or every `maxBatch` writes
// (whichever comes first), and on shutdown. Holds no lock — every method is called inside the
// write serializer, so git `add`/`commit` never overlap. The pending list only drives the commit
// message; staged files live in git's index, so a failed commit is swept into the next one.

import { type GitRepo, type PushResult } from "./git";
import { type Fact } from "./fact";

export interface BatcherConfig {
  intervalMs: number;
  maxBatch: number;
}

export const DEFAULT_BATCHER_CONFIG: BatcherConfig = { intervalMs: 30_000, maxBatch: 10 };

function toPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

/** Parse batcher config from env; missing/invalid values fall back to defaults. */
export function batcherConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BatcherConfig {
  return {
    intervalMs: toPositiveInt(env.KRIMTO_COMMIT_INTERVAL_MS, DEFAULT_BATCHER_CONFIG.intervalMs),
    maxBatch: toPositiveInt(env.KRIMTO_COMMIT_MAX_BATCH, DEFAULT_BATCHER_CONFIG.maxBatch),
  };
}

/** One commit message for a batch of facts, preserving per-fact audit info. */
export function batchCommitMessage(facts: Fact[], serverEmail = "krimto@localhost"): string {
  const lines = facts.map((f) => {
    const fm = f.frontmatter;
    return `- [${fm.scope}] ${fm.title} (${fm.id}) by ${fm.author}`;
  });
  return [
    `krimto: write batch — ${facts.length} fact${facts.length === 1 ? "" : "s"}`,
    "",
    ...lines,
    "",
    `Co-authored-by: Krimto-Server <${serverEmail}>`,
  ].join("\n");
}

/** Runs a task with exclusive access (the write serializer in production). */
export type RunExclusive = (task: () => Promise<unknown>) => Promise<unknown>;

export class CommitBatcher {
  private readonly pending: Fact[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastPush: PushResult["status"] | "none" = "none";

  constructor(
    private readonly repo: GitRepo,
    private readonly config: BatcherConfig = DEFAULT_BATCHER_CONFIG,
  ) {}

  pendingCount(): number {
    return this.pending.length;
  }

  /** Status of the most recent push attempt ("none" before any flush with a commit). */
  lastPushStatus(): PushResult["status"] | "none" {
    return this.lastPush;
  }

  /** Stage a fact's file and queue it; commit immediately once maxBatch is reached. */
  async stage(relPath: string, fact: Fact): Promise<void> {
    await this.repo.stage(relPath);
    this.pending.push(fact);
    if (this.pending.length >= this.config.maxBatch) {
      await this.flush();
    }
  }

  /** Commit all pending facts as one commit, then push to the remote (if any). */
  async flush(): Promise<string | null> {
    if (this.pending.length === 0) return null;
    const facts = this.pending.splice(0); // clear regardless of commit outcome
    const sha = await this.repo.commit(batchCommitMessage(facts));
    if (sha === null) {
      process.stderr.write(
        `krimto: batch commit of ${facts.length} fact(s) failed; files remain staged for the next commit\n`,
      );
      return null;
    }
    const push = await this.repo.push();
    this.lastPush = push.status;
    if (push.status === "error") {
      process.stderr.write(
        `krimto: push to remote failed (commits are saved locally, will retry next batch): ${push.detail ?? ""}\n`,
      );
    }
    return sha;
  }

  /** Begin the interval flush. `runExclusive` serializes the flush against writes. */
  start(runExclusive: RunExclusive): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void runExclusive(() => this.flush());
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
