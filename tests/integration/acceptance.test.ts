// v0.1 acceptance — mirrors Build Spec Gap 05, in-process. The Docker + live
// MCP-transport run is exercised separately (mcp.test.ts) and in Week 3.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FactStore } from "../../src/storage/store";
import { parseFact, serializeFact } from "../../src/storage/fact";
import { openIndexDb } from "../../src/index/db";
import { FactIndex } from "../../src/index/factIndex";
import { Serializer } from "../../src/index/serialize";
import { krimtoRecall, krimtoWrite, type ToolContext } from "../../src/server/tools";

let root: string;
let ctx: ToolContext;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-accept-"));
  const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
  ctx = {
    store: new FactStore(root),
    index: new FactIndex(db),
    writeQueue: new Serializer(),
    requester: { identity: "alice@acme.com", teams: ["payments"] },
    membership: { org: { slug: "acme", admins: ["alice@acme.com"] }, teams: [], users: [] },
  };
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("v0.1 acceptance", () => {
  it("write -> file on disk -> recall (top-3) -> external edit reflected after reindex", async () => {
    // 1. The agent writes a fact.
    const written = await krimtoWrite(ctx, {
      scope: "user/alice@acme.com",
      title: "Staging resets Sunday",
      body: "Do not run migrations on Sunday nights — staging is wiped at midnight.",
    });

    // 2. The fact appears as a markdown file at user/<id>/<slug>.md.
    expect(written.path).toBe("user/alice@acme.com/staging-resets-sunday.md");
    const abs = path.join(root, written.path);
    await expect(fs.access(abs)).resolves.toBeUndefined();

    // 3. After a fresh session, recall returns the fact in the top 3.
    const first = await krimtoRecall(ctx, { query: "can I run migrations on Sunday?" });
    expect(first.results.slice(0, 3).some((h) => h.id === written.id)).toBe(true);

    // 4. The developer edits the markdown file directly, then the index is reindexed.
    //    (Explicit rebuild from the markdown source of truth; automatic git-pull
    //    external-edit detection is a later increment.)
    const edited = parseFact(await fs.readFile(abs, "utf8"));
    edited.body = "Migrations are wiped every Sunday at midnight; never run them then.";
    await fs.writeFile(abs, serializeFact(edited), "utf8");
    await ctx.index.rebuild(await ctx.store.allFacts());

    // 5. The next recall reflects the edited content (same fact id preserved on disk).
    const second = await krimtoRecall(ctx, { query: "what happens to migrations Sunday midnight?" });
    const hit = second.results.find((h) => h.id === written.id);
    expect(hit?.body).toContain("wiped every Sunday at midnight");
  });
});
