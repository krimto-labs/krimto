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
        `\n🔴 No embedding provider configured\n` +
        `\n━━ How to set one up ━━\n` +
        `\n   Set these env vars and re-run this command:\n` +
        `     $ export KRIMTO_EMBED_PROVIDER=openai      # or "voyage" / "custom"\n` +
        `     $ export KRIMTO_EMBED_API_KEY=sk-...\n` +
        `\n   Optional:\n` +
        `     $ export KRIMTO_EMBED_MODEL=text-embedding-3-small\n` +
        `     $ export KRIMTO_EMBED_BASE_URL=https://api.openai.com/v1\n` +
        `\n   Without these, Krimto uses keyword search (BM25) — recall still\n` +
        `   works, it just won't match paraphrases.\n`,
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
        message:
          `\n🔴 Provider returned an empty embedding vector\n` +
          `\n   That usually means the request shape is wrong for ${cfg.provider}.\n`,
      };
    }
    return {
      status: "ok",
      message:
        `\n✅ Embeddings provider works\n` +
        `\n   Provider:   ${cfg.provider}\n` +
        `   Model:      ${cfg.model ?? "(provider default)"}\n` +
        `   Dimensions: ${vec.length}\n` +
        `\n━━ Next ━━\n` +
        `\n   Restart Krimto with these env vars set. On first boot, Krimto\n` +
        `   rebuilds index.db once to embed every existing fact.\n` +
        `\n   See \`krimto storage\` for the 3 places to put them.\n`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/is required/.test(msg)) {
      return {
        status: "config_error",
        message:
          `\n🔴 Config error: ${msg}\n` +
          `\n   Make sure KRIMTO_EMBED_API_KEY (and KRIMTO_EMBED_MODEL /\n` +
          `   KRIMTO_EMBED_BASE_URL for "custom" provider) are set.\n`,
      };
    }
    return {
      status: "request_failed",
      message:
        `\n🔴 Embedding test request failed\n` +
        `\n   ${msg}\n` +
        `\n━━ Common causes ━━\n` +
        `\n   • Wrong or expired API key.\n` +
        `   • Wrong KRIMTO_EMBED_BASE_URL (typo, missing /v1).\n` +
        `   • Model name not supported by the provider.\n` +
        `     Fix: unset KRIMTO_EMBED_MODEL to use the default.\n`,
    };
  }
}
