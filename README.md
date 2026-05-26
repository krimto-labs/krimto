# Krimto

> **Krimto — open-source team memory for AI coding agents.** Personal, team, and org knowledge your
> agents share, in plain markdown you own (git-backed, Apache-2.0). **Try it solo in two minutes, then
> bring your team.**

One shared brain for every agent at your company. Every agent at every team writes facts to one
place and reads the right slice of it — Alice's preferences override the team's defaults, the team's
conventions override the org's standards, and every fact carries a paper trail (author, source,
timestamp, reviewer).

> **Where we are:** the **v0.2.17 series** (`0.2.17` through `0.2.17-5`) is fully shipped. Everything
> from v0.2.16 (markdown-in-git storage, `user → team → org` hierarchy, hybrid retrieval, server-enforced
> access, two-way git sync, MCP over stdio + HTTP, the Docker image, the web UI, the complete CLI)
> is still here, plus a substantial UX redesign on top. What's new in the v0.2.17 series:
>
> - **One-command interactive setup wizard** (`krimto init`) — five questions with preselected
>   defaults; absorbs `connect`, `init`, `setup-remote`, and `setup-embeddings` into one flow.
> - **Team-mode wizard** (`krimto team init` / `krimto join` / `krimto team disband`) — admins
>   onboard their team in one command; teammates join with a single line from a DM template.
> - **Per-note CLI** (`krimto notes` / `edit` / `mv` / `supersede` / `tag`) — browse, search,
>   and edit notes from the terminal without opening the browser.
> - **Settings shortcuts** (`krimto editors` / `search` / `service` / `reset`) — change one
>   thing without re-running the whole wizard. `reset` cleanly disconnects + uninstalls; `--wipe-notes`
>   moves data to a recoverable trash sibling, never `rm -rf`.
> - **Notes-app `/ui`** — plain-English scope labels (Just me / Team name / Org name), inline
>   Edit + Move + Delete on every note, and a consolidated **Settings** page for the engineering
>   panels.
>
> See [ROADMAP.md](ROADMAP.md), [CHANGELOG.md](CHANGELOG.md), and
> [docs/krimto-v0.2.17-maria-journey.html](docs/krimto-v0.2.17-maria-journey.html) for the design
> rationale and what each release added.

## Try it in 90 seconds (solo, no account)

```bash
npx @krimto-labs/krimto init
```

That's it. The wizard scans your machine, then walks you through 5 questions — each one has a
preselected default and a plain-English explanation. Hit Enter five times if our defaults look
right and your AI has a memory.

What you'll be asked:

| Question | Default | What it means |
|---|---|---|
| Which editors? | (detected ones) | Cursor / Claude Code / Codex / Gemini CLI — toggle which ones get Krimto wired in. |
| How should Krimto run? | As needed | Editor launches it on demand. Pick "Always running" to install a launchd/systemd service. |
| Who's this for? | Just me | Solo mode (no auth). You can flip to team mode any time — facts you save now will stay. |
| Smarter search? | Keyword (free) | Pick OpenAI to enable semantic search. Same key you'd use for GPT. |
| Apply? | Yes | Wizard writes the editor's MCP config + the standing rule, then prints what changed. |

After the wizard finishes:

```bash
"Remember that our staging DB resets every Sunday."   # in any chat
# new chat:
"What do you know about staging?"                     # → it remembers
```

Look at what was saved with **`krimto notes`** or **`krimto ui`** (opens `http://localhost:8080`).
Diagnose with **`krimto status`** — one screen tells you what's wired, what's configured, and
what your agent has been calling.

**Want a server with the browser dashboard?**
`npx @krimto-labs/krimto serve` (defaults to port 8080), or Docker:
`docker run -d -p 8080:8080 -v ~/.krimto:/data ghcr.io/krimto-labs/krimto:latest`.

**Want to bring teammates in?** `krimto team init` walks you through it (admin email + team slug
+ optional git remote + teammate emails). Each teammate runs `krimto join --server <url> --key
<key>` from the DM template the wizard prints. Step back any time with `krimto team disband`
(notes are preserved). All shipped in v0.2.17.1.

**Power-user / CI:** `npx @krimto-labs/krimto init --yes` skips all prompts and applies
defaults non-interactively. `--all` and `--minimal` keep their v0.2.16 meaning.

## Connect your agent

