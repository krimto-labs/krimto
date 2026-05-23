// Lexical (BM25) scoring — the keyword half of the hybrid retrieval pipeline.
// Used directly for v0.1 (no embedding provider required); the vector half plugs
// in alongside it (Gap 09). Scores are normalized to [0,1] by the top match.

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export function termFrequencies(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

export interface LexicalDoc {
  id: string;
  text: string;
}

export interface Bm25Options {
  k1?: number;
  b?: number;
}

/**
 * BM25 score for each doc against the query, normalized to [0,1] by the maximum
 * score in the set. Docs that match no query term score 0.
 */
export function bm25Scores(
  query: string,
  docs: LexicalDoc[],
  opts: Bm25Options = {},
): Map<string, number> {
  const k1 = opts.k1 ?? 1.5;
  const b = opts.b ?? 0.75;
  const scores = new Map<string, number>();

  const queryTerms = [...new Set(tokenize(query))];
  const n = docs.length;
  if (n === 0 || queryTerms.length === 0) {
    for (const d of docs) scores.set(d.id, 0);
    return scores;
  }

  const docTokens = docs.map((d) => tokenize(d.text));
  const docLengths = docTokens.map((t) => t.length);
  const avgdl = docLengths.reduce((sum, len) => sum + len, 0) / n || 1;

  const docFreq = new Map<string, number>();
  for (const term of queryTerms) {
    let count = 0;
    for (const tokens of docTokens) if (tokens.includes(term)) count++;
    docFreq.set(term, count);
  }

  let max = 0;
  const raw = docs.map((_, i) => {
    const tokens = docTokens[i] ?? [];
    const len = docLengths[i] ?? 0;
    const tf = termFrequencies(tokens);
    let score = 0;
    for (const term of queryTerms) {
      const f = tf.get(term) ?? 0;
      if (f === 0) continue;
      const df = docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * len) / avgdl));
    }
    if (score > max) max = score;
    return score;
  });

  docs.forEach((d, i) => scores.set(d.id, max > 0 ? (raw[i] ?? 0) / max : 0));
  return scores;
}
