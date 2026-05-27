// `krimto search` — change the search provider after initial setup. Re-runs the search question
// from Phase A and applies the new KRIMTO_EMBED_* env block across every currently-connected
// editor's MCP config. Keyword → OpenAI flips on semantic search; OpenAI → Keyword strips the
// env vars.
//
// Doesn't re-issue the MCP config from scratch — just merges the env block into each existing
// editor entry, preserving everything else (transport, url, command, args, headers).

import { password, select } from "@inquirer/prompts";
import { promises as fs } from "node:fs";

import {
  detectEditorEnvironments,
  detectExistingSetup,
  type SearchProvider,
} from "./init";
import { assertInteractiveOrUsage, defaultIO, isExitPrompt, type WizardIO } from "./promptHelpers";
import { runSetupEmbeddings } from "./setupEmbeddings";

export interface SearchOptions {
  io?: WizardIO;
  cwd?: string;
  homeDir?: string;
  /** Skip the prompt; pass the desired provider directly. */
  provider?: SearchProvider;
  /** When provider === "openai", the API key. Tests inject this; production prompts. */
  apiKey?: string;
  /** Override runSetupEmbeddings (tests use this to skip the real OpenAI request). */
  verify?: (env: NodeJS.ProcessEnv) => Promise<{ status: string }>;
}

export interface SearchResult {
  newProvider: SearchProvider;
  /** Number of editor configs that had their env block updated. */
  updatedEditors: number;
}

export async function applySearch(
  provider: SearchProvider,
  apiKey: string | undefined,
  opts: SearchOptions = {},
): Promise<SearchResult> {
  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.homeDir;
  const snapshot = await detectExistingSetup(cwd, homeDir);
  const envs = await detectEditorEnvironments(cwd, homeDir);

  let updatedEditors = 0;
  for (const env of envs) {
    if (!snapshot.registeredEditors.includes(env.editor)) continue;
    if (env.mcpWire?.method !== "json") continue; // only JSON-method editors can be patched in-place
    const text = await fs.readFile(env.mcpWire.path, "utf8").catch(() => null);
    if (text === null) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    const servers = parsed[env.mcpWire.key] as Record<string, unknown> | undefined;
    const krimto = servers?.krimto as Record<string, unknown> | undefined;
    if (!krimto) continue;
    // Only patch stdio entries (HTTP entries don't carry env — identity flows via the bearer).
    if (typeof krimto.command !== "string") continue;
    const existingEnv =
      typeof krimto.env === "object" && krimto.env !== null
        ? ({ ...(krimto.env as Record<string, unknown>) } as Record<string, string>)
        : {};
    if (provider === "openai") {
      existingEnv.KRIMTO_EMBED_PROVIDER = "openai";
      if (apiKey) existingEnv.KRIMTO_EMBED_API_KEY = apiKey;
    } else {
      delete existingEnv.KRIMTO_EMBED_PROVIDER;
      delete existingEnv.KRIMTO_EMBED_API_KEY;
    }
    krimto.env = existingEnv;
    await fs.writeFile(env.mcpWire.path, JSON.stringify(parsed, null, 2) + "\n", "utf8");
    updatedEditors++;
  }

  return { newProvider: provider, updatedEditors };
}

export async function runSearchSettings(opts: SearchOptions = {}): Promise<SearchResult | null> {
  const io = opts.io ?? defaultIO;
  // v0.2.34 — when no provider was supplied programmatically we'd open a select prompt.
  // Without a TTY (AI agent / CI) that prompt hangs. Surface the flag form instead.
  if (!opts.provider) {
    assertInteractiveOrUsage(SEARCH_USAGE);
  }
  try {
    const snapshot = await detectExistingSetup(opts.cwd ?? process.cwd(), opts.homeDir);
    io.out("\nKrimto — Search settings\n\n");
    io.out(`  Current: ${snapshot.searchProvider === "openai" ? "Semantic (OpenAI)" : "Keyword (no API key)"}\n\n`);

    const provider =
      opts.provider ??
      (await select<SearchProvider>({
        message: "Smarter search?",
        default: snapshot.searchProvider,
        choices: [
          {
            value: "keyword",
            name: "Keyword search — free, no API key",
            description: "Works great for solo use and small note sets. No external service.",
          },
          {
            value: "openai",
            name: "Semantic search — OpenAI",
            description:
              "Needs an OpenAI API key — the same key you'd use for GPT.\nBetter recall when search words don't match the wrote-it words.",
          },
        ],
      }));

    let apiKey = opts.apiKey;
    if (provider === "openai" && !apiKey) {
      apiKey = await password({
        message: "OpenAI API key (input hidden):",
        mask: "*",
        validate: (v) => (v.trim().length > 0 ? true : "An API key is required"),
      });
      io.out("\nVerifying key with one test embedding...\n");
      const verify = opts.verify ?? runSetupEmbeddings;
      const result = await verify({ KRIMTO_EMBED_PROVIDER: "openai", KRIMTO_EMBED_API_KEY: apiKey });
      if (result.status !== "ok") {
        io.err(
          `\n🔴 Key verification failed (${result.status}). Aborting — no editor configs changed.\n`,
        );
        return null;
      }
      io.out("✓ Key verified.\n");
    }

    const result = await applySearch(provider, apiKey, opts);
    io.out(
      `\n✅ Search provider set to ${provider === "openai" ? "OpenAI" : "Keyword"}.\n` +
        `   Updated ${result.updatedEditors} editor config${
          result.updatedEditors === 1 ? "" : "s"
        }.\n` +
        `\nRestart your editor(s) so they pick up the new env.\n`,
    );
    return result;
  } catch (e) {
    if (isExitPrompt(e)) {
      io.err("\nAborted.\n");
      process.exitCode = 130;
      return null;
    }
    throw e;
  }
}

/** Non-interactive usage shown by the v0.2.34 TTY guard. */
const SEARCH_USAGE =
  "For non-interactive use (AI agents / CI):\n" +
  "  krimto search --keyword                       Use keyword search (default, free)\n" +
  "  krimto search --openai --api-key sk-...       Use OpenAI semantic search (key verified)";

