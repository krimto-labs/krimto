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

export class GitRepo {
  private constructor(private readonly dir: string) {}

  /** Open (initializing if needed) a git repo at dir, ensuring a commit identity. */
  static async open(dir: string): Promise<GitRepo> {
    const repo = new GitRepo(dir);
    if (!(await repo.isRepo())) {
      await exec("git", ["-C", dir, "init", "-q"]);
    }
    await repo.ensureIdentity();
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

  /** The repo's current branch name, or "main" if it can't be determined. */
  private async currentBranch(): Promise<string> {
    try {
      const { stdout } = await exec("git", ["-C", this.dir, "rev-parse", "--abbrev-ref", "HEAD"]);
      const branch = stdout.trim();
      return branch && branch !== "HEAD" ? branch : "main";
    } catch {
      return "main";
    }
  }

  /** Push the current branch to origin. Skipped when no remote; failures are returned, never thrown. */
  async push(): Promise<PushResult> {
    if (!(await this.hasRemote())) return { status: "skipped" };
    try {
      await exec("git", ["-C", this.dir, "push", "origin", await this.currentBranch()]);
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
      // Pull the branch we push (by name) — never the remote's HEAD symref, which may point at a
      // branch the remote doesn't actually have (e.g. a bare repo created with a different default).
      await exec("git", ["-C", this.dir, "pull", "--rebase", "origin", await this.currentBranch()]);
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

