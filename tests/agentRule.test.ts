import { describe, it, expect } from "vitest";
import { AGENT_RULE, applyRule, mcpServerInstructions, removeRule, ruleBlock } from "../src/agentRule";

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

  it("routes scopes: default personal, phrase-driven team/org, and disambiguates multiple teams", () => {
    expect(AGENT_RULE).toContain("user/me = personal");
    expect(AGENT_RULE).toContain("for the team");
    expect(AGENT_RULE).toContain("company-wide");
    expect(AGENT_RULE).toContain("MORE THAN ONE team");
    expect(AGENT_RULE).toContain("krimto_whoami");
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

  // v0.2.29 — Cursor's .cursor/rules/*.mdc files need `alwaysApply: true` frontmatter or
  // they're treated as manual-attach only. The smoke-6 cross-editor test caught this:
  // Cursor would only recall facts when the user said "krimto" in their prompt (the
  // keyword that activates manual-attach rules). With `alwaysApply: true`, Cursor loads
  // the rule on every prompt and the agent auto-uses krimto without the keyword.
  describe("cursorMdc — frontmatter for Cursor .mdc rule files", () => {
    it("prepends `alwaysApply: true` frontmatter when writing into an empty file", () => {
      const out = applyRule(null, { cursorMdc: true });
      expect(out.startsWith("---\nalwaysApply: true\n---\n")).toBe(true);
      expect(out).toContain("<!-- krimto:start -->");
      expect(out).toContain("krimto_recall");
    });

    it("preserves existing user-supplied frontmatter (doesn't double-stack `---`)", () => {
      const userOwned = "---\ndescription: my own thing\nglobs: src/**\n---\n";
      const out = applyRule(userOwned, { cursorMdc: true });
      // Should NOT add our frontmatter on top of theirs.
      expect(out.startsWith("---\ndescription: my own thing")).toBe(true);
      // But should still append our block.
      expect(out).toContain("<!-- krimto:start -->");
      expect(out).toContain("krimto_recall");
      // And no double-frontmatter (only the user's `---` opening fence).
      expect((out.match(/^---\n/gm) ?? []).length).toBeLessThanOrEqual(2); // user's open + close
    });

    it("is idempotent — re-applying yields identical content", () => {
      const once = applyRule(null, { cursorMdc: true });
      const twice = applyRule(once, { cursorMdc: true });
      expect(twice).toBe(once);
    });

    it("preserves frontmatter when refreshing the block in place", () => {
      const stale = "---\nalwaysApply: true\n---\n<!-- krimto:start -->\nOLD\n<!-- krimto:end -->\n";
      const out = applyRule(stale, { cursorMdc: true });
      expect(out.startsWith("---\nalwaysApply: true\n---\n")).toBe(true);
      expect(out).not.toContain("OLD");
      expect(out).toContain("krimto_recall");
    });

    it("does NOT add frontmatter when cursorMdc is false (other editor files unchanged)", () => {
      const out = applyRule(null, { cursorMdc: false });
      expect(out.startsWith("---")).toBe(false);
      expect(out.startsWith("<!-- krimto:start -->")).toBe(true);
    });

    it("default (no opts) matches cursorMdc=false — back-compat", () => {
      expect(applyRule(null)).toBe(applyRule(null, { cursorMdc: false }));
    });
  });
});

describe("mcpServerInstructions", () => {
  it("carries the load-bearing imperatives", () => {
    const s = mcpServerInstructions();
    expect(s).toMatch(/krimto_write/);
    expect(s).toMatch(/krimto_recall/);
    expect(s).toMatch(/krimto_whoami/);
    expect(s).toMatch(/user\/me/);
    expect(s).toMatch(/Do NOT/i);
    // concise — it rides in every session's context
    expect(s.split("\n").length).toBeLessThanOrEqual(12);
  });

  it("shares its core imperatives with the rule-file rendering (no drift)", () => {
    const s = mcpServerInstructions();
    for (const token of ["krimto_write", "krimto_recall", "krimto_whoami", "user/me"]) {
      expect(AGENT_RULE).toContain(token);
      expect(s).toContain(token);
    }
  });

  // v014 work item 3 — DISCOVERY DIRECTIVE. The whole point of Krimto's discovery fix is that
  // when the user says "remember", the agent routes to krimto_write instead of its own built-in
  // memory. That directive must be carried by the MCP `initialize` instructions (Path B: a bare
  // MCP install with no `krimto init` still gets it), and must claim primacy over per-session memory.
  it("names 'remember' as the trigger that routes to krimto_write (Path B discovery)", () => {
    const s = mcpServerInstructions();
    // The trigger phrase + the canonical write tool both appear in one directive.
    expect(s).toMatch(/remember/i);
    expect(s).toMatch(/krimto_write/);
    // Primacy over built-in / per-session memory is asserted, not implied.
    expect(s).toMatch(/built-in|per-session/i);
    expect(s).toMatch(/Do NOT/i);
  });

  // The trigger directive must be in LOCKSTEP across all three surfaces an agent can learn it from:
  // the rule file (krimto init), the MCP initialize instructions (Path B), and the krimto_write
  // tool description (Path A, asserted in buildServer-wiring.test.ts). If any one drifts, an agent
  // wired through that surface won't route "remember" to Krimto.
  it("the 'remember → krimto_write' directive is in lockstep across rule file and MCP instructions", () => {
    const s = mcpServerInstructions();
    for (const surface of [AGENT_RULE, s]) {
      expect(surface).toMatch(/remember/i); // the trigger word
      expect(surface).toContain("krimto_write"); // the destination tool
      expect(surface).toMatch(/per-session|built-in/i); // primacy claim over hidden memory
    }
  });
});
