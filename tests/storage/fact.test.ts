import { describe, expect, it } from "vitest";
import {
  MAX_TITLE_LENGTH,
  createFact,
  generateFactId,
  isValidFactId,
  parseFact,
  resolveFilename,
  serializeFact,
  slugifyTitle,
  toIsoUtc,
  validateFrontmatter,
  type Fact,
} from "../../src/storage/fact";

describe("fact id", () => {
  it("generates a prefixed, valid, time-sortable id", () => {
    const a = generateFactId();
    expect(a.startsWith("fct_")).toBe(true);
    expect(isValidFactId(a)).toBe(true);
  });

  it("ids are unique and roughly time-ordered", async () => {
    const a = generateFactId();
    await new Promise((r) => setTimeout(r, 2));
    const b = generateFactId();
    expect(a).not.toBe(b);
    expect(a < b).toBe(true); // ULID lexical order tracks time
  });

  it("rejects malformed ids", () => {
    expect(isValidFactId("01J2K3M4N5P6Q7R8S9T0V1W2X3")).toBe(false); // no prefix
    expect(isValidFactId("fct_short")).toBe(false);
    expect(isValidFactId("fct_01J2K3M4N5P6Q7R8S9T0V1W2XI")).toBe(false); // I is not base32
  });
});

describe("slugifyTitle", () => {
  it("kebab-cases and lowercases", () => {
    expect(slugifyTitle("Stripe webhook conventions")).toBe("stripe-webhook-conventions");
  });
  it("strips punctuation and collapses separators", () => {
    expect(slugifyTitle("API conventions: v2 (final!!)")).toBe("api-conventions-v2-final");
  });
  it("strips diacritics", () => {
    expect(slugifyTitle("Café déployé")).toBe("cafe-deploye");
  });
  it("falls back to 'untitled' for empty slugs", () => {
    expect(slugifyTitle("!!!")).toBe("untitled");
  });
});

describe("resolveFilename", () => {
  it("uses <slug>.md when free", () => {
    expect(resolveFilename("stripe", [])).toBe("stripe.md");
  });
  it("appends -2, -3 on collision", () => {
    expect(resolveFilename("stripe", ["stripe.md"])).toBe("stripe-2.md");
    expect(resolveFilename("stripe", ["stripe.md", "stripe-2.md"])).toBe("stripe-3.md");
  });
});

describe("serialize/parse round-trip", () => {
  const fact: Fact = {
    frontmatter: {
      id: generateFactId(),
      scope: "team/payments",
      title: "Stripe webhook conventions",
      author: "alice@acme.com",
      created: "2026-05-22T14:32:00Z",
      updated: "2026-05-22T14:32:00Z",
      tags: ["stripe", "webhooks"],
    },
    body: "# Stripe webhook conventions\n\nAlways verify the signature first.",
  };

  it("serializes with frontmatter delimiters and a body", () => {
    const md = serializeFact(fact);
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("title: Stripe webhook conventions");
    expect(md.trimEnd().endsWith("Always verify the signature first.")).toBe(true);
  });

  it("round-trips losslessly and stably", () => {
    const once = serializeFact(fact);
    const parsed = parseFact(once);
    expect(parsed.frontmatter.id).toBe(fact.frontmatter.id);
    expect(parsed.frontmatter.scope).toBe("team/payments");
    expect(parsed.frontmatter.tags).toEqual(["stripe", "webhooks"]);
    expect(parsed.body).toBe(fact.body);
    expect(serializeFact(parsed)).toBe(once); // stable
  });

  it("throws on missing frontmatter", () => {
    expect(() => parseFact("just a body, no frontmatter")).toThrow(/frontmatter/i);
  });
});

describe("createFact", () => {
  it("sets server-controlled fields and mirrors created=updated", () => {
    const now = new Date("2026-05-22T14:32:00Z");
    const fact = createFact({
      scope: "user/alice@acme.com",
      title: "I prefer test-first",
      body: "Write the test before the code.",
      author: "alice@acme.com",
      now,
    });
    expect(isValidFactId(fact.frontmatter.id)).toBe(true);
    expect(fact.frontmatter.created).toBe("2026-05-22T14:32:00Z");
    expect(fact.frontmatter.updated).toBe(fact.frontmatter.created);
    expect(fact.frontmatter.tags).toBeUndefined(); // omitted when empty
  });
});

describe("toIsoUtc", () => {
  it("drops milliseconds", () => {
    expect(toIsoUtc(new Date("2026-05-22T14:32:00.123Z"))).toBe("2026-05-22T14:32:00Z");
  });
});

describe("validateFrontmatter", () => {
  const valid = {
    id: generateFactId(),
    scope: "team/payments",
    title: "ok",
    author: "alice@acme.com",
    created: "2026-05-22T14:32:00Z",
    updated: "2026-05-22T14:32:00Z",
  };

  it("passes a valid frontmatter", () => {
    expect(validateFrontmatter(valid)).toEqual([]);
  });

  it("flags missing required fields", () => {
    const issues = validateFrontmatter({ title: "x" });
    const fields = issues.map((i) => i.field);
    expect(fields).toContain("id");
    expect(fields).toContain("scope");
    expect(fields).toContain("author");
  });

  it("enforces the 80-char title cap", () => {
    const issues = validateFrontmatter({ ...valid, title: "x".repeat(MAX_TITLE_LENGTH + 1) });
    expect(issues.some((i) => i.field === "title")).toBe(true);
  });

  it("requires author in local-part@domain form", () => {
    const issues = validateFrontmatter({ ...valid, author: "alice" });
    expect(issues.some((i) => i.field === "author")).toBe(true);
  });

  it("requires ISO 8601 UTC timestamps", () => {
    const issues = validateFrontmatter({ ...valid, created: "May 22 2026" });
    expect(issues.some((i) => i.field === "created")).toBe(true);
  });

  it("requires lowercase kebab-case tags", () => {
    const issues = validateFrontmatter({ ...valid, tags: ["Stripe", "web hooks"] });
    expect(issues.filter((i) => i.field === "tags").length).toBe(2);
  });
});
