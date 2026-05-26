// MCP-config writer for the v0.2.17 wizard.
//
// Takes an editor's `EditorEnvironment` (from `detectEditorEnvironments`) plus a structured Krimto
// MCP entry (from `src/server/connect.ts`) and applies it via the appropriate method:
//
//   • method "json"  → merge into the editor's MCP-config JSON file (currently: Cursor).
//                      Idempotent. Other servers in the same file are preserved. Pretty-prints
//                      with 2-space indent to minimize diff churn for users who hand-edit.
//   • method "cli"   → shell out to the editor's own CLI (currently: Claude Code's
//                      `claude mcp add krimto -- npx ...`). `opts.dryRun` lets tests/CI capture the
//                      command without executing it.
//   • mcpWire null    → MCP config writing isn't automated for this editor yet (Gemini CLI / Codex);
//                      returns a copy-paste snippet the user can apply manually. The wizard surfaces
//                      this in the final summary block.
//
// Read/write/remove are symmetrical so the wizard's "reconfigure" + `krimto reset` paths can use
// the same primitive.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

import type { EditorEnvironment } from "./init";
import {
  stdioConnectSnippets,
  connectSnippets,
  type ConnectOpts,
  type KrimtoMcpEntry,
} from "../server/connect";

const exec = promisify(execFile);

/**
 * Outcome of a write. Values mirror what the wizard's summary block reports per editor:
 * "created" (first time), "updated" (entry already existed, contents changed), "no-change"
 * (already-current — quiet rerun case), "manual" (we printed a snippet), "cli-executed"
 * (Claude Code's CLI was invoked), "cli-dry-run" (test/CI mode — command captured, not run).
 */
export type WriteAction =
  | "created"
  | "updated"
  | "no-change"
  | "manual"
  | "cli-executed"
  | "cli-dry-run";

export interface WriteResult {
  action: WriteAction;
  /** Set when the user must apply the entry by hand (manual / cli-dry-run). */
  snippet?: string;
  /** Set when `action === "cli-dry-run"`: the exact command + argv the wizard would have run. */
  cliCommand?: { command: string; args: string[] };
}

export interface WriteOptions {
  /** When true, CLI-method writes are NOT executed; the command + args are returned. Tests use this. */
  dryRun?: boolean;
}

/**
 * Read the editor's MCP config (JSON wire method only). Returns null when the editor's wiring
 * method isn't JSON, or when the file doesn't exist. `raw` is the parsed top-level object;
 * `krimtoPresent` is true if the editor's MCP-servers key already has a `krimto` entry.
 */
