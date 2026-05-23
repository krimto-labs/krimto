// End-to-end through the MCP protocol: a real client talks to the Krimto server
// over an in-memory transport, proving the tool wiring (Gap 02) works on the wire.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer } from "../../src/server/index";
import { FactStore } from "../../src/storage/store";
import { type ToolContext } from "../../src/server/tools";

let root: string;
let client: Client;

function textContent(content: unknown): string {
  const blocks = content as { type: string; text?: string }[];
  const block = blocks[0];
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("expected a text content block");
  }
  return block.text;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-mcp-"));
  const ctx: ToolContext = {
    store: new FactStore(root),
    requester: { identity: "alice@acme.com", teams: ["payments"] },
  };
  const server = buildServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "krimto-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("MCP server", () => {
  it("advertises exactly the five Krimto tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "krimto_list_scopes",
      "krimto_read",
      "krimto_recall",
      "krimto_supersede",
      "krimto_write",
    ]);
  });

  it("write then recall over the protocol", async () => {
    const writeRes = await client.callTool({
      name: "krimto_write",
      arguments: {
        scope: "team/payments",
        title: "Stripe webhooks",
        body: "Verify the webhook signature before processing.",
      },
    });
    const written = JSON.parse(textContent(writeRes.content)) as { id: string; scope: string };
    expect(written.id).toMatch(/^fct_/);
    expect(written.scope).toBe("team/payments");

    const recallRes = await client.callTool({
      name: "krimto_recall",
      arguments: { query: "stripe webhook signature" },
    });
    const recalled = JSON.parse(textContent(recallRes.content)) as {
      results: { id: string; title: string }[];
    };
    expect(recalled.results[0]!.title).toBe("Stripe webhooks");
    expect(recalled.results[0]!.id).toBe(written.id);
  });

  it("returns a structured error for an unknown fact id", async () => {
    const res = await client.callTool({ name: "krimto_read", arguments: { id: "fct_missing" } });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(textContent(res.content)) as { error: { code: string } };
    expect(payload.error.code).toBe("not_found");
  });
});
