// Gap 02 — MCP tool surface. Five tools, no more. No delete, no auto-extraction.
// Handlers are pure functions of (context, input) so they can be tested without a
// transport; the MCP/stdio wiring is a thin layer on top.

import { MAX_TITLE_LENGTH, type FactFrontmatter } from "../storage/fact";
import { FactStore } from "../storage/store";
import { recall } from "../retrieval/recall";
import { isValidScope, type Requester } from "../access/scope";
import { KrimtoError } from "./errors";

export interface ToolContext {
  store: FactStore;
  /** Resolved from auth (Gap 06); for now supplied by the caller. */
  requester: Requester;
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
  const { fact, path } = await ctx.store.writeFact({
    scope: input.scope,
    title: input.title,
    body: input.body,
    author: ctx.requester.identity,
    tags: input.tags,
    source: input.source,
    supersedes: input.supersedes,
    now: clock(ctx),
  });
  // commit_sha is null until the git commit batcher lands (Gap 08, v0.2).
  return { id: fact.frontmatter.id, scope: fact.frontmatter.scope, path, commit_sha: null };
}

/** Search across one or more scopes using hybrid retrieval with hierarchical precedence. */
export async function krimtoRecall(ctx: ToolContext, input: RecallInput): Promise<RecallResult> {
  const all = await ctx.store.allFacts();
  const facts =
    input.scopes && input.scopes.length > 0
      ? all.filter((f) => input.scopes!.includes(f.frontmatter.scope))
      : all;
  const ranked = recall(input.query, facts, {
    requester: ctx.requester,
    limit: input.limit,
    now: clock(ctx),
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
  const found = await ctx.store.readFact(id);
  if (!found) throw new KrimtoError("not_found", `Fact ${id} not found`, { id });
  const { fact } = found;
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
  const old = await ctx.store.readFact(input.id);
  if (!old) throw new KrimtoError("not_found", `Fact ${input.id} not found`, { id: input.id });
  if (!input.new_title || input.new_title.length > MAX_TITLE_LENGTH) {
    throw new KrimtoError("invalid_params", `new_title is required and must be <= ${MAX_TITLE_LENGTH} chars`);
  }
  const { fact } = await ctx.store.writeFact({
    scope: old.fact.frontmatter.scope,
    title: input.new_title,
    body: input.new_body,
    author: ctx.requester.identity,
    supersedes: [input.id],
    now: clock(ctx),
  });
  return { old_id: input.id, new_id: fact.frontmatter.id, commit_sha: null };
}

/** Discover the scopes that exist and what they contain. */
export async function krimtoListScopes(ctx: ToolContext): Promise<ListScopesResult> {
  const scopes = await ctx.store.listScopes();
  return {
    scopes: scopes.map((s) => ({
      path: s.path,
      fact_count: s.factCount,
      last_updated: s.lastUpdated,
    })),
  };
}
