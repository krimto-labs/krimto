import { describe, it, expect } from "vitest";
import { localModeBanner, teamModeBanner } from "../../src/server/banner";

describe("localModeBanner", () => {
  it("leads with the dashboard URL, names /ui/connect, shows the data dir + the team upgrade", () => {
    const b = localModeBanner(8080, "/tmp/k-data");
    expect(b).toContain("http://localhost:8080");
    expect(b).toContain("/ui/connect");
    expect(b).toContain("Data: /tmp/k-data");
    expect(b).toContain("KRIMTO_BOOTSTRAP_ADMIN");
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
