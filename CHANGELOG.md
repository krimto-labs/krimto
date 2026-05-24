# Changelog

All notable changes to Krimto are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Krimto adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

- Persistent SQLite index: FTS5 keyword search + sqlite-vec vector search with an embedding
  cache, built from the markdown files and rebuilt on startup. Recall, read, and list-scopes
  now serve from the index instead of scanning every file.

Verified by 188 tests, including the v0.1 acceptance flow, MCP round-trips over both stdio and HTTP
(with bearer auth), an access-control suite, a hybrid keyword-mismatch retrieval, and an HTTP
rate-limit (`429`) end-to-end check.

_Remaining v0.2 work (published pull-image and the minimal web UI) tracked in
[ROADMAP.md](ROADMAP.md)._

[Unreleased]: https://github.com/krimto-labs/krimto/commits/main
