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
  it("local: numbered steps, copy buttons, verify notes, one-click Cursor, no auth", () => {
    const h = connectPanel({ host: "localhost:8080", requireAuth: false });
    expect(h).toContain("claude mcp add --transport http krimto http://localhost:8080/mcp");
    expect(h).toContain("~/.cursor/mcp.json");
    expect(h).toContain("cursor://anysphere.cursor-deeplink/mcp/install");
    expect(h).toContain("data-copy=");                 // copy buttons present
    expect(h).toContain("claude mcp list");            // verify hint
    expect(h).toContain("Cmd-Q");                       // Cursor restart note
    expect(h).toContain("Any other MCP client");        // generic section
    expect(h).toContain("krimto_recall");               // tool names listed
    expect(h).toContain("3. Make it automatic");         // Door 3
    expect(h).toContain("krimto_recall to load");         // the standing rule text
    expect(h).toContain("CLAUDE.md");                     // where to paste the rule
    expect(h).toContain("save your first memory");        // next-step link
    expect(h).not.toContain("Authorization");           // no key in local mode
  });

  it("team: key placeholder, Issue-a-key callout to /ui/keys, generic header, no one-click", () => {
    const h = connectPanel({ host: "memory.acme.com", requireAuth: true });
    expect(h).toContain("memory.acme.com/mcp");
    expect(h).toContain("Authorization: Bearer krm_live_");
    expect(h).toContain('href="/ui/keys"');
    expect(h).toContain("Issue a key");
    expect(h).not.toContain("cursor://");               // no one-click that would 401
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
