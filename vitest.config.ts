import { defineConfig, configDefaults } from "vitest/config";

// Exclude .claude/ so test discovery never walks into nested git worktrees
// (`.claude/worktrees/<branch>/`), which would otherwise double-count tests
// when `pnpm test` runs from the repo root while a worktree exists.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
