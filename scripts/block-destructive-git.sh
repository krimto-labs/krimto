#!/usr/bin/env bash
# PreToolUse(Bash) dev hook — block clearly destructive commands.
# Reads the tool-call JSON from stdin and inspects the command. Falls OPEN
# (exit 0) on any parse problem so it never blocks legitimate work by accident.
input="$(cat 2>/dev/null || true)"

cmd=""
if command -v jq >/dev/null 2>&1; then
  cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
fi
if [ -z "${cmd:-}" ]; then
  cmd="$(printf '%s' "$input" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 \
        | sed 's/.*:[[:space:]]*"//; s/"$//' 2>/dev/null || true)"
fi
[ -z "${cmd:-}" ] && exit 0

case "$cmd" in
  *"git push"*--force*|*"git push -f"*) echo "BLOCKED: force push is not allowed." >&2; exit 2 ;;
  *"git reset --hard"*)                 echo "BLOCKED: git reset --hard is not allowed." >&2; exit 2 ;;
  *"rm -rf .git"*|*"rm -rf"*"/.git"*)   echo "BLOCKED: removing the .git directory is not allowed." >&2; exit 2 ;;
esac
exit 0
