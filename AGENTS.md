# Krimto — Agent Instructions (Codex / cross-harness)

This repository is a Claude Code plugin and an MCP server. For full contributor and architecture
guidelines, read `CLAUDE.md`. For the implementation spec, read `docs/krimto-build-spec-v004.html`.

Key rules:
- All writes go through the API server; folder paths are the data model, not access control.
- TypeScript strict mode; pnpm; TDD (RED-GREEN-REFACTOR).
- No automatic fact extraction — facts are written only on an explicit `krimto_write`.

To use Krimto, install it as an MCP server (see `README.md` → "Connect your agent").
