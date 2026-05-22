# Krimto — Contributor and Development Guidelines

## If you are an AI agent

Read this section before doing anything. Krimto is an open-source team memory layer for AI coding
agents. **Quality matters more than quantity. Slop PRs will be closed.**

Before opening any PR:

1. Read `docs/krimto-build-spec-v004.html` — the canonical implementation spec (19 sections).
2. Read `docs/krimto-concept-v013.html` — the strategic context and the wedge.
3. Check whether your change touches a **Tier 1 gap** (Build Spec Sections 01–05) — those require Plan Mode.
4. Run the `build-spec-conformance` subagent before opening the PR.
5. Run the `integration-test-runner` subagent — all five Gap 05 acceptance steps must pass.

## What this project is

Open-source team memory layer for AI agents. Three layers:

- **Storage** — markdown files in git (the source of truth)
- **Index** — SQLite + sqlite-vec for hybrid retrieval (BM25 + vector)
- **Access** — an API server enforces the `user → team → org` hierarchy

The wedge (per Concept Dossier v013, Section 10) is **two differentiating properties**:

1. Markdown-files-in-git as the storage layer
2. `user → team → org` hierarchy as the primary primitive

Cross-vendor SDK is **table stakes** (Hindsight ships it too). Open source is table stakes — but
**Apache-2.0 specifically** is the differentiator against ELv2 (ByteRover/Cipher) and other
source-available competitors.

## Code conventions

- TypeScript, strict mode (`tsconfig` `strict: true`)
- `camelCase` for variables, `PascalCase` for types
- Functions over classes unless state requires otherwise
- No `any` — use `unknown` and narrow
- pnpm for all dependency and script management

## Required verification (after every change)

- `pnpm typecheck` — passes
- `pnpm lint` — passes
- `pnpm test` — relevant unit tests pass
- `pnpm test:integration` — the five-step Gap 05 acceptance test passes

## Architecture rules — never violate

- All writes go through the API server (Build Spec Gap 08)
- Folder paths are the data model, **not** access control (Gap 07)
- The server enforces access via `.krimto/members.yaml`
- Never bypass the SQLite write coordinator
- Frontmatter `id` is immutable and server-created only
- Timestamps are server-generated only
- No automatic fact extraction — writes happen only on explicit `krimto_write` (Gap 11)

## Plan Mode required for

- Data schema changes (Gap 01)
- MCP tool surface changes (Gap 02)
- Retrieval algorithm changes (Gap 04)
- Access control changes (Gap 07)
- Concurrency model changes (Gap 08)

## Required workflow (verified obra/superpowers pattern)

1. `brainstorming` — refine the design before writing code
2. `using-git-worktrees` — isolated branch
3. `writing-plans` — 2–5 minute tasks with exact paths
4. `subagent-driven-development` — parallel execution
5. `test-driven-development` — RED-GREEN-REFACTOR
6. `requesting-code-review` — by severity
7. `finishing-a-development-branch` — verify before merge

## What we will NOT accept

- Dependencies under ELv2, SSPL, BSL, AGPL, or any GPL (contaminates the Apache-2.0 wedge)
- Changes to the strategic wedge without a corresponding dossier update
- Bulk PRs spraying changes across multiple gaps
- Code without tests (TDD is enforced)
- Closed-source dependencies in core (acceptable only in optional integrations)

## Common mistakes

Grows over time. Every fix becomes context for next time.
