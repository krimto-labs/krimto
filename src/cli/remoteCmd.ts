// `krimto remote` — friendlier wrapper around `setup-remote` (v0.2.31). A single-question
// wizard with three options: show current / set new URL / remove the remote. Reuses
// `runSetupRemote` for the set path so the validation + first-push verification stays in
// one place. The Maria-journey doc §06 names this as one of the "direct shortcuts for power
// users" verbs.

import { confirm, input, select } from "@inquirer/prompts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { readDataDirGitInfo } from "../storage/git";
import { runSetupRemote, type SetupRemoteResult } from "./setupRemote";
import { assertInteractiveOrUsage, defaultIO, isExitPrompt, type WizardIO } from "./promptHelpers";

const exec = promisify(execFile);

export type RemoteAction = "show" | "set" | "remove";

export interface RemoteCmdOptions {
  io?: WizardIO;
  dataDir: string;
  /** Skip the action prompt — used by `--show` / `--set <url>` / `--remove` and by tests. */
  action?: RemoteAction;
  /** When `action === "set"`, the URL to use. Otherwise prompted for. */
  url?: string;
  /** Skip the confirm() on remove. */
  yes?: boolean;
}

export interface RemoteCmdResult {
  action: RemoteAction;
  /** The URL we ended up with (post-set / pre-remove), or null when none. */
  url: string | null;
  /** Forwarded from `runSetupRemote` when action === "set". */
  setupResult?: SetupRemoteResult;
  message: string;
}

export async function runRemoteCmd(opts: RemoteCmdOptions): Promise<RemoteCmdResult | null> {
  const io = opts.io ?? defaultIO;
  const dataDir = opts.dataDir;

  // v0.2.34 — guard against agents calling `krimto remote` cold. Without an action
  // we open a select prompt; without a TTY that hangs. Surface the flag forms.
  if (!opts.action) {
    assertInteractiveOrUsage(REMOTE_USAGE);
  }

  try {
    const gitInfo = await readDataDirGitInfo(dataDir);
    const current = gitInfo.remote;

    io.out("\nKrimto — Git remote (cross-machine sync)\n\n");
    io.out(`  Current: ${current ?? "(none)"}\n\n`);

    const action: RemoteAction =
      opts.action ??
      (await select<RemoteAction>({
        message: "What would you like to do?",
        default: current ? "show" : "set",
        choices: [
          {
            value: "show",
            name: current ? "Show current remote" : "Show current (none)",
            description: current
              ? `Print the current remote URL and exit. Currently: ${current}`
              : "There's no remote configured right now.",
          },
          {
            value: "set",
            name: current ? "Change the remote URL" : "Set a remote URL",
            description:
              "Wire (or rewire) the data dir's git repo to a remote. Krimto will auto-push every batched commit; set KRIMTO_GIT_REMOTE in the env to also auto-pull.",
          },
          {
            value: "remove",
            name: "Remove the remote",
            description: "Unwire `origin`. Existing commits stay on this machine; new ones won't push anywhere.",
          },
        ],
      }));

    if (action === "show") {
      return {
        action,
        url: current,
        message: current
          ? `\n  ${current}\n\n  Krimto auto-pushes here on every batched commit.\n  To also auto-pull (every 60s on next boot):\n    $ export KRIMTO_GIT_REMOTE=${current}\n\n`
          : `\n  (no remote configured)\n\n  To wire one up: re-run \`krimto remote\` and pick "Set".\n\n`,
      };
    }

    if (action === "set") {
      const url =
        opts.url ??
        (await input({
          message: "Remote URL:",
          default: current ?? undefined,
          validate: (v) => (v.trim().length > 0 ? true : "URL is required"),
        }));
      io.out(`\nVerifying push to ${url} ...\n`);
      const setupResult = await runSetupRemote(dataDir, url);
      return { action, url, setupResult, message: setupResult.message + "\n" };
    }

    // action === "remove"
    if (!current) {
      return {
        action,
        url: null,
        message: "\n  Nothing to remove — no remote is configured.\n\n",
      };
    }
    if (!opts.yes) {
      const ok = await confirm({
        message: `Remove remote "${current}"?`,
        default: false,
      });
      if (!ok) {
        return { action, url: current, message: "\n  Aborted. Remote unchanged.\n\n" };
      }
    }
    try {
      await exec("git", ["-C", dataDir, "remote", "remove", "origin"]);
    } catch (e) {
      return {
        action,
        url: current,
        message: `\n  ⚠️  git remote remove failed: ${e instanceof Error ? e.message : String(e)}\n\n`,
      };
    }
    return {
      action,
      url: null,
      message: `\n✅ Removed remote "${current}".\n  Existing commits stay on this machine; new commits won't push.\n\n`,
    };
  } catch (e) {
    if (isExitPrompt(e)) {
      io.err("\nAborted.\n");
      process.exitCode = 130;
      return null;
    }
    throw e;
  }
}

/** v0.2.34 — non-interactive usage shown by the TTY guard. */
const REMOTE_USAGE =
  "For non-interactive use (AI agents / CI):\n" +
  "  krimto remote --show                          Print the current remote URL\n" +
  "  krimto remote --set git@host:repo.git         Wire a remote (verifies the first push)\n" +
  "  krimto remote --remove --yes                  Unwire the remote";
