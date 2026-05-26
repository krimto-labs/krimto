#!/usr/bin/env node
// npx entry: start the Krimto MCP server over stdio (solo, no Docker / no key).
// The server source is ESM with extensionless imports, so it is loaded through tsx's
// programmatic API — the same tsx-at-runtime approach the Dockerfile uses. No build step,
// no rewrite. With no KRIMTO_HTTP_PORT set, main() takes the stdio path automatically.
import process from "node:process";
import { tsImport } from "tsx/esm/api";

try {
  // Two-word command support (v0.2.17.1): `team init`, `team disband`. Collapse argv[2]+argv[3]
  // into one cmd string when argv[2] is one of the namespaced verbs.
  const rawCmd = process.argv[2];
  const cmd =
    rawCmd === "team" && typeof process.argv[3] === "string"
      ? `team ${process.argv[3]}`
      : rawCmd;

  // Guard: `krimto team` alone (or with an unknown subverb) shouldn't fall through to the stdio
  // MCP server. Print usage and exit instead.
  const knownTeamCmds = ["team init", "team disband"];
  if (rawCmd === "team" && !knownTeamCmds.includes(cmd)) {
    process.stderr.write(
      "Usage: krimto team <init|disband>\n" +
        "  init     Set up team mode (admin + members + git remote)\n" +
        "  disband  Step back to solo mode on this machine\n",
    );
    process.exit(2);
  }

  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    // `krimto --help` — surface every subcommand so a user who didn't read the README can still
    // discover them. Version is read from the server module so it never drifts from KRIMTO_VERSION.
    const { formatHelp } = await tsImport("../src/cli/help.ts", import.meta.url);
    const { KRIMTO_VERSION } = await tsImport("../src/server/index.ts", import.meta.url);
    process.stdout.write(formatHelp(KRIMTO_VERSION));
  } else if (cmd === "init") {
    // `krimto init` — v0.2.17 dispatch:
    //   • `--all` / `--minimal`  → legacy rule-only writer (v0.2.16 behaviour, kept for back-compat)
    //   • `--yes`                → non-interactive wizard apply (CI / scripts)
    //   • interactive TTY        → v0.2.17 wizard (5 questions, preselected defaults)
    //   • non-TTY w/o flags      → legacy rule-only writer (existing pipelines keep working)
    const flags = process.argv.slice(3);
    const all = flags.includes("--all");
    const minimal = flags.includes("--minimal");
    const yes = flags.includes("--yes");
    const isTty = process.stdin.isTTY === true;
    const legacyMode = all || minimal || (!isTty && !yes);

    if (legacyMode) {
      const { runInit } = await tsImport("../src/cli/init.ts", import.meta.url);
      const res = await runInit(process.cwd(), { all, minimal });
      if (res.written.length === 0) {
        const detected = res.detected ? res.considered.join(", ") : "(no editor signals)";
        process.stderr.write(
          "\n✅ Already in AUTO MODE — no changes needed\n" +
            "\n" +
            `   Rule detected in: ${detected}\n` +
            "\n" +
            "To undo:  $ npx @krimto-labs/krimto uninit\n" +
            "Other:    --all writes to every supported rule file\n\n",
        );
      } else {
        const detectedLine = res.detected
          ? `   --minimal — wrote only files matching detected editor signals.\n   (Default: write all 4 supported files. Use 'uninit' to clean up unwanted ones.)\n\n`
          : !minimal
            ? `   Default: wrote all 4 supported rule files (safer than detecting one editor and\n   missing the actual one). Pass --minimal to write only matched editors next time.\n\n`
            : "";
        process.stderr.write(
          "\n✅ AUTO MODE on — rule written to " + res.written.length + " file" +
            (res.written.length === 1 ? "" : "s") + "\n" +
            "\n" +
            res.written.map((f) => `   ${f}`).join("\n") + "\n" +
            "\n" +
            detectedLine +
            "━━ Next steps ━━\n" +
            "\n" +
            "  1. Restart your editor (so it loads the new rule)\n" +
            "  2. Test in chat: \"Remember that we use pnpm in this repo\"\n" +
            "  3. Verify it landed: $ npx @krimto-labs/krimto verify-connection\n" +
            "\n" +
            "To undo:  $ npx @krimto-labs/krimto uninit\n" +
            "Manual:   delete the block between <!-- krimto:start --> and <!-- krimto:end -->\n\n",
        );
      }
    } else if (yes) {
      // `--yes` runs the wizard with all defaults — for CI / `pnpm dev` scripts.
      const { runInitNonInteractive } = await tsImport("../src/cli/wizard.ts", import.meta.url);
      const result = await runInitNonInteractive(process.cwd());
      const wired = result.editorOutcomes.map((o) => o.editor).join(", ") || "(none)";
      process.stderr.write(
        `\n✅ Krimto set up (non-interactive). Editors: ${wired}\n` +
          `   Run mode: ${result.serviceInstall ? "always-running" : "as-needed"}\n` +
          `   Search:   ${result.embeddingsConfigured ? "OpenAI" : "keyword"}\n` +
          `   Data:     ${result.dataDir}\n\n` +
          "Restart your editor so it loads the new rule.\n\n",
      );
    } else {
      // Interactive wizard (the v0.2.17 first-run path).
      const { runInitWizard } = await tsImport("../src/cli/wizard.ts", import.meta.url);
      await runInitWizard(process.cwd());
      // The wizard prints its own summary; nothing more to do here.
    }
  } else if (cmd === "team init") {
    // `krimto team init` — admin-side team-mode wizard (v0.2.17.1). Reads `process.cwd()` so it
    // honors the project's data dir override (KRIMTO_DATA via resolveDataDir).
    const { runTeamInit } = await tsImport("../src/cli/teamInit.ts", import.meta.url);
    const { resolveDataDir } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runTeamInit({ dataDir: resolveDataDir() });
    if (result === null) process.exitCode = 1;
  } else if (cmd === "team disband") {
    // `krimto team disband` — per-machine step-back: rewrites HTTP MCP entries as stdio. Notes
    // and team's git state are untouched.
    const flags = process.argv.slice(4);
    const yes = flags.includes("--yes");
    const { runTeamDisband } = await tsImport("../src/cli/teamDisband.ts", import.meta.url);
    const result = await runTeamDisband({ yes });
    if (result === null) process.exitCode = 1;
  } else if (cmd === "join") {
    // `krimto join --server <url> --key <key>` — teammate-side: writes the HTTP MCP entry +
    // standing rule into each detected editor. Flags are required.
    const flags = process.argv.slice(3);
    const serverIdx = flags.indexOf("--server");
    const keyIdx = flags.indexOf("--key");
    const server = serverIdx >= 0 ? flags[serverIdx + 1] : undefined;
    const key = keyIdx >= 0 ? flags[keyIdx + 1] : undefined;
    if (!server || !key) {
      process.stderr.write(
        "Usage: krimto join --server <url> --key <krm_live_...>\n" +
          "  Example:\n" +
          "    krimto join --server http://maria-mbp:8080 --key krm_live_abc...\n",
      );
      process.exit(2);
    }
    const { runJoin } = await tsImport("../src/cli/join.ts", import.meta.url);
    const result = await runJoin({ server, key });
    if (result === null) process.exitCode = 1;
  } else if (cmd === "uninit") {
    // `krimto uninit` — remove the always-use-Krimto rule from this project's rules files,
    // flipping the project back from AUTO MODE to DEFAULT MODE.
    const { runUninit } = await tsImport("../src/cli/uninit.ts", import.meta.url);
    const res = await runUninit(process.cwd());
    if (res.cleaned.length === 0) {
      process.stderr.write("\n✅ No Krimto rule found — nothing to remove.\n\n");
    } else {
      const rewritten = res.cleaned.filter((f) => !res.deleted.includes(f));
      let body = "\n✅ Switched back to DEFAULT MODE — rule removed\n\n";
      if (rewritten.length > 0) {
        body += "   Rule block stripped (files kept, your other content preserved):\n";
        body += rewritten.map((f) => `     ${f}`).join("\n") + "\n";
      }
      if (res.deleted.length > 0) {
        body += "   Files deleted (they held only our rule):\n";
        body += res.deleted.map((f) => `     ${f}`).join("\n") + "\n";
      }
      body += "\n━━ What this means ━━\n\n";
      body += "  Krimto tools are still available to your agent, but it will only\n";
      body += "  call them when you explicitly say \"use krimto to ...\".\n";
      body += "  Run `krimto init` to switch back to AUTO MODE.\n";
      body += "\n  Restart your editor so it picks up the change.\n\n";
      process.stderr.write(body);
    }
  } else if (cmd === "where") {
    // `krimto where` — print the data directory (honors KRIMTO_DATA), so files aren't a surprise.
    const { resolveDataDir } = await tsImport("../src/server/index.ts", import.meta.url);
    process.stdout.write(`${resolveDataDir()}\n`);
  } else if (cmd === "setup-remote") {
    // `krimto setup-remote <url>` — point the data dir's git repo at a remote and verify a push.
    // Krimto must NOT be running while this is invoked (locks the .git/ index).
    const url = process.argv[3];
    if (!url) {
      process.stderr.write("Usage: krimto setup-remote <git-remote-url>\n  e.g. krimto setup-remote git@github.com:acme/krimto-data.git\n");
      process.exit(2);
    }
    const { runSetupRemote } = await tsImport("../src/cli/setupRemote.ts", import.meta.url);
    const { resolveDataDir } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runSetupRemote(resolveDataDir(), url);
    process.stdout.write(result.message + "\n");
    if (result.status !== "ok") process.exitCode = 1;
  } else if (cmd === "status") {
    // `krimto status` — v0.2.17 consolidator: replaces the four separate diagnostics from v0.2.16
    // (`verify-connection`, `where`, `storage`, `usage`) with one screen. The legacy verbs still
    // work and print the same content they always did, with a deprecation pointer at the bottom.
    const { runStatus } = await tsImport("../src/cli/status.ts", import.meta.url);
    const { resolveDataDir } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runStatus(resolveDataDir());
    process.stdout.write(result.message);
    if (result.status === "error") process.exitCode = 1;
  } else if (cmd === "verify-connection") {
    // `krimto verify-connection` — read the lockfile + activity JSONL to answer "is my agent
    // actually calling Krimto right now?" Works from any terminal regardless of how Krimto launched.
    const { runVerifyConnection } = await tsImport("../src/cli/verifyConnection.ts", import.meta.url);
    const { resolveDataDir } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runVerifyConnection(resolveDataDir());
    process.stdout.write(result.message);
    if (result.status === "none") process.exitCode = 1;
  } else if (cmd === "notes") {
    // `krimto notes [query]` — read-only list of every readable note (or search results).
    const query = process.argv[3];
    const { runNotes } = await tsImport("../src/cli/notes.ts", import.meta.url);
    const { resolveDataDir, resolveIdentity } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runNotes({
      dataDir: resolveDataDir(),
      identity: resolveIdentity(),
      query: typeof query === "string" && query.length > 0 ? query : undefined,
    });
    process.stdout.write(result.message);
  } else if (cmd === "edit") {
    // `krimto edit <id>` — open the fact's .md in $EDITOR, reindex on save.
    const id = process.argv[3];
    if (!id) {
      process.stderr.write("Usage: krimto edit <fact-id>\n");
      process.exit(2);
    }
    const { runEdit } = await tsImport("../src/cli/edit.ts", import.meta.url);
    const { resolveDataDir, resolveIdentity } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runEdit({ dataDir: resolveDataDir(), identity: resolveIdentity(), id });
    process.stdout.write(result.message);
    if (result.status !== "ok" && result.status !== "no-change") process.exitCode = 1;
  } else if (cmd === "mv") {
    // `krimto mv <id> <new-scope>` — move a fact between scopes; id is preserved.
    const id = process.argv[3];
    const newScope = process.argv[4];
    if (!id || !newScope) {
      process.stderr.write(
        "Usage: krimto mv <fact-id> <new-scope>\n  e.g. krimto mv fct_01H... team/backend\n",
      );
      process.exit(2);
    }
    const { runMv } = await tsImport("../src/cli/mv.ts", import.meta.url);
    const { resolveDataDir, resolveIdentity } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runMv({
      dataDir: resolveDataDir(),
      identity: resolveIdentity(),
      id,
      newScope,
    });
    process.stdout.write(result.message);
    if (result.status !== "ok" && result.status !== "no-change") process.exitCode = 1;
  } else if (cmd === "supersede") {
    // `krimto supersede <id>` — open $EDITOR for a new body, then call krimtoSupersede.
    const id = process.argv[3];
    if (!id) {
      process.stderr.write("Usage: krimto supersede <fact-id>\n");
      process.exit(2);
    }
    const { runSupersede } = await tsImport("../src/cli/supersedeCmd.ts", import.meta.url);
    const { resolveDataDir, resolveIdentity } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runSupersede({
      dataDir: resolveDataDir(),
      identity: resolveIdentity(),
      id,
    });
    process.stdout.write(result.message);
    if (result.status !== "ok" && result.status !== "no-change") process.exitCode = 1;
  } else if (cmd === "tag") {
    // `krimto tag <id> +new -old ...` — add or remove tags via frontmatter rewrite.
    const id = process.argv[3];
    const changes = process.argv.slice(4);
    if (!id || changes.length === 0) {
      process.stderr.write(
        "Usage: krimto tag <fact-id> +tag1 -tag2 ...\n",
      );
      process.exit(2);
    }
    const { runTag } = await tsImport("../src/cli/tag.ts", import.meta.url);
    const { resolveDataDir, resolveIdentity } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runTag({
      dataDir: resolveDataDir(),
      identity: resolveIdentity(),
      id,
      changes,
    });
    process.stdout.write(result.message);
    if (result.status !== "ok" && result.status !== "no-change") process.exitCode = 1;
  } else if (cmd === "rm" || cmd === "delete") {
    // `krimto rm <id>` — hard delete a fact (file + index + git deletion commit).
    // Refuses if a Krimto server is running on this data dir (would race on .git/ index).
    const id = process.argv[3];
    if (!id) {
      process.stderr.write("Usage: krimto rm <fact-id>\n  e.g. krimto rm fct_01HF7K9XYZ...\n");
      process.exit(2);
    }
    const { runDeleteFact } = await tsImport("../src/cli/deleteFact.ts", import.meta.url);
    const { resolveDataDir, resolveIdentity } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runDeleteFact(resolveDataDir(), resolveIdentity(), id);
    process.stdout.write(result.message);
    if (result.status !== "ok") process.exitCode = 1;
  } else if (cmd === "reindex") {
    // `krimto reindex` — rebuild index.db from the markdown source-of-truth on disk. Use case:
    // user manually deleted a .md file; the index has an orphan. Also recovers from corruption.
    const { runReindex } = await tsImport("../src/cli/reindex.ts", import.meta.url);
    const { resolveDataDir } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runReindex(resolveDataDir());
    process.stdout.write(result.message);
    if (result.status !== "ok") process.exitCode = 1;
  } else if (cmd === "setup-embeddings") {
    // `krimto setup-embeddings` — verify KRIMTO_EMBED_* config by sending one real test embedding,
    // so the user finds out about a bad key now, not after they've turned embeddings on.
    const { runSetupEmbeddings } = await tsImport("../src/cli/setupEmbeddings.ts", import.meta.url);
    const result = await runSetupEmbeddings();
    process.stdout.write(result.message + "\n");
    if (result.status !== "ok") process.exitCode = 1;
  } else if (cmd === "storage") {
    // `krimto storage` — explain where Krimto keeps data (markdown / git / index) in plain English,
    // so the "you own your data" half of Krimto's pitch is reachable without reading the README.
    const { formatStorage } = await tsImport("../src/cli/storage.ts", import.meta.url);
    const { resolveDataDir } = await tsImport("../src/server/index.ts", import.meta.url);
    process.stdout.write(formatStorage(resolveDataDir()));
  } else if (cmd === "serve") {
    // `krimto serve` — boot the HTTP server (with /ui and /ui/connect) from the npx on-ramp,
    // so a stranger doesn't have to clone the repo or install Docker just to see the dashboard.
    // Defaults to port 8080; honors an existing KRIMTO_HTTP_PORT if the caller set one.
    if (!process.env.KRIMTO_HTTP_PORT) process.env.KRIMTO_HTTP_PORT = "8080";
    const mod = await tsImport("../src/server/index.ts", import.meta.url);
    await mod.main();
  } else if (cmd === "usage") {
    // `krimto usage` — the long-form guide: the five tools, both modes, copy-paste examples.
    const { formatUsage } = await tsImport("../src/cli/usage.ts", import.meta.url);
    const { KRIMTO_VERSION } = await tsImport("../src/server/index.ts", import.meta.url);
    process.stdout.write(formatUsage(KRIMTO_VERSION));
  } else if (cmd === "connect") {
    // `krimto connect` — print stdio connect snippets (the npx on-ramp shape), so a solo user
    // doesn't have to chase the README. Honors KRIMTO_IDENTITY when set.
    const { formatConnect } = await tsImport("../src/cli/connect.ts", import.meta.url);
    process.stdout.write(formatConnect({ identity: process.env.KRIMTO_IDENTITY }));
  } else {
    const mod = await tsImport("../src/server/index.ts", import.meta.url);
    await mod.main();
  }
} catch (e) {
  process.stderr.write(`krimto: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
