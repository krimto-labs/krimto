import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { GitRepo } from "../../src/storage/git";
import { FactStore } from "../../src/storage/store";
import { openIndexDb } from "../../src/index/db";
import { FactIndex } from "../../src/index/factIndex";
import { RemoteSync } from "../../src/storage/sync";
import { Serializer } from "../../src/index/serialize";
import { krimtoRecall, type ToolContext } from "../../src/server/tools";
const execFileP = promisify(execFile);

describe("inbound sync: a teammate's edit reaches recall", () => {
  let bare: string;
  let dir: string;
  let mate: string;
  let ctx: ToolContext;
  let sync: RemoteSync;
  let seedRel: string;

  beforeEach(async () => {
    bare = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-bare-"));
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-local-"));
    mate = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-mate-"));
    await execFileP("git", ["init", "--bare", "-q", "-b", "main", bare]); // pin main so it matches the app on a master-default git (CI)

    const repo = await GitRepo.open(dir);
    const store = new FactStore(dir);
    const { path: rel } = await store.writeFact({
      scope: "org/acme", title: "Deploys", body: "deploys happen on tuesday", author: "a@x.com",
    });
    seedRel = rel;
    await repo.stage(rel);
    await repo.commit("krimto: seed");
    await repo.setRemote(bare);
    await repo.push();

    const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
    const index = new FactIndex(db);
    await index.rebuild(await store.allFacts());
    ctx = {
      store, index,
      writeQueue: new Serializer(),
      requester: { identity: "a@x.com", teams: [] },
      membership: { org: { slug: "acme", admins: ["a@x.com"] }, teams: [], users: [] },
    };
    sync = new RemoteSync(repo, async () => { await index.rebuild(await store.allFacts()); }, { intervalMs: 60_000 });

    await execFileP("git", ["clone", "-q", bare, mate]);
    await execFileP("git", ["-C", mate, "config", "user.email", "mate@x.com"]);
    await execFileP("git", ["-C", mate, "config", "user.name", "Mate"]);
  });
  afterEach(async () => {
    for (const d of [bare, dir, mate]) await fs.rm(d, { recursive: true, force: true });
  });

  it("reflects a teammate's edited fact after pull", async () => {
    const mateFile = path.join(mate, seedRel);
    const original = await fs.readFile(mateFile, "utf8");
    await fs.writeFile(mateFile, original.replace("tuesday", "wednesday"), "utf8");
    await execFileP("git", ["-C", mate, "commit", "-aqm", "mate: fix day"]);
    await execFileP("git", ["-C", mate, "push", "-q"]);

    await sync.pullOnce();

    const res = await krimtoRecall(ctx, { query: "when do deploys happen" });
    expect(res.results.some((r) => r.body.includes("wednesday"))).toBe(true);
    expect(res.results.some((r) => r.body.includes("tuesday"))).toBe(false);
  });

  it("drops a teammate-deleted fact from recall after pull", async () => {
    await execFileP("git", ["-C", mate, "rm", "-q", seedRel]);
    await execFileP("git", ["-C", mate, "commit", "-qm", "mate: delete"]);
    await execFileP("git", ["-C", mate, "push", "-q"]);

    await sync.pullOnce();

    const res = await krimtoRecall(ctx, { query: "deploys" });
    expect(res.results).toHaveLength(0);
  });
});
