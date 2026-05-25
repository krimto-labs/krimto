// End-to-end through the npx launcher: spawn `node bin/krimto.mjs` as a real process and drive it
// with a real MCP stdio client. Proves the published-package entry boots the stdio server (solo, no
// auth) and serves the five tools — the no-Docker on-ramp. Mirrors mcp.test.ts but over a spawned
// process instead of an in-memory transport.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/krimto.mjs");

let root: string;
let client: Client;

function text(content: unknown): string {
  return (content as { type: string; text?: string }[])[0]?.text ?? "";
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-npx-"));
  const transport = new StdioClientTransport({
    command: process.execPath, // the node running vitest
    args: [BIN],
    env: { ...process.env, KRIMTO_DATA: root, KRIMTO_IDENTITY: "alice@local" },
  });
  client = new Client({ name: "npx-test", version: "0.0.0" });
  await client.connect(transport); // performs the MCP initialize handshake
}, 30000);

afterEach(async () => {
  await client.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("npx launcher (stdio)", () => {
  it("boots via the bin and advertises exactly the five tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "krimto_list_scopes",
      "krimto_read",
      "krimto_recall",
      "krimto_supersede",
      "krimto_write",
    ]);
  }, 30000);

  it("write then recall round-trips through the launched process", async () => {
    const w = await client.callTool({
      name: "krimto_write",
      arguments: { scope: "user/me", title: "Deploys", body: "Deploys are Tuesdays at 10am." },
    });
    expect(text(w.content)).toContain("fct_");

    const r = await client.callTool({ name: "krimto_recall", arguments: { query: "when are deploys" } });
    expect(text(r.content)).toContain("Deploys");
  }, 30000);
});