export async function readMcpConfig(
  env: EditorEnvironment,
): Promise<{ krimtoPresent: boolean; raw: Record<string, unknown> } | null> {
  if (env.mcpWire?.method !== "json") return null;
  let text: string;
  try {
    text = await fs.readFile(env.mcpWire.path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `MCP config at ${env.mcpWire.path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const raw =
    parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const servers = (raw[env.mcpWire.key] as Record<string, unknown> | undefined) ?? {};
  return { krimtoPresent: "krimto" in servers, raw };
}

/**
 * Apply `entry` to the editor's MCP config. Dispatches by `env.mcpWire.method`:
 *
 * - JSON: idempotent merge under the editor's `mcpWire.key`. Other servers are preserved.
 * - CLI: builds the editor's CLI invocation; executes unless `opts.dryRun` (when it returns the
 *   command for inspection).
 * - null: returns a manual snippet for the user to paste.
 *
 * Returns a `WriteResult` whose `action` describes what happened. Callers (the wizard) render
 * the result to the user.
 */
export async function writeMcpConfig(
  env: EditorEnvironment,
  entry: KrimtoMcpEntry,
  opts: WriteOptions = {},
): Promise<WriteResult> {
  if (env.mcpWire === null) {
    return { action: "manual", snippet: buildSnippet(entry) };
  }
  if (env.mcpWire.method === "json") {
    return writeJsonEntry(env.mcpWire.path, env.mcpWire.key, entry);
  }
  // CLI method (Claude Code)
  const cliArgs = buildClaudeCliArgs(env.mcpWire.baseArgs, entry);
  if (opts.dryRun) {
    return {
      action: "cli-dry-run",
      cliCommand: { command: env.mcpWire.command, args: cliArgs },
      snippet: `${env.mcpWire.command} ${cliArgs.join(" ")}`,
    };
  }
  // v0.2.19 — reconfigure-safe idempotency. `claude mcp add krimto` errors with "MCP server
  // krimto already exists in local config" on the second + Nth runs (per project scope), which
  // breaks every `krimto init` rerun the user might do. The CLI surface has no `add-or-update`
  // verb, so we remove the prior entry first and ignore the "not found" case from fresh setups.
  const removeArgs = env.mcpWire.baseArgs.map((a) => (a === "add" ? "remove" : a));
  try {
    await exec(env.mcpWire.command, removeArgs);
  } catch {
    // "MCP server krimto not found" on a fresh setup — expected, ignore. Any other failure
    // here (e.g. claude not on PATH) will resurface as a real error on the add call below.
  }
  try {
    await exec(env.mcpWire.command, cliArgs);
    return { action: "cli-executed" };
  } catch (e) {
    // Claude CLI may fail if `claude` isn't on PATH or for other reasons. Surface the error so
    // the wizard can show the user what to do next (often: "run this command yourself").
    throw new Error(
      `Failed to register Krimto with ${env.editor} via \`${env.mcpWire.command}\`: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Inverse of `writeMcpConfig`. Removes the `krimto` entry from the editor's MCP config. JSON
 * method only — CLI/null methods print a manual hint instead (most editor CLIs have a
 * matching `mcp remove`, but we don't depend on it).
 */
export async function removeMcpConfig(env: EditorEnvironment): Promise<{ removed: boolean }> {
  if (env.mcpWire === null || env.mcpWire.method !== "json") return { removed: false };
  let text: string;
  try {
    text = await fs.readFile(env.mcpWire.path, "utf8");
  } catch {
    return { removed: false };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { removed: false };
  }
  const servers = parsed[env.mcpWire.key] as Record<string, unknown> | undefined;
  if (!servers || !("krimto" in servers)) return { removed: false };
  const { krimto: _krimto, ...rest } = servers; // eslint-disable-line @typescript-eslint/no-unused-vars
  parsed[env.mcpWire.key] = rest;
  await fs.writeFile(env.mcpWire.path, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  return { removed: true };
}

// --- internal helpers -------------------------------------------------------

async function writeJsonEntry(
  filePath: string,
  serversKey: string,
  entry: KrimtoMcpEntry,
): Promise<WriteResult> {
  let parsed: Record<string, unknown> = {};
  try {
    const text = await fs.readFile(filePath, "utf8");
    const candidate: unknown = JSON.parse(text);
    if (candidate !== null && typeof candidate === "object") {
      parsed = candidate as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable file — start fresh. Invalid JSON is caught here too; we don't want a
    // hand-edited junk file to abort setup. Worst case we overwrite a file the user damaged.
  }
  const servers =
    typeof parsed[serversKey] === "object" && parsed[serversKey] !== null
      ? ({ ...(parsed[serversKey] as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  const krimtoEntry = stripTransportTag(entry);
  const existing = servers.krimto;
  if (existing !== undefined && jsonEqual(existing, krimtoEntry)) {
    return { action: "no-change" };
  }
  const action: WriteAction = existing === undefined ? "created" : "updated";
  servers.krimto = krimtoEntry;
  parsed[serversKey] = servers;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  return { action };
}

/** Drop the `transport` TypeScript discriminator — editors don't expect it in their config. */
function stripTransportTag(entry: KrimtoMcpEntry): Record<string, unknown> {
  const { transport: _t, ...rest } = entry; // eslint-disable-line @typescript-eslint/no-unused-vars
  return rest;
}

/** Stable deep-equality via canonical JSON round-trip. Fine for the small entry objects. */
function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Build the argv for `claude mcp add krimto …`. Two shapes:
 *   stdio: claude mcp add krimto -- <command> <args...>
 *   http:  claude mcp add --transport http krimto <url> [--header "Key: Value" ...]
 * We deliberately do NOT pass env vars via `--env` on the CLI: env handling differs across
 * claude CLI versions. The wizard's standing-rule + identity context covers what env would.
 */
function buildClaudeCliArgs(baseArgs: string[], entry: KrimtoMcpEntry): string[] {
  // baseArgs = ["mcp", "add", "krimto"]
  if (entry.transport === "stdio") {
    return [...baseArgs, "--", entry.command, ...entry.args];
  }
  // HTTP: rebuild the order so --transport http lands before the name. We assert the standard
  // baseArgs shape (["mcp", "add", "krimto"]) since init.ts is the only caller and pins it.
  if (baseArgs.length < 3) {
    throw new Error(`expected baseArgs ["mcp","add","<name>"], got ${JSON.stringify(baseArgs)}`);
  }
  const args: string[] = [baseArgs[0]!, baseArgs[1]!, "--transport", "http", baseArgs[2]!, entry.url];
  if (entry.headers) {
    for (const [k, v] of Object.entries(entry.headers)) {
      args.push("--header", `${k}: ${v}`);
    }
  }
  return args;
}

/** Snippet a user pastes manually when we can't automate the editor (Gemini CLI / Codex / dry-run). */
function buildSnippet(entry: KrimtoMcpEntry): string {
  if (entry.transport === "stdio") {
    // Match `stdioConnectSnippets` output exactly so users see one consistent format everywhere.
    const { cursorJson } = stdioConnectSnippets({ identity: entry.env?.KRIMTO_IDENTITY });
    return cursorJson;
  }
  const opts: ConnectOpts = {
    host: new URL(entry.url).host,
    key: entry.headers?.Authorization?.replace(/^Bearer\s+/, ""),
  };
  return connectSnippets(opts).cursorJson;
}
