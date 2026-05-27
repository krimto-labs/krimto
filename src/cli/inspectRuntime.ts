// v0.2.26 — single reconciled view of "what is Krimto doing right now". Replaces the prior
// ad-hoc detection scattered across status.ts, verifyConnection.ts, whoami.ts, and the
// wizard's reconfigure menu, which disagreed in the smoke-6 transcript audit:
//   • Cursor mcp.json had krimto, Claude Code's `claude mcp` had krimto, launchctl showed
//     the service loaded — but reconfigure menu said "Editors: Cursor", verify-connection
//     said "Launched by: ad-hoc", and reset said "No changes made".
//
// `inspectRuntime` reads every source we care about and reconciles them. Downstream
// commands consume one consistent view instead of running their own subset of checks.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isProcessAlive, type LaunchedBy, type LockInfo, type LockMode } from "../server/lock";
import {
  detectEditorEnvironments,
  detectExistingSetup,
  type EditorKind,
  type RunMode,
  type SearchProvider,
  type SetupSnapshot,
} from "./init";
import { probeServiceState } from "./service";

export interface RuntimeLock {
  pid: number;
  started: string;
  mode: LockMode;
  /**
   * The lock file's own `launchedBy` value. Pre-v0.2.25 processes didn't write this field,
   * so we default to "ad-hoc". The reconciled answer (correct even for pre-v0.2.25 runs)
   * is in {@link RuntimeState.effectiveLaunchedBy}.
   */
  launchedBy: LaunchedBy;
  alive: boolean;
}

export interface RuntimeService {
  installed: boolean;
  loaded: boolean;
  runningPid: number | null;
  unitPath: string | undefined;
}

export interface RuntimeState {
  /** Lock file state (parsed + alive-check), or null when no readable lock. */
  lock: RuntimeLock | null;
  /** Cross-platform service probe (unit-on-disk + actually-loaded + running PID). */
  service: RuntimeService;
  /**
   * Reconciled launch source. Trusts launchctl/systemctl over the lock file: if the
   * running PID matches the service's `runningPid`, the process IS service-launched,
   * even when the lock file lacks the `launchedBy` field (pre-v0.2.25 runs).
   */
  effectiveLaunchedBy: LaunchedBy | null;
  /** Snapshot from detectExistingSetup (registered editors, run mode, search provider). */
  snapshot: SetupSnapshot;
  /** Detected editor environments (all 4, with present/installed flags). */
  editors: Awaited<ReturnType<typeof detectEditorEnvironments>>;
  /** Editors registered with Krimto right now. Same as snapshot.registeredEditors. */
  registeredEditors: EditorKind[];
  /** Convenience: the configured run mode (always-running iff a service unit exists). */
  runMode: RunMode;
  /** Convenience: the configured search provider. */
  searchProvider: SearchProvider;
}

export interface InspectOptions {
  cwd?: string;
  homeDir?: string;
}

/**
 * Build a single, reconciled {@link RuntimeState}. Cheap enough to call from every read-side
 * command (one fs read for lock, one launchctl/systemctl print, one `claude mcp list`, one
 * pass over editor MCP configs).
 */
export async function inspectRuntime(dataDir: string, opts: InspectOptions = {}): Promise<RuntimeState> {
  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.homeDir ?? os.homedir();

  const lock = await readLock(dataDir);
  const snapshot = await detectExistingSetup(cwd, homeDir);
  const editors = await detectEditorEnvironments(cwd, homeDir);
  const service = await probeServiceState(undefined, homeDir);

  // The reconciliation step. Two signals:
  //   1. The lock file's self-reported launchedBy (pre-v0.2.25 runs default to "ad-hoc").
  //   2. Whether the running PID matches launchd's program-PID.
  // If (2) says yes, we know the process was service-launched regardless of what (1) claims.
  let effectiveLaunchedBy: LaunchedBy | null = null;
  if (lock && lock.alive) {
    if (service.loaded && service.runningPid === lock.pid) {
      effectiveLaunchedBy = "service";
    } else {
      effectiveLaunchedBy = lock.launchedBy;
    }
  }

  return {
    lock,
    service: {
      installed: service.unitPresent,
      loaded: service.loaded,
      runningPid: service.runningPid,
      unitPath: undefined, // service.ts's isServiceInstalled returns this; we don't surface it in v0.2.26
    },
    effectiveLaunchedBy,
    snapshot,
    editors,
    registeredEditors: snapshot.registeredEditors,
    runMode: snapshot.runMode,
    searchProvider: snapshot.searchProvider,
  };
}

async function readLock(dataDir: string): Promise<RuntimeLock | null> {
  const file = path.join(dataDir, ".krimto", "lock.json");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  let parsed: Partial<LockInfo>;
  try {
    parsed = JSON.parse(raw) as Partial<LockInfo>;
  } catch {
    return null;
  }
  if (
    typeof parsed.pid !== "number" ||
    typeof parsed.started !== "string" ||
    (parsed.mode !== "stdio" && parsed.mode !== "http")
  ) {
    return null;
  }
  return {
    pid: parsed.pid,
    started: parsed.started,
    mode: parsed.mode,
    launchedBy: parsed.launchedBy === "service" ? "service" : "ad-hoc",
    alive: isProcessAlive(parsed.pid),
  };
}
