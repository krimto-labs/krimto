# Release Notes

User-facing notes for each Krimto release. For the full technical changelog see
[CHANGELOG.md](CHANGELOG.md).

## v0.2 — shipped (v0.2.5 → v0.2.38, 2026-05-25 → 2026-05-28)

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

**v0.2.19 → v0.2.38 — correctness + agent-friendliness.** First-class teardown verbs (`krimto stop
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

Install instructions and the connect-your-agent guide are in the [README](README.md).
