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
- ✅ v0.2.6 — first-run experience: signpost banner, guided Connect page (incl. a "make it automatic" rule and a generic-client contract), empty-dashboard getting-started guide, plain nav + per-page purpose lines, and a multi-arch image.
- ✅ v0.2.8 — `init`, `connect`, `usage`, `storage`, `verify-connection`, `setup-remote`, `setup-embeddings`, `where`, and `--help` CLI verbs; `/ui` activity panel + status panel.

## v0.2.17 series — UX redesign — ✅ Shipped (`0.2.17` through `0.2.17-5`)

The setup + day-to-day UX caught up to the architecture. Six commands collapse into one
interactive wizard, the team door becomes one wizard + one join command, and the `/ui` becomes
a notes-app instead of an engineering dashboard. See
[docs/krimto-v0.2.17-maria-journey.html](docs/krimto-v0.2.17-maria-journey.html) for the design.

- **`0.2.17` — Phase A — Wizard-driven onboarding.** `krimto init` is now an interactive 5-question
  wizard (TTY) with preselected defaults; non-interactive `--yes` for CI. Self-aware rerun shows a
  menu (refresh / change / view status / quit) on already-configured machines. `krimto status`
  consolidates the four legacy diagnostics. New: `src/cli/{wizard,mcpConfig,service,status}.ts` +
  `@inquirer/prompts` (MIT).
- **`0.2.17.1` — Phase C — Team-mode wizard.** `krimto team init` (admin-side) + `krimto join
  --server <url> --key <key>` (teammate-side) + `krimto team disband` (per-machine step-back).
  Composes the existing v0.2 team primitives (`bootstrapAdmin`, `createTeam`, `addUser`,
  `ApiKeyStore.issue`, `runSetupRemote`).
- **`0.2.17-2` — Phase D — Per-note CLI.** `krimto notes [query]`, `edit <id>`, `mv <id> <scope>`,
  `supersede <id>`, `tag <id> +new -old`. Goes through the same write Serializer + index upsert + git
  stage pipeline as MCP writes.
- **`0.2.17-3` — Phase E (part 1) — Notes-app `/ui` redesign.** Plain-English scope labels in the
  notes list + detail page; inline Edit + Move forms gated by `canWrite`; new
  `src/server/{editFact,moveFact}.ts` shared between web and CLI.
- **`0.2.17-4` — Phase B — Shortcut commands + machine reset.** `krimto editors` / `search` /
  `service` / `reset`. Each is a one-question shortcut over the Phase A wizard's apply step;
  `reset --wipe-notes` uses atomic mv to a recoverable trash sibling, never `rm -rf`.
- **`0.2.17-5` — Phase E (part 2) — `/ui/settings` consolidation.** Engineering panels (How
  Krimto works, Behind the scenes, Status dots, Recent activity, quick links) relocate to a
  dedicated `/ui/settings` page so `/ui/facts` stays notes-focused.

Cumulative: +23 source files, +9 test files, +144 tests. No architecture changes — pure CLI/web
surface evolution over the v0.2 storage + index + access layers.

## v0.2.19 → v0.2.35 — correctness + agent-friendliness — ✅ Shipped

Seventeen patch releases on top of the v0.2.17 wizard redesign. No architecture changes — every
patch is an audit-driven correctness fix or a surface upgrade for AI-agent callers. Highlights:

- **`0.2.19` → `0.2.23`** — first-run polish: identity capture from `git config user.email`,
  Cursor-vs-Claude editor detection at both project (`.cursor/`, `CLAUDE.md`) and machine
  (`~/.cursor/`, `~/.claude.json`) levels, reconfigure menu that re-reads lock + launchctl reality
  on each invocation.
- **`0.2.24` → `0.2.25`** — empty-result safety nets: `krimto_recall` returns a write-opportunity
  hint when results are empty; `krimto_list_scopes` returns a getting-started hint when no scopes
  exist; **`krimto_whoami` MCP tool** added so agents stop hallucinating identity (Gap 3 from the
  smoke-6 audit).
- **`0.2.26` → `0.2.30`** — runtime reliability: service-first install ordering, port-ready probe
  (the v0.2.27/28 ECONNREFUSED fix), single reconciled runtime view (`inspectRuntime`) shared by
  every read-side command, warm-paper `/ui` aesthetic with scope-icon cards (📔 / 📓 / 🏢),
  Cursor `alwaysApply: true` frontmatter so `.cursor/rules/krimto.mdc` auto-attaches.
- **`0.2.31`** — User-Agent → fact attribution (HTTP MCP handler stamps `source: "cursor"` /
  `"claude-code"` / …); consolidated `krimto status` panels; first-class `krimto remote` and
  `krimto folder` verbs.
- **`0.2.32` → `0.2.33` — "the stop button".** First-class teardown verbs: `krimto stop` /
  `start` / `restart` / `reset [--wipe-notes]`. `reset --wipe-notes` uses atomic mv to a
  recoverable trash sibling, never `rm -rf`. `uninit` now offers to stop the machine-wide service
  after stripping the project rule.
- **`0.2.34` — Phase B agent flags.** Every interactive command has a flag form: `editors --add /
  --remove / --set / --list`, `service --as-needed / --always / --manual`, `search --keyword /
  --openai --api-key`, `remote --show / --set / --remove`, `folder --to`. Non-TTY guards exit 2
  with copy-pasteable usage instead of hanging on unanswerable prompts.
- **`0.2.35`** — honest reconfigure menu (drops fake "Service: always" claim, prints the real
  launchctl-derived run mode); Claude Code reset sweep across user / project / local config
  scopes.

## v0.3 — Humans on top of git

Remaining items that didn't ship in the v0.2.17 series:

- Real human sign-in (OAuth) on top of the v0.2 API-key session scaffold
- Pull-request approval flow for member-edited facts in shared scopes (team / org)
- Verified Codex and Gemini CLI MCP-config auto-wiring (Phase A wires Cursor + Claude Code only;
  the other two still print a manual snippet)

## v1.0 — Krimto Cloud

- Hosted offering (one container per tenant), SSO, built-in embeddings, automatic backups, EU region
- Zero-friction migration both directions (`git clone` / GitHub App install + config edit)

## Later (explicitly deferred)

Multi-region, SAML/SCIM, custom roles, analytics dashboards, stale-source detection, Slack/webhook
integrations, Notion importer, broader embedding-provider support. Enterprise certification (SOC 2)
follows OSS traction — it does not precede it.
