# Release Notes

User-facing notes for each Krimto release. For the full technical changelog see
[CHANGELOG.md](CHANGELOG.md).

## v0.2 — shipped (v0.2.5 → v0.2.45, 2026-05-25 → 2026-05-31)

The first public release. Krimto is a **team memory layer** you can self-host with `npx`, `pnpm
dev`, or the published Docker image at `ghcr.io/krimto-labs/krimto`:

- Write and recall facts from any MCP-compatible coding agent (Claude Code, Cursor, Codex CLI,
  Gemini CLI, Copilot, OpenClaw, Cline).
- Organize knowledge across **personal**, **team**, and **company** scopes, with the most specific
  scope winning at recall time.
- Every fact is a plain markdown file in git — readable, editable, reviewable via pull request.

**v0.2.17 series (shipped as v0.2.18) — UX redesign.** Six commands collapse into one interactive
wizard (`krimto init`); admin team setup becomes one wizard + one join command (`krimto team init`
/ `krimto join`); `/ui` becomes a notes app (plain-English scope labels, inline Edit/Move/Delete);
per-note CLI (`krimto edit / mv / supersede / tag / notes`).

**v0.2.19 → v0.2.40 — correctness + agent-friendliness.** First-class teardown verbs (`krimto stop
/ start / restart / reset`); Phase B agent flags so every interactive command also has a
non-interactive form (`editors --add`, `service --always`, `search --keyword`, `remote --set`,
…); non-TTY guards so AI agents stop hanging on prompts they can't answer; `krimto whoami` CLI +
`krimto_whoami` MCP tool so agents stop hallucinating identity; editor attribution via User-Agent
sniffing; honest reconfigure menu driven by lock + launchctl reality. **v0.2.36** makes `krimto
team init` restart the running service into team mode itself (no copy-paste recipe, no lock
conflict), saves invite keys to a 0600 backup file, validates the git remote URL at the prompt,
and makes `krimto notes` work from any terminal by falling back to `git config user.email`.
**v0.2.37** adds a retrieval-quality eval and a write-time duplicate backstop: `krimto_write`
now flags a near-duplicate fact in the same scope (a `related` list + a hint to
`krimto_supersede`), so memory doesn't silently accumulate two facts about the same thing
even when the agent forgets to recall first.
**v0.2.38** makes team mode activate **live from `members.yaml`**: `krimto team init` no longer
needs a restart or an env var — the running server notices the new admin (~2s) and flips to
team mode on its own, the wizard verifies it's genuinely enforced before saying "🟢 live", and
the admin's own editor is auto-reconnected with their key.
**v0.2.39** stops the accidental solo→team identity split: `krimto team init` defaults the admin
to the identity that already owns your notes, so going team keeps your account (and notes) instead
of silently creating a second one.
**v0.2.40 — Team UX hardening + agent-safe team setup.** New `krimto team status` (and a Team block
in `krimto status`) shows team mode, members, your role, and whether THIS machine is the server
everyone depends on. `krimto reset` now warns before wiping the keys your whole team logs in with;
`krimto stop` warns before disconnecting teammates; `krimto team disband` explains it's per-machine
and prints the exact reconnect command; and a new `krimto team leave` covers the joined-teammate
case. Team setup is now agent-safe too: `krimto team init --yes --team <slug>` (with optional
`--admin` / `--name` / `--remote` / `--invite a,b`) stands up a whole team with no prompts — the
same no-keyboard bar solo got with `krimto init --yes` — while `team disband` / `team leave` print
`--yes` usage instead of hanging when there's no terminal. Two saving frictions are gone, too: the
**team creator is now a member of the team they create** (so "remember for the team" works for the
admin immediately — no more hand-editing `members.yaml`; re-running `team init` heals older setups),
and **saving to a scope is now discoverable** — `team init` ends with a "How to save notes" guide,
`krimto team status` lists your exact **Save targets** (one line per scope, each team spelled out),
and the agent's tool description + standing rule now route "for the team" / "company-wide" reliably,
asking which team when you belong to more than one. Finally, you can **name your organization** at
team setup — `krimto team init` asks "What's your organization called?" (or pass `--org "Acme Inc"`),
so company-wide notes read as **"Acme Inc (whole org)"** instead of the old `org/default` placeholder;
the path-safe slug is derived from the name you type (no guessing), and if you skip it, `team status`
shows the one command to set it.

**v0.2.41 — git sync made real.** Krimto always auto-committed and auto-pushed your notes, but
pulling teammates' notes was a hidden second switch — gated on an env var no command ever set, with
no "pull now" verb, and `krimto status` reported it wrong. Now **setting a git remote turns on
two-way sync** (auto-push every commit + a running server auto-pulls every ~60s — `krimto remote
--set <url>` or `team init` is all it takes), there's a first-class **`krimto sync`** (alias `pull`)
to pull/push on demand, and `krimto status` shows the truth (`Team sync: ⇅ push + pull · <url>`). A
new teammate who runs their own Krimto now has a clear path: `krimto remote --set <shared-repo>` then
`krimto sync`. The README/usage/help now explain the two ways a team shares memory — one shared
server (thin clients via `krimto join`) vs. each machine syncing over the git remote — and that
personal and team notes live in one data dir and sync together.

**v0.2.42 → v0.2.43 — `/ui` becomes a control panel.** The web dashboard is now where you use and
control Krimto after setup: browse and curate notes (inline tag / edit / move / delete), a Behavior
panel (git remote, sync now, reindex, embedding status), and a loopback-only This-machine panel (run
mode, identity, search provider, data folder, reset) — all brand-aligned, with no third-party
requests.

**v0.2.44 — first-run friction.** A bare MCP install (no `krimto init`) now routes "remember X" to
`krimto_write`: the standing memory directive is advertised at the MCP protocol level, so the agent
gets it without any project file. The startup banner and the first-write hint make it clear your
notes live in `~/.krimto` regardless of which folder you're in; `krimto --help` and `/ui/connect`
show which editors auto-connect vs. need a manual snippet; and the README is a lean newcomer-first
read.

**v0.2.45 — security & correctness hardening.** An audit pass closed the gaps that mattered most for
running Krimto safely and for AI agents driving it. **Security:** the HTTP server now binds to
`127.0.0.1` by default — solo mode is no longer reachable from your network without a key (opening it
to the LAN takes an explicit opt-in); `/ui` has CSRF protection; and the API-key store is written
atomically so concurrent key changes can't corrupt it and lock out a team. **Search:** vector recall is
now scope-aware (your notes aren't crowded out by other scopes in a big team), and `reindex` / `sync` /
`rm` no longer silently turn vector search off. **Sync:** a teammate's update now arrives even while you
have an unsaved edit in flight. **Agents:** the commands that used to freeze a no-keyboard shell
(`set identity`, `remote --remove`, `folder --to`) now print clear flag usage and exit; `stop --yes`
finally takes effect; `edit` / `supersede` accept `--body` (no `$EDITOR` needed); and the setup wizard
no longer crashes if the `claude` CLI isn't installed. **Plus:** superseding a note keeps its tags,
source, and expiry, and the Claude Code plugin now actually registers its MCP server on `/plugin
install`. The index schema (now v3) migrates automatically on first open.

Install instructions and the connect-your-agent guide are in the [README](README.md).
