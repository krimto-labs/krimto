// Gap 09 (part 2) — Concrete embedding providers. All use the OpenAI-style
// /embeddings request shape, so OpenAI, Voyage (Anthropic's recommended embeddings
// partner), and any OpenAI-compatible endpoint are covered.
//
// Note: Anthropic/Claude has no embeddings API — a Claude key cannot produce
// embeddings. Users in the Anthropic ecosystem use Voyage, a custom endpoint, or
// lexical-only (no provider).

import { type EmbeddingProvider } from "./embeddings";

interface EmbeddingsResponse {
  data: { embedding: number[] }[];
}

async function postEmbeddings(
  url: string,
  apiKey: string,
  model: string,
  texts: string[],
): Promise<number[][]> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) {
    throw new Error(`Embeddings request to ${url} failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as EmbeddingsResponse;
  return json.data.map((d) => d.embedding);
}

export interface OpenAICompatibleConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  dimensions?: number;
}

/** OpenAI embeddings (default text-embedding-3-small) — also used for custom endpoints via baseUrl. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(cfg: OpenAICompatibleConfig) {
    this.apiKey = cfg.apiKey;
    this.model = cfg.model ?? "text-embedding-3-small";
    this.baseUrl = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.dimensions = cfg.dimensions ?? 1536;
  }

  embed(texts: string[]): Promise<number[][]> {
    return postEmbeddings(`${this.baseUrl}/embeddings`, this.apiKey, this.model, texts);
  }
}

/** Voyage AI embeddings — the Anthropic-ecosystem path. */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = "voyage";
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(cfg: OpenAICompatibleConfig) {
    this.apiKey = cfg.apiKey;
    this.model = cfg.model ?? "voyage-3-lite";
    this.baseUrl = (cfg.baseUrl ?? "https://api.voyageai.com/v1").replace(/\/$/, "");
    this.dimensions = cfg.dimensions ?? 512;
  }

  embed(texts: string[]): Promise<number[][]> {
    return postEmbeddings(`${this.baseUrl}/embeddings`, this.apiKey, this.model, texts);
  }
}

export interface EmbeddingConfig {
  provider?: "none" | "openai" | "voyage" | "custom";
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  dimensions?: number;
}

function requireField(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Embedding provider config: ${name} is required`);
  return value;
}

/** Build a provider from config, or null for lexical-only (the default). */
export function createEmbeddingProvider(cfg: EmbeddingConfig): EmbeddingProvider | null {
  switch (cfg.provider) {
    case "openai":
      return new OpenAIEmbeddingProvider({
        apiKey: requireField(cfg.apiKey, "apiKey"),
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        dimensions: cfg.dimensions,
      });
    case "voyage":
      return new VoyageEmbeddingProvider({
        apiKey: requireField(cfg.apiKey, "apiKey"),
        model: cfg.model,
        dimensions: cfg.dimensions,
      });
    case "custom":
      return new OpenAIEmbeddingProvider({
        apiKey: requireField(cfg.apiKey, "apiKey"),
        model: requireField(cfg.model, "model"),
        baseUrl: requireField(cfg.baseUrl, "baseUrl"),
        dimensions: cfg.dimensions,
      });
    case "none":
    case undefined:
    default:
      return null;
  }
}

export function embeddingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const provider = env.KRIMTO_EMBED_PROVIDER as EmbeddingConfig["provider"] | undefined;
  return {
    provider: provider ?? "none",
    apiKey: env.KRIMTO_EMBED_API_KEY,
    model: env.KRIMTO_EMBED_MODEL,
    baseUrl: env.KRIMTO_EMBED_BASE_URL,
    dimensions: env.KRIMTO_EMBED_DIMENSIONS ? Number(env.KRIMTO_EMBED_DIMENSIONS) : undefined,
  };
}
