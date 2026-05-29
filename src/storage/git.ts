// Gap 08 — low-level git primitives. The server is the single writer to git; CommitBatcher
// (src/storage/batcher.ts) stages each fact and commits batches on top of these primitives.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface PushResult {
  status: "ok" | "skipped" | "error";
  detail?: string;
}

export interface PullResult {
  status: "ok" | "skipped" | "up-to-date" | "conflict" | "error";
  changedFiles?: string[];
  detail?: string;
}

const DEFAULT_BRANCH = "main";

export class GitRepo {
  private constructor(private readonly dir: string) {}

  /** Open (initializing if needed) a git repo at dir on the pinned branch, ensuring a commit identity. */
  static async open(dir: string): Promise<GitRepo> {
    const repo = new GitRepo(dir);
    if (!(await repo.isRepo())) {
      await exec("git", ["-C", dir, "init", "-q", "-b", DEFAULT_BRANCH]);
    }
    await repo.ensureIdentity();
    await repo.ensureBranch();
    return repo;
  }

  async isRepo(): Promise<boolean> {
    try {
      await exec("git", ["-C", this.dir, "rev-parse", "--is-inside-work-tree"]);
      return true;
    } catch {
      return false;
    }
  }

  private async getConfig(key: string): Promise<string | null> {
    try {
      const { stdout } = await exec("git", ["-C", this.dir, "config", "--get", key]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async ensureIdentity(): Promise<void> {
    if (!(await this.getConfig("user.name"))) {
      await exec("git", ["-C", this.dir, "config", "user.name", "Krimto Server"]);
    }
    if (!(await this.getConfig("user.email"))) {
      await exec("git", ["-C", this.dir, "config", "user.email", "krimto@localhost"]);
    }
  }

  async stage(relPath: string): Promise<void> {
    await exec("git", ["-C", this.dir, "add", "--", relPath]);
  }

  /** Commit staged changes. Returns the commit SHA, or null if there was nothing to commit. */
  async commit(message: string): Promise<string | null> {
    try {
      await exec("git", ["-C", this.dir, "commit", "-q", "-m", message]);
    } catch {
      return null;
    }
    return this.head();
  }

  /** Stage and commit ONLY relPath (path-limited), leaving any other staged files uncommitted. */
  async commitPath(relPath: string, message: string): Promise<string | null> {
    await exec("git", ["-C", this.dir, "add", "--", relPath]);
    try {
      await exec("git", ["-C", this.dir, "commit", "-q", "-m", message, "--", relPath]);
    } catch {
      return null; // nothing to commit for this path
    }
    return this.head();
  }

  async head(): Promise<string | null> {
    try {
      const { stdout } = await exec("git", ["-C", this.dir, "rev-parse", "HEAD"]);
      return stdout.trim();
    } catch {
      return null;
    }
  }

  /** True when an `origin` remote is configured. */
  async hasRemote(): Promise<boolean> {
    try {
      await exec("git", ["-C", this.dir, "remote", "get-url", "origin"]);
      return true;
    } catch {
      return false;
    }
  }

  /** Point `origin` at `url` (add if absent, update if present). */
  async setRemote(url: string): Promise<void> {
    if (await this.hasRemote()) {
      await exec("git", ["-C", this.dir, "remote", "set-url", "origin", url]);
    } else {
      await exec("git", ["-C", this.dir, "remote", "add", "origin", url]);
    }
  }

  /** Remove the `origin` remote if present. No-op (never throws) when there is none. */
  async removeRemote(): Promise<void> {
    if (!(await this.hasRemote())) return;
    await exec("git", ["-C", this.dir, "remote", "remove", "origin"]);
  }

  /** Ensure the repo is on DEFAULT_BRANCH (rename a committed branch; set the ref when unborn). */
  private async ensureBranch(): Promise<void> {
    let current = "";
    try {
      current = (await exec("git", ["-C", this.dir, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    } catch {
      current = "";
    }
    if (current === DEFAULT_BRANCH) return;
    if (current === "HEAD" || current === "") {
      // unborn (no commits yet): point HEAD at the default branch
      await exec("git", ["-C", this.dir, "symbolic-ref", "HEAD", `refs/heads/${DEFAULT_BRANCH}`]);
      return;
    }
    try {
      await exec("git", ["-C", this.dir, "branch", "-m", current, DEFAULT_BRANCH]);
    } catch {
      // a `main` already exists — switch to it rather than crash startup over branch naming
      try {
        await exec("git", ["-C", this.dir, "checkout", DEFAULT_BRANCH]);
      } catch {
        /* leave as-is — never abort startup over a branch name */
      }
    }
  }

  /** Push the pinned branch to origin. Skipped when no remote; failures are returned, never thrown. */
  async push(): Promise<PushResult> {
    if (!(await this.hasRemote())) return { status: "skipped" };
    try {
      await exec("git", ["-C", this.dir, "push", "origin", DEFAULT_BRANCH]);
      return { status: "ok" };
    } catch (e) {
      return { status: "error", detail: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Files changed between two commits (all tracked files when `before` is null). */
  private async changedFiles(before: string | null, after: string | null): Promise<string[]> {
    if (after === null) return [];
    const args =
      before === null
        ? ["-C", this.dir, "ls-tree", "-r", "--name-only", "HEAD"]
        : ["-C", this.dir, "diff", "--name-only", `${before}..${after}`];
    const { stdout } = await exec("git", args);
    return stdout.split("\n").filter((l) => l.length > 0);
  }

  /** git pull --rebase from origin. Skipped without a remote; conflicts are aborted (local kept). */
  async pull(): Promise<PullResult> {
    if (!(await this.hasRemote())) return { status: "skipped" };
    const before = await this.head();
    try {
      // Pull our pinned branch by name — never the remote's HEAD symref.
      await exec("git", ["-C", this.dir, "pull", "--rebase", "origin", DEFAULT_BRANCH]);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      try {
        await exec("git", ["-C", this.dir, "rebase", "--abort"]);
        return { status: "conflict", detail };
      } catch {
        return { status: "error", detail };
      }
    }
    const after = await this.head();
    if (before === after) return { status: "up-to-date" };
    return { status: "ok", changedFiles: await this.changedFiles(before, after) };
  }
}

/**
 * Read-only summary of the data-dir's git repo. Used by `krimto status` (overall health),
 * the `/ui` dashboard (sync timestamp in the header), and any future surface that needs
 * the same numbers. Survives a missing/uninitialised repo by returning zeros — callers
 * don't need their own try/catch.
 */
export interface DataDirGitInfo {
  commits: number;
  lastCommitAt: Date | null;
  remote: string | null;
}

export async function readDataDirGitInfo(dataDir: string): Promise<DataDirGitInfo> {
  // v0.2.31 — make each query independent. The original implementation wrapped everything in
  // one outer try/catch, so an empty repo (no HEAD) would blank out the remote field too —
  // which the `krimto remote` command then mis-read as "no remote configured".
  let commits = 0;
  try {
    const { stdout: countStr } = await exec("git", ["-C", dataDir, "rev-list", "--count", "HEAD"]);
    commits = Number(countStr.trim()) || 0;
  } catch {
    /* not a repo, or no HEAD yet — commits stays 0 */
  }
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
}
