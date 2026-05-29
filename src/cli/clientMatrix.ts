// Single source of truth for "which editors auto-wire vs. need a manual snippet". The human-facing
// matrix (`krimto --help`, README, /ui/connect) renders from this; a test binds it to the actual
// `mcpWire` methods in `detectEditorEnvironments` so the two can never drift.
import { type EditorKind } from "./init";

export type WireMethod = "json" | "cli" | "manual";

export interface ClientRow {
  editor: EditorKind;
  label: string;
  method: WireMethod;
  /** True when `krimto init` wires this editor's MCP config automatically. */
  autoWires: boolean;
}

export const CLIENT_MATRIX: ClientRow[] = [
  { editor: "cursor", label: "Cursor", method: "json", autoWires: true },
  { editor: "claude-code", label: "Claude Code", method: "cli", autoWires: true },
  { editor: "codex", label: "Codex", method: "manual", autoWires: false },
  { editor: "gemini-cli", label: "Gemini CLI", method: "manual", autoWires: false },
];

export function clientMatrix(): ClientRow[] {
  return CLIENT_MATRIX;
}
