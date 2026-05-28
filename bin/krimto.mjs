#!/usr/bin/env node
// npx entry: start the Krimto MCP server over stdio (solo, no Docker / no key).
// The server source is ESM with extensionless imports, so it is loaded through tsx's
// programmatic API — the same tsx-at-runtime approach the Dockerfile uses. No build step,
// no rewrite. With no KRIMTO_HTTP_PORT set, main() takes the stdio path automatically.
import process from "node:process";
import { tsImport } from "tsx/esm/api";

/**
 * v0.2.34 — collect every value passed via a repeating flag. Used by `editors --add cursor
 * --add codex` and similar. Accepts both `--flag value` and `--flag=value` forms; ignores
 * the flag itself.
 */
function collectFlagValues(flags, name) {
  const values = [];
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (f === name) {
      if (typeof flags[i + 1] === "string") values.push(flags[i + 1]);
    } else if (typeof f === "string" && f.startsWith(`${name}=`)) {
      values.push(f.slice(name.length + 1));
    }
  }
  return values;
}

try {
  // Two-word command support (v0.2.17.1): `team init`, `team disband`. Collapse argv[2]+argv[3]
  // into one cmd string when argv[2] is one of the namespaced verbs.
  const rawCmd = process.argv[2];
  const sub = process.argv[3];
  // v0.2.32 — `service stop` / `service start` are explicit, scriptable subverbs (no prompt).
  // `service` alone still launches the interactive wizard. Mirrors the team/set two-word shape.
  const serviceSubverbs = ["stop", "start"];
  const cmd =
    rawCmd === "team" && typeof sub === "string"
      ? `team ${sub}`
      : rawCmd === "set" && typeof sub === "string"
        ? `set ${sub}`
        : rawCmd === "service" && typeof sub === "string" && serviceSubverbs.includes(sub)
          ? `service ${sub}`
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

  // Same guard for `krimto set <subverb>`.
  const knownSetCmds = ["set identity"];
  if (rawCmd === "set" && !knownSetCmds.includes(cmd)) {
    process.stderr.write(
      "Usage: krimto set <identity> <value>\n" +
        "  identity <email>   Change the identity used for new fact writes\n",
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

    // v0.2.24 — fix for the "AI agent runs krimto init and silently gets the legacy writer"
    // gap. When invoked from a non-TTY context (e.g. Claude Code's Bash tool) with no flags,
    // the interactive wizard CAN'T run; the legacy rule-only writer would proceed silently
    // and the caller wouldn't realize MCP wiring + service install were skipped. Print a
    // clear notice up front so the user (or AI relaying the result) knows what just happened.
    if (!isTty && !all && !minimal && !yes) {
      process.stderr.write(
        "ℹ️  No interactive terminal detected — running lightweight init (rules only).\n" +
          "   For the FULL setup (editor wiring + service install), either:\n" +
          "     • Run from a real terminal:   $ npx @krimto-labs/krimto init\n" +
          "     • Or pass --yes here:         $ npx @krimto-labs/krimto init --yes\n\n",
      );
    }

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

        // v0.2.25 — show both the files we wrote AND the files we skipped (already current).
        // Before, "wrote 2 of 4" was opaque: the user couldn't tell whether the other 2 were
        // intentionally skipped or silently failed. `res.considered` is the full target list
        // for this invocation, so the skipped set is just considered \ written.
        const writtenSet = new Set(res.written);
        const skipped = res.considered.filter((f) => !writtenSet.has(f));
        const skippedBlock = skipped.length > 0
          ? "\n   Already current (no change):\n" + skipped.map((f) => `     • ${f}`).join("\n") + "\n"
          : "";

        // v0.2.25 — Gap 9. Rules-only init writes "always use krimto_*" instructions, but if
        // no editor has Krimto wired into its MCP config, those instructions reference tools
        // that won't exist in chat. Detect and warn so the user doesn't think the chat side
        // is mysteriously broken later.
        let mcpWarning = "";
        try {
          const { detectExistingSetup } = await tsImport("../src/cli/init.ts", import.meta.url);
          const snap = await detectExistingSetup(process.cwd());
          if (snap.registeredEditors.length === 0) {
            mcpWarning =
              "\n⚠️  Rule files written, but NO editor is wired to Krimto yet.\n" +
              "   The rules tell your AI to use krimto_*, but those tools won't be available\n" +
              "   until you register the MCP server. From a terminal:\n" +
              "     $ npx @krimto-labs/krimto init        # full interactive wizard\n" +
              "     $ npx @krimto-labs/krimto connect     # print copy-paste snippets\n";
          }
        } catch {
          /* best-effort — don't block the success path if detection fails */
        }

        process.stderr.write(
          "\n✅ AUTO MODE on — rule written to " + res.written.length + " file" +
            (res.written.length === 1 ? "" : "s") + "\n" +
            "\n" +
            res.written.map((f) => `   ${f}`).join("\n") + "\n" +
            skippedBlock +
            "\n" +
            detectedLine +
            "━━ Next steps ━━\n" +
            "\n" +
            "  1. Restart your editor (so it loads the new rule + MCP tools)\n" +
            "  2. Test in chat: \"Remember that we use pnpm in this repo\"\n" +
            "  3. Verify it landed: $ npx @krimto-labs/krimto verify-connection\n" +
            mcpWarning +
            "\n" +
            // v0.2.32 — three honest off-ramps, three blast radii. The old single line said
            // "To undo: krimto uninit" which only stripped this project's rule files; users
            // were stranded thinking they had a working stop button when the service kept
            // running on their machine.
            "To stop the service:        $ npx @krimto-labs/krimto stop\n" +
            "To undo this project only:  $ npx @krimto-labs/krimto uninit\n" +
            "To disconnect everything:   $ npx @krimto-labs/krimto reset       (notes preserved)\n\n",
        );
      }
    } else if (yes) {
      // `--yes` runs the wizard with all defaults — for CI / `pnpm dev` scripts.
      const { runInitNonInteractive } = await tsImport("../src/cli/wizard.ts", import.meta.url);
      const result = await runInitNonInteractive(process.cwd());
      const wired = result.editorOutcomes.map((o) => o.editor).join(", ") || "(none)";
      // v0.2.27 — surface the port-readiness probe result. If the wizard installed an
      // always-running service AND the port came up, the editor can reconnect immediately.
      // If portReady is false, the wizard prints a warning so the CI/agent caller knows
      // the service is up but its HTTP listener didn't bind in time.
      let serviceLine = `   Run mode: as-needed\n`;
      if (result.serviceInstall) {
        if (result.serviceInstall.portReady === false) {
          serviceLine =
            `   Run mode: always-running ⚠ port did NOT come up within 10s\n` +
            `             Check /tmp/com.krimto.server.err.log for boot errors.\n`;
        } else {
          serviceLine = `   Run mode: always-running · port ready\n`;
        }
      }
      process.stderr.write(
        `\n✅ Krimto set up (non-interactive). Editors: ${wired}\n` +
          serviceLine +
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
    //
    // v0.2.32: the smoke-6 audit caught users assuming `uninit` was the full undo button —
    // it wasn't (the background service kept running). After rule removal, if a service
    // and/or a live krimto process is detected on this machine, we now ask whether the
    // user also wants to stop it. Default is No (the service is machine-wide; other
    // projects may use it). The flag `--also-stop` skips the prompt; `--keep-running`
    // explicitly suppresses it (for scripted runs).
    const flags = process.argv.slice(3);
    const alsoStopFlag = flags.includes("--also-stop");
    const keepRunningFlag = flags.includes("--keep-running");
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

      // Now offer to stop the service. Skip the prompt if either flag was passed.
      if (!keepRunningFlag) {
        const { isServiceInstalled, detectPlatform } = await tsImport("../src/cli/service.ts", import.meta.url);
        const svc = await isServiceInstalled(detectPlatform());
        if (svc.installed) {
          let stop = alsoStopFlag;
          if (!alsoStopFlag && process.stdin.isTTY === true) {
            const { confirmStop } = await tsImport("../src/cli/stopCmd.ts", import.meta.url);
            process.stderr.write(
              "ℹ️  The background service is still running on this machine — other projects may use it.\n",
            );
            stop = await confirmStop();
          }
          if (stop) {
            const { runStop } = await tsImport("../src/cli/stopCmd.ts", import.meta.url);
            const { resolveDataDir } = await tsImport("../src/server/index.ts", import.meta.url);
            const stopRes = await runStop({ dataDir: resolveDataDir() });
            process.stdout.write(stopRes.message);
          }
        }
      }
    }
  } else if (cmd === "where") {
    // `krimto where` — print the data directory. v0.2.31: deprecated in favour of
    // `krimto status` (which shows the data dir + everything else in one screen). Output is
    // preserved for scripts that grep for the path; deprecation hint goes to stderr so it
    // doesn't break pipes like `cd "$(krimto where)"`.
    const { resolveDataDir } = await tsImport("../src/server/index.ts", import.meta.url);
    process.stdout.write(`${resolveDataDir()}\n`);
    process.stderr.write("\n→ `krimto where` is now part of `krimto status` (the data-dir is in the Storage block).\n");
  } else if (cmd === "folder") {
    // `krimto folder` — guided move of the data dir. v0.2.31. Stops the service (if any),
    // moves the dir (atomic when same filesystem; cp+rm fallback for EXDEV), reinstalls the
    // service with the new KRIMTO_DATA env, prints an export hint for the user's shell.
    const flags = process.argv.slice(3);
    const toIdx = flags.indexOf("--to");
    const to = toIdx >= 0 ? flags[toIdx + 1] : undefined;
    const yes = flags.includes("--yes");
    const { runFolderCmd } = await tsImport("../src/cli/folderCmd.ts", import.meta.url);
    const { resolveDataDir } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runFolderCmd({
      from: resolveDataDir(),
      ...(to ? { to } : {}),
      yes,
    });
    if (result !== null) {
      process.stdout.write(result.message);
      if (result.status === "error") process.exitCode = 1;
    }
  } else if (cmd === "remote") {
    // `krimto remote` — friendly wrapper around setup-remote: show current / set new / remove.
    // v0.2.31. Reuses runSetupRemote for the set path so URL validation + first-push verification
    // happen in one place.
    const flags = process.argv.slice(3);
    const action = flags.includes("--show")
      ? "show"
      : flags.includes("--remove")
        ? "remove"
        : flags.includes("--set")
          ? "set"
          : undefined;
    const setIdx = flags.indexOf("--set");
    const url = setIdx >= 0 ? flags[setIdx + 1] : undefined;
    const yes = flags.includes("--yes");
    const { runRemoteCmd } = await tsImport("../src/cli/remoteCmd.ts", import.meta.url);
    const { resolveDataDir } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runRemoteCmd({
      dataDir: resolveDataDir(),
      ...(action ? { action } : {}),
      ...(url ? { url } : {}),
      yes,
    });
    if (result !== null) {
      process.stdout.write(result.message);
      if (result.setupResult && result.setupResult.status !== "ok") process.exitCode = 1;
    }
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
    // `krimto verify-connection` — v0.2.31: deprecated in favour of `krimto status` (which
    // includes the same lock + activity + sync info as one of its blocks). Existing output
    // preserved verbatim so existing scripts/READMEs keep working; deprecation hint to stderr.
    const { runVerifyConnection } = await tsImport("../src/cli/verifyConnection.ts", import.meta.url);
    const { resolveDataDir } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runVerifyConnection(resolveDataDir());
    process.stdout.write(result.message);
    process.stderr.write("\n→ `krimto verify-connection` is now part of `krimto status` (one command, four answers).\n");
    if (result.status === "none") process.exitCode = 1;
  } else if (cmd === "editors") {
    // `krimto editors` — Phase B shortcut. v0.2.34 added flag forms for AI-agent + CI use:
    //   --add <name>       Connect one editor (merge with current set). Repeatable.
    //   --remove <name>    Disconnect one editor (merge with current set). Repeatable.
    //   --set <list>       Replace the entire connected set (comma-separated).
    //   --list             Print current connected editors, one per line.
    // No flags + TTY → interactive checkbox wizard (unchanged).
    // No flags + no TTY → the new assertInteractiveOrUsage guard prints flag usage and exits 2.
    const flags = process.argv.slice(3);
    if (flags.includes("--list")) {
      const { listConnectedEditors } = await tsImport("../src/cli/editors.ts", import.meta.url);
      const connected = await listConnectedEditors();
      for (const e of connected) process.stdout.write(`${e}\n`);
    } else {
      const adds = collectFlagValues(flags, "--add");
      const removes = collectFlagValues(flags, "--remove");
      const setIdx = flags.indexOf("--set");
      const setValue = setIdx >= 0 ? flags[setIdx + 1] : undefined;
      const yes = flags.includes("--yes");
      const { runEditors, parseEditorList, listConnectedEditors } = await tsImport(
        "../src/cli/editors.ts",
        import.meta.url,
      );
      if (adds.length > 0 || removes.length > 0 || setValue !== undefined) {
        // Programmatic path — compute the target set and call applyEditors directly through
        // the wrapper. `editors` option short-circuits the prompt.
        let target;
        try {
          if (setValue !== undefined) {
            target = parseEditorList([setValue]);
          } else {
            const current = await listConnectedEditors();
            const toAdd = parseEditorList(adds);
            const toRemove = new Set(parseEditorList(removes));
            target = [...current];
            for (const a of toAdd) if (!target.includes(a)) target.push(a);
            target = target.filter((e) => !toRemove.has(e));
          }
        } catch (err) {
          process.stderr.write(`krimto editors: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(2);
        }
        const result = await runEditors({ editors: target, ...(yes ? { yes: true } : {}) });
        if (result === null) process.exitCode = 1;
      } else {
        // No flags — TTY user gets the interactive checkbox; agents get the guard's usage.
        const result = await runEditors();
        if (result === null) process.exitCode = 1;
      }
    }
  } else if (cmd === "search") {
    // `krimto search` — change the search provider (Keyword vs OpenAI) without re-running the
    // whole setup wizard (Phase B). v0.2.34 added flag forms for agent / CI use:
    //   --keyword                   Switch to keyword search (default, no API key).
    //   --openai --api-key sk-...   Switch to OpenAI semantic search (key verified first).
    // No flags + TTY → interactive select; no flags + no TTY → guard prints usage + exit 2.
    const flags = process.argv.slice(3);
    const keyword = flags.includes("--keyword");
    const openai = flags.includes("--openai");
    const apiKeyIdx = flags.indexOf("--api-key");
    const keyIdx = flags.indexOf("--key");
    const apiKey =
      apiKeyIdx >= 0 ? flags[apiKeyIdx + 1] : keyIdx >= 0 ? flags[keyIdx + 1] : undefined;
    const { runSearchSettings } = await tsImport("../src/cli/searchSettings.ts", import.meta.url);
    if (keyword) {
      const result = await runSearchSettings({ provider: "keyword" });
      if (result === null) process.exitCode = 1;
    } else if (openai) {
      if (!apiKey) {
        process.stderr.write("krimto search --openai requires --api-key <sk-...>\n");
        process.exit(2);
      }
      const result = await runSearchSettings({ provider: "openai", apiKey });
      if (result === null) process.exitCode = 1;
    } else {
      // No flags — TTY user gets the interactive select; agents get the guard's usage.
      const result = await runSearchSettings();
      if (result === null) process.exitCode = 1;
    }
  } else if (cmd === "service") {
    // `krimto service` — change run mode (as-needed / always-running / manual). Installs or
    // uninstalls the platform service to match (Phase B). v0.2.32: accepts `--as-needed`,
    // `--always` (alias for --always-running), or `--manual` to skip the prompt for scripts.
    const flags = process.argv.slice(3);
    const flagMode = flags.includes("--as-needed")
      ? "as-needed"
      : flags.includes("--always") || flags.includes("--always-running")
        ? "always-running"
        : flags.includes("--manual")
          ? "manual"
          : undefined;
    const { runServiceCmd } = await tsImport("../src/cli/serviceCmd.ts", import.meta.url);
    const { resolveDataDir } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runServiceCmd({
      dataDir: resolveDataDir(),
      ...(flagMode ? { mode: flagMode } : {}),
    });
    if (result === null) process.exitCode = 1;
  } else if (cmd === "stop" || cmd === "service stop") {
    // `krimto stop` — v0.2.32 first-class teardown verb. Uninstalls the launchd/systemd
    // service (if installed) and SIGTERMs whatever PID is holding the lock. Idempotent.
    // `service stop` is the same code path, named for users coming via `service` discovery.
    const { runStop } = await tsImport("../src/cli/stopCmd.ts", import.meta.url);
    const { resolveDataDir } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runStop({ dataDir: resolveDataDir() });
    process.stdout.write(result.message);
  } else if (cmd === "start" || cmd === "service start") {
    // `krimto start` — v0.2.32 counterpart to stop. If a service plist exists on disk,
    // reinstall + bootstrap (goes through the v0.2.26 kickstart-or-bootstrap path). If no
    // service is configured, prints an instructive message instead of doing a brittle
    // background-detached spawn.
    const { runStart } = await tsImport("../src/cli/stopCmd.ts", import.meta.url);
    const { resolveDataDir } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runStart({ dataDir: resolveDataDir() });
    process.stdout.write(result.message);
    if (result.status === "no-service-configured" || result.status === "error") process.exitCode = 1;
  } else if (cmd === "restart") {
    // `krimto restart` — v0.2.32. stop + start. On always-running mode this is effectively
    // `launchctl kickstart -k` via installService's v0.2.26 reload path — atomic, no
    // port-unbound window.
    const { runRestart } = await tsImport("../src/cli/stopCmd.ts", import.meta.url);
    const { resolveDataDir } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runRestart({ dataDir: resolveDataDir() });
    process.stdout.write(result.message);
  } else if (cmd === "reset") {
    // `krimto reset` — disconnect from all editors + uninstall service + wipe local key store.
    // `--wipe-notes` adds a second confirmation and moves the data dir to a trash sibling.
    const flags = process.argv.slice(3);
    const yes = flags.includes("--yes");
    const wipeNotes = flags.includes("--wipe-notes");
    const { runReset } = await tsImport("../src/cli/reset.ts", import.meta.url);
    const { resolveDataDir } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runReset({ dataDir: resolveDataDir(), yes, wipeNotes });
    if (result === null) process.exitCode = 1;
  } else if (cmd === "notes") {
    // `krimto notes [query]` — read-only list of every readable note (or search results).
    const query = process.argv[3];
    const { runNotes } = await tsImport("../src/cli/notes.ts", import.meta.url);
    const { resolveDataDir, resolveIdentity } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runNotes({
      dataDir: resolveDataDir(),
      identity: await resolveIdentity(),
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
    const result = await runEdit({ dataDir: resolveDataDir(), identity: await resolveIdentity(), id });
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
      identity: await resolveIdentity(),
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
      identity: await resolveIdentity(),
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
      identity: await resolveIdentity(),
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
    const result = await runDeleteFact(resolveDataDir(), await resolveIdentity(), id);
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
    // `krimto storage` — v0.2.31: deprecated in favour of `krimto status` (Storage block).
    // Existing output preserved; deprecation hint to stderr.
    const { formatStorage } = await tsImport("../src/cli/storage.ts", import.meta.url);
    const { resolveDataDir } = await tsImport("../src/server/index.ts", import.meta.url);
    process.stdout.write(formatStorage(resolveDataDir()));
    process.stderr.write("\n→ `krimto storage` is now part of `krimto status` (look for the Storage block).\n");
  } else if (cmd === "serve") {
    // `krimto serve` — boot the HTTP server (with /ui and /ui/connect) from the npx on-ramp,
    // so a stranger doesn't have to clone the repo or install Docker just to see the dashboard.
    // Defaults to port 8080; honors an existing KRIMTO_HTTP_PORT if the caller set one.
    if (!process.env.KRIMTO_HTTP_PORT) process.env.KRIMTO_HTTP_PORT = "8080";
    const mod = await tsImport("../src/server/index.ts", import.meta.url);
    await mod.main();
  } else if (cmd === "ui") {
    // `krimto ui` — open the browser dashboard. The Maria-journey doc names this as one of the
    // four user-facing verbs; the implementation is a one-liner over the platform "open this URL"
    // command. If no krimto server is running, the browser will hit ECONNREFUSED — surface a
    // pointer rather than a cryptic error.
    const port = process.env.KRIMTO_HTTP_PORT ?? "8080";
    const url = `http://localhost:${port}/ui`;
    const { spawn } = await import("node:child_process");
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
    process.stdout.write(`Opening ${url}\n`);
    process.stdout.write(`If the page doesn't load, start the server first:  $ krimto serve\n`);
  } else if (cmd === "open") {
    // `krimto open` — reveal the notes folder in the OS file manager. Companion to `krimto ui`
    // for users who want to inspect / back up the markdown directly. macOS uses `open`, Linux
    // `xdg-open`, Windows `explorer`. We deliberately do NOT do this from a browser button on
    // /ui (cross-origin POST + a process running as the user can `open arbitrary://` URLs);
    // the CLI is the right surface.
    const { resolveDataDir } = await tsImport("../src/server/index.ts", import.meta.url);
    const dataDir = resolveDataDir();
    const { spawn } = await import("node:child_process");
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(opener, [dataDir], { detached: true, stdio: "ignore" }).unref();
    process.stdout.write(`Revealing ${dataDir} in your file manager.\n`);
  } else if (cmd === "usage") {
    // `krimto usage` — the long-form guide. v0.2.31: kept (the guide is genuinely long and
    // doesn't fit in `krimto status`) but still flagged so users who want the dashboard know
    // where to find it.
    const { formatUsage } = await tsImport("../src/cli/usage.ts", import.meta.url);
    const { KRIMTO_VERSION } = await tsImport("../src/server/index.ts", import.meta.url);
    process.stdout.write(formatUsage(KRIMTO_VERSION));
    process.stderr.write("\n→ For runtime status (is Krimto running, recent calls, where data lives) use `krimto status`.\n");
  } else if (cmd === "connect") {
    // `krimto connect` — print stdio connect snippets (the npx on-ramp shape), so a solo user
    // doesn't have to chase the README. Honors KRIMTO_IDENTITY when set.
    const { formatConnect } = await tsImport("../src/cli/connect.ts", import.meta.url);
    process.stdout.write(await formatConnect({ identity: process.env.KRIMTO_IDENTITY }));
  } else if (cmd === "whoami") {
    // `krimto whoami` — show the active KRIMTO_IDENTITY and every place it's currently set
    // (each editor's MCP config + the always-running service unit). Surfaces drift between
    // sources so users notice before notes start splitting across two scopes.
    const { runWhoami } = await tsImport("../src/cli/whoami.ts", import.meta.url);
    const result = await runWhoami();
    process.stdout.write(result.message);
    if (result.mismatch) process.exitCode = 1;
  } else if (cmd === "set identity") {
    // `krimto set identity <email>` — update KRIMTO_IDENTITY across every registered editor
    // and the always-running service. Preserves other env keys (KRIMTO_EMBED_*). Existing
    // notes do NOT move — that's an intentional separate step.
    const newIdentity = process.argv[4];
    const flags = process.argv.slice(5);
    const yes = flags.includes("--yes");
    if (!newIdentity) {
      process.stderr.write(
        "Usage: krimto set identity <email> [--yes]\n  e.g. krimto set identity alice@acme.com\n",
      );
      process.exit(2);
    }
    const { runSetIdentity } = await tsImport("../src/cli/setIdentity.ts", import.meta.url);
    const { resolveDataDir } = await tsImport("../src/server/index.ts", import.meta.url);
    const result = await runSetIdentity({
      identity: newIdentity,
      dataDir: resolveDataDir(),
      yes,
    });
    process.stdout.write(result.message);
    if (result.status === "error") process.exitCode = 1;
  } else {
    const mod = await tsImport("../src/server/index.ts", import.meta.url);
    await mod.main();
  }
} catch (e) {
  process.stderr.write(`krimto: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
