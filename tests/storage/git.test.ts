import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitRepo, GitWriter, commitMessage } from "../../src/storage/git";
import { FactStore } from "../../src/storage/store";
import { createFact } from "../../src/storage/fact";

describe("commitMessage", () => {
  it("formats the Build Spec commit message", () => {
    const fact = createFact({
      scope: "team/payments",
      title: "Stripe webhooks",
      body: "verify the signature",
      author: "alice@acme.com",
      tags: ["stripe", "webhooks"],
      now: new Date("2026-05-23T00:00:00Z"),
    });
    const msg = commitMessage(fact);
    expect(msg).toContain("krimto: write [scope=team/payments] by alice@acme.com");
    expect(msg).toContain(`Fact ID: ${fact.frontmatter.id}`);
    expect(msg).toContain("Tags: stripe, webhooks");
    expect(msg).toContain("Co-authored-by: Krimto-Server <krimto@localhost>");
  });
});

describe("GitWriter", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-git-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("initializes a repo and commits written facts, returning the SHA", async () => {
    const repo = await GitRepo.open(dir);
    expect(await repo.isRepo()).toBe(true);
    const writer = new GitWriter(repo);
    const store = new FactStore(dir);

    const first = await store.writeFact({
      scope: "team/payments",
      title: "Stripe webhooks",
      body: "verify the signature",
      author: "alice@acme.com",
    });
    const sha = await writer.recordWrite(first.path, first.fact);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await repo.head()).toBe(sha);

    const second = await store.writeFact({
      scope: "team/payments",
      title: "Refund policy",
      body: "refunds within 30 days",
      author: "alice@acme.com",
    });
    const sha2 = await writer.recordWrite(second.path, second.fact);
    expect(sha2).toMatch(/^[0-9a-f]{40}$/);
    expect(sha2).not.toBe(sha);
  });

  it("commit returns null when there is nothing to commit", async () => {
    const repo = await GitRepo.open(dir);
    expect(await repo.commit("nothing changed")).toBeNull();
  });
});
