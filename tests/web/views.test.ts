import { describe, it, expect } from "vitest";
import { keysBody } from "../../src/web/views";

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
