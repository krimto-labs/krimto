// Gap 02 — MCP tool surface. Five tools, no more. No delete, no auto-extraction.
// Handlers are pure functions of (context, input) so they can be tested without a
// transport; the MCP/stdio wiring is a thin layer on top.

import { createFact, MAX_TITLE_LENGTH, type FactFrontmatter } from "../storage/fact";
import { FactStore } from "../storage/store";
import { isValidScope, type Requester } from "../access/scope";
import { canRead, canWrite, type Membership } from "../access/membership";
import { FactIndex } from "../index/factIndex";
import { Serializer } from "../index/serialize";
import { rankCandidates } from "../retrieval/pipeline";
import { type GitWriter } from "../storage/git";
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
  /** Optional git writer; when present, writes are committed and commit_sha is populated (Gap 08). */
  git?: GitWriter;
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
  commit_sha: string | null;
}

export interface ListScopesResult {
  scopes: { path: string; fact_count: number; last_updated: string | null }[];
}

function clock(ctx: ToolContext): Date {
  return ctx.now ? ctx.now() : new Date();
}

function readableScopesFor(ctx: ToolContext): string[] {
  // Every scope present in the index that the requester is allowed to read.
  return ctx.index.allScopes().filter((s) => canRead(ctx.membership, ctx.requester.identity, s));
}

/** Create a new fact. Author comes from the requester identity; scope is required. */
export async function krimtoWrite(ctx: ToolContext, input: WriteInput): Promise<WriteResult> {
  if (!isValidScope(input.scope)) {
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
  if (!canWrite(ctx.membership, ctx.requester.identity, input.scope)) {
    throw new KrimtoError("forbidden", `Not allowed to write to ${input.scope}`, { scope: input.scope });
  }
  return ctx.writeQueue.run(async () => {
    const fact = createFact({
      scope: input.scope,
      title: input.title,
      body: input.body,
      author: ctx.requester.identity,
      tags: input.tags,
      source: input.source,
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
    let commit_sha: string | null = null;
    if (ctx.git) {
      try {
        commit_sha = await ctx.git.recordWrite(path, fact);
      } catch (e) {
        process.stderr.write(
          `krimto: git commit failed (fact ${fact.frontmatter.id} is persisted): ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }
    return { id: fact.frontmatter.id, scope: fact.frontmatter.scope, path, commit_sha };
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
  return {
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
}

/** Fetch one fact by id, including its full frontmatter (git history lands in Gap 08). */
export async function krimtoRead(ctx: ToolContext, id: string): Promise<ReadResult> {
  const fact = ctx.index.getFact(id);
  // Not-found is returned for unreadable facts too, so existence isn't leaked.
  if (!fact || !canRead(ctx.membership, ctx.requester.identity, fact.frontmatter.scope)) {
    throw new KrimtoError("not_found", `Fact ${id} not found`, { id });
  }
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
    let commit_sha: string | null = null;
    if (ctx.git) {
      try {
        commit_sha = await ctx.git.recordWrite(path, replacement);
      } catch (e) {
        process.stderr.write(
          `krimto: git commit failed (fact ${replacement.frontmatter.id} is persisted): ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }
    return { old_id: input.id, new_id: replacement.frontmatter.id, commit_sha };
  });
}

/** Discover the scopes that exist and what they contain. */
export async function krimtoListScopes(ctx: ToolContext): Promise<ListScopesResult> {
  const scopes = ctx.index.listScopes(readableScopesFor(ctx));
  return {
    scopes: scopes.map((s) => ({
      path: s.path,
      fact_count: s.factCount,
      last_updated: s.lastUpdated,
    })),
  };
}
