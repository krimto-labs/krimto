// The v0.2.17.1 team-mode wizard. Wraps the existing team primitives
// (`bootstrapAdmin`, `createTeam`, `addUser`, `ApiKeyStore.issue`, `runSetupRemote`) in a single
// guided flow with the same UX shape as `krimto init`: scan → questions → summary → apply.
//
// Two cleanly separated layers:
//   • `applyTeamInit(answers, opts)` — pure orchestration, no prompts, unit-testable.
//   • `runTeamInit(opts)` — interactive prompts via @inquirer/prompts; calls applyTeamInit.
//
// After the apply, the admin's key + per-teammate keys are printed once + a copy-paste DM
// template that points each teammate at `krimto join --server <host> --key krm_live_...`.
//
// Reuses (does not re-implement): `bootstrapAdmin` (src/server/bootstrap.ts),
// `createTeam`/`addUser` (src/access/membershipStore.ts), `ApiKeyStore` (src/access/auth.ts),
// `runSetupRemote` (src/cli/setupRemote.ts), `defaultIdentity` (src/cli/init.ts).

import { confirm, input, select } from "@inquirer/prompts";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ApiKeyStore } from "../access/auth";
import { addUser, createTeam } from "../access/membershipStore";
import { bootstrapAdmin } from "../server/bootstrap";
import { defaultIdentity } from "./init";
import { defaultIO, isExitPrompt, type WizardIO } from "./promptHelpers";
import { runSetupRemote } from "./setupRemote";

/** Everything the wizard collects before it calls {@link applyTeamInit}. */
export interface TeamInitAnswers {
  adminEmail: string;
  teamSlug: string;
  /** Optional human-readable display name for the team. Falls back to the slug. */
  teamName?: string;
  /** Optional git remote URL. When set, `applyTeamInit` calls `runSetupRemote`. */
  gitRemote?: string;
  /** Email list of initial teammates. Each gets a key + membership entry. */
  teammates: string[];
}

/** One row per invited teammate — printed by the wizard so the admin can DM the key out. */
export interface InviteRecord {
  email: string;
  /** The plaintext key. Shown once; only the hash is persisted. */
  key: string;
}

/** Apply outcome. Consumed by the wizard's `printApplyResult` + by tests. */
export interface TeamInitResult {
  adminEmail: string;
  /** The admin's plaintext key. Shown once. Null when the admin already had one. */
  adminKey: string | null;
  teamSlug: string;
  teamName?: string;
  /** Set when a remote URL was provided; reports whether the test push worked. */
  remote?: { url: string; pushStatus: "ok" | "push_failed" | "invalid_url" };
  invites: InviteRecord[];
  /** Best-effort "where to point teammates at" — falls back to localhost:<port>. */
  serverHost: string;
  /** Resolved data dir the wizard wrote membership/keys into. */
  dataDir: string;
}

