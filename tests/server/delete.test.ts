// deleteFact() — hard delete with index + markdown sync. Not an MCP tool (the agent surface stays
// at 5 by design); reached only through `krimto rm` and the /ui Delete button.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FactStore } from "../../src/storage/store";
import { openIndexDb } from "../../src/index/db";
import { FactIndex } from "../../src/index/factIndex";
import { Serializer } from "../../src/index/serialize";
import { deleteFact } from "../../src/server/deleteFact";
import { krimtoRead, krimtoWrite, type ToolContext } from "../../src/server/tools";

let root: string;
let ctx: ToolContext;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-delete-"));
  const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
  ctx = {
    store: new FactStore(root),
    index: new FactIndex(db),
    writeQueue: new Serializer(),
    requester: { identity: "alice@acme.com", teams: ["payments"] },
    membership: {
      org: { slug: "acme", admins: ["alice@acme.com"] },
      teams: [{ slug: "payments", members: ["alice@acme.com", "bob@acme.com"], leads: [] }],
      users: [],
    },
  };
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("deleteFact", () => {
  it("removes a fact end-to-end: file gone, index entry gone, read returns not_found", async () => {
    const w = await krimtoWrite(ctx, { scope: "user/alice@acme.com", title: "Pref", body: "tabs" });
    expect((await fs.stat(path.join(root, w.path))).isFile()).toBe(true);

    const r = await deleteFact(ctx, w.id);
    expect(r.status).toBe("ok");
    expect(r.id).toBe(w.id);
    expect(r.path).toBe(w.path);

    await expect(fs.access(path.join(root, w.path))).rejects.toThrow();
    await expect(krimtoRead(ctx, w.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("cleans up an orphaned INDEX entry (file was manually deleted)", async () => {
    const w = await krimtoWrite(ctx, { scope: "user/alice@acme.com", title: "Stale", body: "x" });
    // Simulate the user's manual `rm ~/.krimto/...md`
    await fs.unlink(path.join(root, w.path));

    const r = await deleteFact(ctx, w.id);
    expect(r.status).toBe("orphan_index");
    // Index should be cleared now too
    await expect(krimtoRead(ctx, w.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("returns not_found when the fact exists in neither index nor store", async () => {
    await expect(deleteFact(ctx, "fct_doesnotexist")).rejects.toMatchObject({ code: "not_found" });
  });

  it("respects canWrite — a team member cannot delete from another user's personal scope", async () => {
    // Set requester to bob (NOT an org admin)
    const bobCtx: ToolContext = { ...ctx, requester: { identity: "bob@acme.com", teams: ["payments"] } };
    // Alice writes to her own scope as bob would see it...
    const aliceCtx: ToolContext = { ...ctx, requester: { identity: "alice@acme.com", teams: ["payments"] } };
    const w = await krimtoWrite(aliceCtx, { scope: "user/alice@acme.com", title: "Pref", body: "tabs" });
    // bob is org admin? No — we removed bob from admins. Try delete as bob, expect forbidden.
    bobCtx.membership = { ...ctx.membership, org: { slug: "acme", admins: [] } };
    await expect(deleteFact(bobCtx, w.id)).rejects.toMatchObject({ code: "forbidden" });
    // Sanity: alice (admin) can delete it
    aliceCtx.membership = bobCtx.membership; // same membership view
    aliceCtx.membership = { ...bobCtx.membership, org: { slug: "acme", admins: ["alice@acme.com"] } };
    const r = await deleteFact(aliceCtx, w.id);
    expect(r.status).toBe("ok");
  });

  it("records a krimto_delete entry in the activity log when one is configured", async () => {
    const { ActivityLog } = await import("../../src/server/activity");
    const activity = new ActivityLog(root);
    const ctxWithActivity: ToolContext = { ...ctx, activity };
    const w = await krimtoWrite(ctxWithActivity, { scope: "user/alice@acme.com", title: "Pref", body: "tabs" });
    await deleteFact(ctxWithActivity, w.id);
    const tail = await activity.tail(10);
    const deleteEntry = tail.find((e) => e.tool === "krimto_delete");
    expect(deleteEntry).toBeDefined();
    expect(deleteEntry!.detail).toContain(w.id);
  });
});
