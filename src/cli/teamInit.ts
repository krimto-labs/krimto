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
import { loadMembership } from "../access/membership";
import { addUser, createTeam, setOrg, setTeamMember } from "../access/membershipStore";
import { parseScope } from "../access/scope";
import { bootstrapAdmin } from "../server/bootstrap";
import { slugifyTitle } from "../storage/fact";
import { FactStore } from "../storage/store";
import { defaultIdentity } from "./init";
import { applyJoin } from "./join";
import { defaultIO, isExitPrompt, type WizardIO } from "./promptHelpers";
import { looksLikeRemoteUrl, runSetupRemote } from "./setupRemote";

/** Everything the wizard collects before it calls {@link applyTeamInit}. */
export interface TeamInitAnswers {
  adminEmail: string;
  /** Optional human-readable organization name. Sets `org.name` + derives `org.slug` (replacing the
   *  `default` placeholder) so company-wide notes read as "Acme Inc" instead of `org/default`. */
  orgName?: string;
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
  /** The org's display name, when set. */
  orgName?: string;
  /** The org's resolved slug (the `org/<slug>` path) — `"default"` until the org is named. */
  orgSlug: string;
  teamSlug: string;
  teamName?: string;
  /** Set when a remote URL was provided; reports whether the test push worked. */
  remote?: { url: string; pushStatus: "ok" | "push_failed" | "invalid_url" };
  invites: InviteRecord[];
  /** Best-effort "where to point teammates at" — falls back to localhost:<port>. */
  serverHost: string;
  /** Resolved data dir the wizard wrote membership/keys into. */
  dataDir: string;
  /**
   * Path to the 0600-mode invite file written at apply time, when any keys were minted.
   * Unset when there was nothing new to save (idempotent rerun where admin + all teammates
   * already had keys). Admin's key is shown-once-only — losing it from scrollback used to
   * require `reset-admin-key`; the file is the recoverable backup.
   */
  inviteFilePath?: string;
}

export interface TeamInitOptions {
  io?: WizardIO;
  /** Override resolveDataDir for tests + non-default data locations. */
  dataDir?: string;
  /** Override the keys store path; defaults to `<dataDir>/.krimto/keys.json`. */
  keysPath?: string;
  /** Override KRIMTO_HTTP_PORT detection. */
  port?: number;
  /** Override os.homedir() — forwarded to the admin-reconnect `applyJoin` for editor detection. */
  homeDir?: string;
  /** When true, the admin-reconnect `applyJoin` writes nothing to real editor configs. Tests use this. */
  dryRun?: boolean;
  /** Inject the live-team-mode probe (tests). Defaults to the real {@link confirmTeamModeLive}
   * which polls the running server's /mcp for a 401. */
  confirmLive?: (host: string) => Promise<LiveOutcome>;
  /** Skip `runSetupRemote` even when a URL was given. Tests use this. */
  skipRemoteSetup?: boolean;
}

/**
 * Result of verifying that the running server is ACTUALLY enforcing team mode (not just that a
 * port is open). The old wizard printed "🟢 live" off a TCP probe and lied; this is the honest signal.
 *   - "live"      — the server returned 401 on /mcp ⇒ bearer required ⇒ team mode enforced.
 *   - "no-server" — nothing reachable at the host (start one with `krimto serve`).
 *   - "timeout"   — a server responded but never 401 within the window (it polls members.yaml ~2s).
 */
