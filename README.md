# Krimto

> Open-source team memory layer for AI coding agents — markdown files in git, user→team→org hierarchy, cross-vendor MCP server. Apache-2.0.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@krimto-labs/krimto)](https://www.npmjs.com/package/@krimto-labs/krimto)
[![CI](https://github.com/krimto-labs/krimto/actions/workflows/test.yml/badge.svg)](https://github.com/krimto-labs/krimto/actions/workflows/test.yml)

Krimto gives every AI coding agent on your team one shared memory. Tell your agent "remember X" in
any editor and it saves a durable, attributable fact; ask later — in a new chat, a different editor,
or from a teammate's machine — and it recalls the right answer. Your personal notes override the
team's; the team's override the org's.

Facts are plain markdown files in a git repo you own — readable, reviewable, and yours. No lock-in,
no proprietary store.

## Why Krimto

- **Markdown-in-git storage.** Every fact is a markdown file with frontmatter. Audit it with
  `git log`, edit it in any editor, review it in a pull request.
- **`user → team → org` hierarchy.** Knowledge is scoped to a person, a team, or the whole company,
  and the most specific scope wins at recall time.
- **Cross-vendor + Apache-2.0.** One MCP server works with Claude Code, Cursor, Codex, Gemini CLI,
  and more — fully open source, with no managed-service restriction.

## Try it in 2 minutes (solo, no account)

```bash
npx @krimto-labs/krimto init
```

The setup wizard detects your editor, wires it up, and turns on automatic memory. Then, in any chat:

```
"Remember that our staging DB resets every Sunday."
```

Open a new chat and ask:

```
"What do you know about staging?"   → it remembers.
```

See your notes with `krimto notes` (terminal) or `krimto ui` (browser dashboard). Your data lives in
`~/.krimto` — the same folder no matter which project you're working in.

## Connect your agent

`krimto init` wires supported editors for you. What auto-connects vs. needs one copy-paste step:

| Editor | Setup |
|---|---|
| Cursor | auto-connects |
| Claude Code | auto-connects |
| Codex | manual snippet |
| Gemini CLI | manual snippet |

To connect any MCP client manually, point it at Krimto over stdio:

```bash
claude mcp add krimto -- npx -y @krimto-labs/krimto
```

…or the config-file form (Cursor, Codex, Gemini CLI, etc. use the same shape):

```json
{ "mcpServers": { "krimto": { "command": "npx", "args": ["-y", "@krimto-labs/krimto"] } } }
```

By default an agent uses Krimto only when you ask. Running `krimto init` once in your project drops a
standing rule so it uses Krimto on its own.

### Install as a Claude Code plugin

Prefer Claude Code's plugin system? Add Krimto's marketplace and install it directly:

```bash
/plugin marketplace add krimto-labs/krimto
/plugin install krimto@krimto
```

This bundles the MCP server together with Krimto's skills, the `/krimto-status` command, and the
memory hooks — no separate `krimto init` needed.

## How it works

Three layers, one source of truth:

1. **Storage** — facts are markdown files in a git repository (the source of truth; git is the audit log).
2. **Index** — a SQLite + sqlite-vec hybrid index (keyword + vector) for fast retrieval, with scope
   precedence applied at ranking time.
3. **Access** — an API server enforces who can read and write each scope (`user` / `team` / `org`).

## Team mode

When you're ready to share memory with teammates:

```bash
npx @krimto-labs/krimto team init
```

This walks you through an admin email, your org/team name, an optional shared git remote, and
teammate invites — then prints a join command for each teammate:

```bash
krimto join --server <url> --key <key>
```

Teammates can connect to one shared server, or each run their own Krimto synced over a shared git
remote. Personal and team notes live together and sync as a unit. Step back to solo any time with
`krimto team disband` (your notes are preserved).

## Self-host

Krimto runs anywhere Node 20+ runs.

```bash
# HTTP server + browser dashboard at http://localhost:8080
npx @krimto-labs/krimto serve

# or Docker
docker run -d -p 8080:8080 -v ~/.krimto:/data ghcr.io/krimto-labs/krimto:latest
```

Run `npx @krimto-labs/krimto --help` for the full command surface.

## Roadmap

v0.2 (current) ships the memory core, teams, the web dashboard, and the cross-vendor MCP server.
Next: OAuth sign-in and a pull-request approval flow (v0.3), then a hosted Krimto Cloud (v1.0). See
[ROADMAP.md](ROADMAP.md).

## Contributing & license

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and our
[Code of Conduct](CODE_OF_CONDUCT.md). Security reports: [SECURITY.md](SECURITY.md).

Licensed under [Apache-2.0](LICENSE). The same code is self-hostable by a solo developer or an
enterprise — no tier walls.
