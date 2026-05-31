import { defineConfig, configDefaults } from "vitest/config";

// Exclude .claude/ so test discovery never walks into nested git worktrees
// (`.claude/worktrees/<branch>/`), which would otherwise double-count tests
// when `pnpm test` runs from the repo root while a worktree exists.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.claude/**"],
    // The integration suite spawns many `tsx`-compiling subprocesses (the real `bin/krimto.mjs`,
    // git pull/stash, a fake embeddings server, …). Under vitest's parallel workers these saturate
    // CPU, and the 5s default was starving fast tests into spurious timeouts. 20s gives headroom;
    // a genuinely-stuck test still fails well before CI's job timeout.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
