import { describe, it, expect } from "vitest";
import { requesterFromAuth } from "../../src/server/tools";

describe("requesterFromAuth", () => {
  it("builds a requester from authInfo.extra", () => {
    const r = requesterFromAuth({ token: "t", clientId: "alice@x.com", scopes: [], extra: { identity: "alice@x.com", teams: ["payments"] } });
    expect(r).toEqual({ identity: "alice@x.com", teams: ["payments"] });
  });
  it("rejects missing authInfo", () => {
    expect(() => requesterFromAuth(undefined)).toThrow(/bearer/i);
  });
  it("rejects authInfo without an identity", () => {
    expect(() => requesterFromAuth({ token: "t", clientId: "x", scopes: [], extra: {} })).toThrow(/identity/i);
  });
  it("ignores a non-array teams value (no substring matching)", () => {
    const r = requesterFromAuth({ token: "t", clientId: "x", scopes: [], extra: { identity: "x@x.com", teams: "payments" } });
    expect(r.teams).toEqual([]);
  });
});
