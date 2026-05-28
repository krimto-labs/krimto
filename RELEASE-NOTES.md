# Release Notes

User-facing notes for each Krimto release. For the full technical changelog see
[CHANGELOG.md](CHANGELOG.md).

## v0.2 — shipped (v0.2.5 → v0.2.40, 2026-05-25 → 2026-05-28)

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

Install instructions and the connect-your-agent guide are in the [README](README.md).
