// Krimto MCP server entrypoint. Wires the five tools (Gap 02) over the markdown
// store + hybrid retrieval. Serves via HTTP (KRIMTO_HTTP_PORT) or stdio.
//
// Auth (Gap 06): bearer API keys enforced in HTTP mode. stdio mode retains the
// single-user local default (identity from env).

import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";

import { ApiKeyStore } from "../access/auth";
import { bootstrapAdmin, reissueKey } from "./bootstrap";
import { buildHttpApp } from "./http";
import { RateLimiter, rateLimitConfigFromEnv } from "./ratelimit";
import { TelemetrySender, telemetryConfigFromEnv, resolveInstallId } from "./telemetry";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Database as Db } from "better-sqlite3";
import { z } from "zod";

import { FactStore } from "../storage/store";
import { GitRepo } from "../storage/git";
import { CommitBatcher, batcherConfigFromEnv } from "../storage/batcher";
import { loadMembership, requesterFor } from "../access/membership";
import { createEmbeddingProvider, embeddingConfigFromEnv } from "../index/providers";
import { openIndexDb, embeddingSpaceChanged, type IndexConfig } from "../index/db";
import { FactIndex } from "../index/factIndex";
import { Serializer } from "../index/serialize";
import { RemoteSync, syncConfigFromEnv } from "../storage/sync";
import { KrimtoError } from "./errors";
import {
  krimtoListScopes,
  krimtoRead,
  krimtoRecall,
  krimtoSupersede,
  krimtoWrite,
  type ToolContext,
} from "./tools";
import { type Requester } from "../access/scope";