Krimto is one MCP server — point any client at `http://localhost:8080/mcp`. Verified for **Claude Code**
and **Cursor**:

**Claude Code** (local, no key):

```bash
claude mcp add --transport http krimto http://localhost:8080/mcp
```

**Cursor** (local, no key) — add to `~/.cursor/mcp.json` and restart Cursor:

```json
{ "mcpServers": { "krimto": { "url": "http://localhost:8080/mcp" } } }
```

…or one-click: open **http://localhost:8080/ui/connect** and click **Add to Cursor**.

**Team mode** (after `KRIMTO_BOOTSTRAP_ADMIN`): connecting needs your API key. The server prints a
ready-to-paste config (with the key) on boot, and `/ui/connect` shows it too. Add the key as a header:

- Claude Code: append `--header "Authorization: Bearer krm_live_…"`
- Cursor: add `"headers": { "Authorization": "Bearer krm_live_…" }` to the server block

Other clients (Codex, Gemini CLI, Copilot, Cline) use the same `url` (plus the `Bearer` header in team
mode); those are best-effort and not yet individually verified.

### Make it automatic

By default your agent uses Krimto only when you ask ("use krimto to remember X"). One command, run
once in your project, makes it call Krimto **on its own** (recall before tasks, write when you say
"remember"):

```bash
npx @krimto-labs/krimto init
```

`init` auto-detects which editor you're using (`.cursor/`, `.claude/`, existing `CLAUDE.md` /
`AGENTS.md` / `GEMINI.md`, `gemini-extension.json`) and writes the rule only into the files that
match. Pass `--all` to write to every supported rules file. Change your mind later? Run
`npx @krimto-labs/krimto uninit` to cleanly strip the rule (and delete files that held only it).

The rule it writes:

```
# Krimto memory — always use
- Before a task, call krimto_recall to load what we already know.
- When I say "remember", or you learn a durable fact, call krimto_write
  (user/me = personal, team/<slug> = shared).
- Respect precedence: user beats team beats org.
- Don't save secrets or one-off chatter.
```

The in-product **Connect** page (`/ui/connect`) shows this same rule with a copy button.

### The CLI surface

Everything is reachable via `npx`. Run `npx @krimto-labs/krimto --help` for the full list. All
commands print clean, sectioned output with ✅ / ⚠️ / 🟢 status indicators and copy-paste shell
commands. Grouped by purpose:

**Get connected (start here)**

| Command | What it does |
|---|---|
| `init` | Interactive setup wizard — five questions, preselected defaults. Connects detected editors, applies the standing rule, optionally installs a background service. `--yes` skips prompts; legacy `--all` / `--minimal` still work. |
| `serve` | Start the HTTP server (port 8080) + browser `/ui` dashboard |
| `connect` | Print copy-paste config for Claude Code & Cursor (manual path) |
| `uninit` | Strip the standing rule from this project's rules files |

**Daily use** (v0.2.17-2 Phase D)

| Command | What it does |
|---|---|
| `notes [query]` | List notes grouped by plain-English scope (`Just me` / team name / org name). With a query: ranked search via `krimto_recall`. |
| `edit <id>` | Open the fact's `.md` in `$EDITOR`; reindexes on save. Validates frontmatter; restores immutable fields. |
| `mv <id> <scope>` | Move a note between scopes (id preserved). Refuses if `canWrite` fails on either side. `user/me` resolves to the caller's identity. |
| `supersede <id>` | Replace a note with a new version. Old version stays in git history + index (hidden from recall). |
| `tag <id> +new -old ...` | Add or remove tags via frontmatter rewrite. Lowercase kebab-case enforced. |

**Team mode** (v0.2.17.1 Phase C)

| Command | What it does |
|---|---|
| `team init` | Admin-side wizard: admin email, team slug, optional git remote, initial teammates. Prints the admin key + per-teammate keys + a copy-paste DM template. |
| `join --server <url> --key <key>` | Teammate-side: detects editors, writes HTTP MCP config with the bearer header + the standing rule. |
| `team disband [--yes]` | Per-machine step-back to solo mode: rewrites HTTP MCP entries as stdio. Notes / `members.yaml` / git history untouched. |

**Change settings** (v0.2.17-4 Phase B)

