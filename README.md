# Krimto

> **Krimto — open-source team memory for AI coding agents.** Personal, team, and org knowledge your
> agents share, in plain markdown you own (git-backed, Apache-2.0). **Try it solo in two minutes, then
> bring your team.**

One shared brain for every agent at your company. Every agent at every team writes facts to one
place and reads the right slice of it — Alice's preferences override the team's defaults, the team's
conventions override the org's standards, and every fact carries a paper trail (author, source,
timestamp, reviewer).

> **Where we are:** this is the **v0.2.9** surface. Here today: the markdown-in-git storage layer, the
> `user → team → org` hierarchy, hybrid retrieval, server-enforced access, two-way git sync, the MCP
> server over **stdio + HTTP** (Bearer API-key auth on HTTP), a **published multi-arch Docker image**
> (`ghcr.io/krimto-labs/krimto`), a **web UI** with browse/search/admin/diagnostics, and a complete
> **CLI** (`serve`, `connect`, `init`, `usage`, `storage`, `setup-remote`, `setup-embeddings`,
> `verify-connection`, `uninit`, `where`, `--help`). We claim the team-memory position now and fulfil
> it in the open — see [ROADMAP.md](ROADMAP.md) and [CHANGELOG.md](CHANGELOG.md) for what each release adds.

## Try it in 2 minutes (solo, no account)

1. **Run it** — one command, no clone, no Docker (data stays in `~/.krimto`):
   ```bash
   npx @krimto-labs/krimto serve
   ```
   *Prefer Docker?* `docker run -d -p 8080:8080 -v ~/.krimto:/data ghcr.io/krimto-labs/krimto:latest`
2. **Point Claude Code at it — one line, no key:**
   ```json
   { "mcpServers": { "krimto": { "url": "http://localhost:8080/mcp" } } }
   ```
   (or run `claude mcp add --transport http krimto http://localhost:8080/mcp`)
3. Tell your agent: **"remember that our staging DB resets every Sunday."** Then ask in a *new* chat:
   **"what do you know about staging?"** — it remembers.
4. Open **http://localhost:8080** to browse. The dashboard shows your facts, a *Status* row (git
   remote + embeddings health), and a *Recent activity* feed (so you can see your agent calling
   Krimto in real time). That's the *personal* layer — Krimto's point is the **team** layer:
   restart with `KRIMTO_BOOTSTRAP_ADMIN=you@acme.com` to turn on accounts and invite teammates.

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

Everything is reachable via `npx`. Run `npx @krimto-labs/krimto --help` for the full list. Briefly:

| Command | What it does |
|---|---|
| (no args) | Start the stdio MCP server (default; for MCP clients to launch) |
| `serve` | Start the HTTP server (port 8080) — `/ui` dashboard, no clone, no Docker |
| `connect` | Print copy-paste Claude Code + Cursor config snippets |
| `init [--all]` | Switch this project to AUTO MODE — write the always-use rule (auto-detects editor; `--all` writes every file) |
| `uninit` | Switch back to DEFAULT MODE — remove the rule, delete files it created |
| `usage` | Show the five `krimto_*` tools with chat examples for both modes |
| `storage` | Explain where Krimto keeps your data (markdown / git / index), how to verify, optional add-ons |
| `setup-remote <url>` | Wire the data dir to a git remote and verify the initial push |
| `setup-embeddings` | Send a real test embedding to verify a `KRIMTO_EMBED_*` config |
| `verify-connection` | Diagnose "is my agent calling Krimto?" (lock status + last 5 calls) |
| `where` | Print the data directory |
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

**Inviting teammates (org admins).** Open `http://localhost:8080/ui/admin` (or use the
admin REST API: `POST /admin/members`, `POST /admin/keys`, `POST /admin/teams`,
`PATCH /admin/teams/:slug`, all bearer-authed and org-admin-only) to add members, manage teams, and
issue/revoke keys — no file edits or restarts. `KRIMTO_BOOTSTRAP_ADMIN` only makes the **first** admin;
add later admins/members through the admin surface.

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

The dashboard shows:

- **How Krimto works** — personal → team → org explainer for first-time users.
- **Behind the scenes — your data, your files** — names the data folder; reminds you it's just
  markdown in git that you can open in any editor.
- **Status** — green/gold/red dots for the two optional add-ons (git remote sync; semantic embeddings).
- **Recent activity** — last 5 MCP tool calls (tool, detail, caller, relative timestamp). Critical
  for diagnosing "did my agent actually search?" without grepping stderr.
- **Fact list / detail** — browse and search the facts you're allowed to see; the detail page shows
  the absolute source-file path so you can open the underlying `.md` in any editor.
- **API keys** — issue/revoke your own keys (team mode).
- **Team admin** (`/ui/admin`, org admins only) — add members, manage teams, issue keys for others.

The UI reuses the same access control as the MCP tools — you only ever see what you can read. Set
`KRIMTO_SESSION_SECRET` to keep sessions valid across restarts (otherwise a random per-boot secret is
used). The UI is read-only for facts; editing with a review/approval flow lands in v0.3.

## The eight promises (current status)

| # | Promise | Status |
|---|---------|--------|
| 1 | Markdown-first hybrid storage | ✓ v0.2 |
| 2 | Hierarchical scope (`user`/`team`/`org`) as primary primitive | ✓ v0.2 |
| 3 | Cross-vendor SDK (MCP server + per-marketplace plugins) | ✓ MCP server over stdio + HTTP v0.2; native plugins planned |
| 4 | Attribution baked into every fact | ✓ v0.2 |
| 5 | Self-hostable, single Docker | ✓ v0.2 — published multi-arch image at `ghcr.io/krimto-labs/krimto`; also `npx krimto serve` (no Docker needed) and `pnpm dev` |
| 6 | Apache-2.0 — fully open, no rug-pull | ✓ |
| 7 | Web interface for humans, on top of git | ✓ v0.2.8 — `/ui` with browse/search, fact detail (with source-file path), status panel, recent-activity feed, API keys, team admin; full editing + PR approval in v0.3 |
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

`v0.2` (teams, today) → `v0.3` (web UI) → `v1.0` (Krimto Cloud). See [ROADMAP.md](ROADMAP.md).

## License

[Apache-2.0](LICENSE). The same code is self-hostable by a solo developer, a startup, or an
enterprise — no tier walls in the open-source distribution.
