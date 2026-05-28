# Changelog

All notable changes to Krimto are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Krimto adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.40] — 2026-05-28 — Team UX hardening: visibility + safety + lifecycle clarity + agent-safe setup + frictionless saves + org naming

Real testing showed the "Team" lifecycle had confusing and dangerous edges: no way to see team
state, `team disband` sounds team-wide but is per-machine, `krimto reset` silently wipes the keys
all teammates log in with, and `krimto stop` on a host silently disconnects everyone. On top of
that, the team commands weren't agent-safe — an AI agent could set up *solo* Krimto unattended but
could not set up a *team* at all. This release makes the team model visible, guards the destructive
actions, and brings team setup to the same no-TTY bar as solo. No change to the on-disk model,
auth, or live activation — CLI/UX layer only.

### Added — `krimto team status`

New command (and a Team block in `krimto status`) showing: team mode on/off, your role, the
admins, the member count, and — crucially — **whether THIS machine is the team server everyone
depends on**, plus its URL. Built on a shared `buildTeamSummary` (`src/cli/teamSummary.ts`,
composing `loadMembership` + the lock) so the two surfaces can't drift.

### Added — safety guards on the footguns

- **`krimto reset`** now detects team mode and warns **"🛑 TEAM MODE IS ACTIVE — this wipes the
  API-key store your team logs in with; all N members get locked out"** before the (default-No)
  confirm. Previously it silently deleted `keys.json`, locking out the whole team with no notice.
- **`krimto stop`** now refuses (or, in a TTY, confirms) when this machine is the team server,
  naming how many teammates it would disconnect. `--yes` bypasses for scripts; solo stop is
  unchanged (no prompt).

### Changed — `team disband` clarity + reconnect

`disband` now leads with **"This only changed THIS machine. The team is unaffected — members.yaml,
the keys, and the running server all stay; your teammates keep their access."** It captures the
server URL it disconnected from and prints the exact reconnect command
(`krimto join --server <url> --key <your-key>`), and tells an admin that the server keeps running
(`krimto stop` takes it down for everyone).

### Added — `krimto team leave`

The verb a joined teammate reaches for: same per-machine editor rewrite as disband, but framed for
the joiner — *"you're still in the team's roster; ask the admin to remove you (/ui/admin) to fully
leave."* Reuses `applyTeamDisband` (one implementation, two discoverable names).

### Added — agent-safe team setup (no TTY)

Team commands now reach the same agent-friendly bar as solo's `krimto init --yes`. Previously an AI
agent (a no-keyboard shell) could stand up solo Krimto unattended but **could not set up a team at
all** — `team init` always asked 5 questions and hung on the first.