| Command | What it does |
|---|---|
| `editors` | Add or remove editor connections (checkbox prompt with current state preselected). |
| `search` | Flip between Keyword and OpenAI search. Verifies the OpenAI key before persisting. |
| `service` | Switch run mode (as-needed / always-running / manual). Installs or uninstalls the platform service. |
| `reset [--yes] [--wipe-notes]` | Disconnect from all editors + uninstall service + wipe local keys. `--wipe-notes` atomically moves the data dir to a timestamped trash sibling (recoverable). |

**Diagnose**

| Command | What it does |
|---|---|
| `status` | One-screen consolidator (v0.2.17): connections, storage, optional add-ons, recent activity, hijack warning. |
| `verify-connection` / `where` / `storage` / `usage` | Legacy verbs — still work, point at `status` for the consolidated view. |
| `setup-remote <url>` | Wire the data dir to a git remote and verify the initial push. |
| `setup-embeddings` | Send a real test embedding to verify a `KRIMTO_EMBED_*` config. |

**Storage**

| Command | What it does |
|---|---|
| `rm <id>` | Delete a fact (file + index + git deletion commit). Refuses while a server holds the lock. |
| `reindex` | Rebuild `index.db` from the markdown files (fixes orphans left by manual `rm` of .md files). |

**Other**

| Command | What it does |
|---|---|
| (no args) | Start the stdio MCP server (default; for MCP clients to launch) |
| `--help`, `-h` | Show the full CLI surface |

The stdio entrypoint enforces a **single-writer lock** on the data dir (`.krimto/lock.json`) — two
Krimto processes can no longer race on the same `~/.krimto`. A second `serve`/stdio launch is
refused with a precise error pointing at the holder's PID.

## How it works

Three layers, one source of truth:

1. **Storage** — facts are **markdown files in a git repository**. Humans read them, edit them, and
   review them via pull request. Git is the audit log.
2. **Index** — a **SQLite + sqlite-vec** hybrid index (BM25 + vector) sits on top for fast semantic
   retrieval, with hierarchical scope precedence applied at ranking time.
3. **Access** — an **API server** enforces who can read/write which scope. Folder paths are the data
   model; the server is the access enforcer (filesystem permissions are not RBAC).

