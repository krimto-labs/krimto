## What this PR changes

<!-- One sentence. Which subsystem (storage / index / access / retrieval / MCP server) does it touch? -->

## Checklist

- [ ] I understand which subsystem this changes
- [ ] This PR touches a single subsystem (no spraying changes across many)
- [ ] `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass
- [ ] `pnpm test:integration` (end-to-end acceptance) passes
- [ ] Tests added/updated (TDD — no production code without a failing test first)
- [ ] No new dependencies under ELv2 / SSPL / BSL / GPL / AGPL
- [ ] If this changes the schema, MCP tool surface, retrieval, access control, or concurrency, it was designed in Plan Mode first
