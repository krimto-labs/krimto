# Krimto Roadmap

Krimto claims the **team memory layer** position from day one and fulfils it incrementally, in the
open — shipping toward it release by release. Each milestone has a tracking issue on GitHub.

## v0.2 — Team memory (first public release)

The memory core, shipped — today as a local **MCP server over stdio**.

**Shipped and wired into the running server:**
- Markdown-in-git storage layer; one file per fact with mandatory frontmatter
- `user → team → org` scope hierarchy with precedence at retrieval time
- SQLite + sqlite-vec hybrid retrieval (BM25 + vector, temporal decay, MMR, scope boost)
- MCP tool surface over stdio: `krimto_write`, `krimto_recall`, `krimto_read`, `krimto_supersede`, `krimto_list_scopes`
- Four-role access model enforced server-side (requester identity from `KRIMTO_IDENTITY` for now)
- Server-coordinated batched writes to git; remote push; periodic pull with external-edit re-index

**In progress (built as modules, not yet wired) — next up:**
- HTTP transport + single-Docker image (`docker run`) — the precondition for the items below
- API-key bearer auth (machines) + OAuth scaffold (humans)
- Operational endpoints: structured errors (done on the MCP surface), health checks, rate limiting, opt-in telemetry
- Minimal web UI (browse, search, fact detail, API keys)

## v0.3 — Humans on top of git

- Full seven-page web UI (browse, search, fact detail, pull requests, team management, API keys, settings)
- Pull-request approval flow for member-edited facts

## v1.0 — Krimto Cloud

- Hosted offering (one container per tenant), SSO, built-in embeddings, automatic backups, EU region
- Zero-friction migration both directions (`git clone` / GitHub App install + config edit)

## Later (explicitly deferred)

Multi-region, SAML/SCIM, custom roles, analytics dashboards, stale-source detection, Slack/webhook
integrations, Notion importer, broader embedding-provider support. Enterprise certification (SOC 2)
follows OSS traction — it does not precede it.
