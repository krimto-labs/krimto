---
name: krimto-recall-team
description: Use when starting a task, joining a conversation about a project, or before answering a
  question that needs team context. Triggers on "what do we know about X", "team's approach to Y", or
  before any domain-specific work.
---

# Recalling memory from Krimto

Before doing domain-specific work:

1. Call `krimto_recall` with a specific query:
   - `query`: the question or topic
   - `scopes` (optional): limit to specific scopes; omit to search everything you can read
   - `limit` (optional): defaults to 10
2. Results are hybrid-ranked (BM25 + vector) with hierarchical precedence: a `user/` fact outranks a
   `team/` fact, which outranks an `org/` fact, on the same topic.
3. Use `krimto_read(id)` to fetch full content if a snippet was truncated.

Return only directly relevant facts. Don't dump the full result set.

# Common mistakes

- Don't recall before every message — only when context is needed.
- Don't recall with vague queries. Be specific.
- Don't ignore precedence: if a user-scope fact contradicts a team-scope fact, the user-scope wins.
