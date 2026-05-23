import { describe, expect, it } from "vitest";
import {
  comparePrecedence,
  isValidScope,
  parseScope,
  scopeFromPath,
  scopeRelation,
  scopeRelativePath,
  type Requester,
} from "../../src/access/scope";

describe("parseScope", () => {
  it("parses the three kinds", () => {
    expect(parseScope("user/alice@acme.com")).toEqual({ kind: "user", id: "alice@acme.com" });
    expect(parseScope("team/payments")).toEqual({ kind: "team", id: "payments" });
    expect(parseScope("org/acme")).toEqual({ kind: "org", id: "acme" });
  });

  it("rejects malformed scopes", () => {
    expect(parseScope("payments")).toBeNull(); // no slash
    expect(parseScope("team/")).toBeNull(); // empty id
    expect(parseScope("team/eng/payments")).toBeNull(); // nesting not allowed
    expect(parseScope("project/x")).toBeNull(); // unknown kind
    expect(parseScope("team/pay ments")).toBeNull(); // space not allowed
  });

  it("isValidScope mirrors parseScope", () => {
    expect(isValidScope("org/acme")).toBe(true);
    expect(isValidScope("nope")).toBe(false);
  });
});

describe("scope <-> path", () => {
  it("maps a scope to its relative folder path", () => {
    expect(scopeRelativePath("team/payments")).toBe("team/payments");
    expect(scopeRelativePath("user/alice@acme.com")).toBe("user/alice@acme.com");
  });

  it("throws on an invalid scope", () => {
    expect(() => scopeRelativePath("bogus")).toThrow(/invalid scope/i);
  });

  it("recovers a scope from a path (incl. backslashes)", () => {
    expect(scopeFromPath("team\\payments")).toEqual({ kind: "team", id: "payments" });
  });
});

describe("precedence", () => {
  it("orders user before team before org", () => {
    expect(comparePrecedence("user", "team")).toBeLessThan(0);
    expect(comparePrecedence("team", "org")).toBeLessThan(0);
    expect(comparePrecedence("org", "user")).toBeGreaterThan(0);
  });
});

describe("scopeRelation", () => {
  const requester: Requester = { identity: "alice@acme.com", teams: ["payments", "infra"] };

  it("classifies the requester's own user scope", () => {
    expect(scopeRelation("user/alice@acme.com", requester)).toBe("own-user");
    expect(scopeRelation("user/bob@acme.com", requester)).toBe("other");
  });

  it("classifies the requester's own team scope", () => {
    expect(scopeRelation("team/payments", requester)).toBe("own-team");
    expect(scopeRelation("team/marketing", requester)).toBe("other");
  });

  it("treats org scope as the shared baseline", () => {
    expect(scopeRelation("org/acme", requester)).toBe("org");
  });

  it("returns 'other' for malformed scopes", () => {
    expect(scopeRelation("garbage", requester)).toBe("other");
  });
});
