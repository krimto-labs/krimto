# Changelog

All notable changes to Krimto are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Krimto adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