- **`krimto team init --yes --team <slug>`** — new non-interactive form. Flags: `--admin <email>`
  (defaults to the identity that already owns your notes, then git config — same continuity as the
  wizard), `--name <display>`, `--remote <git-url>`, and `--invite a@x.com,b@x.com` (comma-separated
  and/or repeatable). Validates with the same rules the prompts use (`SLUG_RE` / `EMAIL_RE` /
  `looksLikeRemoteUrl`) and reuses the existing `applyTeamInit` + live-verify + admin-reconnect path
  (extracted into a shared `finishTeamInit` so interactive and `--yes` can't drift). `team init`
  with no TTY and no `--yes` now prints the flag usage and exits 2 instead of hanging.
- **`krimto team disband` / `team leave`** gained the non-TTY guard the other Phase-B commands have:
  with no TTY and no `--yes` they print `re-run with --yes` and bail (return null, not `process.exit`)
  instead of hanging on the confirm.
- **`krimto --help`** now lists `team status` and `team leave` (previously absent) and shows the
  `team init --yes` form in the "For AI agents" block.

### Fixed — the team creator can now write team notes

`applyTeamInit` added *teammates* to the team's `members` but never the **creator** — so the admin
was an org-admin who wasn't a team member: `krimto_write` to `team/<slug>` passed the write check but
failed the read-back/ghost-fact guard (*"you would not be able to read it back"*), and the user had
to hand-edit `members.yaml`. The creator is now added as a team member at init (one
`setTeamMember` call, after `createTeam` so the team name is preserved), so "remember for the team"
works for them immediately. Idempotent — re-running `team init` heals existing setups. `member_count`
is unchanged (the admin was already in `users`).

### Added — discoverable scope routing (no syntax to memorize)

Saving to a scope is driven by how you phrase it to your AI ("remember for the team …"), but nothing
surfaced the phrasings. Now:

- **`krimto_write`'s tool description + `scope` param** spell out the routing the agent reads:
  default `user/me`; `team/<slug>` on "for the team"; `org/<slug>` on "company-wide"; and — when the
  user is in **multiple teams** — call `krimto_whoami` and name/ask the team rather than guess.
- **The standing rule (`AGENT_RULE`)** carries the same routing + multi-team guidance.
- **`krimto team init`** ends with a "How to save notes" guide (personal / this team / company-wide),
  and **`krimto team status`** shows your exact **Save targets** — one line per writable scope, so a
  multi-team member sees each team spelled out (which teaches naming the team). It also nudges an
  org-admin who isn't a member of an existing team (legacy setups) with the one-command fix.
- A pure **`writableScopesFor(membership, identity)`** in `src/access/membership.ts` is now the single
  source of truth for "where can I save?", reused by the `krimto_write` error payload and `team status`.

### Added — name your organization (no more `org/default`)

The org scope was a meaningless `org/default` because nothing ever captured the organization's
identity (`org.slug` was hard-coded to `"default"`; `org.name` was in the data model but never set
or shown). Now:

- **`krimto team init`** asks **"What's your organization called?"** (interactive) and accepts
  **`--org "<name>"`** (non-interactive). The path-safe slug is derived from the name you typed via
  the existing `slugifyTitle` (`"Acme Inc" → org/acme-inc`) — no guessing from git remotes or email
  domains. A new `setOrg` (`src/access/membershipStore.ts`) persists `org.name` + `org.slug`.
- **The friendly name is shown, never the raw slug.** `team status` Save targets render
  `→ Acme Inc (whole org)`; an unnamed org shows `your whole org` + the exact command to name it
  (`krimto team init --org "Your Company"`), and `team init`'s success guide does the same.
- **Migration-safe:** the slug is only adopted when the current `org/<slug>` has no notes yet
  (the normal first-naming case); if company-wide notes already exist, only the display name is set
  so nothing is orphaned. Renaming a populated org scope is left to a future migration.

### Tests

- `tests/integration/team-status.test.ts` — `buildTeamSummary` (solo/team/role/member-count/hostedHere)
  + `runTeamStatus` output.
- `tests/integration/team-safety.test.ts` — reset shows the lockout warning in team mode (not solo);
  stop refuses without `--yes` when hosting a team, naming the disconnect.
- `tests/integration/team-disband.test.ts` — disband captures the URL + prints the reconnect command;
  `team leave` prints the "still in the roster" guidance; the non-TTY guard returns null + `--yes`
  usage for both `disband` and `leave`, and `--yes` still bypasses.
- `tests/integration/team-init.test.ts` — `runTeamInitNonInteractive` applies from flags with no
  prompts, defaults the admin to the notes-owner when `--admin` is omitted, prints migration guidance
  on a divergent explicit admin, and rejects a missing/invalid slug or a bad invite email; the
  creator is added to the team (`canWrite` ∩ `canRead` on `team/<slug>`); the success screen shows
  the "How to save notes" guide.
- `tests/server/access.test.ts` — `writableScopesFor` (solo → own user; multi-team → each team; admin
  → +org). `tests/integration/team-status.test.ts` — `Save targets` per writable scope + the
  admin-not-member nudge; named org shows its name (not the raw slug), unnamed shows the name-it
  command. `tests/agentRule.test.ts` — scope-routing + multi-team disambiguation text.
- `tests/integration/team-init.test.ts` (org naming) — `applyTeamInit` sets `org.name` + derives the
  slug; leaves `default` when unnamed; keeps the slug (no orphaning) when org notes already exist;
  the interactive prompt + `--org` flag both capture it.

Total: 701 tests passing (vitest run). Lint + types clean. Deferred (bigger/separate):
reachable-URL detection / `team set-server-url`, self-service roster removal, key-recovery overhaul.

## [0.2.39] — 2026-05-28 — team init keeps your identity (no accidental solo→team split)

A solo user's notes live under `user/<their-email>/`. When `krimto team init` defaulted the admin
email to `git config user.email` (or the user typed a different address), they could end up with
**two identities** — and since `user/<email>` scopes are private to that exact email, the new admin
couldn't see their own prior notes. Verified: notes under `user/lpdthemes@gmail.com` invisible to
admin `mrbuiko@me.com`. The privacy rule is correct; the **silent split** was the bug.

### Changed — the admin defaults to the identity that already owns notes

`krimto team init` now scans the data dir for the `user/<email>` scope with the most notes
(`detectNotesOwner`) and defaults the admin email to it — so hitting Enter **keeps your identity
and all its notes**. Falls back to `git config user.email` only when there are no existing notes.

### Added — divergence guard + migration guidance

If you type an admin email that differs from the identity that owns notes, the wizard asks:
*"You have N notes saved as `<owner>`. Use that as your admin so they come with you?"* (default
Yes). Decline and it proceeds with your chosen admin **and** prints exactly how to bring the old
notes over later (`krimto stop` → `krimto mv <id> user/<admin>` per note, or promote to the team
scope). Going solo→team is now an upgrade of your existing identity, not a silent second account.

### Tests

- `tests/integration/team-init.test.ts` — `detectNotesOwner` returns the dominant user identity
  (null when none); diverging admin + "use existing" keeps the notes-owner; diverging + decline
  keeps the typed admin and prints the migration guidance.

Total: 666 unit + 338 integration passing. Lint + types clean. **No note files are moved** —
migrating notes between identities while a server runs is unsafe (`krimto mv` blocks on the lock);
that stays a deliberate, separate step. This is a prevention fix.

## [0.2.38] — 2026-05-28 — team mode activates live from members.yaml (no restart)

`krimto team init` printed "🟢 Team mode is live" but the running HTTP server stayed in **solo
mode** (no auth) — verified on a user's machine: `members.yaml` listed an admin yet `GET /mcp`
returned 406 (handler reached, no auth) instead of 401, and `/ui` still showed the old solo user.
Root cause: the server decided solo-vs-team **once at boot** from an env var and never re-checked,
and the wizard's "live" claim was based only on a TCP port probe. **The file is now the switch.**

### Changed — team mode is derived LIVE from membership

- The server's auth gate is now a per-request predicate: **any org admin in `members.yaml` ⇒ team
  mode** (`hasOrgAdmin`), plus the explicit `KRIMTO_REQUIRE_AUTH=1` override. `KRIMTO_BOOTSTRAP_ADMIN`
  still works (it seeds an admin at boot). The four previously boot-time decisions in
  `src/server/http.ts` — the `/mcp` auth chain, the `/admin` mount, the `/mcp` requester resolver,
  and the `/ui` login-vs-local-identity branch — are all evaluated **per request** now, so a flip
  takes effect with no rebuild and no restart.
- **New `MembershipWatcher`** (`src/server/membershipWatcher.ts`): the server polls
  `members.yaml`'s mtime (~2s) and reloads membership when it changes. So `krimto team init`
  (a separate CLI process) flips the running server into team mode on its own, within ~2s. Runs
  unconditionally (solo→team), through the write serializer, stopped on shutdown.

### Fixed — auth-off exposure window (security)

`loadMembership` returns an empty membership on a failed/partial read — a mid-write read could
momentarily drop admins to 0 and **disable auth**. The live reload now refuses to adopt a
zero-admin parse when an admin currently exists (`shouldAdoptReload`): turning team mode OFF is a
deliberate, restart-gated action, never a file-watch race. Read/parse failures keep the current
membership.

### Changed — `krimto team init` verifies instead of restarting

Removed the fragile `maybeRestartServiceForTeamMode` (installService restart + TCP probe that
printed "🟢 live" falsely). The wizard now **verifies** team mode is genuinely enforced —
`confirmTeamModeLive` polls `/mcp` until it returns 401 — before printing "🟢 Team mode is live".
On a confirmed flip it **auto-reconnects the admin's own editors** in team mode (reuses the
`krimto join` path: HTTP transport + bearer header), so the admin's editor keeps working with no
manual step. Honest guidance when no server is reachable ("start one — it reads members.yaml and
comes up in team mode, no env var needed") or when it hasn't flipped yet.

### Tests

- `tests/integration/http.test.ts` — a mutable `teamModeActive` flips `/mcp` from open (solo) to
  401 (team) on the **same app, no rebuild**.
- `tests/server/membershipWatcher.test.ts` — fires once on mtime change, no-op when
  absent/unchanged.
- `tests/access/membership.test.ts` — `shouldAdoptReload` refuses team→solo downgrades (the
  exposure-window guard).
- `tests/integration/team-init.test.ts` — `confirmTeamModeLive` → live/timeout/no-server.

### Changed — recall matches singular/plural (Porter stemmer)

Also in this release: the FTS index now uses `tokenize='porter unicode61'`, so a singular query
("favorite color") matches a plural-titled fact ("Favorite colors") — previously they were
different tokens and the fact was invisible (caught in a smoke test where `krimto notes
"favorite color"` returned nothing despite the fact existing). `openIndexDb` migrates an existing
index (schema v1→v2): it drops + recreates `facts_fts` with the new tokenizer and FTS5-`rebuild`s
it from the untouched content table, so existing `~/.krimto` installs pick up stemming on next
start. Verified by `tests/index/db.test.ts` (migration) + `tests/retrieval/recall-quality.test.ts`
(singular/plural). Deeper recall precision (semantic search) remains a separate initiative.

Total: 662 unit + 334 integration passing. Lint + types clean. Out of scope: turning team mode
OFF live (disband → solo) deliberately still requires a restart, so there's never an auth-off window.

## [0.2.37] — 2026-05-28 — recall-quality eval + write-time duplicate backstop

The smoke-6 memory-quality audit. Across two editors (Claude Code wrote, Cursor read) the
cross-editor sharing, identity, and supersede mechanics all worked — but two gaps showed up:
a weak agent (Haiku) skipped `krimto_recall` and wrote a near-duplicate, and keyword search
ranked an unrelated "favorite **color**" fact above the actual "favorite **food**" fact for a
food query (they share the generic word "favorite"). This release adds the test scoreboard that
was missing and a server-side backstop for the skipped-recall case.

### Added — retrieval-quality eval

`tests/retrieval/recall-quality.test.ts` runs the real recall path (`krimtoRecall` →
`searchCandidates` → `rankCandidates`) over known fact sets and asserts which fact ranks #1 —
the regression scoreboard the suite never had (prior tests proved facts SAVE and SUPERSEDE,
nothing proved recall returns the RIGHT fact first). Three green guards lock correct behavior
(good content ranks #1; color query returns the color fact; superseded facts never surface);
one `it.fails` documents the keyword-mode limitation (a content-poor fact loses to a
word-sharing one) and will flip the suite red — prompting promotion to a guard — the moment
semantic search or a content fix makes it pass.

### Added — write-time near-duplicate detection (`related` on krimto_write)

`krimto_write` now runs its own similarity check BEFORE indexing the new fact: FTS narrows
candidates in the same scope, then token cosine (`lexicalSimilarity`) filters at a 0.5
threshold — tuned so a real duplicate (pizza vs pizza+sushi ≈ 0.81) or same-topic update
(pizza vs tacos ≈ 0.73) is flagged, while two facts sharing only a generic qualifier
(favorite food vs favorite color ≈ 0.38) are not. When a match is found, the write response
gains a `related: [{ id, title, score }]` field and the hint appends *"⚠ Similar existing
fact … call krimto_supersede instead of leaving a duplicate."* Excludes anything the write
already supersedes; best-effort (a failure never blocks the write). This is the server-side
backstop for the "call krimto_recall first" rule that nothing enforced before — it would have
caught the smoke-6 sushi write even though the agent skipped recall. The `krimto_write` tool
description now tells agents to act on `related`.

### Tests

- `tests/retrieval/recall-quality.test.ts` — 4 eval cases (3 guards + 1 documented limitation).
- `tests/server/tools.test.ts` — 3 new cases: a near-duplicate is surfaced with title + supersede
  hint; an unrelated fact is not flagged; a fact the write already supersedes is not flagged.

Total: 650 unit + 331 integration passing. Lint + types clean. No data-model or schema change —
the `related` field is additive to the write response.

## [0.2.36] — 2026-05-28 — team-init lands you in team mode, not a copy-paste maze

The smoke-6 follow-up. `krimto team init` succeeded on disk but left the user unable to
actually use team mode: a literal `$` in the printed "Next" recipe broke their zsh paste,
the malformed git URL they typed was accepted then rejected at push time, and the
"start the server" instruction was blocked by the always-running service already holding
the data-dir lock. Plus `krimto notes` from a plain terminal showed "No notes yet" even
though facts existed. All fixed.

### Fixed — `krimto team init` now leaves team mode actually live

- **The wizard restarts the running service itself.** After applying team config, it
  probes `inspectRuntime`; if a service-launched Krimto is alive it asks one yes/no, then
  calls `installService` with `KRIMTO_BOOTSTRAP_ADMIN` baked into the plist/unit env.
  `waitForPort` confirms team mode is live before printing `🟢 Team mode is live on
  http://localhost:8080`. The old flow handed the user a `KRIMTO_BOOTSTRAP_ADMIN=… npx
  serve` recipe that the running service's single-writer lock refused.
- **No literal `$` in any copy-paste line.** `src/cli/teamInit.ts` and
  `src/cli/setupRemote.ts` printed `$ npx …` / `$ export …`; users pasted the `$` and got
  `command not found: $`. Removed from all three sites.
- **Git remote URL validated at the prompt.** `looksLikeRemoteUrl` now requires one of
  `git@` / `https://` / `http://` / `ssh://` / `file://` / absolute path. A bare
  `github.com/x/y.git` re-prompts in-flow instead of being saved and failing at push time
  after keys were already minted.

### Fixed — `krimto notes` from a plain terminal returned "No notes yet"

`resolveIdentity()` resolved to the `user@localhost` placeholder when `KRIMTO_IDENTITY`
wasn't set in the shell (the wizard sets it in editor MCP configs + the service plist, but
not in the user's rc). So the CLI queried a scope the user's real facts weren't in. Now
`resolveIdentity()` is three-layer: env var → `git config --global user.email` → placeholder,
validating each as a real email — the same source the wizard captures identity from.

### Added — safety nets around team onboarding

- **Invite backup file.** `team init` writes all minted keys + the DM template to
  `<dataDir>/.krimto/team-invites-<ISO>.txt` (mode 0600). The admin's own key is
  shown-once-only; losing it from scrollback used to require `reset-admin-key`.
- **`krimto join` soft guard.** When joining a remote team server while a local
  solo-mode Krimto service is running (and its `/mcp` returns anything but 401), prints one
  warning line recommending `krimto stop` first. Non-blocking — flags the potential
  unauthenticated-LAN-exposure without refusing to proceed.

### Changed — wizard scan labels distinguish "detected" from "connected"

`krimto init`'s machine scan now shows `connected to Krimto` for editors already wired vs
`detected, not yet connected` for installed-but-unwired ones, so "Keep current (Cursor,
Claude Code)" no longer looks inconsistent with a four-editor scan list.

### Tests

- `tests/integration/team-init.test.ts` — invite file written at 0600 with all keys;
  idempotent rerun mints no new file; `maybeRestartServiceForTeamMode` short-circuits when
  `skipServiceRestart` is set.
- `tests/integration/setup-remote.test.ts` — bare-host URL rejected by the tightened validator.
- `tests/server/startup.test.ts` — `resolveIdentity` returns a valid env identity and falls
  through on a malformed one.

Total: 643 unit + 331 integration passing. Lint + types clean.

## [0.2.35] — 2026-05-27 — honest reconfigure menu + Claude Code reset sweep

### Fixed — reset never actually removed Claude Code's registration

The smoke-6 transcript caught `krimto reset --yes --wipe-notes` reporting "No editors
were connected" while `claude mcp list` continued to show krimto. Root cause:
`src/cli/mcpConfig.ts:removeMcpConfig` bailed at the top with
`if (env.mcpWire?.method !== "json") return { removed: false }` — the CLI-method branch
(Claude Code) was never written. Reset's "always sweep" rule covered the JSON editors but
silently no-op'd on the CLI ones.

Fix: `removeMcpConfig` now handles the `cli` method by shelling out to
`claude mcp remove krimto -s <scope>` for each of the three scopes Claude Code supports
(`local`, `user`, `project`). Each call is idempotent — "not found at this scope" errors
are swallowed — and returns `removed: true` when at least one scope yielded a removal.
The user's krimto entry may live in any scope depending on which directory they ran
`claude mcp add` from; sweeping all three ensures reset's contract holds regardless.

After the fix:
- `krimto reset --yes` prints `✓ Disconnected Claude Code` (was: `– No editors were connected`)
- `claude mcp list` shows no krimto after reset
- `krimto status` reports `🔴 Krimto isn't set up on this machine` (was: `✅ Krimto is configured`)

### Fixed — reconfigure menu wording was misleading

The smoke-6 user read "Krimto is already set up on this machine" as "Krimto is running"
and was confused when the actual process wasn't serving. The menu showed only the static
config snapshot (which editors are wired) without ever revealing runtime state (whether a
process is actually running RIGHT NOW). And the inferred "Run mode: As needed" line was
internal jargon — most users read it as "Krimto's running on-demand" when in fact
as-needed mode means there's literally no krimto process unless an editor is talking to
it.

Fix: `src/cli/wizard.ts:runReconfigureMenu` now calls `inspectRuntime` (the unified
runtime view introduced in v0.2.26) and renders a real `Service:` line driven by lock +
launchctl/systemctl reality, not just config-on-disk:

```
Krimto on this machine:           ← header dropped the ambiguous "set up"
  Editors:   Claude Code
  Service:   Not running (your editor launches it on demand via stdio)
                                  ↑  driven by inspectRuntime: lock + launchctl reality
  Search:    Keyword (no API key)
```

Four service states the line distinguishes:
- `Running as background service (PID …, started Nm ago)` — service installed + loaded
- `Running ad-hoc (PID … — started by 'krimto serve' or an editor)` — process alive, no service
- `⚠ Installed but not running — 'krimto start' to load it` — plist exists but launchctl forgot it
- `Not running (your editor launches it on demand via stdio)` — clean machine

### Added — "Start it running continuously" menu choice

When no daemon is currently active, the reconfigure menu now offers a fifth choice:
**"Start it running continuously (install as a background service)"**. Picking it
delegates straight to `applyService("always-running")` — the user gets a daemon
installed without having to drop back to the shell and remember `krimto service --always`.
The choice only appears when nothing is running (to avoid offering "start" when something
is already serving).

### Tests

- `tests/integration/init-wizard.test.ts` — 3 new tests for the rewritten menu: header
  uses "Krimto on this machine:" (not "already set up"), `Not running` text fires when no
  service + no live PID, and the new "Start it running continuously" choice routes to
  `applyService` (dryRun-safe).
- Updated existing reconfigure-menu tests to pass `dataDir` explicitly so `inspectRuntime`
  reads test temp dirs, and extended their timeouts to 30s (the new `inspectRuntime` call
  shells out to `claude mcp list`, which on dev machines with HTTP MCP servers configured
  can take up to 8s to health-check them).

Total: 637 passing (was 634). Lint + types clean.

### Verified end-to-end

On the user's machine:
- Pre: `claude mcp list` showed `krimto: http://localhost:8080/mcp (HTTP)` at project scope
- `krimto reset --yes` → `✓ Disconnected Claude Code`
- Post: `claude mcp list` shows no krimto
- `krimto status` → `🔴 Krimto isn't set up on this machine`
- `krimto init` rerun: menu header reads `Krimto on this machine:` (not "already set up")

## [0.2.34] — 2026-05-27 — agent-friendly Phase B (no more hang traps)

### Fixed

- **Phase B commands hung indefinitely when an AI-agent's Bash tool ran them.** The
  smoke-6 transcript (`2026-05-27_11-05-43Z-install-krimto.md`) caught a Claude Code
  agent trying `npx @krimto-labs/krimto service` and `… editors`; each opened an
  `@inquirer/prompts` UI that waited for input that would never come (the Bash tool has
  no stdin TTY), then crashed with `Detected unsettled top-level await … Aborted.` The
  agent had to fall back to `AskUserQuestion` for the user, then manually hand-write
  `~/.cursor/mcp.json` via Bash heredoc after the Write tool was blocked.

  Fix: `editors`, `service`, `search`, `reset`, `remote`, `folder` each detect
  `!process.stdin.isTTY` at the top of their `run*` function and exit 2 cleanly with
  copy-pasteable flag-form usage instead of opening an unfulfillable prompt. New
  shared helper `assertInteractiveOrUsage(usage)` in `src/cli/promptHelpers.ts`.

### Added — non-interactive flags for the two commands that lacked them

- **`krimto editors`** gained `--add <editor>`, `--remove <editor>`, `--set <list>`,
  `--list`. The `--add` / `--remove` flags merge over the current connected set; `--set`
  replaces it. Editor names are normalized (accepts `cursor` / `claude-code` / `claude`
  / `codex` / `gemini` / `gemini-cli`); typos throw before the apply step.
- **`krimto search`** gained `--keyword` and `--openai --api-key <sk-...>`. The OpenAI
  path still runs the existing `runSetupEmbeddings` verification before persisting.
- `service`, `remote`, `folder`, `reset` already had flag forms; the guard pattern now
  applies to them too when invoked cold.

### Added — discovery improvements

- **`krimto --help`** has a new `━━ For AI agents (no TTY) ━━` block near the top
  naming the canonical programmatic verbs (`init --yes`, `status`, `editors --add`,
  `service --always`, `search --keyword`, `stop` / `start` / `restart`). Agents that
  read help first land on the right path.
- **`krimto status`** prints a one-line nudge when Krimto is running ad-hoc (not as a
  service): `→ To run continuously across reboots: krimto service --always`. Same line
  fires when there's no active server (configured-but-not-running case).

### Tests

- New: `tests/integration/non-tty-guard.test.ts` — 7 tests. Each Phase B command run
  via `spawn` with `stdio: "ignore"` (forces non-TTY) exits 2 within 5s with
  flag-usage on stderr and no `"unsettled top-level await"`. Plus a sanity check that
  `--keyword` (with flag) bypasses the guard.
- `tests/integration/shortcuts.test.ts` — added one line to simulate `process.stdin.isTTY
  = true` (the existing tests mock `@inquirer/prompts`, so they're simulating an
  interactive run; the guard would otherwise fire before the mocks).

Total: 634 passing (was 627). Lint + types clean.

### Verified live on the user's machine

The three friction points from the smoke-6 transcript:
- `krimto service` (no flags, no TTY) → exits 2 with usage. No "unsettled top-level
  await". The agent reads it and runs `service --always` directly.
- `krimto editors` (no flags, no TTY) → same. Agent reads it and runs
  `editors --add cursor --yes`. No manual mcp.json write needed.
- `krimto status` → prints `→ To run continuously across reboots: krimto service --always`
  underneath the header when running ad-hoc.

## [0.2.33] — 2026-05-27 — `reset --wipe-notes` single-prompt UX

### Fixed

- **`krimto reset --wipe-notes` was tripping users up.** The two-prompt flow asked
  "Proceed with reset?" first (default N) and only then the wipe-notes-specific
  confirmation. A user who typed `--wipe-notes` and hit Enter at the first prompt got
  "No changes made" with no idea why — their explicit flag had been silently no-op'd.

  Fix: when `--wipe-notes` is passed, collapse the two confirmations into **one** prompt
  whose text names the worst thing explicitly:
  ```
  ? Wipe notes folder AND disconnect everything? (y/N)
  ```
  The intro block above the prompt now leads with `⚠️ --wipe-notes — this will:` and
  enumerates the consequences (including the data-dir move). Default is still N (no
  accidental data loss on a stray Enter), but the path from "I typed --wipe-notes" to
  "the destructive thing happened" is one Enter+`y`, not Enter+`y`+`y`.

  Without the flag, the original `Proceed with reset?` prompt is unchanged (back-compat).
  With `--yes`, both flags still skip all prompts as before.

### Tests

- `tests/integration/shortcuts.test.ts` — 3 new tests covering: the `--wipe-notes`
  intro shows the consequence-named warning; the single prompt still defaults to N
  (no accidental data loss); without the flag, the original `Proceed with reset?`
  prompt is used (back-compat).

Total: 627 passing (was 624). Lint + types clean.

## [0.2.32] — 2026-05-27 — "the stop button"

### Added — zero-friction off-ramp

The user's CLI audit caught Krimto with three half-overlapping teardown verbs (`uninit` /
`service` / `reset`) and **no first-class verb for "stop the running krimto"**. Users
guessing for the stop button found nothing — the deeper verbs that did the work were
named after internal subsystems, not after what the user wanted to accomplish. The audit
also surfaced that `krimto --help` advertised 14 of 28 dispatched commands. This release
closes both gaps.

