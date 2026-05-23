// Krimto MCP server entrypoint. Wires the five tools (Gap 02) over the markdown
// store + hybrid retrieval and serves them on the MCP stdio transport.
//
// Auth (Gap 06) and membership (Gap 07) land in v0.2; until then the requester
// identity/teams come from environment variables (single-user local default).

import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import * as path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { FactStore } from "../storage/store";
import { GitWriter } from "../storage/git";
import { loadMembership, requesterFor } from "../access/membership";
import { createEmbeddingProvider, embeddingConfigFromEnv } from "../index/providers";
import { openIndexDb } from "../index/db";
import { FactIndex } from "../index/factIndex";
import { Serializer } from "../index/serialize";
import { KrimtoError } from "./errors";
import {
  krimtoListScopes,
  krimtoRead,
  krimtoRecall,
  krimtoSupersede,
  krimtoWrite,
  type ToolContext,
} from "./tools";

export const KRIMTO_VERSION = "0.2.0";

export function resolveDataDir(): string {
  return process.env.KRIMTO_DATA ?? path.join(homedir(), ".krimto");
}

export function resolveIdentity(): string {
  return process.env.KRIMTO_IDENTITY ?? "user@localhost";
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown): CallToolResult {
  const err =
    error instanceof KrimtoError
      ? error
      : new KrimtoError("internal", error instanceof Error ? error.message : String(error));
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: { code: err.code, message: err.message, data: err.data } }, null, 2),
      },
    ],
  };
}

/** Build the MCP server with the five Krimto tools registered against the given context. */
export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "krimto", version: KRIMTO_VERSION });

  server.registerTool(
    "krimto_write",
    {
      description:
        "Save a durable, attributable fact to Krimto memory. Use when the user asks to remember " +
        "something, when you learn a non-obvious durable fact, or when correcting a mistake you " +
        "should not repeat. Default to the user's personal scope unless the fact is clearly shared. " +
        "Call krimto_recall first to avoid duplicates.",
      inputSchema: {
        scope: z.string().describe("user/<id>, team/<slug>, or org/<slug>"),
        title: z.string().describe("descriptive title, <= 80 chars"),
        body: z.string().describe("markdown content"),
        tags: z.array(z.string()).optional(),
        source: z.string().optional(),
        supersedes: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      try {
        return ok(await krimtoWrite(ctx, args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "krimto_recall",
    {
      description:
        "Search Krimto memory. Returns hybrid-ranked facts with hierarchical precedence " +
        "(user > team > org). Call before domain-specific work; use specific queries.",
      inputSchema: {
        query: z.string(),
        scopes: z.array(z.string()).optional(),
        limit: z.number().optional(),
      },
    },
    async (args) => {
      try {
        return ok(await krimtoRecall(ctx, args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "krimto_read",
    {
      description: "Fetch one fact by id, including its full frontmatter.",
      inputSchema: { id: z.string() },
    },
    async (args) => {
      try {
        return ok(await krimtoRead(ctx, args.id));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "krimto_supersede",
    {
      description:
        "Replace a fact with a new one whose supersedes field references the old. The old fact " +
        "remains in git history.",
      inputSchema: {
        id: z.string(),
        new_title: z.string(),
        new_body: z.string(),
        reason: z.string(),
      },
    },
    async (args) => {
      try {
        return ok(await krimtoSupersede(ctx, args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "krimto_list_scopes",
    {
      description: "Discover the scopes that exist and what they contain.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await krimtoListScopes(ctx));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

export async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  const membership = await loadMembership(dataDir);
  const identity = resolveIdentity();
  const embedCfg = embeddingConfigFromEnv();
  const embeddingProvider = createEmbeddingProvider(embedCfg);
  const db = openIndexDb(`${dataDir}/index.db`, {
    provider: embedCfg.provider ?? "none",
    dimensions: embeddingProvider?.dimensions ?? 0,
  });
  const index = new FactIndex(db, embeddingProvider ?? undefined);
  const ctx: ToolContext = {
    store: new FactStore(dataDir),
    index,
    writeQueue: new Serializer(),
    membership,
    requester: requesterFor(membership, identity),
    embedQuery: embeddingProvider
      ? async (query: string) => {
          const [vec] = await embeddingProvider.embed([query]);
          return vec ? Float32Array.from(vec) : null;
        }
      : undefined,
    git: await GitWriter.open(dataDir),
  };
  const server = buildServer(ctx);
  if (embeddingProvider) {
    process.stderr.write(`Krimto embeddings: ${embeddingProvider.name} (${embeddingProvider.dimensions}d)\n`);
  }
  await server.connect(new StdioServerTransport());
  process.stderr.write(`Krimto ${KRIMTO_VERSION} MCP server ready (data: ${resolveDataDir()})\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((e: unknown) => {
    process.stderr.write(`krimto: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
