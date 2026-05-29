import { describe, it, expect } from "vitest";
import { DEFAULT_IDENTITY, identityWarning, localModeBanner, stdioStartupBanner, teamModeBanner } from "../../src/server/banner";

describe("stdioStartupBanner (v2)", () => {
  it("orients the user — version, data dir, CWD-independence, useful next steps", () => {
    const b = stdioStartupBanner("0.2.7", "/tmp/k-data");
    expect(b).toContain("0.2.7");
    expect(b).toContain("/tmp/k-data");
    expect(b).toContain("stdio MCP server ready");
    expect(b).toMatch(/no matter which (project|folder)/i); // data dir is CWD-independent
    expect(b).toContain("krimto init");
    expect(b).toContain("krimto notes");
    expect(b).toContain("--help");
  });

  it("drops the deprecated verbs the old banner listed", () => {
    const b = stdioStartupBanner("0.2.7", "/tmp/k-data");
    expect(b).not.toMatch(/verify-connection/);
    expect(b).not.toMatch(/\bstorage\b/);
  });
});

describe("identityWarning (G2)", () => {
  it("warns when the identity is the unset-placeholder default", () => {
    const w = identityWarning(DEFAULT_IDENTITY);
    expect(w).toContain("⚠");
    expect(w).toContain("KRIMTO_IDENTITY");
    expect(w).toContain("different scopes between");
  });

  it("returns empty when an explicit identity is set", () => {
    expect(identityWarning("maria@acme.com")).toBe("");
  });
});

describe("localModeBanner", () => {
  it("leads with the dashboard URL, names /ui/connect, shows the data dir + the team upgrade", () => {
    const b = localModeBanner(8080, "/tmp/k-data");
    expect(b).toContain("http://localhost:8080");
    expect(b).toContain("/ui/connect");
    expect(b).toContain("/tmp/k-data");
    expect(b).toContain("krimto team init"); // v2: live team mode, not the old env var
    expect(b).not.toContain("KRIMTO_BOOTSTRAP_ADMIN");
    expect(b).toMatch(/no matter which (project|folder)/i); // data dir is CWD-independent
  });

  it("teaches that facts are plain markdown files in that folder", () => {
    const b = localModeBanner(8080, "/tmp/k-data");
    expect(b).toContain("plain markdown");
  });

  it("appends the identity warning when identity is the placeholder default", () => {
    const b = localModeBanner(8080, "/tmp/k-data"); // default identity arg
    expect(b).toContain("KRIMTO_IDENTITY");
    expect(b).toContain("different scopes");
  });

  it("omits the identity warning when an explicit identity is passed", () => {
    const b = localModeBanner(8080, "/tmp/k-data", "maria@acme.com");
    expect(b).not.toContain("⚠");
  });

  it("tells the user not to double-configure when she's already connected via stdio (G3)", () => {
    const b = localModeBanner(8080, "/tmp/k-data");
    expect(b).toContain("Already connected via stdio");
    expect(b).toContain("Keep that config");
  });

  it("includes the explicit 2-command recipe + verify prompt so users know what to do next (Gap #5d)", () => {
    const b = localModeBanner(8080, "/tmp/k-data");
    // The two commands explicitly:
    expect(b).toContain("claude mcp add --transport http krimto http://localhost:8080/mcp");
    expect(b).toContain("npx @krimto-labs/krimto init");
    // The required-vs-optional callout:
    expect(b).toContain("BOTH steps required");
    expect(b).toContain("without this");
    // The verify prompt so they know what success looks like:
    expect(b).toContain("Remember we use pnpm");
    expect(b).toContain("What do we use");
  });
});

describe("teamModeBanner", () => {
  it("prints a ready-to-paste config when a key was minted this boot", () => {
    const b = teamModeBanner({ host: "localhost:8080", key: "krm_live_abc123", dataDir: "/tmp/k-data" });
    expect(b).toContain("claude mcp add");
    expect(b).toContain("Bearer krm_live_abc123");
    expect(b).toContain("Data: /tmp/k-data");
    expect(b).toContain("/ui/connect");
  });
  it("prints reissue guidance (no placeholder key) when no key was minted", () => {
    const b = teamModeBanner({ host: "localhost:8080", key: null, dataDir: "/tmp/k-data" });
    expect(b).toContain("KRIMTO_REISSUE_ADMIN_KEY");
    expect(b).not.toContain("krm_live_…");
    expect(b).not.toContain("claude mcp add");
  });
});
