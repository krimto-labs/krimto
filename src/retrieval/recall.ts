// Recall orchestrator — turns a set of facts + a query into ranked results.
// v0.1 runs lexical-only (no embedding provider); when vector scores are supplied
// the full hybrid weighting applies. Excludes expired and superseded facts.

import { type Fact } from "../storage/fact";
import { type Requester } from "../access/scope";
import { bm25Scores } from "./lexical";
import { rankCandidates, type Candidate, type RankParams, type RankedResult } from "./pipeline";

export interface RecallOptions {
  requester: Requester;
  limit?: number;
  now?: Date;
  /** Vector (cosine) scores keyed by fact id, [0,1]. Lexical-only when omitted. */
  vectorScores?: Map<string, number>;
  params?: Partial<RankParams>;
}

/** Facts that are expired or superseded by another fact in the set are not retrievable. */
export function retrievableFacts(facts: Fact[], now: Date): Fact[] {
  const superseded = new Set<string>();
  for (const f of facts) {
    for (const id of f.frontmatter.supersedes ?? []) superseded.add(id);
  }
  return facts.filter((f) => {
    if (superseded.has(f.frontmatter.id)) return false;
    const { expires } = f.frontmatter;
    if (expires && new Date(expires).getTime() <= now.getTime()) return false;
    return true;
  });
}

export function recall(query: string, facts: Fact[], opts: RecallOptions): RankedResult[] {
  const now = opts.now ?? new Date();
  const live = retrievableFacts(facts, now);

  const docs = live.map((f) => ({
    id: f.frontmatter.id,
    text: `${f.frontmatter.title}\n${f.body}`,
  }));
  const bm25 = bm25Scores(query, docs);
  const lexicalOnly = opts.vectorScores === undefined;

  const candidates: Candidate[] = live.map((f) => {
    const bm25Score = bm25.get(f.frontmatter.id) ?? 0;
    // In lexical-only mode the vector score mirrors BM25 so the spec's default
    // weights (0.7/0.3) collapse to the lexical score rather than zeroing it out.
    const vectorScore = lexicalOnly ? bm25Score : (opts.vectorScores?.get(f.frontmatter.id) ?? 0);
    return {
      id: f.frontmatter.id,
      scope: f.frontmatter.scope,
      title: f.frontmatter.title,
      body: f.body,
      author: f.frontmatter.author,
      updated: f.frontmatter.updated,
      bm25Score,
      vectorScore,
    };
  });

  const params: Partial<RankParams> = { ...opts.params };
  if (opts.limit !== undefined) params.resultLimit = opts.limit;

  return rankCandidates(candidates, { requester: opts.requester, now, params });
}
