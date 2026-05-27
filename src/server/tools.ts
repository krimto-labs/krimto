// Gap 02 — MCP tool surface. Five tools, no more. No delete, no auto-extraction.
// Handlers are pure functions of (context, input) so they can be tested without a
// transport; the MCP/stdio wiring is a thin layer on top.

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createFact, MAX_TITLE_LENGTH, type FactFrontmatter } from "../storage/fact";
import { FactStore } from "../storage/store";
import { isValidScope, type Requester } from "../access/scope";
import { canRead, canWrite, isOrgAdmin, type Membership } from "../access/membership";
import { FactIndex } from "../index/factIndex";
import { Serializer } from "../index/serialize";
import { rankCandidates } from "../retrieval/pipeline";
import { type CommitBatcher } from "../storage/batcher";
import { type ActivityLog } from "./activity";
import { KrimtoError } from "./errors";

export interface ToolContext {
  store: FactStore;
  index: FactIndex;
  /** Resolved from auth (Gap 06). */
  requester: Requester;
  /** Org/team/user membership for server-enforced access (Gap 07). */
  membership: Membership;
  /** Returns the query embedding, or null in lexical-only mode. */
  embedQuery?: (query: string) => Promise<Float32Array | null>;
  /** Serializes write-path mutations. */
  writeQueue: Serializer;
  /** Optional commit batcher; when present, writes are staged and committed in batches (Gap 08). */
  git?: CommitBatcher;
  /** Persistent activity log for the /ui Recent Activity panel + `verify-connection` CLI (G5). */
  activity?: ActivityLog;
  /**
   * G6 — mutable per-process flag. False initially; set to true after the first successful
   * krimto_write, so the expanded "where things live" hint only fires once per process. Cursor
   * swallows the startup banner; this is how Maria learns the discovery hints by other means.
   */
  firstSaveHintEmitted?: boolean;
  /** Clock override for tests. */
  now?: () => Date;
}

export interface WriteInput {
  scope: string;
  title: string;
  body: string;
  tags?: string[];
  source?: string;
  supersedes?: string[];
}
export interface WriteResult {
  id: string;
  scope: string;
  path: string;
  /** Full path to the markdown file on disk. Lets the agent (and via it, the user) find the file. */
  absolute_path: string;
  /** Human-readable hint for the agent to relay back. Teaches "this is just a file you can open." */
  hint: string;
  commit_sha: string | null;
}

export interface RecallInput {
  query: string;
  scopes?: string[];
  limit?: number;
}
export interface RecallHit {
  id: string;
  scope: string;
  title: string;
  body: string;
  score: number;
  author: string;
  updated: string;
}
export interface RecallResult {
  results: RecallHit[];
  /**
   * Gap #4 — when results is empty, nudges the agent toward `krimto_write` instead of letting
   * it loop on reformulated queries. Critical for the "remember X" intent that ended up routed
   * to a competing memory system after a series of empty recalls.
   */
  hint?: string;
}

export interface ReadResult {
  id: string;
  scope: string;
  title: string;
  body: string;
  frontmatter: FactFrontmatter;
  history: unknown[];
}

export interface SupersedeInput {
  id: string;
  new_title: string;
  new_body: string;
  reason: string;
}
export interface SupersedeResult {
  old_id: string;
  new_id: string;
  /** Full path to the new markdown file on disk. */
  absolute_path: string;
  /** Human-readable hint for the agent to relay back. */
  hint: string;
  commit_sha: string | null;
}

export interface ListScopesResult {
  scopes: { path: string; fact_count: number; last_updated: string | null }[];
  /** Present only when `scopes` is empty — tells the calling agent how to make a scope appear. */
  hint?: string;
}

/**
 * v0.2.25 — Gap 3. The smoke-6 transcript showed an agent in chat inventing a wrong identity
 * (`lpd.themes@gmail.com` instead of `lpdthemes@gmail.com`) because it had no MCP-side way to
 * ask "who am I writing as?". `krimto_whoami` returns the resolved identity plus the scopes
 * the caller can read and write, so the agent never has to guess.
 */
export interface WhoamiResult {
  identity: string;
  readable_scopes: string[];
  writable_scopes: string[];
}

