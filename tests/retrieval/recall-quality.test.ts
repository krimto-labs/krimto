// Retrieval-quality eval. Runs the REAL recall path (krimtoRecall → searchCandidates →
// rankCandidates) over known fact sets and asserts which fact ranks #1. This is the
// regression scoreboard the suite was missing: existing tests prove facts SAVE and SUPERSEDE,
// but nothing proved recall returns the RIGHT fact first.
//
// Derived from the smoke-6 transcript: "favorite food" returned the user's favorite COLOR
// (green) as the top hit, above the actual food fact — because keyword search matched the
// shared generic word "favorite" and the food fact's body had been written too thin ("Also
// likes sushi", dropping "pizza"/"food"/"favorite"). These tests pin both the behavior we
// want to keep (good content ranks correctly; superseded facts never surface) and the known
// keyword-mode limitation that motivates the write-time similarity hint + semantic search.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FactStore } from "../../src/storage/store";
import { openIndexDb } from "../../src/index/db";
import { FactIndex } from "../../src/index/factIndex";
import { Serializer } from "../../src/index/serialize";
import { krimtoRecall, krimtoSupersede, krimtoWrite, type ToolContext } from "../../src/server/tools";

const SCOPE = "user/maria@acme.com";

let root: string;
let ctx: ToolContext;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-recallq-"));
  // Keyword mode (provider: "none") — the zero-config DEFAULT every new user runs.
  const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
  ctx = {
    store: new FactStore(root),
    index: new FactIndex(db),
    writeQueue: new Serializer(),
    requester: { identity: "maria@acme.com", teams: [] },
    membership: {
      org: { slug: "acme", admins: [] },
      teams: [],
      users: [{ email: "maria@acme.com" }],
    },
  };
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(title: string, body: string): Promise<string> {
  const r = await krimtoWrite(ctx, { scope: SCOPE, title, body });
  return r.id;
}
async function recallIds(query: string): Promise<string[]> {
  const { results } = await krimtoRecall(ctx, { query });
  return results.map((r) => r.id);
}

describe("recall quality — ranking guards (must stay green)", () => {
  it("ranks a well-written food fact #1 for 'favorite food', above an unrelated color fact", async () => {
    await write("Favorite color: green", "User's favorite color is green.");
    const food = await write("Favorite food: pizza and sushi", "User's favorite food is pizza and sushi.");
    // Good content (title + body both carry "favorite" AND "food") wins even in keyword mode.
    expect((await recallIds("favorite food"))[0]).toBe(food);
  });

  it("ranks the color fact #1 for 'favorite color'", async () => {
    const color = await write("Favorite color: green", "User's favorite color is green.");
    await write("Favorite food: pizza and sushi", "User's favorite food is pizza and sushi.");
    expect((await recallIds("favorite color"))[0]).toBe(color);
  });

  it("never returns a superseded fact", async () => {
    const pizza = await write("Favorite food: pizza", "User's favorite food is pizza.");
    await krimtoSupersede(ctx, {
      id: pizza,
      new_title: "Favorite food: pizza and sushi",
      new_body: "User's favorite food is pizza and sushi.",
      reason: "added sushi",
    });
    expect(await recallIds("favorite food")).not.toContain(pizza);
  });
});

describe("recall quality — known keyword-mode limitation (smoke-6 repro)", () => {
  // DESIRED: a content-poor food fact still ranks #1 for "favorite food". Keyword search
  // can't achieve this — the food fact's body ("Also likes sushi") contains none of the query
  // terms, so it loses to a color fact that shares the generic word "favorite". This `it.fails`
  // documents the limitation and will flip to an UNEXPECTED PASS (turning the suite red) the
  // moment semantic search is the default or the body is repaired — that's the signal to
  // delete `.fails` and promote it to a guard.
  it.fails("ranks a content-poor food fact #1 for 'favorite food' (fails in keyword mode)", async () => {
    await write("Favorite color: green", "User's favorite color is green.");
    const food = await write("Food preferences: pizza and sushi", "Also likes sushi.");
    expect((await recallIds("favorite food"))[0]).toBe(food);
  });
});
