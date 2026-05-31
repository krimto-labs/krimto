// Shared index opener for the standalone CLI commands (reindex / sync / rm). Mirrors how the server
// (src/server/index.ts) and per-note CLI (cliRuntime.ts) build their index: resolve the configured
// embedding provider so these commands rebuild WITH vectors instead of silently lexical-only (H5).
import * as path from "node:path";

import { openIndexDb, type IndexConfig } from "../index/db";
import { FactIndex } from "../index/factIndex";
import { type EmbeddingProvider } from "../index/embeddings";
import { createEmbeddingProvider, embeddingConfigFromEnv } from "../index/providers";

export interface CliIndex {
  db: ReturnType<typeof openIndexDb>;
  index: FactIndex;
  provider: EmbeddingProvider | null;
  indexConfig: IndexConfig;
}

export function openCliIndex(dataDir: string, env: NodeJS.ProcessEnv = process.env): CliIndex {
  const embedCfg = embeddingConfigFromEnv(env);
  const provider = createEmbeddingProvider(embedCfg);
  const indexConfig: IndexConfig = {
    provider: embedCfg.provider ?? "none",
    dimensions: provider?.dimensions ?? 0,
  };
  const db = openIndexDb(path.join(dataDir, "index.db"), indexConfig);
  const index = new FactIndex(db, provider ?? undefined);
  return { db, index, provider, indexConfig };
}