export type LiveOutcome = "live" | "no-server" | "timeout";

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
export const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

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
  // The creator is a working member of the team they just made — add them so they can read/write
  // team notes immediately. Without this they're an org-admin who isn't a team member: canWrite is
  // true but canRead is false, so krimtoWrite's ghost-fact guard refuses ("you would not be able to
  // read it back"). Done AFTER createTeam so the team's display name is preserved. Idempotent.
  await setTeamMember(dataDir, answers.teamSlug, answers.adminEmail, true);

  // 2b. Name the organization, replacing the meaningless `org/default` placeholder. We derive a
  // path-safe slug from the name the user typed (NOT a guess from git/email). The slug is the
  // folder for company-wide notes, so we only adopt a new slug when the current org scope has no
  // notes yet — otherwise we'd orphan them; in that case we update the display name only.
  if (answers.orgName) {
    const current = await loadMembership(dataDir);
    const desiredSlug = slugifyTitle(answers.orgName);
    const orgHasNotes = (await new FactStore(dataDir).listScopes()).some(
      (s) => s.path === `org/${current.org.slug}` && s.factCount > 0,
    );
    if (SLUG_RE.test(desiredSlug) && !orgHasNotes) {
      await setOrg(dataDir, { name: answers.orgName, slug: desiredSlug });
    } else {
      await setOrg(dataDir, { name: answers.orgName });
    }
  }

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
  const serverHost = `localhost:${port}`;

  // 5. Save plaintext keys + DM template to a 0600 file. Admin's key is shown-once-only;
  // teammates' keys are shown-once-each. Without this file the only recovery is
  // `reset-admin-key` (admin) or re-issuing each invite (teammates) — both unnecessary churn.
  let inviteFilePath: string | undefined;
  if (adminKey || invites.length > 0) {
    inviteFilePath = await writeInviteFile({
      dataDir,
      adminEmail: answers.adminEmail,
      adminKey,
      teamSlug: answers.teamSlug,
      teamName: answers.teamName,
      invites,
      serverHost,
    });
  }

  // Read back the final org identity so callers can display the name + resolved slug.
  const finalOrg = (await loadMembership(dataDir)).org;

  return {
    adminEmail: answers.adminEmail,
    adminKey,
    ...(finalOrg.name ? { orgName: finalOrg.name } : {}),
    orgSlug: finalOrg.slug,
    teamSlug: answers.teamSlug,
    teamName: answers.teamName,
    remote,
    invites,
    serverHost,
    dataDir,
    ...(inviteFilePath ? { inviteFilePath } : {}),
  };
}

/**
 * Write the team-invite file to `<dataDir>/.krimto/team-invites-<ISO-timestamp>.txt` with
 * mode 0o600. Filename's timestamp colons are replaced with dashes so the path is portable
 * across filesystems. Returns the absolute path.
 */
