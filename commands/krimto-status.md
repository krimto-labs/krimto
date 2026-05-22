---
name: krimto-status
description: Show the current state of Krimto memory — total facts, scope breakdown, recent writes,
  and index health.
---

Show the user a summary of Krimto's current state:

1. Call `krimto_list_scopes` to get scope counts.
2. Call `git log` on the Krimto storage directory for recent activity.
3. Format as a clean status report:

```
## Krimto Status

Scopes: N user, M team, K org
Total facts: T
Recent writes: (last 5 timestamps)
Index status: synced / out-of-sync
```
