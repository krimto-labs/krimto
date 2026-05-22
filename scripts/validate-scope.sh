#!/usr/bin/env bash
# Plugin PreToolUse hook — client-side safety net that validates a Krimto scope
# parameter before a write/recall reaches the server. The server is the real
# enforcer (Build Spec Gap 07); this only saves a wasted round-trip on an
# obviously malformed scope. Falls OPEN (exit 0) on any parse problem.
input="$(cat 2>/dev/null || true)"

scope=""
if command -v jq >/dev/null 2>&1; then
  scope="$(printf '%s' "$input" | jq -r '.tool_input.scope // empty' 2>/dev/null || true)"
fi
# No scope argument (e.g. krimto_recall without an explicit scopes list) -> allow.
[ -z "${scope:-}" ] && exit 0

case "$scope" in
  user/*|team/*|org/*) exit 0 ;;
  *)
    echo "Invalid Krimto scope '$scope' — must be user/<id>, team/<slug>, or org/<slug>." >&2
    exit 2
    ;;
esac
