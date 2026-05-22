---
name: krimto-write-fact
description: Use when the user asks you to remember something for later, save team knowledge, record
  a decision, or note a durable fact about the project, person, or team. Triggers on "remember that",
  "save this", "add to memory", "note for the team". Do not use for conversational context.
---

# Writing facts to Krimto memory

When the user wants to save a durable fact:

1. Choose the scope (default to the user's personal scope unless the fact is clearly shared):
   - `user/<identity>` — personal preferences, individual decisions (e.g. `user/alice@acme.com`)
   - `team/<slug>` — team conventions, shared system rules (e.g. `team/payments`)
   - `org/<slug>` — company-wide standards (e.g. `org/acme`); org admins only
2. Call `krimto_recall` first to avoid writing a duplicate.
3. Call the MCP tool `krimto_write` with:
   - `scope`: one of the forms above
   - `title`: a descriptive title, ≤ 80 characters
   - `body`: markdown content
   - `tags` (optional): lowercase kebab-case array
   - `source` (optional): URL or stable identifier
   - `supersedes` (optional): array of fact ids this replaces

The server assigns the author, timestamps, and fact id, writes the markdown file, and commits to git.
Return the resulting `path` so the user can find it.

# Common mistakes

- Don't write the same fact at multiple scopes. Pick the broadest scope where it is true.
- Don't write to `org/` without confirming the user is an org admin.
- Don't invent the scope. If unclear, ask, or default to the user's personal scope.
- Don't extract facts silently — only write when the user asks or you learn a durable, non-obvious fact.
