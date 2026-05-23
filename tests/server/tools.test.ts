import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FactStore } from "../../src/storage/store";
import {
  krimtoListScopes,
  krimtoRead,
  krimtoRecall,
  krimtoSupersede,
  krimtoWrite,
  type ToolContext,
} from "../../src/server/tools";
import { KrimtoError } from "../../src/server/errors";

let root: string;
let ctx: ToolContext;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-tools-"));
  ctx = {
    store: new FactStore(root),
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

    const read = await krimtoRead(ctx, res.id);
    expect(read.frontmatter.author).toBe("alice@acme.com");
  });

  it("rejects an invalid scope and an over-long title", async () => {
    await expect(
      krimtoWrite(ctx, { scope: "nope", title: "x", body: "y" }),
    ).rejects.toBeInstanceOf(KrimtoError);
    await expect(
      krimtoWrite(ctx, { scope: "org/acme", title: "x".repeat(81), body: "y" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
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
});
