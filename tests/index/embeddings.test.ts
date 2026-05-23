import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  EmbeddingCache,
  cosineSimilarity,
  vectorScores,
  type EmbeddingProvider,
} from "../../src/index/embeddings";
import {
  createEmbeddingProvider,
  embeddingConfigFromEnv,
} from "../../src/index/providers";
import { FactStore } from "../../src/storage/store";
import { krimtoRecall, type ToolContext } from "../../src/server/tools";
import { type Membership } from "../../src/access/membership";

class FakeProvider implements EmbeddingProvider {
  readonly name = "fake";
  readonly dimensions = 3;
  calls = 0;
  constructor(private readonly vectors: Record<string, number[]>) {}
  embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    return Promise.resolve(texts.map((t) => this.vectors[t] ?? [0, 0, 0]));
  }
}

describe("cosineSimilarity", () => {
  it("is 1 for identical, 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
  });
});

describe("vectorScores", () => {
  const provider = new FakeProvider({
    "database wiped weekly": [1, 0, 0],
    "A: staging reset on a schedule": [1, 0, 0],
    "B: stripe webhook signatures": [0, 1, 0],
  });
  const docs = [
    { id: "a", text: "A: staging reset on a schedule" },
    { id: "b", text: "B: stripe webhook signatures" },
  ];

  it("max-normalizes cosine scores to [0,1]", async () => {
    const s = await vectorScores(provider, "database wiped weekly", docs);
    expect(s.get("a")).toBeCloseTo(1); // semantically aligned with the query vector
    expect(s.get("b")).toBeCloseTo(0);
  });

  it("only embeds uncached texts", async () => {
    const p = new FakeProvider({ q: [1, 0, 0], d: [1, 0, 0] });
    const cache = new EmbeddingCache();
    await vectorScores(p, "q", [{ id: "x", text: "d" }], cache);
    const callsAfterFirst = p.calls;
    await vectorScores(p, "q", [{ id: "x", text: "d" }], cache); // all cached now
    expect(p.calls).toBe(callsAfterFirst); // no further embedding calls
  });
});

describe("createEmbeddingProvider", () => {
  it("returns null for none/undefined (lexical-only default)", () => {
    expect(createEmbeddingProvider({ provider: "none" })).toBeNull();
    expect(createEmbeddingProvider({})).toBeNull();
  });
  it("builds openai and voyage providers", () => {
    expect(createEmbeddingProvider({ provider: "openai", apiKey: "k" })?.name).toBe("openai");
    expect(createEmbeddingProvider({ provider: "voyage", apiKey: "k" })?.name).toBe("voyage");
  });
  it("requires an api key", () => {
    expect(() => createEmbeddingProvider({ provider: "openai" })).toThrow(/apiKey/);
  });
  it("custom requires baseUrl and model", () => {
    expect(() => createEmbeddingProvider({ provider: "custom", apiKey: "k" })).toThrow();
    expect(
      createEmbeddingProvider({ provider: "custom", apiKey: "k", model: "m", baseUrl: "http://x/v1" })?.name,
    ).toBe("openai");
  });
  it("reads config from the environment", () => {
    const cfg = embeddingConfigFromEnv({ KRIMTO_EMBED_PROVIDER: "voyage", KRIMTO_EMBED_API_KEY: "k" } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ provider: "voyage", apiKey: "k" });
  });
});

describe("hybrid recall with an embedding provider", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-embed-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("retrieves a keyword-mismatched fact via its vector", async () => {
    const store = new FactStore(root);
    await store.writeFact({
      scope: "user/alice@acme.com",
      title: "Staging reset",
      body: "Staging is reset every Sunday.",
      author: "alice@acme.com",
    });
    await store.writeFact({
      scope: "user/alice@acme.com",
      title: "Stripe webhooks",
      body: "Verify the signature.",
      author: "alice@acme.com",
    });

    const provider = new FakeProvider({
      "database wiped weekly": [1, 0, 0],
      "Staging reset\nStaging is reset every Sunday.": [1, 0, 0],
      "Stripe webhooks\nVerify the signature.": [0, 1, 0],
    });
    const membership: Membership = { org: { slug: "acme", admins: [] }, teams: [], users: [] };
    const ctx: ToolContext = {
      store,
      membership,
      requester: { identity: "alice@acme.com", teams: [] },
      embeddings: provider,
      embeddingCache: new EmbeddingCache(),
    };

    // Query shares no keywords with either fact; only the vector links it to staging.
    const { results } = await krimtoRecall(ctx, { query: "database wiped weekly" });
    expect(results.map((r) => r.title)).toContain("Staging reset");
    expect(results.map((r) => r.title)).not.toContain("Stripe webhooks");
  });
});
