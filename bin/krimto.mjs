#!/usr/bin/env node
// npx entry: start the Krimto MCP server over stdio (solo, no Docker / no key).
// The server source is ESM with extensionless imports, so it is loaded through tsx's
// programmatic API — the same tsx-at-runtime approach the Dockerfile uses. No build step,
// no rewrite. With no KRIMTO_HTTP_PORT set, main() takes the stdio path automatically.
import process from "node:process";
import { tsImport } from "tsx/esm/api";

try {
  const cmd = process.argv[2];
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    // `krimto --help` — surface every subcommand so a user who didn't read the README can still
    // discover them. Version is read from the server module so it never drifts from KRIMTO_VERSION.
    const { formatHelp } = await tsImport("../src/cli/help.ts", import.meta.url);
    const { KRIMTO_VERSION } = await tsImport("../src/server/index.ts", import.meta.url);
    process.stdout.write(formatHelp(KRIMTO_VERSION));
  } else if (cmd === "init") {
    // `krimto init` — drop the always-use-Krimto rule into this project's agent rules files.
    // By default, auto-detects the editor (.cursor/, CLAUDE.md, etc.) and writes only matching
    // files. Pass `--all` to write to every supported rules file regardless of signals.
    const all = process.argv.slice(3).includes("--all");
    const { runInit } = await tsImport("../src/cli/init.ts", import.meta.url);
    const res = await runInit(process.cwd(), { all });
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
        ? `   Detected editor signals — wrote only matching files.\n   (--all writes to all 4 supported files instead.)\n\n`
        : !all
          ? `   No editor signals found — wrote all supported files.\n   (Re-run with --all to force, or 'uninit' to remove what you don't need.)\n\n`
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
  } else if (cmd === "verify-connection") {
    // `krimto verify-connection` — read the lockfile + activity JSONL to answer "is my agent
    // actually calling Krimto right now?" Works from any terminal regardless of how Krimto launched.
    const { runVerifyConnection } = await tsImport("../src/cli/verifyConnection.ts", import.meta.url);
    const { resolveDataDir } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runVerifyConnection(resolveDataDir());
    process.stdout.write(result.message);
    if (result.status === "none") process.exitCode = 1;
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
