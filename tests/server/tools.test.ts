import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FactStore } from "../../src/storage/store";
import { openIndexDb } from "../../src/index/db";
import { FactIndex } from "../../src/index/factIndex";
import { Serializer } from "../../src/index/serialize";
import {
  krimtoListScopes,
  krimtoRead,
  krimtoRecall,
  krimtoSupersede,
  krimtoWhoami,
  krimtoWrite,
  type ToolContext,
} from "../../src/server/tools";
import { KrimtoError } from "../../src/server/errors";

let root: string;
let ctx: ToolContext;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-tools-"));
  const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
  ctx = {
    store: new FactStore(root),
    index: new FactIndex(db),
    writeQueue: new Serializer(),
    requester: { identity: "alice@acme.com", teams: ["payments"] },
    // alice is an org admin (writes anywhere) and a payments member.
    membership: {
      org: { slug: "acme", admins: ["alice@acme.com"] },
      teams: [{ slug: "payments", members: ["alice@acme.com"], leads: [] }],
      users: [],
    },
  };
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("krimto_write", () => {
  it("creates a fact, sets the author from the requester, returns id/scope/path", async () => {
    const res = await krimtoWrite(ctx, {
      scope: "user/alice@acme.com",
      title: "Staging resets Sunday",
      body: "Don't migrate Sunday nights.",
    });
    expect(res.id.startsWith("fct_")).toBe(true);
    expect(res.scope).toBe("user/alice@acme.com");
    expect(res.path).toBe("user/alice@acme.com/staging-resets-sunday.md");
    expect(res.commit_sha).toBeNull();
    // The absolute path + hint teach the agent (and via it, the user) that this is just a file.
    expect(res.absolute_path).toContain("user/alice@acme.com/staging-resets-sunday.md");
    expect(res.absolute_path.endsWith(res.path)).toBe(true);
    expect(res.hint).toContain("markdown file");
    expect(res.hint).toContain(res.absolute_path);

    const read = await krimtoRead(ctx, res.id);
    expect(read.frontmatter.author).toBe("alice@acme.com");
  });

  it("includes the expanded 'where things live' hint on the FIRST save only (G6)", async () => {
    // First write: extended hint
    const first = await krimtoWrite(ctx, {
      scope: "user/alice@acme.com",
      title: "First fact",
      body: "x",
    });
    expect(first.hint).toContain("First save in this session");
    expect(first.hint).toContain("git auto-commits every 30s");
    expect(first.hint).toContain("krimto --help");
    expect(first.hint).toContain("krimto storage");
    // Subsequent writes: normal one-line hint, no orientation
    const second = await krimtoWrite(ctx, {
      scope: "user/alice@acme.com",
      title: "Second fact",
      body: "y",
    });
    expect(second.hint).not.toContain("First save in this session");
    expect(second.hint).toContain("markdown file");
  });

  it("rejects an invalid scope and an over-long title", async () => {
    await expect(
      krimtoWrite(ctx, { scope: "nope", title: "x", body: "y" }),
    ).rejects.toBeInstanceOf(KrimtoError);
    await expect(
      krimtoWrite(ctx, { scope: "org/acme", title: "x".repeat(81), body: "y" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("resolves user/me and user/self to the caller's personal scope (readable back)", async () => {
    const res = await krimtoWrite(ctx, { scope: "user/me", title: "My note", body: "personal" });
    expect(res.scope).toBe("user/alice@acme.com");
    const read = await krimtoRead(ctx, res.id);
    expect(read.scope).toBe("user/alice@acme.com");

    const res2 = await krimtoWrite(ctx, { scope: "user/self", title: "Another", body: "x" });
    expect(res2.scope).toBe("user/alice@acme.com");
  });

  it("refuses a write the author could not read back — no ghost facts, even for an admin", async () => {
    // alice is an org admin, so canWrite('user/bob@acme.com') is true — but she can't read it back.
    await expect(
      krimtoWrite(ctx, { scope: "user/bob@acme.com", title: "ghost", body: "y" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const scopes = (await krimtoListScopes(ctx)).scopes.map((s) => s.path);
    expect(scopes).not.toContain("user/bob@acme.com");
  });

  it("forbidden write errors list the caller's writable scopes so an agent can self-correct", async () => {
    try {
      await krimtoWrite(ctx, { scope: "user/bob@acme.com", title: "x", body: "y" });
      throw new Error("expected krimtoWrite to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(KrimtoError);
      const data = (e as KrimtoError).data as { writable_scopes?: string[] };
      expect(data.writable_scopes).toContain("user/alice@acme.com");
      expect(data.writable_scopes).toContain("team/payments");
      expect(data.writable_scopes).toContain("org/acme");
    }
  });
});

describe("krimto_recall empty-hint (Gap #4)", () => {
  it("populates a 'no hits — call krimto_write' hint when results is empty", async () => {
    const empty = await krimtoRecall(ctx, { query: "nothing-matches-this-yet-xyz123" });
    expect(empty.results).toHaveLength(0);
    expect(empty.hint).toBeDefined();
    expect(empty.hint!).toContain("krimto_write");
    expect(empty.hint!).toContain("~/.claude/projects/*/memory/"); // explicit primacy claim
  });

  it("omits the hint when results is non-empty", async () => {
    await krimtoWrite(ctx, { scope: "user/alice@acme.com", title: "Stripe webhook signing", body: "verify signed_secret" });
    const hit = await krimtoRecall(ctx, { query: "stripe webhook" });
    expect(hit.results.length).toBeGreaterThan(0);
    expect(hit.hint).toBeUndefined();
  });
});

describe("krimto_recall", () => {
  it("returns ranked hits with attribution", async () => {
    await krimtoWrite(ctx, {
      scope: "team/payments",
      title: "Stripe webhook conventions",
      body: "Always verify the signature first.",
    });
    await krimtoWrite(ctx, { scope: "team/payments", title: "Postgres backups", body: "pg_dump nightly" });

    const { results } = await krimtoRecall(ctx, { query: "stripe webhook signature" });
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("Stripe webhook conventions");
    expect(results[0]!.author).toBe("alice@acme.com");
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it("can restrict the search to specific scopes", async () => {
    await krimtoWrite(ctx, { scope: "team/payments", title: "Deploy rules", body: "deploy on wednesdays" });
    await krimtoWrite(ctx, { scope: "org/acme", title: "Deploy policy", body: "deploy windows only" });
    const { results } = await krimtoRecall(ctx, { query: "deploy", scopes: ["org/acme"] });
    expect(results.every((r) => r.scope === "org/acme")).toBe(true);
  });
});

describe("krimto_read", () => {
  it("throws not_found for an unknown id", async () => {
    await expect(krimtoRead(ctx, "fct_missing")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("krimto_supersede", () => {
  it("rejects when new_body is empty", async () => {
    const original = await krimtoWrite(ctx, {
      scope: "team/payments",
      title: "Some fact",
      body: "Original body.",
    });
    await expect(
      krimtoSupersede(ctx, {
        id: original.id,
        new_title: "Some fact",
        new_body: "",
        reason: "Testing validation",
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("creates a replacement and the old fact drops out of recall", async () => {
    const original = await krimtoWrite(ctx, {
      scope: "team/payments",
      title: "Postgres version",
      body: "We use Postgres 14.",
    });
    const sup = await krimtoSupersede(ctx, {
      id: original.id,
      new_title: "Postgres version",
      new_body: "We use Postgres 16.",
      reason: "Upgraded to 16",
    });
    expect(sup.old_id).toBe(original.id);
    expect(sup.new_id).not.toBe(original.id);
    expect(sup.absolute_path).toContain("team/payments");
    expect(sup.hint).toContain("git history");

    const { results } = await krimtoRecall(ctx, { query: "postgres version" });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(sup.new_id);
    expect(results[0]!.body).toContain("Postgres 16");
  });
});

describe("krimto_list_scopes", () => {
  it("returns snake_case scope summaries", async () => {
    await krimtoWrite(ctx, { scope: "team/payments", title: "A", body: "x" });
    await krimtoWrite(ctx, { scope: "team/payments", title: "B", body: "y" });
    const { scopes } = await krimtoListScopes(ctx);
    const payments = scopes.find((s) => s.path === "team/payments");
    expect(payments).toMatchObject({ path: "team/payments", fact_count: 2 });
    expect(payments!.last_updated).toBeTypeOf("string");
  });

  // v0.2.24 — the smoke-6 transcript showed an agent inventing an explanation for the
  // empty `[]` response ("scopes aren't configured for your identity"). Hint payload
  // gives the agent the right answer to relay verbatim instead.
  it("attaches a 'no scopes yet' hint when nothing has been written (v0.2.24)", async () => {
    const result = await krimtoListScopes(ctx);
    expect(result.scopes).toHaveLength(0);
    expect(result.hint).toBeDefined();
    expect(result.hint).toContain("krimto_write");
    expect(result.hint).toContain(ctx.requester.identity);
  });

  it("does NOT include the hint when at least one scope exists", async () => {
    await krimtoWrite(ctx, { scope: "team/payments", title: "A", body: "x" });
    const result = await krimtoListScopes(ctx);
    expect(result.scopes.length).toBeGreaterThan(0);
    expect(result.hint).toBeUndefined();
  });
});

// v0.2.25 — Gap 3. The chat-side identity-introspection tool. Replaces the agent's habit of
// guessing the identity from out-of-band signals (the smoke-6 transcript caught one inventing
// `lpd.themes@gmail.com` from the real `lpdthemes@gmail.com`).
describe("krimto_whoami", () => {
  it("returns the resolved identity, readable scopes, and writable scopes", async () => {
    // Seed: alice writes to her personal scope + a team she's a member of, so the readable
    // set has something to enumerate.
    await krimtoWrite(ctx, { scope: "user/me", title: "p", body: "personal" });
    await krimtoWrite(ctx, { scope: "team/payments", title: "t", body: "team" });

    const r = await krimtoWhoami(ctx);
    expect(r.identity).toBe("alice@acme.com");
    expect(r.writable_scopes).toContain("user/alice@acme.com");
    expect(r.writable_scopes).toContain("team/payments");
    // alice is an org admin per the fixture, so org/<slug> must be writable too.
    expect(r.writable_scopes).toContain("org/acme");
    expect(r.readable_scopes).toContain("user/alice@acme.com");
    expect(r.readable_scopes).toContain("team/payments");
  });

  it("never returns null/empty identity even on a clean data dir", async () => {
    const r = await krimtoWhoami(ctx);
    expect(r.identity).toBeTruthy();
    expect(typeof r.identity).toBe("string");
    expect(r.writable_scopes.length).toBeGreaterThan(0); // user/<identity> always writable
  });
});
