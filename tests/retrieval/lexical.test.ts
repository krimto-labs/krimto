import { describe, expect, it } from "vitest";
import { bm25Scores, tokenize } from "../../src/retrieval/lexical";

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumerics", () => {
    expect(tokenize("Stripe-Webhook, v2!")).toEqual(["stripe", "webhook", "v2"]);
  });
});

describe("bm25Scores", () => {
  const docs = [
    { id: "a", text: "Stripe webhook signature verification" },
    { id: "b", text: "Postgres backup cron schedule" },
    { id: "c", text: "Stripe refunds and disputes" },
  ];

  it("ranks the best lexical match highest (normalized to 1)", () => {
    const s = bm25Scores("stripe webhook", docs);
    expect(s.get("a")).toBe(1); // matches both query terms
    expect(s.get("a")! > s.get("c")!).toBe(true); // c matches only 'stripe'
    expect(s.get("b")).toBe(0); // matches neither
  });

  it("returns all-zero for an empty query", () => {
    const s = bm25Scores("", docs);
    expect([...s.values()].every((v) => v === 0)).toBe(true);
  });

  it("handles an empty corpus", () => {
    expect(bm25Scores("anything", []).size).toBe(0);
  });
});