This hybrid pattern (markdown for storage + index for retrieval + server for access) is the
verified-successful approach used by Claude Code's CLAUDE.md system, Manus, OpenClaw, and
[memweave](https://towardsdatascience.com/) (Towards Data Science, April 2026). Krimto's
differentiator is the storage *choice within* that pattern — human-readable markdown in git — plus
`user → team → org` hierarchy as the primary primitive.

## Quick start (self-host)

```bash
git clone https://github.com/krimto-labs/krimto && cd krimto
pnpm install
```

Facts live as markdown files under `KRIMTO_DATA` (default `~/.krimto/`) — a folder you can open in any
editor and version with git. Run Krimto with `pnpm` (Options A/B) or in **Docker** (Option C).

### Option A — local, over stdio (no auth)

For a single developer on one machine. **Fastest path — no clone, no Docker** (Claude Code shown):

```bash
claude mcp add krimto -- npx -y @krimto-labs/krimto
```

…or the config-file form any stdio MCP client accepts (Cursor, Codex CLI, Gemini CLI, Copilot,
OpenClaw, Cline use the same shape):

```json
{
  "mcpServers": {
    "krimto": {
      "command": "npx",
      "args": ["-y", "@krimto-labs/krimto"],
      "env": { "KRIMTO_IDENTITY": "you@acme.com" }
    }
  }
}
```

The first run downloads dependencies (including `better-sqlite3`, which ships prebuilt binaries), then
starts the **stdio** server with data in `~/.krimto` (override with `KRIMTO_DATA`; run
`npx @krimto-labs/krimto where` to print the exact path). Want the browser dashboard too? Stop the
stdio process and run `npx @krimto-labs/krimto serve` (Option B) — same data folder, plus `/ui`.

**Make your agent actually use Krimto.** By default an editor's agent routes "remember X" to its own
built-in memory. Run this once in your project so it calls Krimto instead:

```bash
npx @krimto-labs/krimto init
```

It auto-detects which editor you're using and writes the idempotent "always use Krimto" rule into the
matching rules file (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `.cursor/rules/krimto.mdc`). Pass
`--all` to write all four. Run `npx @krimto-labs/krimto uninit` to cleanly remove the rule later.
Restart your editor afterward.

From a clone instead of npm, swap the command for `pnpm`:

```json
{
  "mcpServers": {
    "krimto": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/krimto", "dev"],
      "env": { "KRIMTO_DATA": "/Users/you/.krimto", "KRIMTO_IDENTITY": "you@acme.com" }
    }
  }
}
```

`KRIMTO_IDENTITY` is who the agent writes as (fact author + access scope). Stdio mode has **no network
auth** — run it locally/trusted.

### Option B — over HTTP (browser dashboard + optional team auth)

For solo with a browser UI, or a shared/networked deployment with bearer auth. **No clone, no
Docker** — `npx` starts the HTTP server (default port 8080):

```bash
# Solo, local-only (no auth, no login on /ui)
npx @krimto-labs/krimto serve

# Team mode (first run prints an admin API key once)
KRIMTO_BOOTSTRAP_ADMIN=you@acme.com npx @krimto-labs/krimto serve
# → "issued admin API key for you@acme.com (shown once): krm_live_…"
# MCP at http://localhost:8080/mcp ; health at http://localhost:8080/health/ready
```

(`pnpm dev` is the dev-mode equivalent — only useful when working on Krimto itself.)

Then point your agent at it with that key:

```json
{
  "mcpServers": {
    "krimto": {
      "url": "http://localhost:8080/mcp",
      "headers": { "Authorization": "Bearer krm_live_..." }
    }
  }
}
```

To sync with teammates, set `KRIMTO_GIT_REMOTE` to a git remote you can push/pull over SSH.

Optional HTTP knobs (both **off by default**): set `KRIMTO_RATE_LIMIT_PER_MINUTE=<n>` to rate-limit
each API key on `/mcp` (responses carry `X-RateLimit-*`; over the limit returns `429` with
`Retry-After`); set `KRIMTO_TELEMETRY_ENDPOINT=<url>` to send anonymous, **bucketed** usage counts
(version, install id, and size buckets only — never fact content, identities, queries, scopes, or git
remotes).

**Locked out of the admin account?** Restart with `KRIMTO_REISSUE_ADMIN_KEY=you@acme.com` to mint and
print a fresh admin key. (The web UI also refuses to revoke your last remaining key.)

**Multi-instance sync:** Krimto pushes and pulls on the repo's current branch, so give every instance
the same default branch — e.g. `git config --global init.defaultBranch main` before first run. A
stuck pull is reported at `/health/ready` under `git_sync` (it never blocks readiness).

When an agent saves a personal note, point it at `user/me` — the server resolves that to the caller's
own scope, so facts never land in an unreadable scope.

**Inviting teammates (org admins).** Easiest path: `npx @krimto-labs/krimto team init` — interactive
wizard that bootstraps the admin, creates the team, issues per-teammate keys, optionally wires a
shared git remote, and prints a copy-paste DM template ending with `krimto join --server <url> --key
<key>` for each teammate. The browser admin panel (`/ui/admin`) and the admin REST API
(`POST /admin/members`, `POST /admin/keys`, `POST /admin/teams`, `PATCH /admin/teams/:slug`, all
bearer-authed and org-admin-only) are still there for live edits — no file edits or restarts.
`KRIMTO_BOOTSTRAP_ADMIN` only makes the **first** admin; add later admins/members through the
admin surface.

### Option C — Docker (HTTP + bearer auth, containerized)

Build the image and run it (a published image is coming):

```bash
docker build -t krimto .
docker run -d --name krimto -p 8080:8080 \
  -e KRIMTO_BOOTSTRAP_ADMIN=you@acme.com \
  -v ~/.krimto:/data \
  krimto
docker logs krimto | grep "admin API key"   # the key is printed once
```

The container serves MCP at `http://localhost:8080/mcp` (bearer auth) and health at
`/health/ready`; facts persist in the mounted `/data` volume. Point your agent at it with the same
`"url"` + `Bearer` config as Option B.

**Pulling a published image (no local build):** pushing a `v*` git tag runs
[`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml), which publishes the
image to `ghcr.io/krimto-labs/krimto`. After the first release tag you can skip `docker build` and run
the published image directly:

```bash
docker run -d --name krimto -p 8080:8080 \
  -e KRIMTO_BOOTSTRAP_ADMIN=you@acme.com -v ~/.krimto:/data \
  ghcr.io/krimto-labs/krimto:latest
```

### Web UI (humans)

When the HTTP server is running, open `http://localhost:8080/ui`. In local mode (no
`KRIMTO_BOOTSTRAP_ADMIN`), there's no login. In team mode, sign in with any Krimto API key.

Nav: **Memory** · **Connect** · **Keys** · **Settings** · *Team* (admins only) · *Logout*.

**`/ui/facts` (Memory)** — focused on the notes:

- **Plain-English scope labels** — `Just me` / your team's display name / your org's display name,
  computed from `members.yaml` (falls back to the literal `<kind>/<id>` when no name configured).
- **Inline Edit, Move, Delete** on every note's detail page when you have `canWrite` on its scope.
  Edit replaces the body; Move drops down every scope you can write to; Delete is git-tracked.
- **Search box + scope cards + flat notes list** — newest first, capped at 50.
- **Hijack warning** — shown when 3+ recalls land with 0 writes in 5min (signature of an editor's
  built-in memory intercepting "remember X"). Points at `krimto init` to refresh the standing rule.
- **One-line activity blurb** that links to `/ui/settings` for the full log.

**`/ui/settings`** — engineering panels in one place: how Krimto works, where your data lives
(markdown/git/index explainer), status dots for the optional add-ons, recent MCP-tool-call log,
quick links to keys / connect / team admin.

**`/ui/keys`** — issue or revoke your own API keys (team mode).

**`/ui/connect`** — copy-paste config for any MCP client + the always-use standing rule.

**`/ui/admin`** (org admins only) — invite teammates, manage teams, issue keys for others.

The UI reuses the same access control as the MCP tools — you only ever see what you can read. Set
`KRIMTO_SESSION_SECRET` to keep sessions valid across restarts (otherwise a random per-boot secret
is used). Inline Edit/Move/Delete shipped in v0.2.17-3; the formal review/approval flow for shared
scopes still lands in v0.3.

## The eight promises (current status)

| # | Promise | Status |
|---|---------|--------|
| 1 | Markdown-first hybrid storage | ✓ v0.2 |
| 2 | Hierarchical scope (`user`/`team`/`org`) as primary primitive | ✓ v0.2 |
| 3 | Cross-vendor SDK (MCP server + per-marketplace plugins) | ✓ MCP server over stdio + HTTP v0.2; native plugins planned |
| 4 | Attribution baked into every fact | ✓ v0.2 |
| 5 | Self-hostable, single Docker | ✓ v0.2 — published multi-arch image at `ghcr.io/krimto-labs/krimto`; also `npx krimto serve` (no Docker needed) and `pnpm dev` |
| 6 | Apache-2.0 — fully open, no rug-pull | ✓ |
| 7 | Web interface for humans, on top of git | ✓ v0.2.8 + v0.2.17 — `/ui` with browse/search, fact detail, plain-English scope labels, inline Edit/Move/Delete, a dedicated `/ui/settings` consolidator, API keys, team admin. Formal PR-approval flow lands in v0.3. |
| 8 | Zero-friction migration between self-hosted and Cloud | ⏳ full flow with v1.0 Cloud (`git clone` works today) |

## How Krimto compares

Krimto combines three properties that are each uncommon among existing memory tools:

- **Apache-2.0** — fully open, with no managed-service restriction. (ByteRover/Cipher is
  source-available under the Elastic License 2.0, which is not OSI-approved open source.)
- **Markdown-files-in-git storage** — human-readable and reviewable in git. (Hindsight uses
  PostgreSQL; Mem0 uses a vector + graph database.)
- **`user → team → org` hierarchy as the primary primitive.** (Mem0 organizes by user/session/agent.)

Cross-vendor reach — working across Claude Code, Cursor, Codex, Gemini CLI, Copilot, OpenClaw, and
Cline — is table stakes today, so Krimto ships it but doesn't lead with it.

## Roadmap

`v0.2` (teams) → `v0.2.17` series (UX redesign — wizards, per-note CLI, notes-app `/ui` — fully
shipped) → `v0.3` (OAuth + PR approval flow) → `v1.0` (Krimto Cloud). See
[ROADMAP.md](ROADMAP.md) for the per-release breakdown.

## License

[Apache-2.0](LICENSE). The same code is self-hostable by a solo developer, a startup, or an
enterprise — no tier walls in the open-source distribution.