function clock(ctx: ToolContext): Date {
  return ctx.now ? ctx.now() : new Date();
}

function readableScopesFor(ctx: ToolContext): string[] {
  // Every scope present in the index that the requester is allowed to read.
  return ctx.index.allScopes().filter((s) => canRead(ctx.membership, ctx.requester.identity, s));
}

const PERSONAL_SCOPE_ALIASES = new Set(["me", "self", "user/me", "user/self"]);

/** Rewrite a personal-scope alias (user/me, user/self, me, self) to the caller's own user scope. */
function resolvePersonalScope(scope: string, identity: string): string {
  return PERSONAL_SCOPE_ALIASES.has(scope.trim().toLowerCase()) ? `user/${identity}` : scope;
}

/** Scopes the requester can write to AND read back — surfaced in errors so an agent can self-correct. */
function writableScopesFor(ctx: ToolContext): string[] {
  const scopes = [`user/${ctx.requester.identity}`, ...ctx.requester.teams.map((t) => `team/${t}`)];
  if (isOrgAdmin(ctx.membership, ctx.requester.identity)) scopes.push(`org/${ctx.membership.org.slug}`);
  return scopes;
}

/** Create a new fact. Author comes from the requester identity; scope is required. */
export async function krimtoWrite(ctx: ToolContext, input: WriteInput): Promise<WriteResult> {
  // "user/me"/"user/self" (and bare "me"/"self") mean the caller's own personal scope. An agent
  // can't know the caller's email, so resolve the alias here instead of orphaning the fact.
  const scope = resolvePersonalScope(input.scope, ctx.requester.identity);
  if (!isValidScope(scope)) {
    throw new KrimtoError("invalid_params", `Invalid scope: ${input.scope}`, { field: "scope" });
  }
  if (!input.title || input.title.length > MAX_TITLE_LENGTH) {
    throw new KrimtoError("invalid_params", `title is required and must be <= ${MAX_TITLE_LENGTH} chars`, {
      field: "title",
    });
  }
  if (!input.body) {
    throw new KrimtoError("invalid_params", "body is required", { field: "body" });
  }
  if (!canWrite(ctx.membership, ctx.requester.identity, scope)) {
    throw new KrimtoError("forbidden", `Not allowed to write to ${scope}`, {
      scope,
      writable_scopes: writableScopesFor(ctx),
    });
  }
  // Ghost-fact guard: refuse a write the author couldn't read back (e.g. an org admin writing into
  // another user's personal scope — permitted by canWrite, but then invisible to them via recall/read).
  if (!canRead(ctx.membership, ctx.requester.identity, scope)) {
    throw new KrimtoError("forbidden", `Refusing to write to ${scope}: you would not be able to read it back`, {
      scope,
      writable_scopes: writableScopesFor(ctx),
    });
  }
  return ctx.writeQueue.run(async () => {
    const fact = createFact({
      scope,
      title: input.title,
      body: input.body,
      author: ctx.requester.identity,
      tags: input.tags,
      // v0.2.31 — fall back to the HTTP User-Agent-derived source when the caller didn't
      // pass one explicitly. The HTTP MCP handler (src/server/http.ts) stamps
      // `requester.source` with "cursor" / "claude-code" / "codex" / "gemini" based on the
      // UA. Stdio transport has no UA, so requester.source stays undefined — back-compat.
      source: input.source ?? ctx.requester.source,
      supersedes: input.supersedes,
      now: clock(ctx),
    });
    await ctx.index.upsertFact(fact); // SQLite first (coordination layer)
    let path: string;
    try {
      ({ path } = await ctx.store.writeFactExact(fact)); // markdown (source of truth)
    } catch (e) {
      ctx.index.removeFact(fact.frontmatter.id); // rollback the index entry
      throw e;
    }
    if (ctx.git) {
      try {
        await ctx.git.stage(path, fact);
      } catch (e) {
        process.stderr.write(
          `krimto: git stage failed (fact ${fact.frontmatter.id} is persisted): ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }
    const absolutePath = `${ctx.store.dataDir()}/${path}`;
    if (ctx.activity) await ctx.activity.record("krimto_write", ctx.requester.identity, `${scope}: ${input.title}`);
    // G6 — first save in this process gets the expanded "where things live" hint, so a user
    // launched-by-Cursor (who never sees the startup banner) still learns the basics.
    const baseHint = `Saved to ${absolutePath} — this is a plain markdown file you can open in any editor.`;
    let hint = baseHint;
    if (!ctx.firstSaveHintEmitted) {
      ctx.firstSaveHintEmitted = true;
      hint =
        `${baseHint}\n` +
        `(First save in this session — quick orientation: your data lives at ${ctx.store.dataDir()}, ` +
        `git auto-commits every 30s, run \`npx @krimto-labs/krimto --help\` for the full CLI surface, ` +
        `or \`npx @krimto-labs/krimto storage\` for the storage model.)`;
    }
    return {
      id: fact.frontmatter.id,
      scope: fact.frontmatter.scope,
      path,
      absolute_path: absolutePath,
      hint,
      commit_sha: null,
    };
  });
}

/** Search across one or more scopes using hybrid retrieval with hierarchical precedence. */
export async function krimtoRecall(ctx: ToolContext, input: RecallInput): Promise<RecallResult> {
  const readable = readableScopesFor(ctx);
  const scopes = input.scopes?.length ? readable.filter((s) => input.scopes!.includes(s)) : readable;
  const queryVector = ctx.embedQuery ? await ctx.embedQuery(input.query) : null;
  const candidates = await ctx.index.searchCandidates(input.query, {
    readableScopes: scopes,
    now: clock(ctx),
    queryVector: queryVector ?? undefined,
  });
  const ranked = rankCandidates(candidates, {
    requester: ctx.requester,
    now: clock(ctx),
    params: input.limit !== undefined ? { resultLimit: input.limit } : undefined,
  });
  if (ctx.activity) await ctx.activity.record("krimto_recall", ctx.requester.identity, `"${input.query}" → ${ranked.length} hit(s)`);
  const result: RecallResult = {
    results: ranked.map((r) => ({
      id: r.id,
      scope: r.scope,
      title: r.title,
      body: r.body,
      score: r.score,
      author: r.author,
      updated: r.updated,
    })),
  };
  if (result.results.length === 0) {
    // Gap #4 — convert empty recall from a dead end into a write opportunity. Without this hint,
    // agents tend to reformulate the query several times instead of pivoting to `krimto_write`.
    result.hint =
      `No Krimto facts match "${input.query}". If the user said "remember", call krimto_write to ` +
      `save this fact to Krimto — do NOT fall back to local per-session memory ` +
      `(~/.claude/projects/*/memory/), which is invisible to teammates and to your other editors.`;
  }
  return result;
}

/** Fetch one fact by id, including its full frontmatter (git history lands in Gap 08). */
export async function krimtoRead(ctx: ToolContext, id: string): Promise<ReadResult> {
  const fact = ctx.index.getFact(id);
  // Not-found is returned for unreadable facts too, so existence isn't leaked.
  if (!fact || !canRead(ctx.membership, ctx.requester.identity, fact.frontmatter.scope)) {
    throw new KrimtoError("not_found", `Fact ${id} not found`, { id });
  }
  if (ctx.activity) await ctx.activity.record("krimto_read", ctx.requester.identity, `${fact.frontmatter.scope}: ${fact.frontmatter.title}`);
  return {
    id: fact.frontmatter.id,
    scope: fact.frontmatter.scope,
    title: fact.frontmatter.title,
    body: fact.body,
    frontmatter: fact.frontmatter,
    history: [],
  };
}

/** Replace a fact with a new one whose `supersedes` references the old. Old fact stays in history. */
export async function krimtoSupersede(
  ctx: ToolContext,
  input: SupersedeInput,
): Promise<SupersedeResult> {
  const old = ctx.index.getFact(input.id);
  if (!old || !canRead(ctx.membership, ctx.requester.identity, old.frontmatter.scope)) {
    throw new KrimtoError("not_found", `Fact ${input.id} not found`, { id: input.id });
  }
  if (!canWrite(ctx.membership, ctx.requester.identity, old.frontmatter.scope)) {
    throw new KrimtoError("forbidden", `Not allowed to write to ${old.frontmatter.scope}`);
  }
  if (!input.new_title || input.new_title.length > MAX_TITLE_LENGTH) {
    throw new KrimtoError("invalid_params", `new_title is required and must be <= ${MAX_TITLE_LENGTH} chars`);
  }
  if (!input.new_body) {
    throw new KrimtoError("invalid_params", "new_body is required", { field: "new_body" });
  }
  return ctx.writeQueue.run(async () => {
    const replacement = createFact({
      scope: old.frontmatter.scope,
      title: input.new_title,
      body: input.new_body,
      author: ctx.requester.identity,
      supersedes: [input.id],
      now: clock(ctx),
    });
    await ctx.index.upsertFact(replacement);
    let path: string;
    try {
      ({ path } = await ctx.store.writeFactExact(replacement));
    } catch (e) {
      ctx.index.removeFact(replacement.frontmatter.id); // rollback on markdown failure
      throw e;
    }
    if (ctx.git) {
      try {
        await ctx.git.stage(path, replacement);
      } catch (e) {
        process.stderr.write(
          `krimto: git stage failed (fact ${replacement.frontmatter.id} is persisted): ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }
    const absolutePath = `${ctx.store.dataDir()}/${path}`;
    if (ctx.activity) await ctx.activity.record("krimto_supersede", ctx.requester.identity, `${old.frontmatter.scope}: ${input.new_title} (was ${input.id})`);
    return {
      old_id: input.id,
      new_id: replacement.frontmatter.id,
      absolute_path: absolutePath,
      hint: `Updated fact saved to ${absolutePath} — the old version is still in git history.`,
      commit_sha: null,
    };
  });
}

/**
 * Return the caller's identity plus the scopes they can read and write. The agent in chat uses
 * this to avoid hallucinating identity (Gap 3 from the smoke-6 transcript audit).
 */
export async function krimtoWhoami(ctx: ToolContext): Promise<WhoamiResult> {
  const readable = readableScopesFor(ctx);
  const writable = writableScopesFor(ctx);
  if (ctx.activity) await ctx.activity.record("krimto_whoami", ctx.requester.identity, ctx.requester.identity);
  return {
    identity: ctx.requester.identity,
    readable_scopes: readable,
    writable_scopes: writable,
  };
}

/** Discover the scopes that exist and what they contain. */
export async function krimtoListScopes(ctx: ToolContext): Promise<ListScopesResult> {
  const scopes = ctx.index.listScopes(readableScopesFor(ctx));
  if (ctx.activity) await ctx.activity.record("krimto_list_scopes", ctx.requester.identity, `${scopes.length} scope(s)`);
  const result: ListScopesResult = {
    scopes: scopes.map((s) => ({
      path: s.path,
      fact_count: s.factCount,
      last_updated: s.lastUpdated,
    })),
  };
  // v0.2.24 — empty result is the #1 first-impression confuser ("Krimto must be broken").
  // Surface the next step in the response itself, so an agent in chat can relay it verbatim
  // instead of inventing a hallucinated explanation about "scopes aren't configured".
  if (result.scopes.length === 0) {
    result.hint =
      `No scopes exist yet for ${ctx.requester.identity}. Scopes are created on the first ` +
      `write — try krimto_write with a small fact (e.g. "we use pnpm in this repo") and ` +
      `your user/<email> scope will appear here.`;
  }
  return result;
}

/** Build a Requester from a validated bearer token's AuthInfo (its `extra` carries identity+teams). */
export function requesterFromAuth(authInfo: AuthInfo | undefined): Requester {
  if (!authInfo) throw new KrimtoError("unauthorized", "missing or invalid bearer token");
  const extra = (authInfo.extra ?? {}) as { identity?: unknown; teams?: unknown };
  if (typeof extra.identity !== "string" || extra.identity.length === 0) {
    throw new KrimtoError("unauthorized", "token has no identity");
  }
  const teams = Array.isArray(extra.teams)
    ? extra.teams.filter((t): t is string => typeof t === "string")
    : [];
  return { identity: extra.identity, teams };
}
