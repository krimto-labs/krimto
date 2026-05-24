import { describe, it, expect } from "vitest";
import { signSession, verifySession, parseCookies, sessionConfigFromEnv, COOKIE_NAME } from "../../src/web/session";

const secret = "test-secret";

describe("session signing", () => {
  it("round-trips an identity", () => {
    expect(verifySession(signSession("alice@x.com", secret), secret)).toBe("alice@x.com");
  });
  it("rejects tampering, wrong secret, and undefined", () => {
    const v = signSession("alice@x.com", secret);
    expect(verifySession(v + "x", secret)).toBeNull();
    expect(verifySession(v, "other-secret")).toBeNull();
    expect(verifySession(undefined, secret)).toBeNull();
    expect(verifySession("no-dot", secret)).toBeNull();
  });
});

describe("parseCookies", () => {
  it("parses a multi-cookie header and handles missing", () => {
    expect(parseCookies(`${COOKIE_NAME}=abc; other=1`)).toMatchObject({ [COOKIE_NAME]: "abc", other: "1" });
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe("sessionConfigFromEnv", () => {
  it("uses env secret when set, else a 64-char random one", () => {
    expect(sessionConfigFromEnv({ KRIMTO_SESSION_SECRET: "s" } as NodeJS.ProcessEnv).secret).toBe("s");
    expect(sessionConfigFromEnv({} as NodeJS.ProcessEnv).secret).toHaveLength(64);
  });
});
