// Gap 08 — low-level git primitives. The server is the single writer to git; CommitBatcher
// (src/storage/batcher.ts) stages each fact and commits batches on top of these primitives.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

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
}

