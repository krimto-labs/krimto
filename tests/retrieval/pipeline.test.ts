import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  boostFactor,
  decayFactor,
  lexicalSimilarity,
  mergeScore,
  mmrSelect,
  rankCandidates,
  type Candidate,
} from "../../src/retrieval/pipeline";
import { type Requester } from "../../src/access/scope";

const NOW = new Date("2026-05-22T00:00:00Z");
const requester: Requester = { identity: "alice@acme.com", teams: ["payments"] };

function cand(over: Partial<Candidate>): Candidate {
  return {
    id: "fct_x",
    scope: "org/acme",
    title: "t",
    body: "b",
    author: "alice@acme.com",
    updated: NOW.toISOString(),
    bm25Score: 1,
    vectorScore: 1,
    ...over,
  };
}

describe("mergeScore", () => {
  it("applies 0.7 vector / 0.3 bm25", () => {
    expect(mergeScore(cand({ vectorScore: 1, bm25Score: 0 }), DEFAULT_PARAMS)).toBeCloseTo(0.7);
  });
});

describe("decayFactor", () => {
  it("never decays org scope (evergreen)", () => {
    const old = new Date("2020-01-01T00:00:00Z").toISOString();
    expect(decayFactor(old, NOW, 30, "org")).toBe(1);
  });
  it("decays older non-org facts more", () => {
    const fresh = decayFactor(NOW.toISOString(), NOW, 30, "user");
    const month = decayFactor(new Date("2026-04-22T00:00:00Z").toISOString(), NOW, 30, "user");
    expect(fresh).toBeCloseTo(1);
    expect(month).toBeLessThan(fresh);
  });
  it("clamps future timestamps to 1", () => {
    const future = new Date("2027-01-01T00:00:00Z").toISOString();
    expect(decayFactor(future, NOW, 30, "user")).toBe(1);
  });
});

describe("boostFactor", () => {
  const boost = { ownUser: 1.5, ownTeam: 1.2, org: 1.0, other: 1.0 };
  it("maps relations to multipliers", () => {
    expect(boostFactor("own-user", boost)).toBe(1.5);
    expect(boostFactor("own-team", boost)).toBe(1.2);
    expect(boostFactor("org", boost)).toBe(1.0);
    expect(boostFactor("other", boost)).toBe(1.0);
  });
});

describe("lexicalSimilarity", () => {
  it("is 1 for identical text and 0 for disjoint", () => {
    expect(lexicalSimilarity("stripe webhook", "stripe webhook")).toBeCloseTo(1);
    expect(lexicalSimilarity("stripe webhook", "postgres cron")).toBe(0);
  });
});

describe("mmrSelect", () => {
  const items = [
    { score: 1.0, text: "stripe webhook signature" },
    { score: 0.95, text: "stripe webhook signature verify" }, // near-duplicate of #1
    { score: 0.9, text: "postgres backup cron" }, // diverse
  ];
  const sim = (a: { text: string }, b: { text: string }) => lexicalSimilarity(a.text, b.text);

  it("diversifies: prefers the different item over a near-duplicate", () => {
    const picked = mmrSelect(items, 0.7, 2, sim);
    expect(picked.map((i) => i.text)).toEqual([
      "stripe webhook signature",
      "postgres backup cron",
    ]);
  });

  it("with lambda=1 it is pure top-k by relevance", () => {
    const picked = mmrSelect(items, 1, 2, sim);
    expect(picked.map((i) => i.score)).toEqual([1.0, 0.95]);
  });
});

describe("rankCandidates", () => {
  it("filters sub-threshold candidates", () => {
    const out = rankCandidates([cand({ id: "low", bm25Score: 0.1, vectorScore: 0.1 })], {
      requester,
      now: NOW,
    });
    expect(out).toHaveLength(0);
  });

  it("boosts the requester's own user scope above org at equal relevance", () => {
    const out = rankCandidates(
      [
        cand({ id: "org", scope: "org/acme", title: "alpha", body: "alpha" }),
        cand({ id: "mine", scope: "user/alice@acme.com", title: "beta", body: "beta" }),
      ],
      { requester, now: NOW },
    );
    expect(out[0]!.id).toBe("mine");
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
  });

  it("ranks a fresh fact above an older one of the same scope", () => {
    const out = rankCandidates(
      [
        cand({ id: "old", scope: "team/payments", updated: "2026-01-01T00:00:00Z", title: "x", body: "x" }),
        cand({ id: "new", scope: "team/payments", updated: NOW.toISOString(), title: "y", body: "y" }),
      ],
      { requester, now: NOW },
    );
    expect(out[0]!.id).toBe("new");
  });

  it("respects the result limit", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      cand({ id: `f${i}`, title: `title ${i}`, body: `body number ${i}` }),
    );
    expect(rankCandidates(many, { requester, now: NOW, params: { resultLimit: 5 } })).toHaveLength(5);
  });
});
