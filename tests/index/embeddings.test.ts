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
import { openIndexDb } from "../../src/index/db";
import { FactIndex } from "../../src/index/factIndex";
import { Serializer } from "../../src/index/serialize";
import { krimtoRecall, krimtoWrite, type ToolContext } from "../../src/server/tools";
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
    // FactIndex embeds just the body text; the query vector comes from embedQuery.
    const provider = new FakeProvider({
      "database wiped weekly": [1, 0, 0],
      "Staging is reset every Sunday.": [1, 0, 0], // body of staging fact
      "Verify the signature.": [0, 1, 0],           // body of stripe fact
    });
    // Build the index with the same provider so embeddings are stored during upsert.
    const db = openIndexDb(":memory:", { provider: "fake", dimensions: 3 });
    const index = new FactIndex(db, provider);
    const membership: Membership = { org: { slug: "acme", admins: ["alice@acme.com"] }, teams: [], users: [] };
    const ctx: ToolContext = {
      store,
      index,
      writeQueue: new Serializer(),
      membership,
      requester: { identity: "alice@acme.com", teams: [] },
      // embedQuery returns the raw query vector via the same provider.
      embedQuery: async (query: string) => {
        const [vec] = await provider.embed([query]);
        return vec ? Float32Array.from(vec) : null;
      },
    };

    await krimtoWrite(ctx, {
      scope: "user/alice@acme.com",
      title: "Staging reset",
      body: "Staging is reset every Sunday.",
    });
    await krimtoWrite(ctx, {
      scope: "user/alice@acme.com",
      title: "Stripe webhooks",
      body: "Verify the signature.",
    });

    // Query shares no keywords with either fact; only the vector links it to staging.
    const { results } = await krimtoRecall(ctx, { query: "database wiped weekly" });
    expect(results.map((r) => r.title)).toContain("Staging reset");
    expect(results.map((r) => r.title)).not.toContain("Stripe webhooks");
  });
});
