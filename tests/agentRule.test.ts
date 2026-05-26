import { describe, it, expect } from "vitest";
import { AGENT_RULE, applyRule, removeRule, ruleBlock } from "../src/agentRule";

describe("agentRule", () => {
  it("the rule tells the agent to recall and write to Krimto", () => {
    expect(AGENT_RULE).toContain("krimto_recall");
    expect(AGENT_RULE).toContain("krimto_write");
  });

  it("claims primacy over Claude Code's per-session auto-memory (Gap #1+#2)", () => {
    expect(AGENT_RULE).toContain("PRIMARY memory system");
    expect(AGENT_RULE).toContain("canonical memory system");
    expect(AGENT_RULE).toContain("~/.claude/projects/*/memory/");
    expect(AGENT_RULE).toContain("Do NOT use any other memory tool");
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

  it("removeRule: returns null when the file contains only our block (signal: delete file)", () => {
    const onlyOurs = applyRule(null);
    expect(removeRule(onlyOurs)).toBeNull();
  });

  it("removeRule: strips the block but preserves pre-existing content around it", () => {
    const mixed = applyRule("# My project rules\n- use 2 spaces\n");
    const cleaned = removeRule(mixed);
    expect(cleaned).not.toBeNull();
    expect(cleaned).toContain("# My project rules");
    expect(cleaned).toContain("- use 2 spaces");
    expect(cleaned).not.toContain("<!-- krimto:start -->");
    expect(cleaned).not.toContain("krimto_recall");
  });

  it("removeRule: returns the input unchanged when no markers are present (no-op)", () => {
    const unrelated = "# rules\n- pnpm only\n";
    expect(removeRule(unrelated)).toBe(unrelated);
  });

  it("removeRule: null in, null out", () => {
    expect(removeRule(null)).toBeNull();
  });
});
