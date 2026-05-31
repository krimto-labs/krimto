import { describe, it, expect } from "vitest";
import { resolveBindHost } from "../../src/server/bindHost";

describe("resolveBindHost", () => {
  it("binds loopback (127.0.0.1) by default — this machine only", () => {
    expect(resolveBindHost({}, { authOn: false })).toBe("127.0.0.1");
  });

  it("honors KRIMTO_HTTP_HOST when it names a loopback interface", () => {
    expect(resolveBindHost({ KRIMTO_HTTP_HOST: "::1" }, { authOn: false })).toBe("::1");
    expect(resolveBindHost({ KRIMTO_HTTP_HOST: "localhost" }, { authOn: false })).toBe("localhost");
    expect(resolveBindHost({ KRIMTO_HTTP_HOST: "127.0.0.5" }, { authOn: false })).toBe("127.0.0.5");
  });

  it("recognizes the bracketed IPv6 loopback [::1] as loopback (no false refusal)", () => {
    expect(resolveBindHost({ KRIMTO_HTTP_HOST: "[::1]" }, { authOn: false })).toBe("[::1]");
  });

  it("allows a non-loopback bind when auth is on (team mode)", () => {
    expect(resolveBindHost({ KRIMTO_HTTP_HOST: "0.0.0.0" }, { authOn: true })).toBe("0.0.0.0");
  });

  it("refuses a non-loopback bind when auth is off (the critical exposure)", () => {
    expect(() => resolveBindHost({ KRIMTO_HTTP_HOST: "0.0.0.0" }, { authOn: false })).toThrow(
      /loopback|auth|insecure/i,
    );
    expect(() => resolveBindHost({ KRIMTO_HTTP_HOST: "192.168.1.5" }, { authOn: false })).toThrow();
  });

  it("allows the explicit insecure override even with auth off", () => {
    expect(
      resolveBindHost({ KRIMTO_HTTP_HOST: "0.0.0.0", KRIMTO_ALLOW_INSECURE_HOST: "1" }, { authOn: false }),
    ).toBe("0.0.0.0");
  });
});