async function writeInviteFile(input: {
  dataDir: string;
  adminEmail: string;
  adminKey: string | null;
  teamSlug: string;
  teamName?: string;
  invites: InviteRecord[];
  serverHost: string;
}): Promise<string> {
  const ts = new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
  const file = path.join(input.dataDir, ".krimto", `team-invites-${ts}.txt`);
  const teamLabel = input.teamName ? `${input.teamSlug} ("${input.teamName}")` : input.teamSlug;
  const adminBlock = input.adminKey
    ? `━━ Admin ━━\n  ${input.adminEmail.padEnd(28)} ${input.adminKey}\n\n`
    : `━━ Admin ━━\n  ${input.adminEmail} — existing key kept (no new one minted).\n\n`;
  const inviteBlock =
    input.invites.length > 0
      ? "━━ Teammates (send each their key) ━━\n" +
        input.invites.map((i) => `  ${i.email.padEnd(28)} ${i.key}`).join("\n") +
        "\n\n"
      : "";
  const dmTemplate =
    "━━ DM template (one per teammate) ━━\n" +
    "  1. Install Krimto:\n" +
    `     npx @krimto-labs/krimto join \\\n` +
    `         --server http://${input.serverHost} \\\n` +
    `         --key <your key from above>\n` +
    "  2. Restart your editor.\n" +
    "  3. Test: \"Remember our package manager is pnpm\" → new chat → \"What do we use?\"\n\n" +
    (input.serverHost.startsWith("localhost:")
      ? "  Note: `localhost` only works if your teammates are on this same machine.\n" +
        "  Swap the --server URL for a reachable address before sharing.\n"
      : "");
  const body =
    `Krimto team mode — saved ${new Date().toISOString()}\n` +
    `Team: ${teamLabel}\n\n` +
    adminBlock +
    inviteBlock +
    dmTemplate;
  await fs.writeFile(file, body, { encoding: "utf8", mode: 0o600 });
  return file;
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

    // Detect the identity that already owns notes so we keep it as the admin by default — going
    // solo→team is an UPGRADE of your existing identity, not a fresh second account.
    const notesOwner = await detectNotesOwner(dataDir);
    let adminEmail = await askAdminEmail(notesOwner);

    // Divergence guard: if the chosen admin differs from the identity that owns notes, those notes
    // would be private to the old identity and invisible to the admin. Offer the one-key fix.
    let divergedFrom: NotesOwner | null = null;
    if (notesOwner && notesOwner.email !== adminEmail) {
      const useExisting = await confirm({
        message:
          `You have ${notesOwner.factCount} note${notesOwner.factCount === 1 ? "" : "s"} saved as ` +
          `${notesOwner.email}. Use that as your admin so they come with you? ` +
          `(otherwise they stay private to ${notesOwner.email} and the admin won't see them)`,
        default: true,
      });
      if (useExisting) {
        adminEmail = notesOwner.email;
      } else {
        divergedFrom = notesOwner;
      }
    }

    const orgName = await askOrgName();
    const teamSlug = await askTeamSlug();
    const teamName = await askTeamName(teamSlug);
    const gitRemote = await askGitRemote(io);
    const teammates = await askTeammates();

    printSummary({ adminEmail, orgName, teamSlug, teamName, gitRemote, teammates }, io);
    const ok = await confirm({ message: "Apply this setup?", default: true });
    if (!ok) {
      io.out("\nNo changes made.\n");
      return null;
    }

    io.out("\nSetting up team mode...\n");
    const result = await applyTeamInit(
      { adminEmail, orgName, teamSlug, teamName, gitRemote, teammates },
      opts,
    );
    await finishTeamInit(result, opts, divergedFrom);
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

// === Non-interactive entry point (agent-safe `--yes` form) ==================

/** Flag inputs collected by `bin/krimto.mjs` for `team init --yes ...`. All optional except the
 *  team slug (enforced at runtime) — the rest default the same way the interactive wizard would. */
export interface TeamInitFlags {
  adminEmail?: string;
  orgName?: string;
  teamSlug?: string;
  teamName?: string;
  gitRemote?: string;
  teammates?: string[];
}

/**
 * The agent-safe twin of {@link runTeamInit}: build the answers from flags instead of prompts, then
 * apply. This is what `krimto team init --yes --team <slug> [--admin … --invite a,b]` calls so an AI
 * agent can stand a team up unattended — the same bar solo already has via `krimto init --yes`.
 *
 * Validates with the SAME rules the prompts use ({@link SLUG_RE}, {@link EMAIL_RE},
 * {@link looksLikeRemoteUrl}); throws on the first bad input so the bin's top-level catch prints it.
 * The admin defaults to the identity that already owns notes (solo→team continuity) then git config.
 */
export async function runTeamInitNonInteractive(
  opts: TeamInitOptions & TeamInitFlags,
): Promise<TeamInitResult> {
  const io = opts.io ?? defaultIO;
  const dataDir = opts.dataDir ?? path.join(os.homedir(), ".krimto");

  // Team slug is the one truly required input — there's no sensible default for a team's name.
  const teamSlug = opts.teamSlug?.trim();
  if (!teamSlug) {
    throw new Error("team init --yes requires --team <slug> (e.g. --team backend)");
  }
  if (!SLUG_RE.test(teamSlug)) {
    throw new Error(
      `Invalid team slug "${teamSlug}" — use lowercase letters, digits, dashes or underscores only`,
    );
  }

  // Admin defaults to the notes-owner (keeps the solo user's identity), then git config. An
  // explicit --admin that differs from the notes-owner is honored, but we flag the divergence so
  // those earlier notes aren't silently orphaned (the printed guidance shows how to bring them).
  const notesOwner = await detectNotesOwner(dataDir);
  const explicitAdmin = opts.adminEmail?.trim();
  const adminEmail = explicitAdmin || notesOwner?.email || (await defaultIdentity());
  if (!EMAIL_RE.test(adminEmail)) {
    throw new Error(`Invalid admin email "${adminEmail}" — expected name@domain`);
  }
  const divergedFrom =
    explicitAdmin && notesOwner && notesOwner.email !== adminEmail ? notesOwner : null;

  const teammates = (opts.teammates ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  const badEmails = teammates.filter((e) => !EMAIL_RE.test(e));
  if (badEmails.length > 0) {
    throw new Error(`These don't look like emails: ${badEmails.join(", ")}`);
  }

  const gitRemote = opts.gitRemote?.trim() || undefined;
  if (gitRemote && !looksLikeRemoteUrl(gitRemote)) {
    throw new Error(
      `Invalid git remote "${gitRemote}" — must start with git@, https://, http://, ssh://, file://, or /`,
    );
  }
  const teamName = opts.teamName?.trim() || undefined;
  const orgName = opts.orgName?.trim() || undefined;

  io.out("\nSetting up team mode (non-interactive)...\n");
  const result = await applyTeamInit(
    { adminEmail, orgName, teamSlug, teamName, gitRemote, teammates },
    opts,
  );
  await finishTeamInit(result, opts, divergedFrom);
  return result;
}

/**
 * Shared post-apply tail for BOTH the interactive and non-interactive team-init paths: verify the
 * running server actually flipped to team mode (members.yaml is the switch — no restart), reconnect
 * the admin's own editors when it's confirmed live, and print the result. Extracted so the agent-safe
 * `--yes` path gets identical "is it live?" + reconnect + reporting behavior without duplicating it.
 */
async function finishTeamInit(
  result: TeamInitResult,
  opts: TeamInitOptions,
  divergedFrom: NotesOwner | null,
): Promise<void> {
  const io = opts.io ?? defaultIO;
  // No restart, no env var: writing members.yaml IS the switch. The running server polls the file
  // (~2s) and flips to team mode on its own. We VERIFY it (poll /mcp for a 401) — not a TCP probe.
  const live = await (opts.confirmLive ?? confirmTeamModeLive)(result.serverHost);

  // When team mode is confirmed live, reconnect the admin's OWN editors in team mode (their
  // solo/no-key connection would otherwise start getting 401s). Reuses the teammate join path.
  let reconnected = false;
  if (live === "live" && result.adminKey) {
    try {
      const join = await applyJoin(
        { server: `http://${result.serverHost}`, key: result.adminKey },
        {
          cwd: process.cwd(),
          ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
          ...(opts.dryRun ? { dryRun: opts.dryRun } : {}),
        },
      );
      reconnected = join.editorOutcomes.some((o) => o.mcpAction !== "manual");
    } catch {
      /* best-effort — the admin can run `krimto join` manually if this fails */
    }
  }

  printApplyResult(result, io, { live, reconnected, divergedFrom });
}

// === Question functions ====================================================

/** The identity that already owns notes in this data dir (the solo user's pre-team self). */
export interface NotesOwner {
  email: string;
  factCount: number;
}

/**
 * Detect which identity owns existing notes, so the wizard can keep it as the admin (and not
 * silently split the solo user into two identities whose notes the admin can't read). Scans the
 * `user/<email>` scopes and returns the one with the most notes, or null when there are none.
 */
export async function detectNotesOwner(dataDir: string): Promise<NotesOwner | null> {
  const scopes = await new FactStore(dataDir).listScopes();
  const owners = scopes
    .filter((s) => s.path.startsWith("user/") && s.factCount > 0)
    .map((s) => ({ email: parseScope(s.path)?.id ?? "", factCount: s.factCount }))
    .filter((o) => o.email.length > 0)
    .sort((a, b) => b.factCount - a.factCount);
  return owners[0] ?? null;
}

/** Ask for the admin email, defaulting to the identity that already owns notes (so hitting Enter
 *  keeps the solo user's identity), or git config when there are none. */
async function askAdminEmail(notesOwner: NotesOwner | null): Promise<string> {
  const fallback = notesOwner?.email ?? (await defaultIdentity());
  return input({
    message: "What's your email? (this becomes the admin account)",
    default: fallback === "you@acme.com" ? undefined : fallback,
    validate: (v) =>
      EMAIL_RE.test(v.trim()) ? true : "Looks like that's not an email — expected name@domain",
  }).then((v) => v.trim());
}

/** Ask for the organization's display name (optional). Sets the company-wide scope's identity so
 *  it reads as "Acme Inc" instead of the `org/default` placeholder. Enter skips it. */
async function askOrgName(): Promise<string | undefined> {
  const v = (
    await input({
      message:
        'What\'s your organization called? (e.g. "Acme Inc" — for company-wide notes; Enter to skip)',
      default: "",
    })
  ).trim();
  return v === "" ? undefined : v;
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
      validate: (v) => {
        const t = v.trim();
        if (t.length === 0) return "Please paste a URL or pick 'Not yet'";
        if (!looksLikeRemoteUrl(t)) {
          return "URL must start with git@, https://, http://, ssh://, file://, or / (no bare 'github.com/...')";
        }
        return true;
      },
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

// === Verify team mode is actually live ======================================

/**
 * Poll the running server's `/mcp` until it returns 401 — the precise signal that bearer auth is
 * being enforced (team mode is genuinely ON). Writing members.yaml flips the server within its
 * ~2s membership-watch tick, so we give it a short window. Returns "live" on 401, "no-server"
 * when nothing was ever reachable, "timeout" when a server responded but never 401 in time.
 *
 * This replaces the v0.2.36 restart dance: there's nothing to restart anymore — the file is the
 * switch. We only confirm it took effect (the old code printed "🟢 live" off a TCP probe and lied).
 */
export async function confirmTeamModeLive(host: string, timeoutMs = 8000): Promise<LiveOutcome> {
  const deadline = Date.now() + timeoutMs;
  let reached = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${host}/mcp`, { method: "GET" });
      reached = true;
      if (res.status === 401) return "live";
    } catch {
      /* not reachable yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return reached ? "timeout" : "no-server";
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
  io.out(`  Organization: ${a.orgName ?? "(not named — company-wide notes go to org/default)"}\n`);
  io.out(`  Team:         ${a.teamSlug}${a.teamName ? ` ("${a.teamName}")` : ""}\n`);
  io.out(`  Git remote:   ${a.gitRemote ?? "(not configured)"}\n`);
  io.out(`  Teammates:    ${a.teammates.length === 0 ? "(none yet)" : a.teammates.join(", ")}\n\n`);
}

function printApplyResult(
  res: TeamInitResult,
  io: WizardIO,
  status: { live: LiveOutcome; reconnected: boolean; divergedFrom: NotesOwner | null },
): void {
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
    io.out(`     npx @krimto-labs/krimto join \\\n`);
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

  if (res.inviteFilePath) {
    io.out("━━ Backup ━━\n\n");
    io.out(`  All keys + the DM template are also saved to:\n    ${res.inviteFilePath}\n`);
    io.out(`  (mode 0600 — read by you only. Delete it once teammates have their keys.)\n\n`);
  }

  // The user chose an admin email different from the identity that owns their existing notes, so
  // those notes stay private to the old identity. Tell them exactly how to bring them over.
  if (status.divergedFrom) {
    const d = status.divergedFrom;
    io.out("━━ Heads up: your earlier notes ━━\n\n");
    io.out(`  Your ${d.factCount} note${d.factCount === 1 ? "" : "s"} saved as ${d.email} stay private to\n`);
    io.out(`  ${d.email} — the admin ${res.adminEmail} can't see them. To bring them over:\n`);
    io.out(`    1. krimto stop\n`);
    io.out(`    2. krimto mv <id> user/${res.adminEmail}   (per note — \`krimto notes\` lists ids)\n`);
    io.out(`       …or move them to the team scope so everyone sees them.\n`);
    io.out(`    3. start the server again\n\n`);
  }

  // The "Next" block reflects the VERIFIED state of the running server (members.yaml is the
  // switch — no restart). "🟢 live" is only printed when /mcp actually returned 401.
  io.out("━━ Next ━━\n\n");
  if (status.live === "live") {
    io.out(`  🟢 Team mode is live on http://${res.serverHost}\n`);
    if (status.reconnected) {
      io.out(`  ✓ Reconnected your editor in team mode — restart it once to pick up the key.\n`);
    }
    io.out(`  • View the dashboard at http://${res.serverHost}/ui/admin (sign in with your admin key)\n`);
  } else if (status.live === "timeout") {
    io.out(`  ⏳ A server is running at ${res.serverHost} but team mode hasn't taken effect yet.\n`);
    io.out(`     It re-reads members.yaml every ~2s — give it a moment, then reload /ui/admin.\n`);
  } else {
    // "no-server" — nothing reachable. With members.yaml written, a plain serve starts in team mode.
    io.out(`  • No running server found at ${res.serverHost}. Start one (it reads members.yaml and\n`);
    io.out(`    comes up in team mode — no env var needed):\n`);
    io.out(`      npx @krimto-labs/krimto serve\n`);
    io.out(`  • Then open http://${res.serverHost}/ui/admin and sign in with your admin key.\n`);
  }
  io.out("  • Step back to solo with `krimto team disband` (data preserved)\n");
  if (res.remote) {
    io.out(
      `  • Teammates who run their OWN Krimto (instead of connecting to this server):\n` +
        `      krimto remote --set ${res.remote.url}   then   krimto sync\n`,
    );
  }
  io.out("\n");

  // Discoverability: there's no save syntax — you signal scope by how you phrase it to your AI.
  // Show that here (and in `krimto team status`) so nobody has to know the phrasings in advance.
  io.out("━━ How to save notes (just tell your AI in chat) ━━\n\n");
  io.out(`  Personal      "remember my editor is vim"               → only you\n`);
  io.out(`  This team     "remember for the ${res.teamSlug} team, we ship Fri"  → team/${res.teamSlug}\n`);
  const orgLabel = res.orgName ? `${res.orgName} (whole org)` : "your whole org";
  io.out(`  Company-wide  "remember company-wide, support is …"      → ${orgLabel} (admins)\n`);
  if (!res.orgName) {
    io.out(`                Name your org so this reads nicely: krimto team init --org "Your Company"\n`);
  }
  io.out("\n  Tip: `krimto team status` lists your exact save targets any time.\n\n");
}
