import { describe, it, expect } from "vitest";
import { AGENT_RULE, applyRule, ruleBlock } from "../src/agentRule";

describe("agentRule", () => {
  it("the rule tells the agent to recall and write to Krimto", () => {
    expect(AGENT_RULE).toContain("krimto_recall");
    expect(AGENT_RULE).toContain("krimto_write");
  });

  it("inserts the marker-wrapped block into an empty/absent file", () => {
    const out = applyRule(null);
    expect(out).toContain("<!-- krimto:start -->");
    expect(out).toContain("<!-- krimto:end -->");
    expect(out).toContain("krimto_recall");
  });

  it("appends to an existing file without clobbering its content", () => {
    const existing = "# My project rules\n- use 2 spaces\n";
    const out = applyRule(existing);
    expect(out).toContain("# My project rules"); // preserved
    expect(out).toContain("- use 2 spaces"); // preserved
    expect(out).toContain(ruleBlock()); // block added
  });

  it("is idempotent — re-applying replaces the marked block, not duplicates it", () => {
    const once = applyRule("# rules\n");
    const twice = applyRule(once);
    expect(twice).toBe(once);
    expect((twice.match(/<!-- krimto:start -->/g) ?? []).length).toBe(1);
  });

  it("updates the block in place if the rule text changes, preserving surrounding text", () => {
    const stale = `# top\n\n<!-- krimto:start -->\nOLD RULE\n<!-- krimto:end -->\n\n# bottom\n`;
    const out = applyRule(stale);
    expect(out).toContain("# top");
    expect(out).toContain("# bottom");
    expect(out).not.toContain("OLD RULE");
    expect(out).toContain("krimto_recall");
    expect((out.match(/<!-- krimto:start -->/g) ?? []).length).toBe(1);
  });
});
