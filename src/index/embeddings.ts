// Gap 09 (part 1) — Embedding abstraction. The vector half of hybrid retrieval is
// provider-pluggable: Krimto works with NO provider (lexical-only) and with any
// provider you have a key for. See providers.ts for concrete adapters.

import { createHash } from "node:crypto";

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  /** Embed a batch of texts, returning one vector per input (same order). */
  embed(texts: string[]): Promise<number[][]>;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** In-process cache of embeddings keyed on content hash (avoids re-embedding unchanged text). */
export class EmbeddingCache {
  private readonly map = new Map<string, number[]>();
  has(key: string): boolean {
    return this.map.has(key);
  }
  get(key: string): number[] | undefined {
    return this.map.get(key);
  }
  set(key: string, value: number[]): void {
    this.map.set(key, value);
  }
  get size(): number {
    return this.map.size;
  }
}

export interface EmbeddedDoc {
  id: string;
  text: string;
}

/**
 * Vector scores in [0,1] (max-normalized, negatives clamped to 0) for each doc vs the
 * query, using the provider. Only uncached texts are sent to the provider.
 */
export async function vectorScores(
  provider: EmbeddingProvider,
  query: string,
  docs: EmbeddedDoc[],
  cache: EmbeddingCache = new EmbeddingCache(),
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (docs.length === 0) return scores;

  const queryKey = `q:${hashText(query)}`;
  const pending: { key: string; text: string }[] = [];
  if (!cache.has(queryKey)) pending.push({ key: queryKey, text: query });
  for (const doc of docs) {
    const key = hashText(doc.text);
    if (!cache.has(key)) pending.push({ key, text: doc.text });
  }

  if (pending.length > 0) {
    const vectors = await provider.embed(pending.map((p) => p.text));
    pending.forEach((p, i) => cache.set(p.key, vectors[i] ?? []));
  }

  const queryVec = cache.get(queryKey) ?? [];
  let max = 0;
  const raw = docs.map((doc) => {
    const docVec = cache.get(hashText(doc.text)) ?? [];
    const score = Math.max(0, cosineSimilarity(queryVec, docVec));
    if (score > max) max = score;
    return score;
  });
  docs.forEach((doc, i) => scores.set(doc.id, max > 0 ? (raw[i] ?? 0) / max : 0));
  return scores;
}
