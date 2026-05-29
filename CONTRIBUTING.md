# Contributing to Krimto

Thanks for your interest in Krimto. Quality matters more than quantity — focused, well-tested PRs
are very welcome; bulk "slop" PRs will be closed.

## Prerequisites

- Node.js ≥ 20
- pnpm (used for all dependency and script management)

```bash
git clone https://github.com/krimto-labs/krimto && cd krimto
pnpm install
```

## Project shape

Three layers:

- **Storage** — markdown files in git (`src/storage/`)
- **Index** — SQLite + sqlite-vec hybrid retrieval (`src/index/`, `src/retrieval/`)
- **Access** — a server enforcing the `user → team → org` hierarchy (`src/access/`, `src/server/`)

## Before you open a PR

1. Identify which subsystem your change touches (storage / index / access / retrieval / MCP server / CLI / web).
2. Write tests first — Krimto is test-driven.
3. Run the full verification suite; everything must pass:

   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm test:integration
   ```

4. Keep each PR scoped to one subsystem.

## Conventions

- TypeScript, strict mode. `camelCase` for values, `PascalCase` for types.
- Prefer functions over classes unless state requires otherwise.
- No `any` — use `unknown` and narrow.

## Licensing

Krimto is Apache-2.0 and stays that way. Don't add dependencies under ELv2, SSPL, BSL, or any
GPL/AGPL license. By contributing, you agree your contributions are licensed under Apache-2.0 and
that you follow our [Code of Conduct](CODE_OF_CONDUCT.md).