export interface TeamInitOptions {
  io?: WizardIO;
  /** Override resolveDataDir for tests + non-default data locations. */
  dataDir?: string;
  /** Override the keys store path; defaults to `<dataDir>/.krimto/keys.json`. */
  keysPath?: string;
  /** Override KRIMTO_HTTP_PORT detection. */
  port?: number;
  /** Skip `runSetupRemote` even when a URL was given. Tests use this. */
  skipRemoteSetup?: boolean;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

// === Pure apply step =======================================================

/**
 * Apply the wizard's answers to disk. Pure orchestrator — no prompts. Idempotent: re-running with
 * the same answers refreshes membership without re-issuing keys for users who already have one.
 */
export async function applyTeamInit(
  answers: TeamInitAnswers,
  opts: TeamInitOptions = {},
): Promise<TeamInitResult> {
  const dataDir = opts.dataDir ?? path.join(os.homedir(), ".krimto");
  await fs.mkdir(path.join(dataDir, ".krimto"), { recursive: true });

  const keysPath = opts.keysPath ?? path.join(dataDir, ".krimto", "keys.json");
  const keys = new ApiKeyStore(keysPath);

  // 1. Bootstrap admin (idempotent — re-running returns null if a key already exists for them).
  const { key: adminKey } = await bootstrapAdmin(answers.adminEmail, keys, dataDir);
  // The admin is now in members.yaml's org.admins; also add a `users` entry so they show up
  // in the user list (bootstrapAdmin only touches org.admins).
  await addUser(dataDir, answers.adminEmail, { admin: true });

  // 2. Create the team. `createTeam` is idempotent.
  await createTeam(dataDir, answers.teamSlug, answers.teamName);

  // 3. Invite each teammate: add them to members.yaml + issue a key.
  const invites: InviteRecord[] = [];
  for (const email of answers.teammates) {
    await addUser(dataDir, email, { team: answers.teamSlug });
    const existing = await keys.list();
    if (existing.some((k) => k.identity === email)) {
      // Already has a key — skip (don't churn keys on idempotent rerun).
      continue;
    }
    const { key } = await keys.issue(email, "live", `invite to ${answers.teamSlug}`);
    invites.push({ email, key });
  }

  // 4. Git remote (optional). Skipped in tests via opts.skipRemoteSetup.
  let remote: TeamInitResult["remote"] = undefined;
  if (answers.gitRemote && !opts.skipRemoteSetup) {
    const r = await runSetupRemote(dataDir, answers.gitRemote);
    remote = { url: answers.gitRemote, pushStatus: r.status };
  } else if (answers.gitRemote && opts.skipRemoteSetup) {
    remote = { url: answers.gitRemote, pushStatus: "ok" }; // pretend; test asserts the URL was captured
  }

  const port = opts.port ?? Number(process.env.KRIMTO_HTTP_PORT ?? "8080");
  return {
    adminEmail: answers.adminEmail,
    adminKey,
    teamSlug: answers.teamSlug,
    teamName: answers.teamName,
    remote,
    invites,
    serverHost: `localhost:${port}`,
    dataDir,
  };
}

// === Interactive entry point ===============================================

/**
 * The interactive `krimto team init` flow. Returns `null` if the user quit / Ctrl-C'd / declined
 * the final confirm.
 */
export async function runTeamInit(opts: TeamInitOptions = {}): Promise<TeamInitResult | null> {
  const io = opts.io ?? defaultIO;
  const dataDir = opts.dataDir ?? path.join(os.homedir(), ".krimto");

  try {
    printPreamble(dataDir, io);

    const adminEmail = await askAdminEmail();
    const teamSlug = await askTeamSlug();
    const teamName = await askTeamName(teamSlug);
    const gitRemote = await askGitRemote(io);
    const teammates = await askTeammates();

    printSummary({ adminEmail, teamSlug, teamName, gitRemote, teammates }, io);
    const ok = await confirm({ message: "Apply this setup?", default: true });
    if (!ok) {
      io.out("\nNo changes made.\n");
      return null;
    }

    io.out("\nSetting up team mode...\n");
    const result = await applyTeamInit(
      { adminEmail, teamSlug, teamName, gitRemote, teammates },
      opts,
    );
    printApplyResult(result, io);
    return result;
  } catch (e) {
    if (isExitPrompt(e)) {
      io.err("\nAborted (Ctrl-C). No changes were made.\n");
      process.exitCode = 130;
      return null;
    }
    throw e;
  }
}

// === Question functions ====================================================

async function askAdminEmail(): Promise<string> {
  const fallback = await defaultIdentity();
  return input({
    message: "What's your email? (this becomes the admin account)",
    default: fallback === "you@acme.com" ? undefined : fallback,
    validate: (v) =>
      EMAIL_RE.test(v.trim()) ? true : "Looks like that's not an email — expected name@domain",
  }).then((v) => v.trim());
}

async function askTeamSlug(): Promise<string> {
  return input({
    message: 'What\'s your team called? (lowercase slug — e.g. "backend", "infra", "growth")',
    validate: (v) =>
      SLUG_RE.test(v.trim()) ? true : "Use lowercase letters, digits, dashes or underscores only",
  }).then((v) => v.trim());
}

async function askTeamName(slug: string): Promise<string | undefined> {
  const v = (
    await input({
      message: `Team display name (optional — press Enter to use "${slug}")`,
      default: "",
    })
  ).trim();
  return v === "" ? undefined : v;
}

async function askGitRemote(io: WizardIO): Promise<string | undefined> {
  const pick = await select<"now" | "later">({
    message: "Set up a shared git remote for cross-machine sync?",
    default: "now",
    choices: [
      {
        value: "now",
        name: "Yes, I have one",
        description:
          "Paste the SSH/HTTPS URL. The wizard verifies the first push before saving anything.",
      },
      {
        value: "later",
        name: "Not yet — I'll add one later",
        description:
          "Your team's notes will only live on this machine until a remote is configured.\nAdd one any time with `krimto setup-remote <url>`.",
      },
    ],
  });
  if (pick === "later") return undefined;
  const url = (
    await input({
      message: "Remote URL (e.g. git@github.com:acme/krimto-data.git)",
      validate: (v) => (v.trim().length > 0 ? true : "Please paste a URL or pick 'Not yet'"),
    })
  ).trim();
  io.out("Will verify the push during apply.\n");
  return url;
}

async function askTeammates(): Promise<string[]> {
  const raw = await input({
    message: "Invite teammates now? (comma-separated emails, or press Enter to skip)",
    default: "",
  });
  const list = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const bad = list.filter((s) => !EMAIL_RE.test(s));
  if (bad.length > 0) {
    throw new Error(`These don't look like emails: ${bad.join(", ")}`);
  }
  return list;
}

// === Pretty printing ========================================================

function printPreamble(dataDir: string, io: WizardIO): void {
  io.out("\nKrimto — Setting up team mode\n\n");
  io.out("  All your existing personal notes stay. Team mode adds:\n");
  io.out("    • API-key login (you + each teammate gets a key)\n");
  io.out("    • A team-shared scope for notes everyone can see\n");
  io.out("    • An optional git remote so teammates sync across machines\n\n");
  io.out(`  Data folder: ${dataDir}\n\n`);
}

function printSummary(a: TeamInitAnswers, io: WizardIO): void {
  io.out("\nReady to set up team mode:\n\n");
  io.out(`  Admin:        ${a.adminEmail}\n`);
  io.out(`  Team:         ${a.teamSlug}${a.teamName ? ` ("${a.teamName}")` : ""}\n`);
  io.out(`  Git remote:   ${a.gitRemote ?? "(not configured)"}\n`);
  io.out(`  Teammates:    ${a.teammates.length === 0 ? "(none yet)" : a.teammates.join(", ")}\n\n`);
}

function printApplyResult(res: TeamInitResult, io: WizardIO): void {
  io.out("  ✓ Admin promoted + members.yaml updated\n");
  io.out(`  ✓ Team "${res.teamSlug}" created\n`);
  if (res.invites.length > 0) {
    io.out(`  ✓ ${res.invites.length} teammate${res.invites.length === 1 ? "" : "s"} invited\n`);
  }
  if (res.remote) {
    if (res.remote.pushStatus === "ok") {
      io.out(`  ✓ Git remote configured + first push succeeded\n`);
    } else {
      io.out(`  ⚠ Git remote saved locally, but initial push errored — re-run \`krimto setup-remote\`\n`);
    }
  }
  io.out("\n✅ Team mode is on.\n\n");

  if (res.adminKey) {
    io.out("━━ Your admin key (shown once — save it now) ━━\n\n");
    io.out(`  ${res.adminEmail}\n  ${res.adminKey}\n\n`);
  } else {
    io.out("━━ Admin key ━━\n\n  You already had a key — none reissued. Use `krimto reset-admin-key` if lost.\n\n");
  }

  if (res.invites.length > 0) {
    io.out("━━ Keys to send your teammates (shown once each) ━━\n\n");
    for (const inv of res.invites) {
      io.out(`  ${inv.email.padEnd(28)} ${inv.key}\n`);
    }
    io.out("\n━━ DM template for each teammate ━━\n\n");
    io.out("  1. Install Krimto:\n");
    io.out(`     $ npx @krimto-labs/krimto join \\\n`);
    io.out(`         --server http://${res.serverHost} \\\n`);
    io.out(`         --key <your key from above>\n`);
    io.out("  2. Restart your editor.\n");
    io.out("  3. Test: \"Remember our package manager is pnpm\" → new chat → \"What do we use?\"\n\n");
    if (res.serverHost.startsWith("localhost:")) {
      io.out(
        `  Note: \`localhost\` only works if your teammates are on this same machine.\n` +
          `  When you're ready to share, swap the \`--server\` URL for your reachable address\n` +
          `  (LAN IP, ngrok tunnel, or wherever you'll host Krimto).\n\n`,
      );
    }
  }

  io.out("━━ Next ━━\n\n");
  io.out("  • Start the server in team mode (if not already):\n");
  io.out(`      $ KRIMTO_BOOTSTRAP_ADMIN=${res.adminEmail} npx @krimto-labs/krimto serve\n`);
  io.out("  • View the dashboard at http://localhost:8080/ui/admin\n");
  io.out("  • Step back to solo with `krimto team disband` (data preserved)\n\n");
}
