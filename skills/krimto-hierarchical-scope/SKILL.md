---
name: krimto-hierarchical-scope
description: Use when deciding what scope to store a fact at, or when reasoning about whether a fact
  applies to the current user. Krimto uses a user -> team -> org hierarchy with precedence rules.
  Triggers when scope selection is required.
---

# Krimto's hierarchical scope model

Three scopes, most specific wins:

1. `user/<identity>` — personal preferences, individual decisions
2. `team/<slug>` — team conventions, project decisions
3. `org/<slug>` — company-wide policies, universal facts

# Precedence (applied at recall time)

- user-scope fact + team-scope fact on the same topic → user wins for that user
- team-scope fact + org-scope fact → team wins for that team's members

# Choosing a scope at write time

- "I prefer X" → `user/<identity>`
- "Our team agreed X" → `team/<slug>`
- "All employees X" → `org/<slug>` (org admins only)

# Common mistakes

- Writing personal preferences at org scope (pollutes everyone)
- Writing team decisions at user scope (no one else sees them)
- Forgetting precedence when answering — always check user before team before org
