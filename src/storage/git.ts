// Gap 08 — Git write coordination. The server is the single writer to git: it stages
// each fact file and commits with a Krimto-generated message, so git is the audit log.
//
// v0.2 commits per write (correct, slightly noisier history). The timed/threshold
// batcher and push-to-remote are a follow-on tuning step.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Fact } from "./fact";

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

/** Build the Build Spec commit message for a fact write. */
export function commitMessage(fact: Fact, serverEmail = "krimto@localhost"): string {
  const fm = fact.frontmatter;
  const tags = fm.tags?.length ? fm.tags.join(", ") : "(none)";
  return [
    `krimto: write [scope=${fm.scope}] by ${fm.author}`,
    "",
    `Title: ${fm.title}`,
    `Fact ID: ${fm.id}`,
    `Tags: ${tags}`,
    "",
    `Co-authored-by: Krimto-Server <${serverEmail}>`,
  ].join("\n");
}

export class GitWriter {
  constructor(private readonly repo: GitRepo) {}

  static async open(dir: string): Promise<GitWriter> {
    return new GitWriter(await GitRepo.open(dir));
  }

  /** Stage a written fact file and commit it. Returns the commit SHA. */
  async recordWrite(relPath: string, fact: Fact): Promise<string | null> {
    await this.repo.stage(relPath);
    return this.repo.commit(commitMessage(fact));
  }
}
