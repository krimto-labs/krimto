// Shared runtime helpers for the v0.2.17-2 per-note CLI commands (notes / edit / mv / supersede /
// tag). Each command needs the same scaffolding the server's `main()` builds — store, index,
// membership, requester, writeQueue, optionally a CommitBatcher — without actually starting the
// MCP transport. `deleteFact.ts` was doing this inline; extracting it here so the new commands
// don't have to copy-paste 30 lines of setup.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { Database } from "better-sqlite3";

import { loadMembership, requesterFor, type Membership } from "../access/membership";
import { parseScope, type ScopeKind } from "../access/scope";
import { FactIndex } from "../index/factIndex";
import { openIndexDb, type IndexConfig } from "../index/db";
import {
  createEmbeddingProvider,
  embeddingConfigFromEnv,
} from "../index/providers";
import { Serializer } from "../index/serialize";
import { ActivityLog } from "../server/activity";
import { isProcessAlive, type LockInfo } from "../server/lock";
import { CommitBatcher, batcherConfigFromEnv } from "../storage/batcher";
import { GitRepo } from "../storage/git";
import { FactStore } from "../storage/store";
import { type ToolContext } from "../server/tools";

export interface CliContextOptions {
  dataDir: string;
  identity: string;
  /** When true, skip git repo + batcher setup. Reads are safe (SQLite WAL allows readers). */
  readOnly?: boolean;
}

export interface CliContextBundle {
  ctx: ToolContext;
  /** The opened SQLite handle. Caller closes it via `close()`. */
  db: Database;
  /** Release SQLite + close any open resources. Idempotent. */
  close: () => Promise<void>;
}

/**
 * True when a live, different Krimto server holds the data-dir lock. Read-only CLI commands skip
 * this check (concurrent SQLite reads are safe under WAL); write commands must call it and refuse
 * if it returns non-null.
 */
export async function getLockHolder(dataDir: string): Promise<LockInfo | null> {
  const file = path.join(dataDir, ".krimto", "lock.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof parsed.pid === "number" && isProcessAlive(parsed.pid) && parsed.pid !== process.pid) {
      return {
        pid: parsed.pid,
        started: typeof parsed.started === "string" ? parsed.started : "unknown",
        mode: (parsed.mode as LockInfo["mode"]) ?? "stdio",
      };
    }
  } catch {
    /* no lock or unreadable — not running */
  }
  return null;
}

/**
 * Build a `ToolContext` ready for the per-note CLI commands. Mirrors what `main()` builds in
 * `src/server/index.ts`, minus the transport. Write commands get a CommitBatcher; read commands
 * skip it for faster startup.
 */
export async function buildCliContext(opts: CliContextOptions): Promise<CliContextBundle> {
  const embedCfg = embeddingConfigFromEnv();
  const embeddingProvider = createEmbeddingProvider(embedCfg);
  const indexConfig: IndexConfig = {
    provider: embedCfg.provider ?? "none",
    dimensions: embeddingProvider?.dimensions ?? 0,
  };
  const db = openIndexDb(path.join(opts.dataDir, "index.db"), indexConfig);
  const store = new FactStore(opts.dataDir);
  const index = new FactIndex(db, embeddingProvider ?? undefined);
  const membership = await loadMembership(opts.dataDir);

  const ctx: ToolContext = {
    store,
    index,
    writeQueue: new Serializer(),
    membership,
    requester: requesterFor(membership, opts.identity),
    embedQuery: embeddingProvider
      ? async (query: string) => {
          const [vec] = await embeddingProvider.embed([query]);
          return vec ? Float32Array.from(vec) : null;
        }
      : undefined,
    activity: new ActivityLog(opts.dataDir),
  };

  if (!opts.readOnly) {
    const repo = await GitRepo.open(opts.dataDir);
    const batcher = new CommitBatcher(repo, batcherConfigFromEnv());
    ctx.git = batcher;
  }

  let closed = false;
  return {
    ctx,
    db,
    close: async () => {
      if (closed) return;
      closed = true;
      // Flush any pending git stages before exiting so the user's edit lands in a commit
      // promptly, not 30 seconds later via the timer (which won't run in a short-lived CLI).
      if (ctx.git) await ctx.writeQueue.run(() => ctx.git!.flush());
      db.close();
    },
  };
}

/**
 * Plain-English label for a scope, computed from `members.yaml` display names. Drives the
 * grouped-by-scope rendering in `krimto notes`. Falls back to the literal `<kind>/<id>` when
 * the membership data doesn't provide a friendlier name.
 *
 *   user/me               → "Just me"          (when scope.id === viewerEmail)
 *   user/other@acme.com   → "other@acme.com"   (a teammate's personal scope an admin can see)
 *   team/backend          → "Backend team"     (when team.name is set in members.yaml)
 *                        or "team/backend"     (when no display name configured)
 *   org/acme              → "Acme"             (when org.name is set)
 *                        or "org/acme"         (when no display name)
 */
export function scopeLabel(scope: string, viewerEmail: string, membership: Membership): string {
  const parsed = parseScope(scope);
  if (!parsed) return scope;
  if (parsed.kind === "user") {
    return parsed.id === viewerEmail ? "Just me" : parsed.id;
  }
  if (parsed.kind === "team") {
    const team = membership.teams.find((t) => t.slug === parsed.id);
    return team?.name ?? `team/${parsed.id}`;
  }
  // org
  return membership.org.name ?? `org/${membership.org.slug}`;
}

/** Sort key for the grouped list — user scopes first, then team, then org (memweave precedence). */
export function scopeSortKey(scope: string): number {
  const k = (parseScope(scope)?.kind as ScopeKind | undefined) ?? "other";
  return { user: 0, team: 1, org: 2, other: 3 }[k as ScopeKind | "other"] ?? 3;
}
