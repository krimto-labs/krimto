// The v0.2.17 first-run wizard. Asks the five questions from §03 of the Maria-journey doc,
// then calls applyWizardAnswers to write everything to disk.
//
// Kept separate from src/cli/init.ts so the pure apply logic stays unit-testable without
// mocking the interactive prompts library. This file owns: the question functions, the
// pre-flight scan, the post-apply summary, the Ctrl-C handler, and the reconfigure menu.

import { checkbox, confirm, password, select } from "@inquirer/prompts";

import { defaultIO, isExitPrompt, type WizardIO } from "./promptHelpers";

import {
  applyWizardAnswers,
  defaultIdentity,
  detectEditorEnvironments,
  detectExistingSetup,
  type ApplyOptions,
  type ApplyResult,
  type EditorKind,
  type EditorEnvironment,
  type RunMode,
  type SearchProvider,
  type SetupSnapshot,
  type WizardAnswers,
} from "./init";
import { runSetupEmbeddings } from "./setupEmbeddings";
import { KRIMTO_VERSION } from "../server/index";

const EDITOR_LABEL: Record<EditorKind, string> = {
  cursor: "Cursor",
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

// WizardIO and defaultIO live in `./promptHelpers` so every wizard shares the same contract.
// Re-exported here so external consumers (e.g. tests importing from `./wizard`) keep working.
export type { WizardIO } from "./promptHelpers";

export interface RunWizardOptions extends ApplyOptions {
  io?: WizardIO;
}

/**
 * The interactive entry point. Detects existing setup; if found, routes to the reconfigure
 * menu (§06). Otherwise runs the five-question wizard (§03). Returns the apply result, or
 * `null` if the user quit / hit Ctrl-C / declined the final confirm.
 */
export async function runInitWizard(
  cwd: string,
  opts: RunWizardOptions = {},
): Promise<ApplyResult | null> {
  const io = opts.io ?? defaultIO;
  try {
    const homeDir = opts.homeDir;
    const snapshot = await detectExistingSetup(cwd, homeDir);
    if (snapshot.configured) {
      return await runReconfigureMenu(cwd, snapshot, opts, io);
    }
    return await runFreshWizard(cwd, opts, io);
  } catch (e) {
    if (isExitPrompt(e)) {
      io.err("\nAborted (Ctrl-C). No changes were made.\n");
      process.exitCode = 130;
      return null;
    }
    throw e;
  }
}

/** §06 — "Krimto is already set up on this machine. What would you like to do?" */
async function runReconfigureMenu(
  cwd: string,
  snapshot: SetupSnapshot,
  opts: RunWizardOptions,
  io: WizardIO,
): Promise<ApplyResult | null> {
  io.out("\n");
  io.out("Krimto is already set up on this machine.\n");
  io.out(`  Editors:   ${snapshot.registeredEditors.map((e) => EDITOR_LABEL[e]).join(", ") || "(none)"}\n`);
  io.out(`  Run mode:  ${runModeLabel(snapshot.runMode)}\n`);
  io.out(`  Search:    ${searchLabel(snapshot.searchProvider)}\n`);
  io.out("\n");

  const choice = await select({
    message: "What would you like to do?",
    choices: [
      {
        value: "refresh" as const,
        name: "Just refresh the standing rule in this project",
        description:
          "Re-applies the 'always use Krimto' rule to CLAUDE.md / .cursor/rules/ here.\nUse this when you just cloned a new repo.",
      },
      {
        value: "reconfigure" as const,
        name: "Change settings (reconfigure)",
        description:
          "Re-runs the setup wizard with your current answers pre-filled.\nSkip anything you don't want to change.",
      },
      {
        value: "status" as const,
        name: "View status",
        description: "Show what's working, what's configured, recent activity.",
      },
      {
        value: "quit" as const,
        name: "Quit",
        description: "Leave Krimto as it is.",
      },
    ],
  });

  if (choice === "quit") {
    io.out("\nNo changes made.\n");
    return null;
  }

  if (choice === "refresh") {
    // Refresh the rule only — no MCP-config or service rewrites. Reuse the apply step with
    // just the rule path (we pass the current editor set so MCP-writes report "no-change").
    const identity = await defaultIdentity();
    const answers: WizardAnswers = {
      selectedEditors: snapshot.registeredEditors,
      runMode: snapshot.runMode,
      whoFor: "just-me",
      search:
        snapshot.searchProvider === "openai"
          ? { provider: "openai", apiKey: "<existing>" } // not actually used — MCP already has it
          : { provider: "keyword" },
      identity,
    };
    const result = await applyWizardAnswers(cwd, answers, opts);
    printRefreshSummary(result, io);
    return result;
  }

  if (choice === "status") {
    io.out("\nRun `krimto status` from your shell to see the full report.\n");
    return null;
  }

  // "reconfigure" — re-run the five questions with snapshot as defaults
  return runFreshWizard(cwd, opts, io, snapshot);
}

/** §03 — the fresh five-question flow. `snapshot` (when given) seeds the defaults. */
async function runFreshWizard(
  cwd: string,
  opts: RunWizardOptions,
  io: WizardIO,
  snapshot: SetupSnapshot | null = null,
): Promise<ApplyResult | null> {
  io.out(`\nKrimto — Setting up your AI's memory · v${KRIMTO_VERSION}\n\n`);
  const envs = await detectEditorEnvironments(cwd, opts.homeDir);
  printScan(envs, io);

  const selectedEditors = await askEditors(envs, snapshot);
  // v0.2.20 — smart default: stdio Krimto can only serve one editor at a time (single-writer
  // lock on the data dir). When the user picks 2+ editors, recommend "Always running" so they
  // can all use Krimto simultaneously over HTTP. Snapshot.runMode wins on reconfigure (respects
  // the user's prior choice). First-run with one editor → "as-needed" (simplest).
  const smartDefault: RunMode = selectedEditors.length >= 2 ? "always-running" : "as-needed";
  const runMode = await askRunMode(snapshot?.runMode ?? smartDefault, selectedEditors.length);
  const whoFor = await askWhoFor();
  if (whoFor === "team") {
    io.out("\nGreat — team mode is set up via `krimto team init` (Phase C). Run that next.\n");
    return null;
  }
  const search = await askSearch(snapshot?.searchProvider, io);
  const identity = await defaultIdentity();

  printSummary({ selectedEditors, runMode, whoFor, search, identity }, io);
  const ok = await confirm({ message: "Apply this setup?", default: true });
  if (!ok) {
    io.out("\nNo changes made.\n");
    return null;
  }

  io.out("\nSetting up...\n");
  const result = await applyWizardAnswers(cwd, { selectedEditors, runMode, whoFor, search, identity }, opts);
  printApplyResult(result, io);
  return result;
}

// === Question functions ====================================================

async function askEditors(
  envs: EditorEnvironment[],
  snapshot: SetupSnapshot | null,
): Promise<EditorKind[]> {
  return checkbox<EditorKind>({
    message: "Which editors should your AI memory work with?",
    choices: envs.map((env) => ({
      value: env.editor,
      name: EDITOR_LABEL[env.editor],
      description: env.present
        ? "detected in this project"
        : env.installed
          ? "installed on this machine (not in this project yet)"
          : env.mcpWire === null
            ? "not detected — manual snippet only"
            : "not detected — toggle on if you want anyway",
      // v0.2.21: preselect on either project-level (present) OR machine-level (installed) signal.
      checked: snapshot
        ? snapshot.registeredEditors.includes(env.editor)
        : env.present || env.installed,
    })),
  });
}

async function askRunMode(
  defaultMode: RunMode = "as-needed",
  editorCount = 1,
): Promise<RunMode> {
  // v0.2.20 — when 2+ editors are selected, "as needed" is broken by Krimto's single-writer
  // lock: only the first editor to call wins; the others fail. The choice descriptions reflect
  // this so a user picking "as needed" with multiple editors sees the warning before they commit.
  const multi = editorCount >= 2;
  return select<RunMode>({
    message: "How should Krimto run?",
    default: defaultMode,
    choices: [
      {
        value: "as-needed",
        name: multi ? "As needed (⚠️  one editor at a time only)" : "As needed (recommended)",
        description: multi
          ? `Your editor launches Krimto when it needs it. Simple — but Krimto's single-writer\n` +
            `lock means only one of your ${editorCount} editors can use it at a time. The second one\n` +
            `to call will fail until the first one exits. Pick "Always running" instead if you\n` +
            `want all of them to work simultaneously.`
          : "Your editor launches Krimto when it needs it. Simplest setup —\nno background process to manage. Works for solo use on one machine.",
      },
      {
        value: "always-running",
        name: multi
          ? "Always running (recommended for multi-editor)"
          : "Always running (background service)",
        description: multi
          ? `ONE Krimto runs continuously in the background; ALL ${editorCount} of your editors connect\n` +
            `to it over HTTP. No lock fights — they can all save and recall simultaneously.\n` +
            `Installs launchd / systemd / schtasks on first use.`
          : "Krimto runs continuously, even after you close your terminal.\nAuto-starts when you log in. Best if multiple editors talk to one Krimto\nor you want /ui always available.",
      },
      {
        value: "manual",
        name: "Manual (I'll run `krimto serve` myself)",
        description: "Power-user mode. Nothing auto-starts. You're in charge.",
      },
    ],
  });
}

async function askWhoFor(): Promise<"just-me" | "team"> {
  return select<"just-me" | "team">({
    message: "Who's this for?",
    default: "just-me",
    choices: [
      {
        value: "just-me",
        name: "Just me, for now (recommended for a 2-minute test)",
        description:
          "No accounts, no API keys, no login on the dashboard.\nYour AI remembers things across your own chats and editors.\nYou can flip into team mode any time — facts you save now will stay.",
      },
      {
        value: "team",
        name: "My team (set up team mode now)",
        description:
          "Adds API keys, an admin dashboard, and a git remote for sync.\nBest when 2+ people share the same memory.\nWe'll walk you through it via `krimto team init`.",
      },
    ],
  });
}

async function askSearch(
  defaultProvider: SearchProvider = "keyword",
  io: WizardIO = defaultIO,
): Promise<WizardAnswers["search"]> {
  const provider = await select<SearchProvider>({
    message: "Smarter search? (optional)",
    default: defaultProvider,
    choices: [
      {
        value: "keyword",
        name: "Keyword search — free, no API key (recommended for now)",
        description:
          "Works great for solo use and small note sets. No external service\ninvolved. You can turn on semantic search later with `krimto search`.",
      },
      {
        value: "openai",
        name: "Semantic search — OpenAI",
        description:
          "Needs an OpenAI API key — the same key you'd use for GPT.\nBetter recall when the words you search for don't match the words\nyour AI wrote.",
      },
    ],
  });
  if (provider === "keyword") return { provider: "keyword" };

  // OpenAI: collect + verify the key before persisting.
  const apiKey = await password({
    message: "OpenAI API key (input hidden):",
    mask: "*",
    validate: (v) => (v.trim().length > 0 ? true : "An API key is required"),
  });

  io.out("\nVerifying key with one test embedding...\n");
  const verify = await runSetupEmbeddings({
    KRIMTO_EMBED_PROVIDER: "openai",
    KRIMTO_EMBED_API_KEY: apiKey,
  });
  if (verify.status !== "ok") {
    io.err(verify.message);
    io.out("\nFalling back to keyword search. You can retry later with `krimto setup-embeddings`.\n");
    return { provider: "keyword" };
  }
  io.out("✓ Key verified.\n");
  return { provider: "openai", apiKey };
}

// === Pretty printing ========================================================

function printScan(envs: EditorEnvironment[], io: WizardIO): void {
  io.out("  Scanning your machine ...\n\n");
  for (const env of envs) {
    // v0.2.21: three states — project-level, machine-level only, not found.
    const dot = env.present ? "✓" : env.installed ? "~" : "–";
    const note = env.present
      ? "detected (in this project)"
      : env.installed
        ? "installed (machine-wide)"
        : "not found";
    io.out(`    ${dot} ${EDITOR_LABEL[env.editor].padEnd(14)} ${note}\n`);
  }
  io.out("\n");
}

function printSummary(answers: WizardAnswers, io: WizardIO): void {
  io.out("\nReady to set up Krimto:\n\n");
  io.out(
    `  Editors connected:    ${answers.selectedEditors.map((e) => EDITOR_LABEL[e]).join(" · ") || "(none)"}\n`,
  );
  io.out(`  Run mode:             ${runModeLabel(answers.runMode)}\n`);
  io.out(`  Mode:                 ${answers.whoFor === "just-me" ? "Just me (no auth)" : "Team"}\n`);
  io.out(`  Search:               ${searchLabel(answers.search.provider)}\n`);
  io.out(`  Identity:             ${answers.identity}\n`);
  io.out("\n");
}

function printApplyResult(res: ApplyResult, io: WizardIO): void {
  for (const o of res.editorOutcomes) {
    const label = EDITOR_LABEL[o.editor];
    if (o.mcpAction === "manual") {
      io.out(`  ! ${label}: manual MCP wiring required (snippet shown at end)\n`);
    } else if (o.mcpAction === "no-change") {
      io.out(`  ✓ ${label}: already configured\n`);
    } else {
      io.out(`  ✓ ${label}: MCP config + standing rule applied\n`);
    }
  }
  if (res.serviceInstall) {
    if (!res.serviceInstall.activated) {
      io.out(`  ✓ Background service configured (${res.serviceInstall.platform}; dry-run)\n`);
    } else if (res.serviceInstall.portReady === false) {
      // v0.2.27 — install succeeded but the HTTP port didn't come up within the probe
      // window. Editors that auto-reconnect on MCP-config change will hit ECONNREFUSED.
      // Surface the warning + pointer to the log file instead of giving false confidence.
      io.out(
        `  ⚠ Background service installed (${res.serviceInstall.platform}) but the HTTP port\n` +
          `    didn't come up within 10s. Check /tmp/com.krimto.server.err.log for boot errors.\n` +
          `    Editors may fail to connect until the server binds the port.\n`,
      );
    } else {
      // portReady === true OR undefined (no HTTP port configured — stdio-only install).
      const readinessNote = res.serviceInstall.portReady === true ? " · port accepting connections" : "";
      io.out(`  ✓ Background service installed and started (${res.serviceInstall.platform})${readinessNote}\n`);
    }
  }
  if (res.embeddingsConfigured) io.out("  ✓ Semantic search enabled (OpenAI)\n");
  // Tell the user where their data will live. The folder itself is created lazily on first save,
  // so the phrasing is "will live at" rather than "initialized" — accurate without being misleading.
  io.out(`  ✓ Notes will live at ${res.dataDir}\n`);

  io.out("\n✅ All set. Your AI's memory is on.\n\n");
  io.out("━━ Try it now ━━\n\n");
  io.out("  In any chat, say:\n");
  io.out(`     "Remember that staging resets every Sunday at midnight."\n\n`);
  io.out("  Then open a new chat and ask:\n");
  io.out(`     "What do you know about staging?"\n\n`);
  io.out("━━ When you want to look at your notes ━━\n\n");
  io.out("  $ krimto notes         List all notes\n");
  io.out("  $ krimto status        Is everything working?\n");
  io.out("  $ krimto ui            Open the dashboard in your browser\n\n");
  io.out("━━ When you want teammates in ━━\n\n");
  io.out("  $ krimto team init     Walks you through team mode\n\n");

  for (const o of res.editorOutcomes) {
    if (o.manualSnippet && o.mcpAction === "manual") {
      io.out(`Manual snippet for ${EDITOR_LABEL[o.editor]} (paste into the editor's MCP config):\n`);
      io.out(o.manualSnippet + "\n\n");
    }
  }

  io.out(
    "Restart your editor once so it loads the new MCP server (the krimto_*\n" +
      "tools won't appear in chat until you do) and picks up the standing rule.\n",
  );
}

function printRefreshSummary(res: ApplyResult, io: WizardIO): void {
  const wrote = res.editorOutcomes.filter((o) => o.ruleWritten).map((o) => o.rulePath);
  if (wrote.length === 0) {
    io.out("\n✅ Rule already up to date in this project — nothing changed.\n");
  } else {
    io.out("\n✅ Standing rule refreshed in this project:\n");
    for (const p of wrote) io.out(`  ${p}\n`);
  }
  io.out("\nRestart your editor so it picks up the change.\n");
}

function runModeLabel(m: RunMode): string {
  switch (m) {
    case "as-needed":
      return "As needed (editor launches it)";
    case "always-running":
      return "Always running (background service)";
    case "manual":
      return "Manual (`krimto serve`)";
  }
}

function searchLabel(p: SearchProvider): string {
  return p === "openai" ? "Semantic (OpenAI)" : "Keyword (no API key)";
}

// === Non-interactive entry point (--yes flag) ==============================

export interface NonInteractiveOptions extends ApplyOptions {
  editors?: EditorKind[];
  runMode?: RunMode;
  search?: SearchProvider;
}

/**
 * Skip the prompts entirely and apply with sensible defaults. Used by CI and the `--yes` flag.
 * Defaults: all detected editors, "just-me", keyword search.
 *
 * Run mode is "as-needed" for a single editor, "always-running" when 2+ editors are selected —
 * mirrors the interactive wizard's smart default (v0.2.20). The stdio + lock combination only
 * supports one editor at a time, so multi-editor `--yes` users should land on the HTTP-backed
 * always-running mode by default. Tests that want the old behavior pass `runMode: "as-needed"`
 * explicitly; CI runs that don't want a real service install pass `dryRun: true`.
 */
export async function runInitNonInteractive(
  cwd: string,
  opts: NonInteractiveOptions = {},
): Promise<ApplyResult> {
  const envs = await detectEditorEnvironments(cwd, opts.homeDir);
  // v0.2.21: count both project-level (`present`) AND machine-level (`installed`) signals so
  // the --yes path matches the interactive wizard's preselect logic.
  const detected = envs.filter((e) => e.present || e.installed).map((e) => e.editor);
  const editors = opts.editors ?? (detected.length > 0 ? detected : envs.map((e) => e.editor));
  const runMode = opts.runMode ?? (editors.length >= 2 ? "always-running" : "as-needed");
  const search = opts.search ?? "keyword";
  const identity = await defaultIdentity();
  const answers: WizardAnswers = {
    selectedEditors: editors,
    runMode,
    whoFor: "just-me",
    search: search === "openai"
      ? { provider: "openai", apiKey: process.env.OPENAI_API_KEY ?? "" }
      : { provider: "keyword" },
    identity,
  };
  return applyWizardAnswers(cwd, answers, opts);
}
