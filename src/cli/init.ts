// `krimto init` — drop the always-use-Krimto standing rule into a project's agent rules files so the
// agent actually uses Krimto (fix for the discovery problem). Idempotent and non-destructive: it only
// adds/refreshes a marker-delimited block, never clobbering other content (see ../agentRule).
//
// G4 — by default, init now auto-detects which editor is in use (`.cursor/`, `.claude/`, existing
// CLAUDE.md / AGENTS.md / GEMINI.md, etc.) and writes ONLY matching files instead of all four. If
// no signals are present, it falls back to writing all four so a brand-new project still picks up
// the rule for whichever editor ships next. `--all` keeps the legacy "write everything" behavior.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { applyRule } from "../agentRule";
import { httpMcpEntry, type KrimtoMcpEntry } from "../server/connect";
import { writeMcpConfig, type WriteAction } from "./mcpConfig";
import { installService, isServiceInstalled, type InstallResult } from "./service";

const exec = promisify(execFile);

/** The agent rules files `krimto init` targets, relative to the project dir. */
export const INIT_TARGETS = [
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  path.join(".cursor", "rules", "krimto.mdc"),
];

export interface InitResult {
  /** Relative paths that were created or updated (empty when everything was already current). */
  written: string[];
  /** Targets considered (after detection/--all decisions). Exposed for the CLI's success message. */
  considered: string[];
  /** True when targets came from auto-detection (some editor signals matched). */
  detected: boolean;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Auto-detect which editor rules files the project should get based on local signals.
 * Returns the subset of INIT_TARGETS that has a positive signal, OR an empty array when
 * nothing matches (caller falls back to writing everything).
 */
export async function detectEditorTargets(cwd: string): Promise<string[]> {
  const matches: string[] = [];

  // CLAUDE.md — Claude Code. `.specstory/` is Claude Code's SpecStory transcript directory and
  // is a reliable "this project has been used with Claude Code" signal even when no CLAUDE.md
  // exists yet (added to fix the smoke-5 false-negative where `.cursor/` existed but the user
  // was actually using Claude Code).
  if (
    (await exists(path.join(cwd, "CLAUDE.md"))) ||
    (await exists(path.join(cwd, ".claude"))) ||
    (await exists(path.join(cwd, ".claude-plugin"))) ||
    (await exists(path.join(cwd, ".specstory")))
  ) {
    matches.push("CLAUDE.md");
  }
  // AGENTS.md — Codex CLI / generic
  if (await exists(path.join(cwd, "AGENTS.md"))) {
    matches.push("AGENTS.md");
  }
  // GEMINI.md — Gemini CLI
  if ((await exists(path.join(cwd, "GEMINI.md"))) || (await exists(path.join(cwd, "gemini-extension.json"))) || (await exists(path.join(cwd, ".gemini")))) {
    matches.push("GEMINI.md");
  }
  // .cursor/rules/krimto.mdc — Cursor
  if (await exists(path.join(cwd, ".cursor"))) {
    matches.push(path.join(".cursor", "rules", "krimto.mdc"));
  }

  return matches;
}

/**
 * The four editors Krimto's wizard reasons about. Each maps 1:1 to one rules-file path
 * and (where supported) one MCP-config wiring method. Names use kebab-case rather than
 * matching `EditorKind` casing exactly because they appear in serialized config + log output.
 */
export type EditorKind = "cursor" | "claude-code" | "codex" | "gemini-cli";

/**
 * How to register Krimto with this editor's MCP client.
 *
 * - `json`: directly merge into an editor's MCP config JSON file (current path supported: Cursor).
 *   The wizard reads the file, adds a `krimto` key under `key`, preserves all other servers.
 * - `cli`: shell out to the editor's own CLI (`claude mcp add ...`). Safer when the editor's
 *   config format isn't a stable file we want to touch directly (Claude Code).
 * - `null` (in `EditorEnvironment.mcpWire`): MCP wiring not yet automated for this editor —
 *   the wizard prints a copy-pasteable snippet for the user to apply manually (Gemini CLI,
 *   Codex; both blocked on TOML or file-format work scheduled for a follow-up).
 */
export type McpWireMethod =
  | { method: "json"; path: string; key: string }
  | { method: "cli"; command: string; baseArgs: string[] };

export interface EditorEnvironment {
  editor: EditorKind;
  /** True when local signals (file/dir presence) indicate this editor is in use here. */
  present: boolean;
  /** Project-relative rules-file path (the CLAUDE.md / .cursor/rules/krimto.mdc / etc.). */
  rulesPath: string;
  /** How to wire MCP config for this editor, or `null` when wiring isn't automated yet. */
  mcpWire: McpWireMethod | null;
}

/**
 * Resolve every editor Krimto can reason about into an `EditorEnvironment` triple
 * (editor + rules-file path + mcp-wiring method). `present` reflects detection signals;
 * the wizard shows all four with the detected ones preselected. `homeDir` is overrideable
 * for tests; production callers can omit it.
 */
export async function detectEditorEnvironments(
  cwd: string,
  homeDir: string = os.homedir(),
): Promise<EditorEnvironment[]> {
  const claudePresent =
    (await exists(path.join(cwd, "CLAUDE.md"))) ||
    (await exists(path.join(cwd, ".claude"))) ||
    (await exists(path.join(cwd, ".claude-plugin"))) ||
    (await exists(path.join(cwd, ".specstory")));
  const codexPresent = await exists(path.join(cwd, "AGENTS.md"));
  const geminiPresent =
    (await exists(path.join(cwd, "GEMINI.md"))) ||
    (await exists(path.join(cwd, "gemini-extension.json"))) ||
    (await exists(path.join(cwd, ".gemini")));
  const cursorPresent = await exists(path.join(cwd, ".cursor"));

  return [
    {
      editor: "cursor",
      present: cursorPresent,
      rulesPath: path.join(".cursor", "rules", "krimto.mdc"),
      mcpWire: {
        method: "json",
        path: path.join(homeDir, ".cursor", "mcp.json"),
        key: "mcpServers",
      },
    },
    {
      editor: "claude-code",
      present: claudePresent,
      rulesPath: "CLAUDE.md",
      // `claude mcp add krimto ...` is the supported invocation. Shelling out to the editor's
      // own CLI sidesteps the question of which exact file Claude Code persists MCP config in
      // (it has shifted between versions — `~/.claude.json`, `~/.claude/config.json`).
      mcpWire: {
        method: "cli",
        command: "claude",
        baseArgs: ["mcp", "add", "krimto"],
      },
    },
    {
      editor: "gemini-cli",
      present: geminiPresent,
      rulesPath: "GEMINI.md",
      // Deferred — Gemini CLI's MCP config path needs empirical confirmation before we write
      // to it. v0.2.17 prints a copy-paste snippet instead.
      mcpWire: null,
    },
    {
      editor: "codex",
      present: codexPresent,
      rulesPath: "AGENTS.md",
      // Deferred — Codex's config is TOML (`~/.codex/config.toml`); writing TOML safely needs
      // a parser we haven't added yet. v0.2.17 prints a copy-paste snippet instead.
      mcpWire: null,
    },
  ];
}

// === v0.2.17 wizard data model ============================================

/** The user picks one of three run modes in question 2 of the wizard. */
export type RunMode = "as-needed" | "always-running" | "manual";

/** Question 3 — Phase A ships solo only; "team" delegates to `krimto team init` (Phase C). */
export type WhoFor = "just-me" | "team";

/** Question 4 — Phase A surfaces keyword + OpenAI. Other providers ship post-v0.2.17. */
export type SearchProvider = "keyword" | "openai";

export type SearchAnswer =
  | { provider: "keyword" }
  | { provider: "openai"; apiKey: string };

/** Everything the wizard collects before it calls {@link applyWizardAnswers}. */
export interface WizardAnswers {
  /** Editors the user toggled on in question 1. Subset of detected/preselected editors. */
  selectedEditors: EditorKind[];
  runMode: RunMode;
  whoFor: WhoFor;
  search: SearchAnswer;
  /** Identity baked into the editor's MCP `env` block (KRIMTO_IDENTITY). Defaults to a sensible value. */
  identity: string;
}

/** Per-editor outcome reported by {@link applyWizardAnswers} for the wizard's summary block. */
export interface EditorOutcome {
  editor: EditorKind;
  /** What `writeMcpConfig` returned. */
  mcpAction: WriteAction;
  /** True if the standing rule file was created or refreshed. */
  ruleWritten: boolean;
  /** Project-relative path of the rule file we wrote (for the summary). */
  rulePath: string;
  /** When MCP-wiring is manual (Gemini/Codex), the snippet the user should paste themselves. */
  manualSnippet?: string;
}

/** What {@link applyWizardAnswers} produced. The wizard's printSummary consumes this. */
export interface ApplyResult {
  editorOutcomes: EditorOutcome[];
  /** Set when "Always running" was picked and the service was registered (or would have been). */
  serviceInstall?: InstallResult;
  /** True when an OpenAI key was verified + baked into the MCP env. */
  embeddingsConfigured: boolean;
  /** Resolved KRIMTO_DATA the wizard wrote rule files for / would point the service at. */
  dataDir: string;
  /** Resolved identity baked into MCP env. */
  identity: string;
}

export interface ApplyOptions {
  /** Forwarded to writeMcpConfig + installService. Used by tests to avoid touching the real OS. */
  dryRun?: boolean;
  /** Override os.homedir() for tests. */
  homeDir?: string;
  /** Override KRIMTO_DATA for tests / non-default data locations. */
  dataDir?: string;
  /** Override the service binary path. Defaults to `process.execPath`. */
  binPath?: string;
  /** Override the service argv. Defaults to `[process.argv[1] ?? "krimto", "serve"]`. */
  serviceArgs?: string[];
}

/**
 * Default identity — used when the wizard can't read git config. Mirrors what
 * `KRIMTO_IDENTITY` defaults to in the server. Not a real address; users override on first save.
 */
const DEFAULT_IDENTITY = "you@acme.com";

/**
 * Resolve a sensible default identity. Reads `git config --global user.email` when present.
 * Returns the literal default when git isn't installed or no email is configured.
 */
export async function defaultIdentity(): Promise<string> {
  try {
    const { stdout } = await exec("git", ["config", "--global", "user.email"]);
    const email = stdout.trim();
    if (email && /^[^@\s]+@[^@\s]+$/.test(email)) return email;
  } catch {
    /* git missing or unconfigured — fall through */
  }
  return DEFAULT_IDENTITY;
}

/**
 * The pure apply step — wizard prompts collect `answers`, this function performs the writes.
 * Tests use `opts.dryRun` + `opts.homeDir` to verify behaviour without touching the real OS.
 *
 * Per selected editor: write MCP config (via {@link writeMcpConfig}) + apply the standing rule
 * (via {@link applyRule}). If `runMode === "always-running"`, also install the system service.
 * If `search.provider === "openai"`, the API key is baked into the MCP entry's `env` block
 * (and into the service's environment when the service is installed).
 */
export async function applyWizardAnswers(
  cwd: string,
  answers: WizardAnswers,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  const homeDir = opts.homeDir ?? os.homedir();
  const dataDir = opts.dataDir ?? path.join(homeDir, ".krimto");
  const envs = await detectEditorEnvironments(cwd, homeDir);
  const selectedEnvs = envs.filter((e) => answers.selectedEditors.includes(e.editor));

  // Build the shared env block (identity + optional embeddings).
  const sharedEnv: Record<string, string> = { KRIMTO_IDENTITY: answers.identity };
  if (answers.search.provider === "openai") {
    sharedEnv.KRIMTO_EMBED_PROVIDER = "openai";
    sharedEnv.KRIMTO_EMBED_API_KEY = answers.search.apiKey;
  }

  // The MCP entry: stdio for "as needed", HTTP for "always running" (talks to the local service).
  let entry: KrimtoMcpEntry;
  if (answers.runMode === "always-running") {
    entry = { transport: "http", ...httpMcpEntry({ host: "localhost:8080" }) };
  } else {
    entry = {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@krimto-labs/krimto"],
      env: sharedEnv,
    };
  }

  const editorOutcomes: EditorOutcome[] = [];
  for (const env of selectedEnvs) {
    const mcpResult = await writeMcpConfig(env, entry, { dryRun: opts.dryRun });
    const rulePath = path.join(cwd, env.rulesPath);
    const existing = await readFileMaybe(rulePath);
    const nextRule = applyRule(existing);
    let ruleWritten = false;
    if (nextRule !== existing) {
      await fs.mkdir(path.dirname(rulePath), { recursive: true });
      await fs.writeFile(rulePath, nextRule, "utf8");
      ruleWritten = true;
    }
    editorOutcomes.push({
      editor: env.editor,
      mcpAction: mcpResult.action,
      ruleWritten,
      rulePath: env.rulesPath,
      manualSnippet: mcpResult.snippet,
    });
  }

  let serviceInstall: InstallResult | undefined;
  if (answers.runMode === "always-running") {
    const binPath = opts.binPath ?? process.execPath;
    const serviceArgs =
      opts.serviceArgs ?? [process.argv[1] ?? path.join(cwd, "bin", "krimto.mjs"), "serve"];
    serviceInstall = await installService(
      {
        binPath,
        args: serviceArgs,
        env: { ...sharedEnv, KRIMTO_DATA: dataDir, KRIMTO_HTTP_PORT: "8080" },
        homeDir,
      },
      { dryRun: opts.dryRun },
    );
  }

  return {
    editorOutcomes,
    serviceInstall,
    embeddingsConfigured: answers.search.provider === "openai",
    dataDir,
    identity: answers.identity,
  };
}

async function readFileMaybe(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

// === A.7 — Self-aware rerun (detect existing setup) ========================

/** A summary of what the wizard last applied, inferred from the filesystem. Drives the rerun menu. */
export interface SetupSnapshot {
  /** True when any editor's MCP config has a `krimto` entry — i.e. Krimto was set up here. */
  configured: boolean;
  /** Editors currently registered with Krimto (subset of detected editors). */
  registeredEditors: EditorKind[];
  /** Inferred from `isServiceInstalled` — "always-running" iff a service exists; else "as-needed". */
  runMode: RunMode;
  /** "openai" when any registered editor's env declares it; else "keyword". */
  searchProvider: SearchProvider;
}

/**
 * Inspect the machine to determine whether Krimto is already configured here, and how. Used by the
 * v0.2.17 rerun flow: if `configured === true`, the wizard shows the "What would you like to do?"
 * menu instead of re-asking the five questions from scratch.
 */
export async function detectExistingSetup(
  cwd: string,
  homeDir: string = os.homedir(),
): Promise<SetupSnapshot> {
  const envs = await detectEditorEnvironments(cwd, homeDir);
  const registeredEditors: EditorKind[] = [];
  let searchProvider: SearchProvider = "keyword";

  for (const env of envs) {
    if (env.mcpWire?.method !== "json") continue;
    let text: string;
    try {
      text = await fs.readFile(env.mcpWire.path, "utf8");
    } catch {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    const servers = parsed[env.mcpWire.key] as Record<string, unknown> | undefined;
    if (!servers || !("krimto" in servers)) continue;
    registeredEditors.push(env.editor);
    const krimto = servers.krimto as { env?: Record<string, string> };
    if (krimto.env?.KRIMTO_EMBED_PROVIDER === "openai") {
      searchProvider = "openai";
    }
  }

  const service = await isServiceInstalled(undefined, homeDir);
  const runMode: RunMode = service.installed ? "always-running" : "as-needed";

  return {
    configured: registeredEditors.length > 0 || service.installed,
    registeredEditors,
    runMode,
    searchProvider,
  };
}

// === Legacy runInit (v0.2.16, kept for --all / --minimal back-compat) ======

export interface RunInitOptions {
  /** Force writing all four files (the v0.2.16+ default — opt out via `minimal: true`). */
  all?: boolean;
  /**
   * Opt in to "write only files for editors actually present in this project" behavior. Default
   * since v0.2.16 is "write all four" to avoid silent failures when detection misses the active
   * editor (e.g. `.cursor/` exists from an earlier session but the user has switched to Claude Code).
   */
  minimal?: boolean;
  /** Override the target list directly (tests; takes precedence over flags). */
  targets?: string[];
}

/** Write/refresh the Krimto standing rule into each target rules file under `cwd`, idempotently. */
export async function runInit(cwd: string, opts: RunInitOptions = {}): Promise<InitResult> {
  let targets: string[];
  let detected = false;
  if (opts.targets) {
    targets = opts.targets;
  } else if (opts.minimal) {
    const auto = await detectEditorTargets(cwd);
    if (auto.length > 0) {
      targets = auto;
      detected = true;
    } else {
      // `--minimal` but nothing matched → still need to write something. Fall back to all four.
      targets = INIT_TARGETS;
    }
  } else {
    // v0.2.16+ default: write to all supported editors. `--all` is now redundant but kept for
    // backwards compatibility with users who scripted it.
    targets = INIT_TARGETS;
  }

  const written: string[] = [];
  for (const rel of targets) {
    const file = path.join(cwd, rel);
    let existing: string | null = null;
    try {
      existing = await fs.readFile(file, "utf8");
    } catch {
      existing = null; // file doesn't exist yet — we'll create it
    }
    const next = applyRule(existing);
    if (next === existing) continue; // already up to date
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, next, "utf8");
    written.push(rel);
  }
  return { written, considered: targets, detected };
}
