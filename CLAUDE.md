# Krimto — Contributor and Development Guidelines

## If you are an AI agent

Read this section before doing anything. Krimto is an open-source team memory layer for AI coding
agents. **Quality matters more than quantity. Slop PRs will be closed.**

Before opening any PR:

1. Identify which subsystem your change touches: storage, index, access, retrieval, or the MCP server.
2. Changes to the **data schema, the MCP tool surface, the retrieval algorithm, access control, or
   the concurrency model** are load-bearing — design them in Plan Mode first.
3. Write tests first (TDD). Run the full verification suite below; everything must pass.

## What this project is

Open-source team memory layer for AI agents. Three layers:

- **Storage** — markdown files in git (the source of truth)
- **Index** — SQLite + sqlite-vec for hybrid retrieval (BM25 + vector)
- **Access** — an API server enforces the `user → team → org` hierarchy

Defining properties: **markdown-files-in-git as the storage layer**, and **`user → team → org`
hierarchy as the primary primitive**. Krimto is **Apache-2.0** licensed and stays that way.

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
- `pnpm test:integration` — the five-step end-to-end acceptance test passes

## Architecture rules — never violate

- All writes go through the API server
- Folder paths are the data model, **not** access control
- The server enforces access via `.krimto/members.yaml`
- Never bypass the SQLite write coordinator
- Frontmatter `id` is immutable and server-created only
- Timestamps are server-generated only
- No automatic fact extraction — facts are written only on an explicit `krimto_write`

## Plan Mode required for

- Data schema changes
- MCP tool surface changes
- Retrieval algorithm changes
- Access control changes
- Concurrency model changes

## Required workflow

1. `brainstorming` — refine the design before writing code
2. `using-git-worktrees` — isolated branch
3. `writing-plans` — small, well-scoped tasks with exact paths
4. `subagent-driven-development` — parallel execution
5. `test-driven-development` — RED-GREEN-REFACTOR
6. `requesting-code-review` — by severity
7. `finishing-a-development-branch` — verify before merge

## What we will NOT accept

- Dependencies under ELv2, SSPL, BSL, AGPL, or any GPL (incompatible with Apache-2.0)
- Bulk PRs spraying changes across multiple subsystems
- Code without tests (TDD is enforced)
- Closed-source dependencies in core (acceptable only in optional integrations)

## Common mistakes

Grows over time. Every fix becomes context for next time.
