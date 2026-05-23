import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitRepo } from "../../src/storage/git";
import { FactStore } from "../../src/storage/store";

describe("GitRepo", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-git-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("initializes, stages, and commits, returning the SHA", async () => {
    const repo = await GitRepo.open(dir);
    expect(await repo.isRepo()).toBe(true);
    const store = new FactStore(dir);
    const { path: rel } = await store.writeFact({
      scope: "team/payments",
      title: "Stripe webhooks",
      body: "verify the signature",
      author: "alice@acme.com",
    });
    await repo.stage(rel);
    const sha = await repo.commit("krimto: test");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await repo.head()).toBe(sha);
  });

  it("commit returns null when there is nothing to commit", async () => {
    const repo = await GitRepo.open(dir);
    expect(await repo.commit("nothing changed")).toBeNull();
  });
});
