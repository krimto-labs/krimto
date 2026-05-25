# Krimto

> **Krimto — open-source team memory for AI coding agents.** Personal, team, and org knowledge your
> agents share, in plain markdown you own (git-backed, Apache-2.0). **Try it solo in two minutes, then
> bring your team.**

One shared brain for every agent at your company. Every agent at every team writes facts to one
place and reads the right slice of it — Alice's preferences override the team's defaults, the team's
conventions override the org's standards, and every fact carries a paper trail (author, source,
timestamp, reviewer).

> **Where we are:** this is the **v0.2** surface. Here today: the markdown-in-git storage layer, the
> `user → team → org` hierarchy, hybrid retrieval, server-enforced access, two-way git sync, and the
> MCP server over **both stdio and HTTP — the HTTP transport has `Bearer` API-key auth and
> `/health` endpoints**. On the near-term roadmap: a single-Docker image and the web UI. We claim the
> team-memory position now and fulfil it in the open — see [ROADMAP.md](ROADMAP.md).

## Try it in 2 minutes (solo, no account)

1. **Run it** (data stays in `~/.krimto`):
   ```bash
   docker run -d -p 8080:8080 -v ~/.krimto:/data krimto    # or, from a clone: pnpm dev
   ```
2. **Point Claude Code at it — one line, no key:**
   ```json
   { "mcpServers": { "krimto": { "url": "http://localhost:8080/mcp" } } }
   ```
   (or run `claude mcp add --transport http krimto http://localhost:8080/mcp`)
3. Tell your agent: **"remember that our staging DB resets every Sunday."** Then ask in a *new* chat:
   **"what do you know about staging?"** — it remembers.
4. Open **http://localhost:8080** to browse. That's your *personal* layer — Krimto's point is the
   **team** layer: restart with `KRIMTO_BOOTSTRAP_ADMIN=you@acme.com` to turn on accounts and invite
   teammates.

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

By default your agent uses Krimto only when you ask. To make it recall and save **on its own**, add a
standing rule to your agent's rules file — Claude Code: `CLAUDE.md`; Cursor: `.cursor/rules/krimto.mdc`;
Codex: `AGENTS.md`; Gemini CLI: `GEMINI.md`:

```
# Krimto memory — always use
- Before a task, call krimto_recall to load what we already know.
- When I say "remember", or you learn a durable fact, call krimto_write
  (user/me = personal, team/<slug> = shared).
- Respect precedence: user beats team beats org.
- Don't save secrets or one-off chatter.
```

The in-product **Connect** page (`/ui/connect`) shows this same rule with a copy button.

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

For a single developer on one machine. Add Krimto as a **stdio** MCP server (Claude Code shown;
Cursor, Codex CLI, Gemini CLI, Copilot, OpenClaw, and Cline use the same stdio-command shape):

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

### Option B — over HTTP, with bearer auth (teams)

For a shared/networked deployment. Start the HTTP server; the first run prints an admin API key once:

```bash
KRIMTO_HTTP_PORT=8080 KRIMTO_BOOTSTRAP_ADMIN=you@acme.com pnpm dev
# → "issued admin API key for you@acme.com (shown once): krm_live_…"
# MCP at http://localhost:8080/mcp ; health at http://localhost:8080/health/ready
```

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

When the HTTP server is running, open `http://localhost:8080/ui` and **sign in with any Krimto API
key**. You can browse and search the facts you're allowed to see, open a fact, and manage your own API
keys (issue / revoke). It reuses the same access control as the MCP tools, so you only ever see facts
you can read. Set `KRIMTO_SESSION_SECRET` to keep sessions valid across restarts (otherwise a random
per-boot secret is used). The UI is read-only for facts; editing with a review/approval flow lands in
v0.3.

## The eight promises (current status)

| # | Promise | Status |
|---|---------|--------|
| 1 | Markdown-first hybrid storage | ✓ v0.2 |
| 2 | Hierarchical scope (`user`/`team`/`org`) as primary primitive | ✓ v0.2 |
| 3 | Cross-vendor SDK (MCP server + per-marketplace plugins) | ✓ MCP server over stdio + HTTP v0.2; native plugins planned |
| 4 | Attribution baked into every fact | ✓ v0.2 |
| 5 | Self-hostable, single Docker | ✓ v0.2 — stdio, HTTP, or **Docker** (`docker build` + `docker run`); a published pull-image is next |
| 6 | Apache-2.0 — fully open, no rug-pull | ✓ |
| 7 | Web interface for humans, on top of git | ✓ minimal v0.2 (`/ui` — login, browse/search, fact detail, API keys); full UI + PR approval in v0.3 |
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
