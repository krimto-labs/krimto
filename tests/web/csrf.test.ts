import { describe, it, expect } from "vitest";
import { isSameOrigin } from "../../src/web/csrf";

const req = (headers: Record<string, string>) => ({ headers });

describe("isSameOrigin", () => {
  it("accepts a same-origin Origin header", () => {
    expect(isSameOrigin(req({ host: "localhost:8080", origin: "http://localhost:8080" }))).toBe(true);
  });

  it("rejects a cross-origin Origin header (CSRF attempt)", () => {
    expect(isSameOrigin(req({ host: "localhost:8080", origin: "http://evil.test" }))).toBe(false);
  });

  it("falls back to the Referer host when no Origin is sent", () => {
    expect(isSameOrigin(req({ host: "localhost:8080", referer: "http://localhost:8080/ui/settings" }))).toBe(true);
    expect(isSameOrigin(req({ host: "localhost:8080", referer: "http://evil.test/x" }))).toBe(false);
  });

  it("allows a request with no Origin and no Referer (non-browser client; not a cross-origin attack)", () => {
    expect(isSameOrigin(req({ host: "localhost:8080" }))).toBe(true);
  });

  it("rejects when the Host header is missing (cannot verify)", () => {
    expect(isSameOrigin(req({ origin: "http://localhost:8080" }))).toBe(false);
  });

  it('rejects an opaque "null" Origin', () => {
    expect(isSameOrigin(req({ host: "localhost:8080", origin: "null" }))).toBe(false);
  });
});
