// Gap 04 — Retrieval ranking pipeline.
// memweave's verified pipeline (weighted merge -> threshold -> temporal decay ->
// MMR) plus Krimto's hierarchical scope boost. Stages are pure and individually
// testable.

import { parseScope, scopeRelation, type Requester, type ScopeRelation } from "../access/scope";
import { termFrequencies, tokenize } from "./lexical";

export interface Candidate {
  id: string;
  scope: string;
  title: string;
  body: string;
  author: string;
  updated: string; // ISO 8601 UTC
  /** Lexical (BM25) score, normalized to [0,1]. */
  bm25Score: number;
  /** Vector (cosine) score, normalized to [0,1]. */
  vectorScore: number;
}

export interface RankedResult {
  id: string;
  scope: string;
  title: string;
  body: string;
  author: string;
  updated: string;
  score: number;
}

export interface RankParams {
  vectorWeight: number;
  bm25Weight: number;
  scoreThreshold: number;
  decayHalfLifeDays: number;
  mmrLambda: number;
  resultLimit: number;
  boost: { ownUser: number; ownTeam: number; org: number; other: number };
}

// Defaults anchored to memweave + Krimto's scope-boost choices (Build Spec Gap 04).
export const DEFAULT_PARAMS: RankParams = {
  vectorWeight: 0.7,
  bm25Weight: 0.3,
  scoreThreshold: 0.35,
  decayHalfLifeDays: 30,
  mmrLambda: 0.7,
  resultLimit: 10,
  boost: { ownUser: 1.5, ownTeam: 1.2, org: 1.0, other: 1.0 },
};

const MS_PER_DAY = 86_400_000;

/** Stage 2 — weighted merge of the vector and lexical scores. */
export function mergeScore(c: Candidate, p: RankParams): number {
  return p.vectorWeight * c.vectorScore + p.bm25Weight * c.bm25Score;
}

/**
 * Stage 4 — temporal decay. Follows the Build Spec formula exp(-daysOld / halfLife).
 * org-scope facts are evergreen and never decayed. Future timestamps clamp to 1.
 */
export function decayFactor(
  updated: string,
  now: Date,
  halfLifeDays: number,
  kind: string | undefined,
): number {
  if (kind === "org") return 1;
  const days = Math.max(0, (now.getTime() - new Date(updated).getTime()) / MS_PER_DAY);
  return Math.exp(-days / halfLifeDays);
}

/** Stage 5 — hierarchical scope boost: personal > team > org. */
export function boostFactor(relation: ScopeRelation, boost: RankParams["boost"]): number {
  switch (relation) {
    case "own-user":
      return boost.ownUser;
    case "own-team":
      return boost.ownTeam;
    case "org":
      return boost.org;
    default:
      return boost.other;
  }
}

/** Token cosine similarity over two texts (used for MMR diversification). */
export function lexicalSimilarity(a: string, b: string): number {
  const fa = termFrequencies(tokenize(a));
  const fb = termFrequencies(tokenize(b));
  if (fa.size === 0 || fb.size === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [term, count] of fa) {
    na += count * count;
    const other = fb.get(term);
    if (other) dot += count * other;
  }
  for (const [, count] of fb) nb += count * count;
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Stage 6 — Maximal Marginal Relevance. Greedily selects up to k items balancing
 * relevance (item.score) against similarity to already-selected items.
 */
export function mmrSelect<T extends { score: number }>(
  items: T[],
  lambda: number,
  k: number,
  similarity: (a: T, b: T) => number,
): T[] {
  const remaining = [...items];
  const selected: T[] = [];
  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i]!;
      let maxSim = 0;
      for (const s of selected) maxSim = Math.max(maxSim, similarity(cand, s));
      const mmr = lambda * cand.score - (1 - lambda) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }
    selected.push(remaining.splice(bestIdx, 1)[0]!);
  }
  return selected;
}

interface Scored {
  c: Candidate;
  score: number;
}

export interface RankOptions {
  requester: Requester;
  now?: Date;
  params?: Partial<RankParams>;
  /** Similarity between two candidates for MMR; defaults to token cosine over title+body. */
  similarity?: (a: Candidate, b: Candidate) => number;
}

function defaultSimilarity(a: Candidate, b: Candidate): number {
  return lexicalSimilarity(`${a.title} ${a.body}`, `${b.title} ${b.body}`);
}

/** Run the full pipeline: merge -> threshold -> decay -> scope boost -> MMR. */
export function rankCandidates(candidates: Candidate[], opts: RankOptions): RankedResult[] {
  const p: RankParams = {
    ...DEFAULT_PARAMS,
    ...opts.params,
    boost: { ...DEFAULT_PARAMS.boost, ...(opts.params?.boost ?? {}) },
  };
  const now = opts.now ?? new Date();
  const similarity = opts.similarity ?? defaultSimilarity;

  let scored: Scored[] = candidates.map((c) => ({ c, score: mergeScore(c, p) }));
  scored = scored.filter((s) => s.score >= p.scoreThreshold);
  for (const s of scored) {
    const kind = parseScope(s.c.scope)?.kind;
    s.score *= decayFactor(s.c.updated, now, p.decayHalfLifeDays, kind);
    s.score *= boostFactor(scopeRelation(s.c.scope, opts.requester), p.boost);
  }
  scored.sort((a, b) => b.score - a.score);

  const selected = mmrSelect(scored, p.mmrLambda, p.resultLimit, (a, b) => similarity(a.c, b.c));
  return selected.map((s) => ({
    id: s.c.id,
    scope: s.c.scope,
    title: s.c.title,
    body: s.c.body,
    author: s.c.author,
    updated: s.c.updated,
    score: s.score,
  }));
}
