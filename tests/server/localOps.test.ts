import { describe, it, expect } from "vitest";
import { resolveLocalOp, runLocalOp, isLoopbackAddress } from "../../src/server/localOps";

describe("isLoopbackAddress", () => {
  it("accepts IPv4/IPv6 loopback forms", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });
  it("rejects non-loopback / unknown addresses", () => {
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
    expect(isLoopbackAddress("192.168.1.20")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
  });
});

describe("resolveLocalOp — allowlist + argv", () => {
  it("maps fixed-verb ops to the right argv", () => {
    expect(resolveLocalOp("stop")).toMatchObject({ ok: true, argv: ["stop"] });
    expect(resolveLocalOp("restart")).toMatchObject({ ok: true, argv: ["restart"] });
    expect(resolveLocalOp("service-always")).toMatchObject({ ok: true, argv: ["service", "--always"] });
    expect(resolveLocalOp("search-keyword")).toMatchObject({ ok: true, argv: ["search", "--keyword"] });
    expect(resolveLocalOp("reset")).toMatchObject({ ok: true, argv: ["reset", "--yes"] });
  });

  it("rejects an unknown action with no argv", () => {
    expect(resolveLocalOp("rm -rf /").ok).toBe(false);
    expect(resolveLocalOp("reset --wipe-notes").ok).toBe(false); // exact ids only; no flag smuggling
  });

  it("validates the set-identity email and builds argv", () => {
    expect(resolveLocalOp("set-identity", { email: "a@b.com" })).toMatchObject({
      ok: true,
      argv: ["set", "identity", "a@b.com", "--yes"],
    });
    expect(resolveLocalOp("set-identity", { email: "not-an-email" }).ok).toBe(false);
    expect(resolveLocalOp("set-identity", {}).ok).toBe(false);
    // a space-bearing value (shell-metachar attempt) is rejected before it could ever reach argv
    expect(resolveLocalOp("set-identity", { email: "a@b.com; rm -rf /" }).ok).toBe(false);
  });

  it("requires an absolute path for folder", () => {
    expect(resolveLocalOp("folder", { path: "/Users/me/krimto" })).toMatchObject({
      ok: true,
      argv: ["folder", "--to", "/Users/me/krimto", "--yes"],
    });
    expect(resolveLocalOp("folder", { path: "relative/dir" }).ok).toBe(false);
    expect(resolveLocalOp("folder", {}).ok).toBe(false);
  });

  it("validates the OpenAI key shape for search-openai", () => {
    expect(resolveLocalOp("search-openai", { apiKey: "sk-abcd1234EFGH" }).ok).toBe(true);
    expect(resolveLocalOp("search-openai", { apiKey: "nope" }).ok).toBe(false);
  });
});

describe("runLocalOp", () => {
  it("spawns the resolved argv via the injected spawn (no shell)", () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const r = runLocalOp("restart", {}, { binPath: "/x/krimto.mjs", spawn: (cmd, args) => calls.push({ cmd, args }) });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["/x/krimto.mjs", "restart"]);
  });

  it("does NOT spawn when the action is invalid", () => {
    const calls: unknown[] = [];
    const r = runLocalOp("bogus", {}, { binPath: "/x/krimto.mjs", spawn: () => calls.push(1) });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
