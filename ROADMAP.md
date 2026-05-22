# Krimto Roadmap

Krimto claims the **team memory layer** position from day one and fulfils it incrementally, in the
open (the verified Langfuse pattern: claim the platform position at launch, ship toward it release by
release). Each milestone has a tracking issue on GitHub.

## v0.2 — Team memory (first public release)

The wedge, shipped. Single-Docker self-host with team hierarchy from day one.

- Markdown-in-git storage layer; one file per fact with mandatory frontmatter
- `user → team → org` scope hierarchy with precedence at retrieval time
- SQLite + sqlite-vec hybrid retrieval (BM25 + vector, temporal decay, MMR, scope boost)
- MCP tool surface: `krimto_write`, `krimto_recall`, `krimto_read`, `krimto_supersede`, `krimto_list_scopes`
- API-key auth (machines) + OAuth scaffold (humans); four-role access model enforced server-side
- Server-coordinated batched writes to git; external-edit detection and re-index
- Operational essentials: structured errors, health checks, rate limiting, opt-in telemetry
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
