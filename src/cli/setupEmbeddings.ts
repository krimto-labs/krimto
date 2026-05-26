// `krimto setup-embeddings` — verify the user's KRIMTO_EMBED_* config by building the provider and
// sending one real embedding request. Saves the user from finding out their key was wrong only
// after they've enabled embeddings on a running server.

import { createEmbeddingProvider, embeddingConfigFromEnv, type EmbeddingConfig } from "../index/providers";

export interface SetupEmbeddingsResult {
  status: "ok" | "no_config" | "config_error" | "request_failed";
  message: string;
}

/**
 * Verify embeddings config. `env` defaults to process.env; tests inject a literal env to avoid
 * touching the real one. `embed` is the function that calls the provider — overridable so tests
 * can simulate success/failure without hitting the network.
 */
export async function runSetupEmbeddings(
  env: NodeJS.ProcessEnv = process.env,
  embed?: (cfg: EmbeddingConfig) => Promise<number[]>,
): Promise<SetupEmbeddingsResult> {
  const cfg = embeddingConfigFromEnv(env);
  if (!cfg.provider || cfg.provider === "none") {
    return {
      status: "no_config",
      message:
        `No embedding provider configured. To verify a config, set the env vars and re-run:\n` +
        `  KRIMTO_EMBED_PROVIDER=openai      (or "voyage" / "custom")\n` +
        `  KRIMTO_EMBED_API_KEY=sk-...\n` +
        `\n` +
        `Optional:\n` +
        `  KRIMTO_EMBED_MODEL=text-embedding-3-small\n` +
        `  KRIMTO_EMBED_BASE_URL=https://api.openai.com/v1\n` +
        `\n` +
        `Without these, Krimto uses keyword search (BM25) — recall still works,\n` +
        `it just won't match paraphrases.\n`,
    };
  }

  // Default embed: build the provider once + send a real test request.
  const doEmbed =
    embed ??
    (async (c: EmbeddingConfig): Promise<number[]> => {
      const provider = createEmbeddingProvider(c);
      if (!provider) throw new Error("provider not configured");
      const [vec] = await provider.embed(["krimto embedding test"]);
      return vec ?? [];
    });

  try {
    const vec = await doEmbed(cfg);
    if (vec.length === 0) {
      return {
        status: "request_failed",
        message: `Provider returned an empty embedding vector — that usually means the request shape is wrong for ${cfg.provider}.`,
      };
    }
    return {
      status: "ok",
      message:
        `✅ Embeddings provider works.\n` +
        `   Provider:   ${cfg.provider}\n` +
        `   Model:      ${cfg.model ?? "(provider default)"}\n` +
        `   Dimensions: ${vec.length}\n` +
        `\n` +
        `To turn this on permanently, restart Krimto with these env vars set\n` +
        `(see \`krimto storage\` for the three places to put them). On first boot\n` +
        `with embeddings enabled, Krimto rebuilds index.db once to embed every fact.\n`,
    };
  } catch (e) {
    // Distinguish missing-required-field (config error) from network/HTTP failures.
    const msg = e instanceof Error ? e.message : String(e);
    if (/is required/.test(msg)) {
      return {
        status: "config_error",
        message: `❌ Config error: ${msg}\nMake sure KRIMTO_EMBED_API_KEY (and KRIMTO_EMBED_MODEL/BASE_URL for "custom") are set.`,
      };
    }
    return {
      status: "request_failed",
      message:
        `❌ Embedding test request failed: ${msg}\n` +
        `\n` +
        `Common causes:\n` +
        `  • Wrong or expired API key.\n` +
        `  • Wrong KRIMTO_EMBED_BASE_URL (e.g. typo, missing /v1).\n` +
        `  • Model name not supported by your provider (try the default — unset KRIMTO_EMBED_MODEL).\n`,
    };
  }
}
