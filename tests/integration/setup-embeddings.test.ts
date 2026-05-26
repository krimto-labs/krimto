// `krimto setup-embeddings` — verifies a KRIMTO_EMBED_* config by sending one real embedding
// request. Tests pass an injectable `embed` fn so we exercise every branch without the network.

import { describe, expect, it } from "vitest";
import { runSetupEmbeddings } from "../../src/cli/setupEmbeddings";

describe("runSetupEmbeddings", () => {
  it("prints helpful guidance when no provider env vars are set", async () => {
    const r = await runSetupEmbeddings({});
    expect(r.status).toBe("no_config");
    expect(r.message).toContain("No embedding provider configured");
    expect(r.message).toContain("KRIMTO_EMBED_PROVIDER");
    expect(r.message).toContain("KRIMTO_EMBED_API_KEY");
    expect(r.message).toContain("BM25");
  });

  it("reports ok with provider + dimensions when the test embedding succeeds", async () => {
    const r = await runSetupEmbeddings(
      { KRIMTO_EMBED_PROVIDER: "openai", KRIMTO_EMBED_API_KEY: "sk-fake", KRIMTO_EMBED_MODEL: "test-model" },
      async () => Array.from({ length: 1536 }, () => 0.1), // simulate a successful 1536-dim response
    );
    expect(r.status).toBe("ok");
    expect(r.message).toContain("Provider:   openai");
    expect(r.message).toContain("Model:      test-model");
    expect(r.message).toContain("Dimensions: 1536");
  });

  it("reports config_error when a required field (e.g. API key) is missing", async () => {
    const r = await runSetupEmbeddings({ KRIMTO_EMBED_PROVIDER: "openai" });
    expect(r.status).toBe("config_error");
    expect(r.message).toContain("KRIMTO_EMBED_API_KEY");
  });

  it("reports request_failed with hints when the embedding call throws", async () => {
    const r = await runSetupEmbeddings(
      { KRIMTO_EMBED_PROVIDER: "openai", KRIMTO_EMBED_API_KEY: "sk-bad" },
      async () => {
        throw new Error("HTTP 401: invalid api key");
      },
    );
    expect(r.status).toBe("request_failed");
    expect(r.message).toContain("HTTP 401");
    expect(r.message).toContain("Common causes");
  });

  it("reports request_failed when the provider returns an empty vector", async () => {
    const r = await runSetupEmbeddings(
      { KRIMTO_EMBED_PROVIDER: "openai", KRIMTO_EMBED_API_KEY: "sk-fake" },
      async () => [],
    );
    expect(r.status).toBe("request_failed");
    expect(r.message).toContain("empty embedding vector");
  });
});
