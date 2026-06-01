import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CLIENT_MATRIX, clientMatrix } from "../../src/cli/clientMatrix";
import { applyWizardAnswers, detectEditorEnvironments, type WizardAnswers } from "../../src/cli/init";

describe("client matrix", () => {
  it("has one row per editor with the right auto/manual classification", () => {
    const rows = clientMatrix();
    expect(rows.map((r) => r.editor).sort()).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "gemini-cli",
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.editor, r]));
    expect(by["cursor"]!.autoWires).toBe(true);
    expect(by["claude-code"]!.autoWires).toBe(true);
    expect(by["codex"]!.autoWires).toBe(false);
    expect(by["gemini-cli"]!.autoWires).toBe(false);
  });

  it("stays consistent with init's mcpWire methods (single source, no drift)", async () => {
    const envs = await detectEditorEnvironments(process.cwd());
    for (const env of envs) {
      const row = CLIENT_MATRIX.find((r) => r.editor === env.editor)!;
      const initMethod = env.mcpWire === null ? "manual" : env.mcpWire.method;
      expect(row.method).toBe(initMethod);
    }
  });

  // v014 work item 5 — the matrix's auto/manual split is HONEST: only the editors flagged
  // `autoWires: true` (Cursor + Claude Code) get exactly one programmatic MCP-wiring method
  // (json/cli); the manual editors (Codex + Gemini) carry none.
  it("autoWires=true iff the editor has a programmatic mcpWire (Cursor+Claude auto; Codex+Gemini manual)", async () => {
    const envs = await detectEditorEnvironments(process.cwd());
    for (const row of CLIENT_MATRIX) {
      const env = envs.find((e) => e.editor === row.editor)!;
      expect(row.autoWires).toBe(env.mcpWire !== null);
    }
    const auto = CLIENT_MATRIX.filter((r) => r.autoWires).map((r) => r.editor).sort();
    expect(auto).toEqual(["claude-code", "cursor"]);
    const manual = CLIENT_MATRIX.filter((r) => !r.autoWires).map((r) => r.editor).sort();
    expect(manual).toEqual(["codex", "gemini-cli"]);
  });
});

// v014 work item 5 — prove the auto/manual classification is REAL at the apply layer, not just a
// table: applyWizardAnswers actually auto-writes an MCP config for the auto editors and only emits
// a manual paste-snippet (no config written) for Codex/Gemini.
describe("editor auto-wiring is honest at the apply layer (work item 5)", () => {
  let dir: string;
  let home: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-cm-apply-"));
    home = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-cm-home-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  const answers = (editor: WizardAnswers["selectedEditors"][number]): WizardAnswers => ({
    selectedEditors: [editor],
    runMode: "as-needed",
    whoFor: "just-me",
    search: { provider: "keyword" },
    identity: "alice@acme.com",
  });

  it("Cursor auto-wires: writes ~/.cursor/mcp.json (no manual snippet)", async () => {
    await fs.mkdir(path.join(dir, ".cursor"));
    const res = await applyWizardAnswers(dir, answers("cursor"), { homeDir: home });
    const outcome = res.editorOutcomes.find((o) => o.editor === "cursor")!;
    expect(outcome.mcpAction).toBe("created"); // a real config write, not "manual"
    expect(outcome.manualSnippet).toBeUndefined();
    // The config file actually landed on disk.
    await expect(fs.access(path.join(home, ".cursor", "mcp.json"))).resolves.toBeUndefined();
  });

  for (const manualEditor of ["codex", "gemini-cli"] as const) {
    it(`${manualEditor} is manual: emits a paste snippet, writes no MCP config`, async () => {
      const res = await applyWizardAnswers(dir, answers(manualEditor), { homeDir: home });
      const outcome = res.editorOutcomes.find((o) => o.editor === manualEditor)!;
      expect(outcome.mcpAction).toBe("manual"); // NOT auto-wired
      expect(outcome.manualSnippet).toBeTruthy(); // user must paste it themselves
      expect(outcome.manualSnippet).toContain("krimto");
      // The standing rule file is still written — only the MCP wiring is manual.
      expect(outcome.ruleWritten).toBe(true);
    });
  }
});
