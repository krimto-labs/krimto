import { describe, it, expect } from "vitest";
import { CLIENT_MATRIX, clientMatrix } from "../../src/cli/clientMatrix";
import { detectEditorEnvironments } from "../../src/cli/init";

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
});
