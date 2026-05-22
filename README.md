# Krimto

> **Krimto — the open-source team memory layer for AI coding agents, with user/team/org hierarchy and markdown-files-in-git storage. Apache-2.0. Self-hostable. Single Docker install.**

One shared brain for every agent at your company. Every agent at every team writes facts to one
place and reads the right slice of it — Alice's preferences override the team's defaults, the team's
conventions override the org's standards, and every fact carries a paper trail (author, source,
timestamp, reviewer).

> **Where we are:** this is the **v0.2** surface. The storage layer, the `user → team → org`
> hierarchy, the MCP server, and single-Docker self-hosting are here today. The web UI is minimal
> and Krimto Cloud is on the roadmap. We claim the team-memory position now and fulfil it in the
> open — see [ROADMAP.md](ROADMAP.md).

## How it works

Three layers, one source of truth:

1. **Storage** — facts are **markdown files in a git repository**. Humans read them, edit them, and
   review them via pull request. Git is the audit log.
2. **Index** — a **SQLite + sqlite-vec** hybrid index (BM25 + vector) sits on top for fast semantic
   retrieval, with hierarchical scope precedence applied at ranking time.
3. **Access** — an **API server** enforces who can read/write which scope. Folder paths are the data
   model; the server is the access enforcer (filesystem permissions are not RBAC).

This hybrid pattern (markdown for storage + index for retrieval + server for access) is the
verified-successful approach used by Claude Code's CLAUDE.md system, Manus, OpenClaw, and
[memweave](https://towardsdatascience.com/) (Towards Data Science, April 2026). Krimto's
differentiator is the storage *choice within* that pattern — human-readable markdown in git — plus
`user → team → org` hierarchy as the primary primitive.

## Quick start (self-host)

```bash
docker run -d -p 8080:8080 -v ~/.krimto:/data ghcr.io/krimto-labs/server
```

Krimto runs at `http://localhost:8080`; all data lives in `~/.krimto/` — a folder you can open in any
editor.

### Connect your agent (MCP)

Add Krimto as an MCP server (Claude Code shown; Cursor, Codex CLI, Gemini CLI, Copilot, OpenClaw,
Cline follow the same one-line pattern):

```json
{
  "mcpServers": {
    "krimto": {
      "url": "http://localhost:8080",
      "headers": { "Authorization": "Bearer krm_live_..." }
    }
  }
}
```

## The eight promises (current status)

| # | Promise | Status |
|---|---------|--------|
| 1 | Markdown-first hybrid storage | ✓ v0.2 |
| 2 | Hierarchical scope (`user`/`team`/`org`) as primary primitive | ✓ v0.2 |
| 3 | Cross-vendor SDK (MCP server + per-marketplace plugins) | ✓ MCP server v0.2; native plugins rolling out |
| 4 | Attribution baked into every fact | ✓ v0.2 |
| 5 | Self-hostable, single Docker | ✓ v0.2 |
| 6 | Apache-2.0 — fully open, no rug-pull | ✓ |
| 7 | Web interface for humans, on top of git | ⏳ minimal in v0.2, expands in v0.3 |
| 8 | Zero-friction migration between self-hosted and Cloud | ⏳ full flow with v1.0 Cloud (`git clone` works today) |

## How Krimto compares

Krimto combines three properties that are each uncommon among existing memory tools:

- **Apache-2.0** — fully open, with no managed-service restriction. (ByteRover/Cipher is
  source-available under the Elastic License 2.0, which is not OSI-approved open source.)
- **Markdown-files-in-git storage** — human-readable and reviewable in git. (Hindsight uses
  PostgreSQL; Mem0 uses a vector + graph database.)
- **`user → team → org` hierarchy as the primary primitive.** (Mem0 organizes by user/session/agent.)

Cross-vendor reach — working across Claude Code, Cursor, Codex, Gemini CLI, Copilot, OpenClaw, and
Cline — is table stakes today, so Krimto ships it but doesn't lead with it.

## Roadmap

`v0.2` (teams, today) → `v0.3` (web UI) → `v1.0` (Krimto Cloud). See [ROADMAP.md](ROADMAP.md).

## License

[Apache-2.0](LICENSE). The same code is self-hostable by a solo developer, a startup, or an
enterprise — no tier walls in the open-source distribution.
