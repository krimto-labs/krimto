import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FactStore } from "../../src/storage/store";
import { parseFact } from "../../src/storage/fact";

let root: string;
let store: FactStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-store-"));
  store = new FactStore(root);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("FactStore", () => {
  it("writes a fact to <scope>/<slug>.md and it round-trips on disk", async () => {
    const { fact, path: rel } = await store.writeFact({
      scope: "user/alice@acme.com",
      title: "Staging resets Sunday",
      body: "Don't migrate Sunday nights.",
      author: "alice@acme.com",
    });
    expect(rel).toBe("user/alice@acme.com/staging-resets-sunday.md");
    const onDisk = await fs.readFile(path.join(root, rel), "utf8");
    expect(parseFact(onDisk).frontmatter.id).toBe(fact.frontmatter.id);
    expect(parseFact(onDisk).body).toContain("Sunday nights");
  });

  it("rejects an invalid scope", async () => {
    await expect(
      store.writeFact({ scope: "bogus", title: "x", body: "y", author: "a@x.com" }),
    ).rejects.toThrow(/invalid scope/i);
  });

  it("resolves filename collisions within a scope", async () => {
    await store.writeFact({ scope: "team/payments", title: "Conventions", body: "a", author: "a@x.com" });
    const second = await store.writeFact({
      scope: "team/payments",
      title: "Conventions",
      body: "b",
      author: "a@x.com",
    });
    expect(second.path).toBe("team/payments/conventions-2.md");
  });

  it("reads a fact by id and returns null for an unknown id", async () => {
    const { fact } = await store.writeFact({
      scope: "org/acme",
      title: "Code style",
      body: "two-space indent",
      author: "a@x.com",
    });
    const found = await store.readFact(fact.frontmatter.id);
    expect(found?.fact.frontmatter.title).toBe("Code style");
    expect(await store.readFact("fct_does_not_exist")).toBeNull();
  });

  it("lists scopes with counts and returns all facts", async () => {
    await store.writeFact({ scope: "team/payments", title: "A", body: "x", author: "a@x.com" });
    await store.writeFact({ scope: "team/payments", title: "B", body: "y", author: "a@x.com" });
    await store.writeFact({ scope: "org/acme", title: "C", body: "z", author: "a@x.com" });

    const scopes = await store.listScopes();
    expect(scopes.find((s) => s.path === "team/payments")?.factCount).toBe(2);
    expect(scopes.find((s) => s.path === "org/acme")?.factCount).toBe(1);
    expect((await store.allFacts()).length).toBe(3);
  });
});
