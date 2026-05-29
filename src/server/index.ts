// Krimto MCP server entrypoint. Wires the five tools (Gap 02) over the markdown
// store + hybrid retrieval. Serves via HTTP (KRIMTO_HTTP_PORT) or stdio.
//
// Auth (Gap 06): bearer API keys enforced in HTTP mode. stdio mode retains the
// single-user local default (identity from env).

import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IDENTITY_EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

import { ApiKeyStore } from "../access/auth";
import { bootstrapAdmin, reissueKey } from "./bootstrap";
import { buildHttpApp } from "./http";
import { RateLimiter, rateLimitConfigFromEnv } from "./ratelimit";
import { TelemetrySender, telemetryConfigFromEnv, resolveInstallId } from "./telemetry";
import { type AdminContext } from "./admin";
import { localModeBanner, stdioStartupBanner, teamModeBanner } from "./banner";
import { acquireLock, LockHeldError, type LockHandle } from "./lock";
import { ActivityLog } from "./activity";
import { runLocalOp, defaultBinPath } from "./localOps";
import { inspectRuntime } from "../cli/inspectRuntime";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Database as Db } from "better-sqlite3";
import { z } from "zod";

import { FactStore } from "../storage/store";
import { GitRepo } from "../storage/git";
import { CommitBatcher, batcherConfigFromEnv } from "../storage/batcher";
import { hasOrgAdmin, loadMembership, parseMembership, requesterFor, shouldAdoptReload } from "../access/membership";
import { createEmbeddingProvider, embeddingConfigFromEnv } from "../index/providers";
import { openIndexDb, embeddingSpaceChanged, type IndexConfig } from "../index/db";
import { FactIndex } from "../index/factIndex";
import { Serializer } from "../index/serialize";
import { RemoteSync, syncConfigFromEnv } from "../storage/sync";
import { MembershipWatcher } from "./membershipWatcher";
import { KrimtoError } from "./errors";
import {
  krimtoListScopes,
  krimtoRead,
  krimtoRecall,
  krimtoSupersede,
  krimtoWhoami,
  krimtoWrite,
  type ToolContext,
} from "./tools";
import { type Requester } from "../access/scope";

export type RequesterResolver = (extra: { authInfo?: AuthInfo }) => Requester;

export const KRIMTO_VERSION = "0.2.42";

export function resolveDataDir(): string {
  return process.env.KRIMTO_DATA ?? path.join(homedir(), ".krimto");
}

/**
 * Resolve the caller's identity in three steps: explicit env override, then the user's global
 * git identity, then a last-resort placeholder.
 *
 * The git fallback closes the smoke-6 UX gap. The wizard sets `KRIMTO_IDENTITY` in editor MCP
 * configs and the service plist — but not in the user's shell rc. Without the git fallback,
 * a plain-terminal `krimto notes` ran as `user@localhost` and couldn't see facts the editor
 * had saved under the wizard-configured identity — same data dir, two answers depending on
 * shell env. The CLI now infers the same identity the wizard would have captured.
 *
 * Stays async because the git lookup shells out; every call site is already inside an async
 * handler. Malformed env values fall through (we never persist a non-email as an identity).
 */