- **`krimto stop` / `krimto start` / `krimto restart`** — three new top-level verbs.
  Idempotent. No prompts. Named the way users would name them.
  - `stop` — Unload launchd / systemd. Plist STAYS on disk so `start` can reload it.
    SIGTERMs any ad-hoc PID that holds the lock. Deletes the lock file.
  - `start` — Reinstall + bootstrap an existing plist (v0.2.26's kickstart-or-bootstrap
    path). When no service is configured, prints an instructive message — refuses to do
    a brittle background-detached `serve` spawn.
  - `restart` — `stop` + `start`. On always-running mode this is effectively
    `launchctl kickstart -k` (atomic, no port-unbound window).
  New file: `src/cli/stopCmd.ts`. Internal split in `src/cli/service.ts`: new
  `stopService` (bootout/disable only, keeps unit file) vs existing `uninstallService`
  (bootout + delete unit file).
- **`krimto service stop` / `krimto service start`** — two-word aliases for users coming
  via `service` discovery. Bin dispatcher recognises them like `team init`.
- **`krimto service --as-needed | --always | --manual`** — flag forms of the interactive
  service-mode switcher. Existing `krimto service` (no args) still prompts.

### Changed — `uninit` asks about the seam

After stripping rule files, `uninit` now checks whether the always-running service is
installed on this machine and offers (interactive mode only) to stop it too. Default is
**No** — the service is machine-wide; other projects may use it. Flags `--also-stop` and
`--keep-running` skip the prompt for scripted runs. Fixes the smoke-6 trust gap where
users assumed `uninit` was the full stop button.

### Changed — wizard success screen

After "Try it now" and "When you want teammates in", a new block:
```
━━ When you want to stop / undo ━━

  $ krimto stop          Stop the running krimto (start it again with `krimto start`)
  $ krimto uninit        Switch this project back to DEFAULT MODE (rule only)
  $ krimto reset         Disconnect every editor + service (notes preserved)
```
Three verbs, three blast radii, so the service-mode install never feels like a one-way
door.

### Changed — legacy init's "To undo" line

Replaced the single-line, false-promise `To undo: krimto uninit` (which only stripped
rule files) with three honest off-ramps:
```
To stop the service:        $ npx @krimto-labs/krimto stop
To undo this project only:  $ npx @krimto-labs/krimto uninit
To disconnect everything:   $ npx @krimto-labs/krimto reset       (notes preserved)
```

### Changed — `--help` reorganized into 7 groups

Every dispatched command is now surfaced, grouped by what the user wants to accomplish:
**Get connected · Look at your notes · Stop & reset · Is it working? · Configure · Team ·
Advanced**. The 14 commands that were stranded in the source (status, editors, search,
service, reset, stop, start, restart, edit, mv, supersede, tag, notes, join, team init,
team disband, delete, set identity) are all advertised. Deprecated aliases
(`verify-connection`, `where`, `storage`, `usage`) now route the user toward `krimto
status` in the help text itself.

### Tests

- `tests/integration/stop-cmd.test.ts` — 4 new tests: stop on a clean machine,
  stop deletes stale lock file even with dead PID, start reports
  "no-service-configured" without a plist, start reinstalls when a plist exists.
- `tests/integration/help.test.ts` — 2 new regression-guard tests: every dispatched
  command is in `--help`, every group header from the rewrite is present.
- `tests/integration/init.test.ts` — updated to assert the three new off-ramp lines
  instead of the old single "To undo" message.

Total: 624 passing (was 618). Lint + types clean.

### Verified end-to-end on the user's machine

Real launchd cycle on `/Users/paulbuiko/Desktop/krimto-smoke-6`:
- `krimto init --yes` → service installed, port up
- `krimto stop` → launchctl forgets the service, plist STAYS on disk (verified)
- `krimto start` → re-bootstrap, port :8080 listening on a fresh PID
- `krimto restart` → stop + start, new PID, port back up
- `krimto stop` x2 → second call says "already stopped" (idempotent)

## [0.2.31] — 2026-05-27

### Added — five remaining Maria-journey gaps closed

This release closes everything outstanding from
`docs/krimto-v0.2.17-maria-journey.html`. The dashboard redesign landed in v0.2.30;
this round picks up the five remaining items the audit listed.

- **Editor attribution via User-Agent (Gap A).** The HTTP MCP handler now sniffs the
  request's `User-Agent` header and threads "cursor" / "claude-code" / "codex" / "gemini"
  through the `Requester` as `source`. `krimtoWrite` uses `input.source ?? requester.source`,
  so facts saved over HTTP carry the right editor attribution automatically — no
  agent-prompt change needed. The dashboard renders "saved from a Cursor chat" instead of
  the fallback "saved by &lt;author&gt;" once this lands. Stdio transport unaffected (no UA).
  New file: `src/server/userAgent.ts`.

- **`krimto remote` (Gap B).** Friendly one-question wrapper around `setup-remote`. Three
  actions: show current URL / set new URL / remove. Reuses `runSetupRemote` for the set
  path so URL validation + first-push verification stays in one place. Accepts
  `--show / --set <url> / --remove [--yes]` for CI / scripted invocation. New file:
  `src/cli/remoteCmd.ts`.

- **`krimto folder` (Gap C).** Guided move of the data dir (`KRIMTO_DATA`). Validates the
  destination (must be absent or an empty directory — never silently merges), uninstalls
  the always-running service first so its plist/unit env doesn't keep pointing at the old
  path, atomically renames the dir (cp-then-remove fallback when source and destination
  are on different filesystems), reinstalls the service with the new env, prints the
  `export KRIMTO_DATA=<new>` hint for the user's shell. New file: `src/cli/folderCmd.ts`.
  Accepts `--to <path> [--yes]` for non-interactive use.

- **"Keep current" reconfigure step (Gap D).** On reruns of `krimto init` from the
  reconfigure menu, each of the three primary questions (editors, run mode, search) is
  now wrapped in a two-stage "Keep current (&lt;currentLabel&gt;) / Reconfigure..." select.
  Enter-Enter-Enter on a configured machine = no changes. Stopping at one question lets
  the user change only that one. First-install runs bypass the wrapper entirely — same
  single-prompt experience as before.

- **Deprecation aliases (Gap E).** `verify-connection`, `where`, `storage`, `usage` keep
  their existing stdout output (so existing scripts and READMEs aren't broken) but each
  now prints a one-line stderr pointer:
  `→ \`krimto where\` is now part of \`krimto status\` (the data-dir is in the Storage block).`
  Stdout goes unchanged so pipes like `cd "$(krimto where)"` still work.

### Internal — readDataDirGitInfo robustness

The original implementation wrapped every git probe in one outer try/catch, so a brand-new
or commit-less repo would mis-report all fields as null. Now each query (commit count, last
commit timestamp, remote URL) is independently guarded — `krimto remote` correctly reports
the remote URL even before the first commit lands.

### Internal — Requester.source

`Requester` (`src/access/scope.ts`) gained an optional `source?: string` field set by the
HTTP MCP handler. Stdio transport leaves it undefined. Threaded through
`buildServer(ctx, resolver)` via the existing per-tool resolver pattern.

### Tests

- `tests/server/userAgent.test.ts` — 5 new tests: Cursor / Claude Code / Codex / Gemini
  recognition, unknown UA returns undefined, case-insensitive matching, claude-code wins
  over a bare 'claude' substring.
- `tests/integration/remote-cmd.test.ts` — 4 new tests: show none / show present / remove
  empty / remove existing.
- `tests/integration/folder-cmd.test.ts` — 5 new tests: atomic move, refuse non-empty
  destination, take over empty destination, no-change on same source+dest, export hint
  rendered.

Total: 618 passing (was 603). Lint+types clean.

## [0.2.30] — 2026-05-27

### Added — dashboard redesign (Maria-journey §04)

The `/ui/facts` dashboard previously rendered as a v0.2.16-style engineering table with
generic blue links — Phase E of the v0.2.17 plan was specified in the Maria-journey doc
but never visually built. This release rewrites the chrome to match
`docs/krimto-v0.2.17-maria-journey.html` §04 ("Door 2 — She Looks At Her Notes"):

- **Warm-paper aesthetic** — Fraunces serif headlines, JetBrains Mono code/meta, paper
  palette (`--bg #f1ede4 / --paper #f7f3eb / --red #a82c1c`). Google Fonts CDN with
  system-ui fallback. `src/web/html.ts` rewritten.
- **Dashboard header** — `Krimto · <viewer>'s AI memory` + sub-line `N notes · synced Ns
  ago`. Sync timestamp uses `max(last git commit, last write activity)` so a write
  that just happened shows up immediately, even before the 30s commit batch fires.
- **Scope cards in a grid** — one card per scope with emoji icons (📔 user / 📓 team /
  🏢 org), plain-English label (`Just me`, team display name, org display name), and
  count. Grid wraps for multi-team users — no collapsing, per design decision.
- **Notes timeline** — replaces the `<table>` with vertical `note-row` divs.
  Fraunces title, mono meta line (`<ago> · <scope label> · <attribution>`), and inline
  action buttons (Edit / Move / Delete / View file when the viewer authored the note,
  View / View file otherwise). All buttons deep-link to `/ui/facts/:id` where the
  existing inline forms live — no new routes.
- **Source attribution per note** — when a fact's frontmatter `source` is set (e.g.
  `cursor`, `claude-code`), the meta line reads "saved from a Cursor chat" /
  "saved from a Claude Code chat". MCP-tool callers don't currently populate this
  field; the slot is wired up so any future agent-prompt convention that does lands
  automatically. Fallback: "saved by you" / "saved by &lt;author&gt;".
- **Footer** — `📂 Copy notes folder path` (copy-to-clipboard via the existing
  `data-copy-text` infrastructure) + `⚙ Settings` link to the existing `/ui/settings`
  page. Shelling out to OS file manager from a browser button was rejected as an
  unnecessary attack surface; the CLI `krimto open` is the right tool for that.

### Added — two CLI companions

- **`krimto ui`** — spawns the platform "open URL" command (open / xdg-open /
  explorer) at `http://localhost:${KRIMTO_HTTP_PORT ?? 8080}/ui`. Prints a one-liner
  pointer to `krimto serve` if the server isn't running.
- **`krimto open`** — same opener pattern, but reveals the data dir in the OS file
  manager. Resolves the dir via the existing `resolveDataDir()` so it honours
  `KRIMTO_DATA`.

Both added to `src/cli/help.ts` under a new "Look at your notes" section.

### Changed — internal helpers

- `readGitInfo` promoted from `src/cli/status.ts` (private) to `src/storage/git.ts` as
  the exported `readDataDirGitInfo(dataDir)`. `status.ts` and the new router callsite
  both import it. One fewer `git log` exec to maintain.