export type RequesterResolver = (extra: { authInfo?: AuthInfo }) => Requester;

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
export function buildServer(ctx: ToolContext, resolveRequester?: RequesterResolver): McpServer {
  const server = new McpServer({ name: "krimto", version: KRIMTO_VERSION });

  server.registerTool(
    "krimto_write",
    {
      description:
        "Save a durable, attributable fact to Krimto memory. Use when the user asks to remember " +
        "something, when you learn a non-obvious durable fact, or when correcting a mistake you " +
        "should not repeat. For the user's personal scope use `user/me` (the server resolves it to " +
        "their identity) — do not guess an email. The write is rejected (with the list of scopes you " +
        "may write to) if you target a scope you couldn't read back. Call krimto_recall first to avoid duplicates.",
      inputSchema: {
        scope: z
          .string()
          .describe("`user/me` for the caller's own scope, or team/<slug> / org/<slug> for shared facts"),
        title: z.string().describe("descriptive title, <= 80 chars"),
        body: z.string().describe("markdown content"),
        tags: z.array(z.string()).optional(),
        source: z.string().optional(),
        supersedes: z.array(z.string()).optional(),
      },
    },
    async (args, extra) => {
      try {
        const requester = resolveRequester ? resolveRequester(extra) : ctx.requester;
        return ok(await krimtoWrite({ ...ctx, requester }, args));
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
    async (args, extra) => {
      try {
        const requester = resolveRequester ? resolveRequester(extra) : ctx.requester;
        return ok(await krimtoRecall({ ...ctx, requester }, args));
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
    async (args, extra) => {
      try {
        const requester = resolveRequester ? resolveRequester(extra) : ctx.requester;
        return ok(await krimtoRead({ ...ctx, requester }, args.id));
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
    async (args, extra) => {
      try {
        const requester = resolveRequester ? resolveRequester(extra) : ctx.requester;
        return ok(await krimtoSupersede({ ...ctx, requester }, args));
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
    async (_args, extra) => {
      try {
        const requester = resolveRequester ? resolveRequester(extra) : ctx.requester;
        return ok(await krimtoListScopes({ ...ctx, requester }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

/** Build the index from the markdown source of truth when it's empty or the embedding space changed. */
export async function buildIndexIfNeeded(
  index: FactIndex,
  store: FactStore,
  db: Db,
  config: IndexConfig,
): Promise<void> {
  if (index.factCount() === 0 || embeddingSpaceChanged(db, config)) {
    await index.rebuild(await store.allFacts());
  }
}

export async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  await fs.mkdir(dataDir, { recursive: true });

  // Key store + bootstrap (must happen before membership is finalised so that
  // ensureOrgAdmin's writes to members.yaml are visible in the loaded membership).
  const keysPath = process.env.KRIMTO_KEYS_PATH ?? path.join(dataDir, ".krimto", "keys.json");
  const keys = new ApiKeyStore(keysPath);
  if (process.env.KRIMTO_BOOTSTRAP_ADMIN) {
    const { key } = await bootstrapAdmin(process.env.KRIMTO_BOOTSTRAP_ADMIN, keys, dataDir);
    if (key) {
      process.stderr.write(
        `Krimto: issued admin API key for ${process.env.KRIMTO_BOOTSTRAP_ADMIN} (shown once):\n${key}\n`,
      );
    }
  }
  // Recovery (BUG-1): mint a fresh key even if a stale record exists, for a locked-out admin.
  if (process.env.KRIMTO_REISSUE_ADMIN_KEY) {
    const key = await reissueKey(process.env.KRIMTO_REISSUE_ADMIN_KEY, keys, dataDir);
    process.stderr.write(
      `Krimto: reissued admin API key for ${process.env.KRIMTO_REISSUE_ADMIN_KEY} (shown once):\n${key}\n`,
    );
  }

  // Load membership AFTER bootstrap so the new admin is present.
  const membership = await loadMembership(dataDir);
  const identity = resolveIdentity();
  const embedCfg = embeddingConfigFromEnv();
  const embeddingProvider = createEmbeddingProvider(embedCfg);
  const indexConfig: IndexConfig = {
    provider: embedCfg.provider ?? "none",
    dimensions: embeddingProvider?.dimensions ?? 0,
  };
  const db = openIndexDb(`${dataDir}/index.db`, indexConfig);
  const store = new FactStore(dataDir);
  const index = new FactIndex(db, embeddingProvider ?? undefined);
  await buildIndexIfNeeded(index, store, db, indexConfig);
  const repo = await GitRepo.open(dataDir);
  if (process.env.KRIMTO_GIT_REMOTE) {
    await repo.setRemote(process.env.KRIMTO_GIT_REMOTE);
  }
  const batcher = new CommitBatcher(repo, batcherConfigFromEnv());
  const ctx: ToolContext = {
    store,
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
    git: batcher,
  };
  if (embeddingProvider) {
    process.stderr.write(`Krimto embeddings: ${embeddingProvider.name} (${embeddingProvider.dimensions}d)\n`);
  }

  batcher.start((fn) => ctx.writeQueue.run(fn));

  const sync = new RemoteSync(
    repo,
    async () => {
      await index.rebuild(await store.allFacts());
    },
    syncConfigFromEnv(),
  );
  if (process.env.KRIMTO_GIT_REMOTE) {
    sync.start((fn) => ctx.writeQueue.run(fn));
  }

  // Opt-in telemetry (off unless KRIMTO_TELEMETRY_ENDPOINT is set). Built here so the
  // shutdown handler can stop it; only start()ed in HTTP mode (the long-running server).
  const installId = await resolveInstallId(dataDir);
  const telemetry = new TelemetrySender(telemetryConfigFromEnv(process.env, installId), () => ({
    version: KRIMTO_VERSION,
    factCount: index.factCount(),
    teamCount: membership.teams.length,
    activeUserCount: membership.users.length,
  }));

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return; // ignore a second SIGINT/SIGTERM
    shuttingDown = true;
    telemetry.stop();
    sync.stop();
    batcher.stop();
    void ctx.writeQueue.run(() => batcher.flush()).finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const httpPort = process.env.KRIMTO_HTTP_PORT ? Number(process.env.KRIMTO_HTTP_PORT) : undefined;
  if (httpPort !== undefined && Number.isInteger(httpPort) && httpPort > 0) {
    const rlConfig = rateLimitConfigFromEnv();
    const app = buildHttpApp({
      ctx,
      keys,
      membership: () => membership,
      db,
      index,
      version: KRIMTO_VERSION,
      startedAt: Date.now(),
      isBuilding: () => false,
      gitRemoteStatus: () => batcher.lastPushStatus(),
      rateLimiter: rlConfig.enabled ? new RateLimiter(rlConfig) : undefined,
    });
    app.listen(httpPort, () => {
      process.stderr.write(`Krimto ${KRIMTO_VERSION} HTTP server on :${httpPort} (data: ${dataDir})\n`);
    });
    telemetry.start(); // no-op unless KRIMTO_TELEMETRY_ENDPOINT is set
  } else {
    const server = buildServer(ctx);
    await server.connect(new StdioServerTransport());
    process.stderr.write(`Krimto ${KRIMTO_VERSION} MCP server ready (data: ${resolveDataDir()})\n`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((e: unknown) => {
    process.stderr.write(`krimto: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
