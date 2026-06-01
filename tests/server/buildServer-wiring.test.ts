import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, type RequesterResolver } from "../../src/server/index";
import { FactStore } from "../../src/storage/store";
import { openIndexDb } from "../../src/index/db";
import { FactIndex } from "../../src/index/factIndex";
import { Serializer } from "../../src/index/serialize";
import { KrimtoError } from "../../src/server/errors";
import { type ToolContext } from "../../src/server/tools";

describe("buildServer resolveRequester wiring", () => {
  let root: string;
  let client: Client | undefined;
  let ctx: ToolContext;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-bs-"));
    const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
    ctx = {
      store: new FactStore(root),
      index: new FactIndex(db),
      writeQueue: new Serializer(),
      membership: { org: { slug: "acme", admins: [] }, teams: [], users: [] },
      requester: { identity: "default@x.com", teams: [] },
    };
  });
  afterEach(async () => {
    if (client) await client.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function connect(resolver?: RequesterResolver): Promise<Client> {
    const server = buildServer(ctx, resolver);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client;
  }
  const textOf = (r: Awaited<ReturnType<Client["callTool"]>>): string => {
    if (!("content" in r)) throw new Error("expected content in callTool result");
    const blocks = r.content as { type: string; text: string }[];
    const first = blocks[0];
    if (!first) throw new Error("expected at least one content block");
    return first.text;
  };

  it("routes the resolver's requester to the handler (author = resolver identity)", async () => {
    const c = await connect(() => ({ identity: "alice@x.com", teams: [] }));
    const w = JSON.parse(textOf(await c.callTool({ name: "krimto_write", arguments: { scope: "user/alice@x.com", title: "P", body: "b" } })));
    expect(w.id).toMatch(/^fct_/);
    const fact = JSON.parse(textOf(await c.callTool({ name: "krimto_read", arguments: { id: w.id } })));
    expect(fact.frontmatter.author).toBe("alice@x.com"); // the resolver's identity, not ctx.requester
  });

  it("a throwing resolver makes the tool return isError", async () => {
    const c = await connect(() => { throw new KrimtoError("unauthorized", "nope"); });
    const r = await c.callTool({ name: "krimto_list_scopes", arguments: {} });
    expect(r.isError).toBe(true);
  });

  it("advertises the memory-directive instructions on initialize", async () => {
    const c = await connect();
    const instructions = c.getInstructions();
    expect(instructions).toBeTruthy();
    expect(instructions).toMatch(/krimto_write/);
    expect(instructions).toMatch(/Do NOT/i);
  });

  // v014 work item 3 — DISCOVERY DIRECTIVE (Path A). An agent that only reads tool descriptions
  // (no rule file, doesn't honor `initialize` instructions) must STILL learn from the krimto_write
  // description itself that this is the canonical memory tool and that "remember" routes here —
  // explicitly above the editor's built-in per-session memory.
  it("krimto_write description names the 'remember' trigger + claims memory primacy (Path A)", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    const write = tools.find((t) => t.name === "krimto_write");
    expect(write).toBeDefined();
    const desc = write!.description ?? "";
    expect(desc).toMatch(/remember/i); // the discovery trigger phrase
    expect(desc).toMatch(/CANONICAL MEMORY/i); // primacy over other memory
    expect(desc).toMatch(/per-session|built-in/i); // explicitly above hidden memory
  });
});