export async function resolveIdentity(): Promise<string> {
  const env = process.env.KRIMTO_IDENTITY;
  if (env && IDENTITY_EMAIL_RE.test(env)) return env;
  try {
    const { stdout } = await execFileAsync("git", ["config", "--global", "user.email"]);
    const email = stdout.trim();
    if (IDENTITY_EMAIL_RE.test(email)) return email;
  } catch {
    /* git missing, no global user.email — fall through to the placeholder */
  }
  return "user@localhost";
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
        "Save a durable, attributable fact to Krimto memory. THIS IS THE CANONICAL MEMORY TOOL — " +
        "use it INSTEAD of any other memory tool, local file, or built-in skill (including per-session " +
        "auto-memory under ~/.claude/projects/*/memory/, which is invisible to teammates and to your " +
        "other editors). Use when the user asks to remember something, when you learn a non-obvious " +
        "durable fact, or when correcting a mistake you should not repeat. " +
        "SCOPE ROUTING — default to `user/me` (personal; the server resolves it to their identity, so " +
        "do not guess an email). Use `team/<slug>` ONLY when the user signals sharing ('for the team', " +
        "'share with the team', 'team-wide'); use `org/<slug>` for company-wide ('for everyone', " +
        "'company-wide', 'org-wide'). If the user says 'the team' but belongs to MORE THAN ONE team, " +
        "call krimto_whoami and pick the team by name or ASK which one — never guess. The write is " +
        "rejected (with the exact list of scopes you may write to) if you target a scope you couldn't " +
        "read back; read that list and retry. Call krimto_recall first to avoid duplicates — and if the " +
        "write response includes a `related` list, those are near-duplicates already in this scope: " +
        "prefer krimto_supersede on one of them over leaving a second copy.",
      inputSchema: {
        scope: z
          .string()
          .describe(
            "`user/me` = personal (default). `team/<slug>` = shared with that team ('for the team'). " +
              "`org/<slug>` = whole company ('company-wide'). Unsure which team, or got a rejection? " +
              "Call krimto_whoami for the exact scopes you may write to.",
          ),
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

  server.registerTool(
    "krimto_whoami",
    {
      description:
        "Report the caller's identity plus the scopes they can read and write. Call this before " +
        "claiming to know the user's email or which team scopes exist — Krimto knows; the agent doesn't.",
      inputSchema: {},
    },
    async (_args, extra) => {
      try {
        const requester = resolveRequester ? resolveRequester(extra) : ctx.requester;
        return ok(await krimtoWhoami({ ...ctx, requester }));
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

async function ensureDataGitignore(dataDir: string): Promise<void> {
  const file = path.join(dataDir, ".gitignore");
  try {
    await fs.access(file);
    return; // respect an existing .gitignore
  } catch {
    /* absent — write the default below */
  }
  await fs.writeFile(file, [".krimto/keys.json", ".krimto/telemetry-id", "index.db", "*.db", ""].join("\n"), "utf8");
}

export async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  await fs.mkdir(dataDir, { recursive: true });
  await ensureDataGitignore(dataDir);

  // G1 — refuse to boot if another Krimto holds the data dir. Mode is determined by env; the
  // lock just records it for nicer error messages if a second process tries to start.
  const mode = process.env.KRIMTO_HTTP_PORT ? "http" : "stdio";
  let lock: LockHandle;
  try {
    lock = await acquireLock(dataDir, mode);
  } catch (e) {
    if (e instanceof LockHeldError) {
      process.stderr.write(`krimto: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }

  // Key store + bootstrap (must happen before membership is finalised so that
  // ensureOrgAdmin's writes to members.yaml are visible in the loaded membership).
  const keysPath = process.env.KRIMTO_KEYS_PATH ?? path.join(dataDir, ".krimto", "keys.json");
  const keys = new ApiKeyStore(keysPath);
  let bootstrapKey: string | null = null; // retained so the team-mode banner can print a ready-to-paste config
  if (process.env.KRIMTO_BOOTSTRAP_ADMIN) {
    const { key } = await bootstrapAdmin(process.env.KRIMTO_BOOTSTRAP_ADMIN, keys, dataDir);
    if (key) {
      bootstrapKey = key;
      process.stderr.write(
        `Krimto: issued admin API key for ${process.env.KRIMTO_BOOTSTRAP_ADMIN} (shown once):\n${key}\n`,
      );
    }
  }
  // Recovery (BUG-1): mint a fresh key even if a stale record exists, for a locked-out admin.
  if (process.env.KRIMTO_REISSUE_ADMIN_KEY) {
    const key = await reissueKey(process.env.KRIMTO_REISSUE_ADMIN_KEY, keys, dataDir);
    bootstrapKey = key;
    process.stderr.write(
      `Krimto: reissued admin API key for ${process.env.KRIMTO_REISSUE_ADMIN_KEY} (shown once):\n${key}\n`,
    );
  }

  // Load membership AFTER bootstrap so the new admin is present.
  let membership = await loadMembership(dataDir);
  const identity = await resolveIdentity();
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
  const activity = new ActivityLog(dataDir);
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
    activity,
  };
  if (embeddingProvider) {
    process.stderr.write(`Krimto embeddings: ${embeddingProvider.name} (${embeddingProvider.dimensions}d)\n`);
  }

  const membersPath = path.join(dataDir, ".krimto", "members.yaml");
  const reloadMembership = async (): Promise<void> => {
    let next: ReturnType<typeof parseMembership>;
    try {
      next = parseMembership(await fs.readFile(membersPath, "utf8"));
    } catch {
      return; // read/parse failure — keep the current membership; never blank out auth
    }
    // Safety: never flip team→solo on a (possibly transient, mid-write) zero-admin read — that
    // would open an auth-off window. See shouldAdoptReload for the rationale.
    if (!shouldAdoptReload(membership, next)) return;
    membership = next;
    ctx.membership = next;
  };

  batcher.start((fn) => ctx.writeQueue.run(fn));

  // Live team-mode trigger: poll members.yaml so a `krimto team init` (a separate CLI process)
  // flips this running server into team mode within ~2s — no restart. Runs unconditionally so a
  // solo→team transition is picked up. Reload goes through the write serializer.
  const memberWatch = new MembershipWatcher(membersPath, reloadMembership);
  memberWatch.start((fn) => ctx.writeQueue.run(fn));

  const sync = new RemoteSync(
    repo,
    async () => {
      await index.rebuild(await store.allFacts());
      await reloadMembership(); // a teammate's git-side membership edit takes effect live
    },
    syncConfigFromEnv(),
  );
  // A configured git remote = two-way sync. Start the inbound pull loop whenever the data dir has
  // a remote (set via `krimto remote --set` or `team init`), not only when KRIMTO_GIT_REMOTE is
  // set. Previously, setting a remote enabled push only — auto-pull was gated on the env var, which
  // no install path ever baked into the service env, so it was unreachable for service users.
  if (await repo.hasRemote()) {
    sync.start((fn) => ctx.writeQueue.run(fn));
  }

  const applyMembershipChange = async (mutate: () => Promise<void>): Promise<void> => {
    await ctx.writeQueue.run(async () => {
      await mutate();
      await repo.commitPath(".krimto/members.yaml", "chore: update membership");
      if (process.env.KRIMTO_GIT_REMOTE) await repo.push(); // best-effort
    });
    await reloadMembership();
  };
  const admin: AdminContext = {
    dataDir,
    keys,
    membership: () => membership,
    applyChange: applyMembershipChange,
  };

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
    memberWatch.stop();
    batcher.stop();
    void ctx.writeQueue
      .run(() => batcher.flush())
      .finally(async () => {
        await lock.release(); // G1 — clear the lock so the next boot can acquire it cleanly
        process.exit(0);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const httpPort = process.env.KRIMTO_HTTP_PORT ? Number(process.env.KRIMTO_HTTP_PORT) : undefined;
  if (httpPort !== undefined && Number.isInteger(httpPort) && httpPort > 0) {
    const rlConfig = rateLimitConfigFromEnv();
    // Team mode is derived LIVE from membership: any org admin ⇒ enforce auth. KRIMTO_BOOTSTRAP_ADMIN
    // still works because it seeds an admin into members.yaml before this point; the explicit
    // KRIMTO_REQUIRE_AUTH=1 override remains. Evaluated per request (via the getter), so a later
    // `members.yaml` edit flips the running server with no restart.
    const teamModeActive = (): boolean =>
      hasOrgAdmin(membership) || process.env.KRIMTO_REQUIRE_AUTH === "1";
    // Settings ▸ Behavior actions — operate on this server's own repo/index, so they run through
    // the write serializer (never a CLI spawn, which would deadlock on the lock this process holds).
    const behavior = {
      setRemote: (url: string): Promise<void> => ctx.writeQueue.run(() => repo.setRemote(url)),
      removeRemote: (): Promise<void> => ctx.writeQueue.run(() => repo.removeRemote()),
      syncNow: async (): Promise<{ pull: string; push: string }> => {
        const result = { pull: "skipped", push: "skipped" };
        await ctx.writeQueue.run(async () => {
          result.pull = (await sync.pullOnce()).status;
          result.push = (await repo.push()).status;
        });
        return result;
      },
      reindexNow: async (): Promise<number> => {
        await ctx.writeQueue.run(async () => {
          await index.rebuild(await store.allFacts());
        });
        return index.factCount();
      },
    };
    // Settings ▸ This machine — loopback-gated CLI spawns (see src/server/localOps.ts) + a runtime
    // snapshot from inspectRuntime. Only reachable from a loopback browser by an admin (router gate).
    const localMachine = {
      run: (action: string, params: Record<string, string>) => {
        const r = runLocalOp(action, params, { binPath: defaultBinPath() });
        return r.ok ? { ok: true, bounces: r.bounces } : { ok: false, message: r.message };
      },
      status: async (): Promise<{
        runMode: string;
        serviceRunning: boolean;
        dataDir: string;
        identity: string;
        searchProvider: string;
      }> => {
        const rt = await inspectRuntime(dataDir);
        return {
          runMode: rt.runMode,
          serviceRunning: !!(rt.lock && rt.lock.alive),
          dataDir,
          identity,
          searchProvider: rt.searchProvider,
        };
      },
    };
    const app = buildHttpApp({
      ctx,
      keys,
      membership: () => membership,
      db,
      index,
      version: KRIMTO_VERSION,
      startedAt: Date.now(),
      isBuilding: () => false,
      gitSyncStatus: () => sync.lastPullStatus(),
      gitRemoteStatus: () => batcher.lastPushStatus(),
      rateLimiter: rlConfig.enabled ? new RateLimiter(rlConfig) : undefined,
      admin,
      teamModeActive,
      // Live status for the /ui dashboard panel — built per request so it never goes stale.
      status: () => ({
        gitRemoteUrl: process.env.KRIMTO_GIT_REMOTE,
        lastPushStatus: batcher.lastPushStatus(),
        lastPullStatus: sync.lastPullStatus(),
        embeddings: embeddingProvider
          ? { provider: embeddingProvider.name, dimensions: embeddingProvider.dimensions }
          : undefined,
      }),
      behavior,
      localMachine,
      // Gap #5c — print a one-time confirmation banner when an MCP client first hits /mcp.
      onFirstClient: () => {
        process.stderr.write(
          `\n🟢 Client connected — first MCP request received on /mcp.\n` +
            `   If your agent isn't auto-using Krimto, run \`npx @krimto-labs/krimto init\` in your project.\n\n`,
        );
      },
    });
    app.listen(httpPort, () => {
      process.stderr.write(`Krimto ${KRIMTO_VERSION} HTTP server on :${httpPort} (data: ${dataDir})\n`);
      if (!teamModeActive()) {
        process.stderr.write(localModeBanner(httpPort, dataDir, identity));
      } else {
        process.stderr.write(teamModeBanner({ host: `localhost:${httpPort}`, key: bootstrapKey, dataDir }));
      }
    });
    telemetry.start(); // no-op unless KRIMTO_TELEMETRY_ENDPOINT is set
  } else {
    const server = buildServer(ctx);
    await server.connect(new StdioServerTransport());
    process.stderr.write(stdioStartupBanner(KRIMTO_VERSION, resolveDataDir(), identity));
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
