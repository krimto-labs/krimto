# Krimto Roadmap

Krimto claims the **team memory layer** position from day one and fulfils it incrementally, in the
open — shipping toward it release by release. Each milestone has a tracking issue on GitHub.

## v0.2 — Team memory (first public release) — ✅ Shipped (v0.2.5, 2026-05-25)

The memory core, shipped — runnable as a **local, no-auth** HTTP server (one command, one config line,
no key — the default), or in **team mode** with API keys (`KRIMTO_BOOTSTRAP_ADMIN`), plus a local
**stdio** server and a **published Docker image**. Team adoption at scale (SSO, invite links) routes to
Krimto Cloud in v1.0.

**Shipped and wired into the running server:**
- Markdown-in-git storage layer; one file per fact with mandatory frontmatter
- `user → team → org` scope hierarchy with precedence at retrieval time
- SQLite + sqlite-vec hybrid retrieval (BM25 + vector, temporal decay, MMR, scope boost)
- MCP tool surface over **stdio and HTTP** (Streamable HTTP): `krimto_write`, `krimto_recall`, `krimto_read`, `krimto_supersede`, `krimto_list_scopes`
- **API-key bearer auth** on the HTTP transport; four-role access model enforced server-side (stdio mode uses `KRIMTO_IDENTITY`)
- **`/health/live` + `/health/ready`** endpoints; first-run admin-key bootstrap (`KRIMTO_BOOTSTRAP_ADMIN`)
- Server-coordinated batched writes to git; remote push; periodic pull with external-edit re-index
- **Docker image** (`docker build` + `docker run`) packaging the HTTP server, with a persisted `/data` volume
- **Per-API-key rate limiting** (`KRIMTO_RATE_LIMIT_PER_MINUTE`) and **opt-in, bucketed telemetry** (`KRIMTO_TELEMETRY_ENDPOINT`) on the HTTP transport — both off by default
- **Minimal web UI** at `/ui` — API-key sign-in (signed-cookie session), browse/search, fact detail, and self-service key management (issue/revoke), all under the same access control as MCP
- **Membership management** — admin-only REST API (`/admin/*`) + `/ui/admin` to add members, manage teams, and issue/revoke keys live; `members.yaml` committed to git; `KRIMTO_BOOTSTRAP_ADMIN` elevates only the first admin
- **Verified connect for Claude Code + Cursor** — copy-paste/one-click snippets in the README and an in-product `/ui/connect` panel (incl. an "Add to Cursor" deeplink); team mode prints a ready-to-paste config with the key
- **Published Docker image** — `ghcr.io/krimto-labs/krimto:latest` (and `:<version>`), built and pushed by `.github/workflows/docker-publish.yml` on every `v*` tag (no local build needed)

**Next (post-v0.2 onboarding polish):**
- Verify Codex and Gemini CLI, and ship an `npx`/stdio package + `curl | sh` installer so connecting needs no Docker build

## v0.3 — Humans on top of git

- Full seven-page web UI (browse, search, fact detail, pull requests, team management, API keys, settings)
- Real human sign-in (OAuth) on top of the v0.2 API-key session scaffold
- Pull-request approval flow for member-edited facts

## v1.0 — Krimto Cloud

- Hosted offering (one container per tenant), SSO, built-in embeddings, automatic backups, EU region
- Zero-friction migration both directions (`git clone` / GitHub App install + config edit)

## Later (explicitly deferred)

Multi-region, SAML/SCIM, custom roles, analytics dashboards, stale-source detection, Slack/webhook
integrations, Notion importer, broader embedding-provider support. Enterprise certification (SOC 2)
follows OSS traction — it does not precede it.
