# Changelog

All notable changes to Krimto are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Krimto adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