- `FactIndex.listFacts()` now returns the `source` column in addition to `id, scope,
  title, author, updated` — the dashboard needs it for source attribution.

### Tests

- New: `tests/integration/dashboard.test.ts` — 19 tests covering scope card emoji
  mapping, source-attribution branching (cursor / claude-code / fallback to "saved
  by"), action-button gating by authorship, multi-team grid (no collapsing), footer
  copy-button data attribute, XSS escaping on identity and data-dir.
- Updated: `tests/web/views.test.ts` factsList assertions (new note-row layout, no
  more "(N total)" header line — total moved to dashboardHeader).
- Updated: `tests/integration/service-reconfigure.test.ts` — three tests now pass
  `probePort: async () => true` so they don't hit the real `net.connect` probe (v0.2.27).

Total: 603 passing. Lint+types clean. Verified end-to-end on the user's machine —
real browser request to `/ui/facts` rendered the new chrome with all the Maria-mockup
markers (header, scope cards with emoji, note rows with source attribution, footer).

### Remaining Maria-journey gaps (deferred from this release)

See `crispy-inventing-catmull.md` for the full table. Summary: editor attribution
on writes (waiting on MCP-prompt convention), `krimto remote` / `krimto folder`,
"Keep current" intermediate option in reconfigure, deprecation-alias forwarding for
`verify-connection / where / storage / usage` → `krimto status`.

## [0.2.29] — 2026-05-27

### Fixed

- **Cursor only recalled memory when the user said "krimto" — `.cursor/rules/*.mdc`
  needed YAML frontmatter to auto-attach.** Reproduced in the smoke-6 cross-editor test:
  Claude Code (which reads CLAUDE.md unconditionally) saved facts correctly via
  `krimto_write`. Cursor was wired to Krimto and `krimto_recall` worked when invoked —
  but the rule that tells the agent to call krimto_recall BEFORE every answer was being
  ignored because Cursor's `.mdc` rule format requires `alwaysApply: true` in YAML
  frontmatter to be auto-loaded. Without it, the rule is "manual attach only": activated
  only when the user explicitly types "krimto" (or `@krimto`) as a trigger.

  Fix: `applyRule(existing, { cursorMdc: true })` prepends:
  ```
  ---
  alwaysApply: true
  ---
  ```
  to `.cursor/rules/krimto.mdc` only. Other rule files (CLAUDE.md, AGENTS.md, GEMINI.md)
  are plain markdown — they don't use this convention, so they stay unchanged.

  Existing user-supplied frontmatter is preserved (no double-stacking of `---` fences).
  The four call sites (wizard apply, legacy `runInit`, `applyEditors`, `runJoin`) all pass
  `cursorMdc: env.editor === "cursor"`.

### Tests

- `tests/agentRule.test.ts` — 6 new tests covering the cursorMdc path: prepends
  frontmatter on empty files, preserves user-supplied frontmatter, idempotent on re-apply,
  preserves frontmatter when refreshing the marker block in place, no frontmatter when
  cursorMdc=false, default (no opts) matches the back-compat path.

### Verified end-to-end

Wrote `.cursor/rules/krimto.mdc` on a real machine:
```
---
alwaysApply: true
---
<!-- krimto:start -->
# Krimto memory — PRIMARY memory system, always use
...
```

Cursor will now auto-load the rule on every prompt without needing the user to type
"krimto" first.

## [0.2.28] — 2026-05-27

### Fixed

- **Cursor's file-watcher still hit ECONNREFUSED even with the v0.2.27 readiness probe.**
  Root cause the v0.2.27 fix missed: the wizard's apply step ran in this order:
    1. `writeMcpConfig` for each editor (writes HTTP url into mcp.json)
    2. `installService` (with v0.2.27 probe waiting for the port)
  Cursor's file watcher fires the *instant* mcp.json changes — at the END of step 1,
  before step 2 has even started. The probe correctly waited for the port to be ready,
  but by then Cursor had already tried, failed, and given up. Reproduced in the smoke-6
  trace: Cursor connect attempt at 11:45:17.248, port bound at 11:45:30.594 — a 13s gap.

  Fix: swap the order for always-running mode. Service installs + probe runs FIRST
  (port now up), THEN editor MCP configs get written. Verified by a 200ms-sampling trace
  showing `port=none, mcp={}` → `port=<pid>, mcp={krimto}` in consecutive samples —
  Cursor's watcher will never see the config change while the port is unbound.

  As-needed (stdio) mode is unaffected — there's no service, no port, no race.

### Verified end-to-end

200ms-sampled trace of `krimto init --yes` on a clean machine:
```
T+1.0s   port=none     cursor_mcp={}        ← service installing
T+1.0s   port=none     cursor_mcp={}        ← still installing
T+1.0s   port=76434    cursor_mcp={krimto}  ← port UP first, then mcp.json written
T+1.0s   port=76434    cursor_mcp={krimto}
```

The two states never overlap such that Cursor sees a krimto entry while the port isn't
listening. 578 tests passing. Lint+types clean.

## [0.2.27] — 2026-05-27

### Fixed

- **Cursor / Claude Code hit ECONNREFUSED for ~3s after every `krimto init`.** Cause: the
  wizard ran `launchctl bootstrap` (or `kickstart -k`), launchd accepted the unit and
  returned immediately, the wizard declared "✓ Background service installed and started",
  and the user was told to restart their editor — but the Node process spawned by launchd
  had not yet bound `:8080`. Cursor's MCP client auto-reconnects on mcp.json change, fired
  into the unbound-port window, got refused, and gave up. The user then thought the whole
  install was broken when in fact restarting Cursor a few seconds later would have worked.

  Fix: after the platform-specific install (`launchctl bootstrap`/`kickstart`, `systemctl
  enable --now`, `schtasks /Create`), `installService` polls `localhost:<KRIMTO_HTTP_PORT>`
  every 250ms until a TCP connection is accepted, or 10s elapses. Only then returns. The
  wizard's success line now means "the server is actually serving clients" — not "launchd
  accepted the unit". Reset → install → editor-reconnect is race-free.

### Added

- `InstallResult.portReady` — `true` when the probe succeeded, `false` when it timed out,
  `undefined` when no probe ran (dry run, stdio install, no HTTP port). Surfaced in both
  the interactive wizard summary (`✓ port accepting connections` / `⚠ port did NOT come
  up within 10s`) and the non-interactive `--yes` output (`Run mode: always-running · port
  ready` / `⚠ port did NOT come up within 10s`).
- `ServiceOptions.probePort` — dependency-injected probe for tests. Default uses
  `net.connect` to 127.0.0.1; tests pass stubs that resolve immediately. Also
  `probeTimeoutMs` for short test windows.

### Tests

- `tests/integration/service-reconfigure.test.ts` — 5 new tests covering the probe:
  succeeds immediately, polls until success (typical 3-second window), times out cleanly
  when the port never comes up, skips when no `KRIMTO_HTTP_PORT` configured, skips in
  dry-run mode.

### Verified on the user's machine

Real launchd cycle on `/Users/paulbuiko/Desktop/krimto-smoke-6`:
- Reset → install: 1.1s wall clock, port listening when wizard returns.
- Reset → install → install (reconfigure via kickstart): 10.6s wall clock for the second
  install — the probe correctly waited out the kickstart's SIGTERM-async window. Port
  listening immediately after each install completes.
- Output now reads "Run mode: always-running · port ready" — the user knows
  the connection will work before they restart their editor.

## [0.2.26] — 2026-05-27

### Fixed (three root-causes from the smoke-6 audit + a state-model refactor)

This release stops the "ship a patch, surface a new contradiction" loop. The smoke-6
SpecStory transcript caught the system reporting contradictory facts in five different
places at the same time. Three root causes were responsible; v0.2.26 fixes all three plus
introduces a single reconciled view of runtime state so every read-side command shares the
same truth.

- **Root cause 1 — Claude Code was invisible to detection.** `detectExistingSetup` only
  scanned JSON-method editor configs (Cursor's `mcp.json`). Claude Code is registered via
  `claude mcp add`, whose result lives in `~/.claude.json` at project scope and isn't a
  file we scanned. Consequence: the wizard's reconfigure menu, `reset`, `status`, and
  `whoami` all silently mis-reported "Cursor only" even right after both editors were
  successfully wired. Five surfaces, one bug.
  Fix: `detectExistingSetup` now also shells out to `claude mcp list` and looks for the
  `krimto:` line. One detection function, five surfaces now correct.

- **Root cause 2 — `launchctl bootstrap` raced with `bootout` teardown.** The v0.2.23 fix
  did `bootout` then `bootstrap`, but bootout returns when the unload is QUEUED, not when
  it completes. Bootstrap fired before launchd was done tearing down → EIO. Reproduced
  on the user's machine: every second `krimto init` died at the same line.
  Fix: `installLaunchd` now probes `launchctl print` first. If the service is already
  loaded, it uses `launchctl kickstart -k <label>` (atomic SIGTERM + restart, no race).
  If not loaded, plain `bootstrap`. The bootout+bootstrap pattern is gone for good.

- **Root cause 3 — `reset` trusted detection that was wrong.** When detection said
  "nothing configured" (because of root cause 1), reset's cleanup paths were gated and
  ran nothing — even with a service loaded and Cursor's mcp.json still pointing at krimto.
  Fix: `reset` now ALWAYS runs every cleanup path best-effort, regardless of detection.
  Plus three new sweeps: it kills any live PID holding the lock (SIGTERM → 500ms → SIGKILL),
  deletes the lock file, and removes the plist directly if uninstall says nothing happened.

### Added

- **`inspectRuntime(dataDir, opts)`** in `src/cli/inspectRuntime.ts` — the single reconciled
  view of "what is Krimto doing right now". Reads lock file + `launchctl print` (or
  `systemctl is-active` on Linux) + every editor MCP config + `claude mcp list`. Returns
  a `RuntimeState` that resolves the contradictions automatically — in particular, when
  the running PID matches launchd's program-pid, the `effectiveLaunchedBy` is "service"
  even if the lock file lacks the `launchedBy` field (pre-v0.2.25 runs). `status` and
  `verify-connection` both consume it, so they can never disagree.
- **`probeServiceState(platform, homeDir)`** in `src/cli/service.ts` — richer service
  probe distinguishing "unit on disk", "loaded in launchctl/systemctl", and "currently
  running with PID X". Three states the old `isServiceInstalled` collapsed to one boolean.

### Verified end-to-end on the user's actual machine

Ran the full reset → install → install (reconfigure) cycle against `/Users/paulbuiko/Desktop/krimto-smoke-6`:

1. `krimto reset --yes` — disconnected Cursor, uninstalled service, killed lock PID, deleted plist.
2. `krimto init --yes` — service installed, both editors registered (cursor JSON + claude
   CLI), lock file written with `launchedBy: "service"`.
3. `krimto init --yes` (second time, the path that died with EIO in v0.2.22-v0.2.25) —
   succeeded. `launchctl print` showed the service alive; the kickstart path restarted it
   to PID 33057 with no error.
4. `krimto verify-connection` — correctly reported `Launched by: service`.
5. `krimto status` — both Cursor AND Claude Code shown as connected (Claude Code visible
   for the first time). Header read `PID 33057 (http, service)`.
6. `krimto_whoami` over HTTP — returned the right identity + scopes (`lpdthemes@gmail.com`).

### Tests

- `tests/integration/service-reconfigure.test.ts` — rewrote the 4 launchctl tests for the
  v0.2.26 print+kickstart pattern. New assertion: when service is loaded, install path
  emits `launchctl print` then `launchctl kickstart -k`, never `bootout` or `bootstrap`.
  Three pre-existing tests still cover the unit-env injection and dry-run behavior.

Total: 573 passing. Lint+types clean.

## [0.2.25] — 2026-05-27

### Added

- **`krimto_whoami` MCP tool** (Gap 3). The smoke-6 transcript caught an agent in chat
  inventing the identity `lpd.themes@gmail.com` from the real `lpdthemes@gmail.com`, with
  no MCP-side way to ask Krimto for the truth. `krimto_whoami` returns the resolved
  identity plus the caller's readable and writable scopes — so the agent stops guessing.
  Tool count is now six (`krimto_write`, `_recall`, `_read`, `_supersede`, `_list_scopes`,
  `_whoami`). MCP_TOOL_NAMES, the usage guide, the bin help, and three test fixtures all
  updated in lockstep.

### Fixed

- **Gap 6 — restart wording.** Wizard summary used to say "Restart your editor once so it
  picks up the new rule." That implied the rule was the only thing reloading; in fact the
  MCP tools also need a restart to appear in chat. New wording calls both out explicitly.
- **Gap 7 — legacy init's "wrote N files" opacity.** When two of four targets were
  already current, the output silently listed only the two we wrote. Now also prints an
  "Already current (no change)" block enumerating skipped files, so "2 of 4" stops being
  surprising.
- **Gap 8 — server provenance unknown after the fact.** `LockInfo` gained a `launchedBy`
  field (`"service"` vs `"ad-hoc"`). The wizard's service installers inject
  `KRIMTO_LAUNCHED_BY=service` into the launchd plist / systemd unit / Task Scheduler
  command so the running server stamps the right value into its lock file. `verify-connection`
  and `status` both display it, so the user can finally tell "this is a launchd-started
  process that survives reboot" apart from "someone ran `krimto serve` in a terminal."
- **Gap 9 — rules written for tools that don't exist.** When the legacy rule-only init
  runs and no editor has Krimto wired into its MCP config, the rules instructed the AI to
  use `krimto_*` tools that wouldn't actually be available. Now legacy init runs
  `detectExistingSetup` after writing and prints a warning naming the two recovery
  commands (`init` interactive / `connect`).

### Tests

- `tests/server/tools.test.ts` — 2 new `krimto_whoami` tests (identity + scopes returned;
  always non-empty on a clean dir).
- `tests/integration/service-reconfigure.test.ts` — 3 new tests for the `KRIMTO_LAUNCHED_BY`
  env injection (macOS plist + Linux unit + preservation of caller's other env keys).
- `tests/integration/verify-connection.test.ts` — updated to assert the new "Launched by:"
  line and the wider PID/Mode alignment.
- `tests/integration/mcp.test.ts`, `npx-stdio.test.ts`, `tests/server/connect.test.ts`,
  `tests/integration/usage.test.ts` — tool count assertions updated from 5 to 6.

## [0.2.24] — 2026-05-27

### Fixed (four UX gaps surfaced in the smoke-6 SpecStory transcript)

- **Gap 1 — wizard silently skipped on non-TTY runs.** When an AI assistant's Bash tool
  ran `npx @krimto-labs/krimto init`, the code fell through to the legacy rule-only writer
  because `process.stdin.isTTY` is false in spawned shells. No editor wiring, no service
  install — but the user thought they ran "the wizard". `bin/krimto.mjs` now prints a clear
  notice up front when this happens, naming the two ways to actually get the full setup
  (real terminal, or `--yes`).
- **Gap 2 — `krimto_list_scopes` returned bare `[]` and looked broken.** The smoke
  transcript shows the agent inventing an explanation ("scopes aren't configured for your
  identity") that the user understood as "Krimto is broken". `krimtoListScopes` now
  attaches a `hint` field when scopes is empty, telling the agent verbatim that scopes are
  created on first write and to try `krimto_write` to make one appear.
- **Gap 4 — `krimto connect` printed `"KRIMTO_IDENTITY": "you@acme.com"` regardless of
  who ran it.** Pasting the snippet wrote facts under the literal placeholder identity.
  Now reads `git config --global user.email` and substitutes (same lookup the wizard
  uses). Falls back to `you@acme.com` only when git is missing or unconfigured.
- **Gap 5 — `claude mcp add krimto` exit-1 on re-paste.** The wizard's MCP writer got
  this fix in v0.2.19, but the snippet `krimto connect` PRINTS still hit the same
  "already exists in local config" error when an AI agent ran the line verbatim a second
  time. The printed snippet now starts with a guarded `claude mcp remove krimto 2>/dev/null;
  true`, so re-runs are silent no-ops.

### Tests

- `tests/server/tools.test.ts` — two new tests for the v0.2.24 list_scopes hint.
- `tests/integration/connect.test.ts` — rewrote existing tests to `await formatConnect()`
  (now async because it shells out to `git config`); added a new test asserting the
  `claude mcp remove` line precedes the `claude mcp add` line in printed output.

## [0.2.23] — 2026-05-27

### Fixed

- **`krimto init` rerun crashed on macOS with `Bootstrap failed: 5: Input/output error`.**
  Reported from a real smoke test after the v0.2.22 release. Root cause: `launchctl bootstrap`
  returns EIO when the LaunchAgent is already loaded. The wizard's reconfigure path called
  `bootstrap` unconditionally, so every second `krimto init` on a machine with the service
  installed died at the install step. Fix: `installLaunchd` now runs `launchctl bootout`
  best-effort before `bootstrap`, so the next bootstrap always starts from a clean slate.
  First-install case (nothing loaded) → bootout errors and is silently ignored; reconfigure
  case → bootout succeeds, bootstrap reloads the latest plist content.

### Tests

- `tests/integration/service-reconfigure.test.ts` — four new tests mocking `child_process`
  to verify the bootout-then-bootstrap order on first install + reconfigure, that the plist
  is written before any launchctl call, and that dryRun still skips both invocations.

## [0.2.22] — 2026-05-27

### Added

- **`krimto whoami` and `krimto set identity <email>`** — two new Phase B identity commands.
  Motivated by the v0.2.21 "data-location surprise" class of bug: users end up with two
  scopes (`user/lpdthemes@gmail.com` + `user/user@localhost`) because different surfaces
  saw different identities, and they only notice weeks later.
  - `krimto whoami` reads `KRIMTO_IDENTITY` from every place it's been written (each
    editor's MCP config + the launchd/systemd service unit) and reports the active
    identity. Flags **mismatches** between sources — exits 1 when sources disagree.
  - `krimto set identity <email>` changes `KRIMTO_IDENTITY` everywhere atomically:
    surgical mutation of each editor's MCP `env` block (preserves other env keys like
    `KRIMTO_EMBED_PROVIDER` and `KRIMTO_EMBED_API_KEY` — users don't silently lose their
    embeddings setup), plus uninstall + reinstall of the always-running service with the
    new env. HTTP-transport entries are left alone (identity lives in the service env).
  - Existing notes do NOT migrate — the folder for the old identity stays put under
    `~/.krimto/user/<old-email>/`. The summary calls this out explicitly so it's not a
    surprise; an interactive `confirm()` prompt requires consent unless `--yes` is passed.
- New file: `src/cli/whoami.ts`. New file: `src/cli/setIdentity.ts`.
- Two-word dispatch added for `set identity` in `bin/krimto.mjs` (mirrors `team init` /
  `team disband` from v0.2.17.1). `--help` now lists both commands under an "Identity"
  section.

### Tests

- `tests/integration/identity.test.ts` — 11 new tests covering:
  - whoami: empty machine, single registered editor, HTTP-entry "(uses service identity)"
    behavior (no false mismatch on always-running setups), mismatch detection
  - set identity: rejects non-email, refuses when Krimto isn't set up, no-change when
    identity already matches, single-editor update, **preserves `KRIMTO_EMBED_*` keys**
    when updating identity, leaves HTTP entries alone, honors the `confirm()` abort path

## [0.2.21] — 2026-05-27

### Fixed

- **Wizard header showed `v0.2.17` regardless of the actual installed version.** A hardcoded
  version string survived every bump from v0.2.18 through v0.2.20. `src/cli/wizard.ts` now imports
  `KRIMTO_VERSION` from `src/server/index.ts` and renders it dynamically. Same hardcoded literal
  fix applied to `src/cli/status.ts` (three places: "✅ Krimto is working", "✅ Krimto is configured",
  "⚠️ Krimto needs attention").

### Added

- **Machine-level editor detection** (`EditorEnvironment.installed`). Catches the case where
  the user is editing in Cursor (or Claude Code) but the project folder hasn't picked up an
  editor-specific marker file yet — e.g. a fresh `krimto-smoke-N` dir.
  - Each editor now has TWO signals:
    - `present`: project-level file marker (existing — `.cursor/`, `CLAUDE.md`, etc. in cwd)
    - `installed`: home-dir footprint (new — `~/.cursor/`, `~/.claude.json`, `~/.codex/`,
      `~/.gemini/`)
  - The wizard's checkbox preselects an editor when `present || installed`. The non-interactive
    `--yes` path uses the same combined signal, so multi-editor users land on the right
    auto-tick set even before they've worked in the project.
  - Scan output now has three states instead of two:
    - `✓ Editor — detected in this project`
    - `~ Editor — installed (machine-wide)`
    - `– Editor — not found`
- Same preselect logic propagated to `editors.ts` (Phase B shortcut) and `join.ts` (teammate
  flow). All four wizards now agree on detection rules.

### Tests

- `tests/integration/init.test.ts` — three new tests for `installed`:
  - Cursor `installed=true` via `~/.cursor/` in homeDir, with no project-level signal
  - Claude Code `installed=true` via `~/.claude.json` in homeDir
  - Baseline: empty homeDir → all editors `installed=false` (regression-locks the heuristic)

Total suite: **550 passing**. Typecheck + lint clean.

## [0.2.20] — 2026-05-27

### Changed (smart default for multi-editor users)

- **`krimto init` now defaults to "Always running" when 2+ editors are selected.** Single-editor
  setups still default to "As needed" (stdio) — that's simpler and avoids the launchd/systemd
  install. But stdio Krimto holds a single-writer lock on the data dir, which means only ONE
  editor can use it at a time. With 2+ editors, the second one to call wins a `Failed to
  connect` from the MCP layer until the first exits — a footgun for any user with Cursor +
  Claude Code (etc.) open simultaneously.

  The fix applies to both interactive (`runInitWizard` → `askRunMode`) and non-interactive
  (`runInitNonInteractive` invoked by `--yes`):
  - The interactive prompt's choice text now warns about the lock contention when 2+ editors
    are picked, and the recommended-asterisk moves from "As needed" to "Always running".
  - The non-interactive `--yes` path picks `always-running` automatically when `editors.length
    >= 2`. Tests that want the old behavior pass `runMode: "as-needed"` explicitly; CI/Docker
    that don't want a real service install pass `dryRun: true`.

  Reconfigure (`init` on a configured machine, "Change settings" option) still honors the
  user's saved `snapshot.runMode` — we don't override an explicit prior choice.

  Source: `src/cli/wizard.ts` (`askRunMode` signature now takes `editorCount`; `runFreshWizard`
  computes `smartDefault`; `runInitNonInteractive` uses the same fallback).

### Tests

- `tests/integration/init-wizard.test.ts` — three new tests:
  - 1 detected editor → `runMode = "as-needed"`, no service install
  - 2+ detected editors → `runMode = "always-running"`, service install fires
  - Explicit `runMode` override wins over the smart default

Total suite: **547 passing**. Typecheck + lint clean.

## [0.2.19] — 2026-05-27

### Fixed

- **`krimto init` reconfigure was broken on Claude Code projects.** Re-running
  `krimto init` (or `krimto editors`, or the wizard's "Change settings" path) in any project
  that had previously registered Krimto with Claude Code failed with:

      Failed to register Krimto with claude-code via `claude`:
      Command failed: claude mcp add krimto -- npx -y @krimto-labs/krimto
      MCP server krimto already exists in local config

  Claude Code's `mcp add` is strict — it refuses to overwrite an existing entry, and there's
  no `add-or-update` verb. The fix is in `writeMcpConfig` (`src/cli/mcpConfig.ts`): when the
  wire method is `cli`, we now run `claude mcp remove krimto` first, silently swallowing the
  "not found" case from fresh setups. Reported by smoke-testing in a second project scope.
  Verified by a new test that mocks Claude Code with a tiny shell script and re-runs
  `writeMcpConfig` twice in a row — both succeed.

Total suite: **544 passing**.

## [0.2.18] — 2026-05-26

Consolidated npm release of the entire v0.2.17 development series — the prerelease tags
`0.2.17`, `0.2.17.1`, `0.2.17-2`, `0.2.17-3`, `0.2.17-4`, and `0.2.17-5` were internal phase
markers; this is the single SemVer-clean version that ships to the npm registry.

What's in it (already detailed below, per phase):
- **Phase A** — Wizard-driven `krimto init` (5 questions, preselected defaults, `--yes` for CI).
- **Phase B** — Shortcut commands: `editors` / `search` / `service` / `reset` (`--wipe-notes` uses
  atomic mv to a recoverable trash sibling, never `rm -rf`).
- **Phase C** — Team-mode wizard: `team init` (admin) + `join` (teammate) + `team disband` (per-machine step-back).
- **Phase D** — Per-note CLI: `notes` / `edit` / `mv` / `supersede` / `tag` — daily editing from
  the terminal without opening the browser.
- **Phase E** — Notes-app `/ui`: plain-English scope labels (Just me / team name / org name),
  inline Edit + Move + Delete on every note, dedicated `/ui/settings` page consolidating the
  engineering panels.

Plus the `edit`/`supersede` `spawnEditor` bug fix (the `execFile` + bad pipe statement that
crashed Node after the file was edited).

23 new source files, 9 new test files, suite grew 399 → 543 tests. `@inquirer/prompts` (MIT)
is the only new runtime dependency. No architecture changes — pure CLI/web surface evolution
over the v0.2 storage + index + access layers. See the per-phase entries below for the full
detail.

## [0.2.17-5] — 2026-05-26

### Added

Phase E.4 of the v0.2.17 plan (deferred from v0.2.17-3) — the `/ui/settings` consolidation.
`/ui/facts` becomes notes-focused; the engineering panels move to a dedicated page reachable
from the nav.

- **`/ui/settings`** — new route that composes the engineering panels in one place:
  - "Shared memory for your team's AI" explainer (How Krimto works)
  - "Behind the scenes — your data, your files" (markdown / git / index storage explainer)
  - Status panel (git remote + embeddings — green/gold/red dots)
  - Recent activity (full tail — last 50 MCP calls)
  - Quick links to API keys, Connect, and Team admin (when admin)
  Source: `settingsBody` in `src/web/views.ts`; route handler in `src/web/router.ts`.
- **`/ui/facts` slimmed to notes-only**. The five engineering panels are gone. What's left:
  the hijack warning (kept — it's an urgent diagnostic), the search box, the scope cards,
  the flat notes list, plus a one-line "Last MCP calls" blurb that links to `/ui/settings`
  for the full activity feed. The empty-store path still renders `gettingStartedPanel`.
- **Nav** — `Settings` link added between `Keys` and `Team` (`src/web/html.ts`).

### Tests

- `tests/integration/web.test.ts` — extended with three new tests:
  - `/ui/settings` renders the moved panels + the quick-links section.
  - `/ui/facts` no longer renders the heavy panels (regression-locking the move).
  - The Settings link appears in the nav on every authenticated page.

Total suite: **543 passing**. `pnpm typecheck` + `pnpm lint` clean.

## [0.2.17-4] — 2026-05-26

### Added

Phase B of the v0.2.17 plan (originally deferred — landing now). Four targeted shortcut
commands that re-run individual questions from the Phase A wizard, plus a machine-level reset.
Each is a thin orchestrator over Phase A primitives (no new write logic).

- **`krimto editors`** — change which editors are connected without re-running the whole
  5-question wizard. Renders the checkbox prompt with currently-connected editors preselected.
  Apply diffs the new selection against the current state: newly-checked editors get
  `writeMcpConfig` + `applyRule`; newly-unchecked get `removeMcpConfig` + `removeRule`. Source:
  `src/cli/editors.ts`.
- **`krimto search`** — flip between Keyword and OpenAI without re-running setup. Patches the
  `KRIMTO_EMBED_*` env block on each connected editor's MCP config (stdio entries only — HTTP
  team mode carries identity via the bearer header). Verifies the OpenAI key via
  `runSetupEmbeddings` before persisting. Source: `src/cli/searchSettings.ts`.
- **`krimto service`** — switch run mode (as-needed / always-running / manual). Installs or
  uninstalls the platform service (launchd / systemd / schtasks) to match. No-op when the
  current state already matches the requested mode. Source: `src/cli/serviceCmd.ts`.
- **`krimto reset`** — machine-level wipe of Krimto's *config*. Disconnects every editor,
  strips standing rules from the current project, uninstalls the background service, and
  wipes the local `keys.json`. Default-N confirmation. Critically, it does NOT touch the
  notes folder, `members.yaml`, or the team's git history. Source: `src/cli/reset.ts`.
- **`krimto reset --wipe-notes`** — adds a second, explicit confirm and atomically moves the
  data dir to a timestamped trash sibling (`<dataDir>.trash-<ts>`). The notes stay on disk
  (recoverable) until the user deletes the trash dir manually — no one-key-press data loss.
- **`krimto reset --yes`** — skip both confirmations. For scripts and CI.
- **Bin dispatch** adds 4 branches (`editors`, `search`, `service`, `reset`). Existing verbs
  (`setup-remote`, `setup-embeddings`) remain unchanged.

### Tests

- `tests/integration/shortcuts.test.ts` — one consolidated file with one describe block per
  command. Each tests both `applyXxx` (pure, no prompts) and `runXxx` (interactive, with
  mocked `@inquirer/prompts`). Covers add/remove diff, key-verification injection, dryRun
  service install, and the `--wipe-notes` trash-move path.

Total suite: **540 passing**. `pnpm typecheck` + `pnpm lint` clean.

## [0.2.17-3] — 2026-05-26

### Added

Phase E (partial) of the v0.2.17 plan — the `/ui` notes-app surface starts catching up to the
CLI changes Phase D delivered. Web users now get the same plain-English scope labels and the
same per-note Edit/Move actions the journey doc §04 promised. (Full settings-page consolidation
is deferred to a follow-up — the engineering panels stay on `/ui/facts` for now.)

- **Plain-English scope labels in `/ui`.** `factsList`, `scopeList`, and `factDetail` now render
  scopes via the new `scopeLabel` helper (`src/access/scopeLabels.ts`):
  - `user/<viewer-email>` → "Just me"
  - `user/<other-email>` → the literal email (when an admin sees a teammate's personal scope)
  - `team/<slug>` → the team's `name` from `members.yaml`, falling back to `team/<slug>`
  - `org/<slug>` → the org's `name`, falling back to `org/<slug>`
  Author column also renders "you" for the viewer's own facts. Source: `src/web/views.ts`.
- **Inline Edit form on `/ui/facts/:id`.** When the viewer has `canWrite` on the fact's scope,
  a `<details>` block exposes a textarea pre-filled with the current body. POST goes to a new
  route `/ui/facts/:id/edit` which calls the new `editFact()` helper. Body validation: empty
  bodies return 422; forbidden returns 403; not-found returns 404. Source: `src/server/editFact.ts`.
- **Inline Move dropdown on `/ui/facts/:id`.** Same gating. The dropdown lists every scope the
  viewer can write to, minus the current scope (computed via a new `writableScopeOptions` helper
  in the router that mirrors `writableScopesFor` in `src/server/tools.ts`). POST `/ui/facts/:id/move`
  calls the new `moveFact()` helper which preserves the id, bumps `updated`, writes the new file,
  unlinks the old, and stages both halves in git. Source: `src/server/moveFact.ts`.
- **`src/access/scopeLabels.ts`** — extracted from `src/cli/cliRuntime.ts` so both the CLI
  (`krimto notes`) and the web (`/ui/facts`) share one source of truth for label computation.
  `cliRuntime.ts` re-exports the helper so existing CLI callers keep working.

### Tests

- `tests/web/views.test.ts` — extended `factsList` tests with plain-English label assertions;
  new factDetail tests for the Edit form, Move dropdown, scopeLabel rendering, and the
  canEdit gating.
- `tests/integration/web.test.ts` — added Edit + Move end-to-end tests (POST round-trips, 422
  on empty body, 422 on invalid scope, unreadable-fact 404). Verified that the writable-scopes
  dropdown excludes the current scope.

Total suite: **523 passing**. `pnpm typecheck` + `pnpm lint` clean.

### Deferred

- `/ui/settings` route + consolidation of the engineering panels (Status, Behind-the-scenes,
  Recent activity, Hijack warning, How-Krimto-works) into one page. The panels currently still
  live on `/ui/facts`. Will revisit if usage signals demand it.

## [0.2.17-2] — 2026-05-26

### Added

Phase D of the v0.2.17 plan — the per-note CLI commands (`docs/krimto-v0.2.17-maria-journey.html`
§04 "Door 2"). Lets a terminal-resident user list, edit, move, supersede, and tag notes without
opening the browser dashboard. Each command wraps existing internals; there's no new write
logic — just a CLI presentation over the canonical pipeline.

- **`krimto notes [query]`** — read-only listing. With no args: every readable note grouped by
  plain-English scope label (`Just me` / team name / org name from `members.yaml`). With a
  query arg: `krimtoRecall` ranked results. SQLite WAL allows concurrent readers, so this is
  safe to run while a server is running. Source: `src/cli/notes.ts`.
- **`krimto edit <id>`** — opens the fact's `.md` in `$EDITOR`; on save, validates frontmatter,
  restores immutable fields (id / scope / created / author), bumps `updated`, reindexes, and
  stages the change in git. Refuses if a Krimto server holds the lock. Source: `src/cli/edit.ts`.
- **`krimto mv <id> <new-scope>`** — moves a fact between scopes while preserving its id. `user/me`
  resolves to the caller's identity. Refuses if `canWrite` fails on either side. Goes through the
  write Serializer so the file move + index update + git staging are atomic. Source: `src/cli/mv.ts`.
- **`krimto supersede <id>`** — opens `$EDITOR` with the old body, then calls the existing
  `krimtoSupersede` MCP tool function. Old version stays in git history (and in the index, hidden
  from recall by the existing `supersededIds` filter). Source: `src/cli/supersedeCmd.ts`.
- **`krimto tag <id> +new -old ...`** — add or remove tags via frontmatter rewrite. Validates the
  lowercase-kebab-case rule (same as `validateFrontmatter`); refuses the whole batch on the first
  invalid tag instead of half-applying. Source: `src/cli/tag.ts`.
- **Shared CLI runtime** — extracted `buildCliContext` + `getLockHolder` + `scopeLabel` into a new
  `src/cli/cliRuntime.ts`. Five commands share the setup (open SQLite index, load membership,
  build `ToolContext`, optionally wire `CommitBatcher`) instead of each copying 30 lines from
  `deleteFact.ts`. Existing CLI commands (`rm`, `reindex`) can migrate to this later if useful.

### Tests

- `tests/integration/per-note-cli.test.ts` — one consolidated file with one describe per command.
  Each test seeds facts via `krimtoWrite` (the canonical write path) so the SQLite index,
  markdown directory, and git repo are consistent.
- `notes`: empty store, grouped listing, search query, no-match path.
- `edit`: editorImpl injection for non-TTY testing, `updated`-bump verification, no-change path,
  not-found path, immutable-fields-restored path.
- `mv`: cross-scope move with id preservation, invalid-scope rejection, same-scope no-change,
  `user/me` alias resolution.
- `supersede`: replacement with new id, no-change path.
- `tag`: add/remove specs, malformed spec rejection, kebab-case validation, no-change.

Total suite: **512 passing**.

### Refactors (no behavior change)

- `src/cli/edit.ts` and `src/cli/supersedeCmd.ts` now also accept an `editorImpl` callback option
  alongside the `editor` command-string. Tests inject the callback; production omits it and falls
  back to the execFile-based default. Lets us cover the editor flow without spawning a real
  editor in CI.

## [0.2.17.1] — 2026-05-26

### Added

Phase C of the v0.2.17 plan — the team-mode wizard (`docs/krimto-v0.2.17-maria-journey.html`
§05). The Phase A wizard pattern (preselected defaults + inline explanations) extended to
the team door, so admins onboard their team with the same UX shape they already learned.

- **`krimto team init`** — interactive admin-side wizard. Asks: admin email (defaults to
  `git config user.email`), team slug, optional team display name, optional git remote URL,
  initial teammate emails (comma-separated). Composes existing primitives — `bootstrapAdmin`,
  `addUser`, `createTeam`, `ApiKeyStore.issue`, `runSetupRemote` — into one apply step. Prints
  the admin key + per-teammate keys + a copy-paste DM template ending with the
  `krimto join --server <host> --key <key>` command. Source: `src/cli/teamInit.ts`.
- **`krimto join --server <url> --key <key>`** — teammate-side: detects this machine's editors,
  writes an HTTP-transport MCP entry pointing at the team server with a `Bearer` header, and
  applies the standing rule. Reuses Phase A's `writeMcpConfig` so the JSON-merge idempotency
  carries over. When multiple editors are detected, asks once which to wire; with one detected
  it just goes. `normalizeServerUrl` accepts `host:port`, `http://host:port`, or `.../mcp` and
  always lands on the canonical `<base>/mcp` shape. Source: `src/cli/join.ts`.
- **`krimto team disband`** — per-machine step-back from team mode to solo. Rewrites each
  editor's HTTP MCP entry as stdio (with the user's identity); leaves notes, `members.yaml`,
  keys, and the team's git remote untouched. The narrower-scope sibling to a future
  `krimto reset` (Phase B). Pass `--yes` to skip the confirm prompt. Source:
  `src/cli/teamDisband.ts`.
- **Shared prompt helpers** — extracted `WizardIO` + `defaultIO` + `isExitPrompt` into a new
  `src/cli/promptHelpers.ts` so the four wizards (init, team init, join, team disband) share
  one I/O contract and one Ctrl-C-detection rule. `src/cli/wizard.ts` re-exports `WizardIO`
  for back-compat.
- **Two-word command dispatch** in `bin/krimto.mjs`: `team init` and `team disband` are now
  resolved by collapsing `argv[2]+argv[3]`. `krimto team` (bare) prints usage. The `join` verb
  is single-word and reads `--server` + `--key` flags.

### Tests

- `tests/integration/team-init.test.ts` — apply-step yaml/keys assertions, idempotency, server
  host inference, and the full interactive flow with mocked prompts (Ctrl-C path included).
- `tests/integration/team-join.test.ts` — URL normalization, HTTP entry shape, bearer header,
  invalid-key guard, Claude Code dry-run, and the multi-editor checkbox flow.
- `tests/integration/team-disband.test.ts` — HTTP-to-stdio rewrite, multi-server preservation,
  no-change for already-solo editors, confirm gate.

Total suite: **493 passing**.

## [0.2.17] — 2026-05-26

### Added

The wizard-driven onboarding redesign (Phase A of the v0.2.17 plan — see
[`docs/krimto-v0.2.17-maria-journey.html`](docs/krimto-v0.2.17-maria-journey.html) for the full
journey, [`/Users/paulbuiko/.claude/plans/crispy-inventing-catmull.md`](#) for the implementation
plan). Six commands collapse into one interactive wizard with preselected defaults and inline
plain-English explanations.

- **`krimto init` is now an interactive 5-question wizard** (TTY-only; non-TTY callers and the
  legacy `--all` / `--minimal` flags get the v0.2.16 rule-only path unchanged). The wizard asks:
  (1) which editors to connect, (2) how Krimto should run (as-needed / always-running / manual),
  (3) just-me or team, (4) keyword vs semantic search, (5) a final summary + confirm. Each
  question carries a preselected default and a one-line "you can change this later" note.
  Powered by `@inquirer/prompts@^7` (MIT). Source: `src/cli/wizard.ts`.
- **`krimto init --yes`** — non-interactive applies all defaults. CI/scripts use this.
- **Self-aware rerun.** Running `krimto init` on an already-configured machine shows a menu:
  refresh the standing rule, change settings (re-runs wizard with current values pre-filled),
  view status, or quit. Source: `detectExistingSetup` in `src/cli/init.ts`.
- **`detectEditorEnvironments(cwd, homeDir)`** in `src/cli/init.ts` — extends the v0.2.16
  `detectEditorTargets` with MCP-config paths + wire method (`json` for Cursor, `cli` for
  Claude Code, `null` for Gemini CLI and Codex where wiring is deferred to a follow-up).
- **`src/cli/mcpConfig.ts`** — idempotent MCP-config writer. Reads/writes/removes the `krimto`
  entry from each editor's MCP config file. Preserves other servers. JSON method (Cursor):
  direct merge; CLI method (Claude Code): shells out to `claude mcp add krimto -- ...`;
  manual method (Gemini/Codex): prints a copy-paste snippet. Includes `dryRun` mode for tests.
- **`src/cli/service.ts`** — three-platform service installer for "Always running" mode:
  macOS launchd (`~/Library/LaunchAgents/com.krimto.server.plist`), Linux systemd-user
  (`~/.config/systemd/user/krimto.service`), Windows Task Scheduler (`schtasks /SC ONLOGON`).
  Every install/uninstall path has `dryRun` + `platform` overrides so all three are tested on
  a single CI runner.
- **`krimto status`** — new consolidated diagnostic that replaces the four separate v0.2.16
  commands (`verify-connection`, `where`, `storage`, `usage`) with one screen. Reports:
  connections (which editors are wired), storage (data dir + git log + index), optional
  add-ons (team sync, semantic search), recent activity (last 5 min), and the hijack warning.
  Source: `src/cli/status.ts`. The four legacy verbs still work unchanged.
- **Structured MCP entry builders.** `src/server/connect.ts` now also exports
  `stdioMcpEntry` / `httpMcpEntry` (returning the entry object) alongside the existing
  snippet-formatting functions, so the wizard's writer + the legacy snippet printers share
  one source of truth for what a Krimto MCP entry looks like.

### Backward compatibility

Every v0.2.16 CLI verb still works. `krimto init --all` and `krimto init --minimal` behave
exactly as before. Non-TTY callers (`exec` / pipes / Dockerfile RUN) also fall through to
the legacy rule-only path — no existing scripts break.

### Tests

Coverage added for every new file:

- `tests/integration/init.test.ts` — extended with `detectEditorEnvironments`,
  `applyWizardAnswers`, `detectExistingSetup`, `defaultIdentity` tests.
- `tests/integration/init-wizard.test.ts` — new: walks the 5 questions with mocked
  `@inquirer/prompts`, plus the `--yes` non-interactive path and the reconfigure menu.
- `tests/integration/mcp-config.test.ts` — new: round-trips for the JSON method (Cursor),
  the CLI method (Claude Code, dry-run), the manual method (Gemini/Codex). Multi-server
  preservation verified.
- `tests/integration/service.test.ts` — new: dry-run install + uninstall on all three
  platforms via `opts.platform` override.
- `tests/integration/status.test.ts` — new: ok / warning / error paths, hijack detection,
  activity rendering.

Total suite: **463 passing**.

## [0.2.16] — 2026-05-26

### Fixed
- **`krimto init` was silently writing only `.cursor/rules/krimto.mdc` when `.cursor/` existed** in
  the project, even when the user was actually using Claude Code (which reads `CLAUDE.md`).
  Symptom: AUTO MODE appeared broken — Claude Code Sonnet kept routing "remember X" to its built-in
  auto-memory because no rule landed in `CLAUDE.md`. Two fixes:
  - **Default behavior reverted to "write all 4 rule files."** Previous default (write only
    detected editors) failed silently when detection missed the active editor — a near-invisible
    UX bug. The detection-only behavior is now opt-in via `--minimal`. Legacy `--all` still works.
  - **Detection now recognizes `.specstory/` as a Claude Code signal.** SpecStory is Claude Code's
    bundled transcript directory and is a reliable "this project is being used with Claude Code"
    indicator even when no `CLAUDE.md` exists yet. The smoke-5 false-negative (had `.specstory/`
    but only `.cursor/` was detected) is now caught — `--minimal` writes both files.

## [0.2.15] — 2026-05-26

### Added
- **`/ui/facts` shows a flat list of every readable fact** (newest-first, capped at 50 with a
  count indicator) so a user can browse without typing a search query first. Each row links to
  `/ui/facts/:id` where the new Delete button lives. Powered by a new `FactIndex.listFacts()`
  method that excludes superseded + expired entries (same rules as recall).
- **`npx @krimto-labs/krimto rm <id>`** (alias: `delete`) — hard-delete a fact end-to-end. Removes
  the `.md` file, drops the SQLite index entry, and records the deletion as a git commit (old
  content stays in `git log`). Refuses while a Krimto server is running on the data dir (would
  race on the .git/ index); the user must stop the server first. Goes through the write
  Serializer + respects `canWrite` access control. Cleanly handles orphan cases:
  index-only orphan (file already gone) and file-only orphan (index entry missing).
- **`npx @krimto-labs/krimto reindex`** — rebuild `index.db` from the markdown source of truth on
  disk. Closes the user's reported gap: *"I deleted a `.md` file by hand and the index still has
  the old entry."* Prints the delta (`+N added` / `-N orphans dropped`). Also useful for
  embedding-space upgrades and index-corruption recovery. Refuses while a server holds the lock.
- **`/ui/facts/:id` Delete button** — a red 🗑️ "Delete this fact" form on the fact detail page,
  with a `confirm()` prompt and a one-line explanation that old content stays in `git log`. Only
  shown when the viewer can write to that scope (server-checked via `canWrite`). The POST handler
  also requires the viewer to be able to *read* the fact (so org-admins can't delete facts they
  can't see — closes a real semantic gap exposed by tests).
- **`ActivityLog.stats()` counts `krimto_delete` as a write** — keeps the hijack-detection
  warning accurate (a delete is real activity, not a recall-without-write signature).

## [0.2.14] — 2026-05-26

### Fixed
- **All CLI outputs reformatted for clarity.** Previously each command piled on prose (multiple
  sub-sections, ALL-CAPS headers, dense paragraphs). New visual style across every command:
  - Leads with a single ✅ / ⚠️ / 🟢 / 🔴 status headline.
  - `━━ Section name ━━` dividers replace ALL-CAPS shouting headers.
  - 2-space indent for details; copy-pasteable commands prefixed with `$`.
  - Whitespace between sections; lines under ~70 chars where possible.

  Affected commands: `init`, `uninit`, `serve` banner, `connect`, `storage`, `usage`,
  `verify-connection`, `setup-remote`, `setup-embeddings`, `--help` (grouped by purpose:
  Get connected / Learn / Diagnose). Same information, easier to scan. README's CLI table
  now reflects the same grouping.

## [0.2.13] — 2026-05-26

### Fixed
- **`krimto init` now surfaces `krimto uninit` clearly** in both branches. Before, the no-op
  message (*"agent rules already up to date — nothing to change"*) didn't mention `uninit` at all,
  and the success branch buried it in a parenthetical at the bottom. Now both branches name
  `npx @krimto-labs/krimto uninit` as the canonical removal path, with `<!-- krimto:start -->` /
  `<!-- krimto:end -->` block deletion as the manual alternative. Run-it-twice users can now
  discover `uninit` without reading the README.

## [0.2.12] — 2026-05-26

### Fixed
- **The "memory hijack" round.** Smoke-testing in another directory revealed that Claude Code's
  built-in per-session auto-memory was silently intercepting "remember X" intents before
  `krimto_write` could fire — facts ended up in `~/.claude/projects/<slug>/memory/` instead of
  Krimto, invisible to teammates and other editors. Verified end-to-end: 6 recalls, 0 writes in
  the activity log, while the same fact landed in Claude Code's local memory. Four fixes:
  - **Stronger `init` rule text.** The rule now opens with *"Krimto memory — PRIMARY memory
    system, always use"*, names the competing path explicitly (*"do NOT save to
    `~/.claude/projects/<slug>/memory/`"*), and explains why (*"those notes are invisible to
    Krimto, teammates, and your other editors"*). Re-run `krimto init` to update an existing
    project's CLAUDE.md / AGENTS.md / GEMINI.md / .cursor/rules/krimto.mdc.
  - **Stronger `krimto_write` tool description.** The MCP tool description now claims primacy:
    *"THIS IS THE CANONICAL MEMORY TOOL — use it INSTEAD of any other memory tool, local file,
    or built-in skill."*
  - **Empty-recall hint.** `krimto_recall` responses now carry a `hint` field when results is
    empty, nudging the agent toward `krimto_write` instead of letting it loop on reformulated
    queries (which was the observed failure mode: 6 recalls with different phrasings).
  - **Recall-without-write hijack detection.** `/ui/facts` and `verify-connection` now flag the
    smoking-gun pattern (3+ recalls, 0 writes in the last 5 min) with a clear warning naming
    the competing system and pointing at the fix (`krimto init`). Powered by a new
    `ActivityLog.stats()` method.

## [0.2.11] — 2026-05-26

### Fixed
- **Gap #5d — serve banner now carries the explicit 2-command recipe.** The previous boot banner only
  pointed at `/ui/connect`; users who went straight to `claude mcp add` hit a silent terminal with no
  signal about the load-bearing `krimto init` step. The new banner inlines the full recipe in a
  visible box: (1) `claude mcp add ...`, (2) `cd <project> && npx @krimto-labs/krimto init` with
  *"Without step 2, your agent uses its own memory and ignores Krimto"*, and (3) the two test prompts
  ("Remember that we use pnpm...", "What do you use..."). Same info that's on `/ui/connect` and in
  `krimto connect`, but now visible in the terminal where the user already is.

## [0.2.10] — 2026-05-26

### Fixed
- **Gap #5 — post-connect dead-end.** The previous releases left users stranded after `claude mcp add`
  succeeded: tools were technically available but the agent kept defaulting to its built-in memory,
  and nothing pointed at `krimto init`. Three fixes close the loop:
  - **`/ui/connect` now ends with "✅ Connected? Do these three things"** — a copy-pasteable verification
    flow: (1) run `npx @krimto-labs/krimto init`, (2) test write (`"Remember that we use pnpm in this
    repo"`), (3) test recall (`"What do you know about this repo?"`), then check `/ui/facts` Recent
    activity to confirm both calls landed. Points at `verify-connection` if the loop fails.
  - **`krimto connect` CLI output mirrors the same three-step verification** so the terminal-only path
    has the same call-to-action.
  - **First `/mcp` request prints a one-time stderr banner** — *"🟢 Client connected — first MCP
    request received on /mcp. If your agent isn't auto-using Krimto, run `npx @krimto-labs/krimto
    init`."* Single-shot per process, fires on any verb (initialize / tools/list / tools/call). Wired
    via a new `onFirstClient` callback on `buildHttpApp` so it's test-clean.

## [0.2.9] — 2026-05-26

### Fixed
- **README** now reflects the v0.2.8 / v0.2.9 reality. The previous README still described the
  v0.2.7 surface and called several already-shipped v0.2 features ("single Docker image", "web
  UI") "near-term roadmap." Updates: "Try it in 2 minutes" leads with `npx @krimto-labs/krimto
  serve` (no Docker required); new "CLI surface" table lists every subcommand; Option B is rewritten
  around `npx krimto serve`; Web UI section enumerates the new panels (Behind the scenes, Status,
  Recent activity); Promise 5 drops the stale "published pull-image is next" line. No code changes.

## [0.2.8] — 2026-05-26

### Added
- **Eight new CLI subcommands**, all discoverable via `npx @krimto-labs/krimto --help`:
  - `serve` — boot the HTTP server (`/ui`, `/ui/connect`) without cloning the repo or installing Docker.
  - `connect` — print copy-paste Claude Code + Cursor stdio snippets straight to the terminal.
  - `uninit` — clean inverse of `init`: strips the marker-delimited rule block, deletes files that held only the rule.
  - `usage` — long-form guide of the five `krimto_*` tools with copy-paste chat examples for DEFAULT and AUTO modes.
  - `storage` — plain-English explainer of the markdown/git/index storage model, with verify commands and the only two optional env vars to set.
  - `setup-remote <url>` — wire the data dir to a git remote and verify the initial push, with "Common causes" hints on failure.
  - `setup-embeddings` — send a real test embedding to verify a `KRIMTO_EMBED_*` config before turning it on.
  - `verify-connection` — diagnose "is my agent calling Krimto?" by reading the lockfile + activity log (works from any terminal, regardless of how Krimto was launched).
- **`--help` (and `-h` / `help`)** — full CLI surface listed, leading with "TWO WAYS TO USE KRIMTO" (DEFAULT vs AUTO).
- **Three new `/ui/facts` panels** — "Behind the scenes — your data, your files" (markdown/git/index explainer), "Status" (green/gold/red dots for git remote + embeddings), and "Recent activity" (last 5 MCP tool calls with relative timestamps). The fact detail page now shows the absolute source-file path.
- **Data-dir lockfile** — `.krimto/lock.json` records the running Krimto's PID/mode; a second `serve`/stdio launch on the same data dir is refused with a precise error (stop the holder, or `KRIMTO_DATA=<other path>`). Stale locks (dead PID) are auto-replaced; release is automatic on graceful shutdown.
- **Activity log** — every MCP tool call is appended to `.krimto/activity.jsonl` (capped at 200 lines). Powers the `/ui` panel and the `verify-connection` CLI; writes are best-effort and never break a tool call.
- **Auto-detected `init` targets** — `krimto init` now detects the editor (`.cursor/`, `.claude/`, existing `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`, `gemini-extension.json`) and writes only matching rules files instead of all four. `--all` keeps the legacy behavior. No more four random files appearing in a Cursor-only project.
- **`krimto_write` / `krimto_supersede` response fields** — added `absolute_path` and `hint` so the agent can teach the user "this is just a markdown file you can open in any editor." The first save in any process gets an expanded `hint` naming the data dir, git auto-commit cadence, and `krimto --help` pointer.

### Fixed
- **Identity-mismatch warning** — when `KRIMTO_IDENTITY` is unset and the server falls back to the placeholder `user@localhost`, both startup banners now print a ⚠️ block warning that other Krimto processes with a different identity will see different scopes (the silent "/ui is empty even though I saved facts" trap).
- **stdio-vs-HTTP guidance** — the local-mode banner and `/ui/connect` page tell a user who's already connected via stdio not to double-configure with HTTP; the HTTP server is just for the browser dashboard.
- **Self-explanatory `connect` + `init` output** — `connect` now states what `connect` alone gives (tools-on-demand) vs. what `init` adds (automatic recall+save), and explicitly marks `init` as optional. `init` explains what changed in each file and how to remove the rule (delete the marker-delimited block, or use `uninit`).
- **30-second batch-commit lag surfaced** — `krimto storage`'s "HOW TO CHECK IT'S WORKING" section warns explicitly that commits are batched every 30s, so a just-saved fact may not appear in `git log` for ~30s (the `.md` file itself is written immediately).

## [0.2.7] — 2026-05-25

### Added
- `npx @krimto-labs/krimto init` — writes the "always use Krimto" standing rule into a project's agent
  rules files (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `.cursor/rules/krimto.mdc`), idempotently and
  non-destructively. Fixes the discovery problem where an agent routes "remember X" to its own built-in
  memory instead of Krimto. Surfaced on the connect page and in the README.
- `npx @krimto-labs/krimto where` — prints the data directory; the startup banner now shows a
  `💾 Data: <dir>` line, so a stranger isn't surprised about where facts land (they default to
  `~/.krimto`, not the current folder).

### Fixed
- `package.json` `repository.url` now carries the `git+` prefix (removes the npm publish warning).

## [0.2.6] — 2026-05-25

### Added
- First-run experience (the pre–North-Star-B zero-friction gate): a signpost startup banner that names
  `/ui/connect`; a guided Connect page (copy buttons, verify/restart notes, a **"make it automatic"**
  standing-rule for the editor's rules file, and a generic **"any MCP client"** contract for clients we
  haven't shipped a verified snippet for); an empty-dashboard **getting-started guide** that explains
  "AI memory" to a newcomer and walks the first save→recall loop with a "what to expect" line; plain nav
  labels (Memory / Connect / Keys / Team) with per-page purpose lines.
- Multi-arch Docker image (`linux/amd64` + `linux/arm64`) — Apple-Silicon users no longer see the
  platform-mismatch warning.

### Fixed
- Team-mode startup banner prints reissue guidance (`KRIMTO_REISSUE_ADMIN_KEY`) instead of a misleading
  `krm_live_…` placeholder when an admin already exists.

## [0.2.5] — 2026-05-25

### Fixed
- CI: pin the git-sync tests' bare remotes to `main` (`git init --bare -b main`). CI runners default
  `init.defaultBranch=master`, so the harness's remotes mismatched the app's `main` branch and the
  sync/pull tests saw no changes. **App behavior is unchanged** — `GitRepo` already pins `main`; this is
  a test-harness-only fix so the release tag is green on a clean CI runner. (Carries the v0.2.4 feature
  set below.)



### Added
- Connect-your-agent docs + an in-product `/ui/connect` panel with verified copy-paste config for
  **Claude Code** and **Cursor** (local no-key and team variants), including a one-click **"Add to
  Cursor"** deeplink (format verified against Cursor's MCP install-links docs). A "Connect" link is now
  in the dashboard nav.
- Team-mode startup now prints a ready-to-paste MCP config **with the issued key already in it** — no
  more grepping the key out of logs and hand-assembling JSON. Snippets for the banner and the panel come
  from one source (`src/server/connect.ts`) so they can't drift.

## [0.2.3] — 2026-05-25

### Added
- Local mode (the default when no auth env is set): a fresh server runs **without authentication** —
  connect an agent with one line and **no `Authorization` header**, the dashboard opens with **no
  login**, and `GET /` redirects to it. A startup banner spells out the connect line and warns it's
  local/trusted-use only. Set `KRIMTO_BOOTSTRAP_ADMIN` (or `KRIMTO_REQUIRE_AUTH=1`) for the unchanged
  team auth (keys, login, `/admin`).
- A team-first "How Krimto works" dashboard explainer (personal → team → org) and a two-minute solo
  quickstart in the README.

### Fixed
- Git sync pinned to `main` end-to-end (new repos init on `main`; existing repos normalize), fixing the
  branch-name mismatch that broke multi-instance sync (smoke-test-2 Test G).

## [0.2.2] — 2026-05-25

### Added
- Membership management (BUG-5): an admin-only REST API (`/admin/members`, `/admin/keys`,
  `/admin/teams`) and a `/ui/admin` page let org admins add teammates, manage teams, and issue/revoke
  keys — changes take effect **live** (no restart) and `members.yaml` is committed to git (reviewable).
  `src/server/admin.ts`, `src/access/membershipStore.ts`; wired via `AdminContext` in `src/server/index.ts`.
- A data-repo `.gitignore` keeps the key store out of git; the membership commit is path-limited
  (`GitRepo.commitPath`) so it never sweeps up staged facts. Last-org-admin and last-key revokes are
  refused (409).

### Fixed
- Bootstrap (BUG-6): `KRIMTO_BOOTSTRAP_ADMIN` elevates to org-admin only on first boot; afterward it
  just issues a key (non-admins included).

## [0.2.1] — 2026-05-25

### Fixed

- Scope ghosting (BUG-4): an agent guessing `user/me` no longer creates a fact invisible to everyone.
  `user/me`/`user/self` resolve to the caller's own scope, and any write the author couldn't read back
  is refused with the list of scopes they may write to (`src/server/tools.ts`).
- Key lockout (BUG-1): the `/ui` revoke handler refuses to remove your only key (409), and
  `KRIMTO_REISSUE_ADMIN_KEY=<email>` mints a fresh admin key for recovery (`src/web/router.ts`,
  `src/server/bootstrap.ts`).
- Revoke clarity (BUG-2): each revoke button has an aria-label naming its key; the sole-key row shows
  "only key" instead of a revoke button (`src/web/views.ts`).
- Silent git sync (BUG-3): push/pull use the repo's explicit branch (not the remote `HEAD` symref), so
  sync no longer fails silently on a branch-name mismatch; the last pull status is surfaced at
  `/health/ready` as `git_sync` (`src/storage/git.ts`, `src/server/health.ts`).

## [0.2.0]

### Added

Scaffold:
- Claude Code plugin structure (`.claude-plugin/plugin.json`, `skills/`, `agents/`, `commands/`,
  `hooks/`), cross-harness directories, `src/` layout, CI workflow.
- Apache-2.0 license, contributor guidelines (`CLAUDE.md`), and public roadmap.

Memory engine (Tier 1):
- Fact schema (Gap 01): one markdown file per fact with YAML frontmatter, ULID ids, slug
  filenames with collision handling, and field validation.
- Scope convention (Gap 03): `user`/`team`/`org` hierarchy mapping 1:1 to git folders, with
  precedence (user > team > org).
- Hybrid retrieval (Gap 04): BM25 + vector weighted merge, score threshold, temporal decay
  (org-scope evergreen-exempt), hierarchical scope boost, and MMR diversification.
- Markdown-tree storage: read/write/list facts on disk.
- MCP server (Gap 02): five tools — `krimto_write`, `krimto_recall`, `krimto_read`,
  `krimto_supersede`, `krimto_list_scopes` — served over stdio.

Team layer + operations (Tier 2):
- Membership + server-enforced access (Gap 07): `.krimto/members.yaml`, four roles,
  `canRead`/`canWrite` — the API server is the access enforcer, not the filesystem.
- API-key bearer auth (Gap 06): `krm_live_`/`krm_test_` keys, generated + hashed at rest. Wired into
  the HTTP transport — each request's `Authorization: Bearer …` is verified against the key store and
  resolved to the requester's identity + teams (`src/server/tokenVerifier.ts`). The stdio entrypoint
  remains no-auth (identity from `KRIMTO_IDENTITY`) for local use.
- Access enforced across every tool: writes to disallowed scopes are forbidden; recall and
  list_scopes only surface readable scopes; read returns not_found for unreadable facts.
- Pluggable embeddings (Gap 09): lexical-only by default (no key); OpenAI, Voyage, and custom
  OpenAI-compatible adapters; hybrid (vector + lexical) retrieval when a provider is configured.
- Git write coordination (Gap 08): the server is the single writer to git, committing with the
  spec message format.
- Batched git commits: writes are committed in batches (every 30s or 10 writes, configurable via
  `KRIMTO_COMMIT_INTERVAL_MS` / `KRIMTO_COMMIT_MAX_BATCH`) instead of one commit per write, keeping
  history clean. Markdown is written immediately; the commit is the deferred audit step.
- Remote git push: when a remote is configured (`KRIMTO_GIT_REMOTE`), each batch commit is pushed
  to it (self-host SSH deploy-key auth). Push is best-effort — failures are logged and retried on
  the next batch; they never block writes or take the server down.
- Inbound sync: Krimto periodically pulls the remote (`git pull --rebase`, every 60s by default,
  configurable via `KRIMTO_PULL_INTERVAL_MS`) and re-indexes teammates' direct edits — added,
  edited, and deleted facts all show up in search. Pull conflicts are aborted and retried, never
  blocking writes.
- HTTP transport (Gap 02): with `KRIMTO_HTTP_PORT` set, Krimto serves MCP over Streamable HTTP at
  `/mcp` (bearer-authenticated) and exposes `GET /health/live` + `GET /health/ready` (returning
  `{sqlite, index, git_remote}`) — wired in `src/server/http.ts` + `src/server/index.ts`.
- First-run bootstrap (Gap 06): `KRIMTO_BOOTSTRAP_ADMIN=<email>` issues one admin API key (printed
  once) and makes that user an org admin in `.krimto/members.yaml`.
- Docker image (Gap 10): a multi-stage `Dockerfile` (node:22-slim, non-root, git + native deps)
  runs the HTTP server. `docker build -t krimto . && docker run -p 8080:8080 -v ~/.krimto:/data
  krimto` boots, serves `/health/ready`, and persists facts in the `/data` volume (verified
  end-to-end with a real MCP client over HTTP).
- Structured error codes on the MCP surface: `KrimtoError` maps to JSON-RPC errors in the tool
  handlers.
- Rate limiting (Gap 18): set `KRIMTO_RATE_LIMIT_PER_MINUTE` to enforce a per-API-key cap on the
  HTTP `/mcp` route — every response carries `X-RateLimit-*`, and exceeding the cap returns `429`
  with `Retry-After`. Off by default; keyed on the authenticated identity. Wired in
  `src/server/http.ts` + `src/server/index.ts`.
- Opt-in telemetry (Gap 19): set `KRIMTO_TELEMETRY_ENDPOINT` to periodically POST **bucketed,
  content-free** usage counts (version, a stable install id, and size buckets) — never fact content,
  identities, queries, scope paths, or git remotes. Off by default; best-effort (a failed send is
  logged and ignored, never crashing the server). Wired in `src/server/index.ts` (HTTP mode only).
- Web UI (`/ui`): a server-rendered surface where humans sign in with an API key (HMAC signed-cookie
  session), browse/search the facts they can read, view a fact, and list/issue/revoke their own API
  keys. Reads go through the same access-controlled tool functions as MCP, so a human sees only what
  they're entitled to; all rendered content is HTML-escaped. Wired in `src/server/http.ts`; pages in
  `src/web/*`. Set `KRIMTO_SESSION_SECRET` to persist sessions across restarts.
- Docker image publishing (Gap 10): `.github/workflows/docker-publish.yml` builds and pushes the
  image to `ghcr.io/krimto-labs/krimto` on a `v*` tag (runs once the repo has a GitHub remote).

- Persistent SQLite index: FTS5 keyword search + sqlite-vec vector search with an embedding
  cache, built from the markdown files and rebuilt on startup. Recall, read, and list-scopes
  now serve from the index instead of scanning every file.

Verified by 203 tests, including the v0.1 acceptance flow, MCP round-trips over both stdio and HTTP
(with bearer auth), an access-control suite, a hybrid keyword-mismatch retrieval, an HTTP rate-limit
(`429`) end-to-end check, and a web-UI flow (login, scoped browse, fact 404, key revoke, XSS escaping).

_The remaining v0.2 item — actually publishing the pull-image — is tracked in
[ROADMAP.md](ROADMAP.md); the publish workflow is in place and runs once the repo has a remote._

[Unreleased]: https://github.com/krimto-labs/krimto/commits/main
