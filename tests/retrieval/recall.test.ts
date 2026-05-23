import { describe, expect, it } from "vitest";
import { recall, retrievableFacts } from "../../src/retrieval/recall";
import { type Fact } from "../../src/storage/fact";
import { type Requester } from "../../src/access/scope";

const NOW = new Date("2026-05-23T00:00:00Z");
const requester: Requester = { identity: "alice@acme.com", teams: ["payments"] };

function fact(over: Partial<Fact["frontmatter"]> & { body?: string }): Fact {
  const { body, ...fm } = over;
  return {
    frontmatter: {
      id: "id",
      scope: "org/acme",
      title: "title",
      author: "alice@acme.com",
      created: "2026-05-22T00:00:00Z",
      updated: "2026-05-22T00:00:00Z",
      ...fm,
    },
    body: body ?? "body",
  };
}

describe("retrievableFacts", () => {
  it("excludes superseded and expired facts", () => {
    const facts = [
      fact({ id: "a", title: "original" }),
      fact({ id: "b", title: "replacement", supersedes: ["a"] }),
      fact({ id: "c", title: "stale", expires: "2020-01-01T00:00:00Z" }),
      fact({ id: "d", title: "current" }),
    ];
    const live = retrievableFacts(facts, NOW).map((f) => f.frontmatter.id);
    expect(live.sort()).toEqual(["b", "d"]);
  });
});

describe("recall (lexical-only)", () => {
  it("returns the matching fact and filters non-matches below threshold", () => {
    const facts = [
      fact({ id: "stripe", title: "Stripe webhook conventions", body: "verify the signature" }),
      fact({ id: "pg", title: "Postgres backups", body: "run pg_dump nightly" }),
    ];
    const out = recall("stripe webhook signature", facts, { requester, now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("stripe");
  });

  it("applies hierarchical precedence: user scope outranks org scope", () => {
    const facts = [
      fact({ id: "org", scope: "org/acme", title: "Stripe webhooks", body: "verify the signature" }),
      fact({
        id: "mine",
        scope: "user/alice@acme.com",
        title: "Stripe webhooks",
        body: "verify the signature",
      }),
    ];
    const out = recall("stripe webhooks signature", facts, { requester, now: NOW });
    expect(out[0]!.scope).toBe("user/alice@acme.com");
  });

  it("respects the limit", () => {
    const facts = Array.from({ length: 8 }, (_, i) =>
      fact({ id: `f${i}`, title: `Deploy step ${i}`, body: "deploy rollout checklist" }),
    );
    expect(recall("deploy checklist", facts, { requester, now: NOW, limit: 3 })).toHaveLength(3);
  });
});
