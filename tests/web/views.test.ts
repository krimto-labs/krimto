import { describe, it, expect } from "vitest";
import { keysBody, howItWorksPanel, connectPanel } from "../../src/web/views";

interface K {
  hash: string;
  prefix: string;
  created: string;
  label?: string;
}
const k = (over: Partial<K> = {}): K => ({
  hash: "a".repeat(64),
  prefix: "krm_live_",
  created: "2026-05-25T00:00:00.000Z",
  ...over,
});

describe("keysBody", () => {
  it("gives each revoke button an aria-label identifying the key (multiple keys)", () => {
    const html = keysBody([k({ label: "ci", hash: "a".repeat(64) }), k({ label: "laptop", hash: "b".repeat(64) })]);
    expect(html).toMatch(/aria-label="Revoke key[^"]*ci/);
    expect(html).toMatch(/aria-label="Revoke key[^"]*laptop/);
    expect((html.match(/name="hash"/g) ?? []).length).toBe(2);
  });

  it("does not offer to revoke the only key (prevents lockout)", () => {
    const html = keysBody([k({ label: "only" })]);
    expect(html).not.toContain('name="hash"'); // no revoke form for the sole key
    expect(html.toLowerCase()).toContain("only key"); // shows a hint instead
  });

  it("escapes a malicious label", () => {
    const html = keysBody([k({ label: "<script>x</script>" }), k({ hash: "c".repeat(64) })]);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>x</script>");
  });
});

describe("connectPanel", () => {
  it("shows the Claude Code command and Cursor JSON for the request host (local: no key, with button)", () => {
    const h = connectPanel({ host: "localhost:8080", requireAuth: false });
    expect(h).toContain("claude mcp add --transport http krimto http://localhost:8080/mcp");
    expect(h).toContain("~/.cursor/mcp.json");
    expect(h).toContain("http://localhost:8080/mcp");
    expect(h).toContain("cursor://anysphere.cursor-deeplink/mcp/install"); // one-click button works in local mode
    expect(h).not.toContain("Authorization"); // no key in local mode
  });

  it("team mode shows a key placeholder + a Keys-page pointer and omits the keyless one-click button", () => {
    const h = connectPanel({ host: "memory.acme.com", requireAuth: true });
    expect(h).toContain("memory.acme.com/mcp");
    expect(h).toContain("Authorization: Bearer krm_live_");
    expect(h).toContain('href="/ui/keys"');
    expect(h).not.toContain("cursor://"); // no one-click install that would 401 without the real key
  });
});

describe("howItWorksPanel", () => {
  it("leads with team memory and names the three layers + a bring-your-team step", () => {
    const h = howItWorksPanel();
    expect(h).toContain("Shared memory for your team");
    expect(h).toContain("Personal");
    expect(h).toContain("Team");
    expect(h).toContain("Org");
    expect(h).toContain("Bring your team");
  });
});
