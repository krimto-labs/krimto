// G5 — Persistent activity log. Records every MCP tool call to a JSONL file under the data dir so
// (a) the /ui dashboard can show "is my agent actually hitting Krimto right now?" without grepping
// stderr, and (b) the `krimto verify-connection` CLI can read the same file from a separate process.
//
// Persistence is append-only JSONL (one JSON object per line). Size is bounded by trimming to the
// last N entries on every write — cheap at this scale (one fact ≈ 100B; capped at 200 entries ≈ 20KB).
// Failures are swallowed: activity logging must never break a write/recall.

import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface ActivityEntry {
  /** ISO 8601 UTC timestamp. */
  timestamp: string;
  /** MCP tool name (krimto_write, krimto_recall, krimto_read, krimto_supersede, krimto_list_scopes). */
  tool: string;
  /** Caller identity (server-resolved). */
  identity: string;
  /** Short human-readable detail (query text, fact title, scope, etc.) — no secrets. */
  detail?: string;
}

const MAX_ENTRIES = 200;

export class ActivityLog {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, ".krimto", "activity.jsonl");
  }

  /** Append one entry. Best-effort — a write failure is logged to stderr but never re-thrown. */
  async record(tool: string, identity: string, detail?: string): Promise<void> {
    const entry: ActivityEntry = { timestamp: new Date().toISOString(), tool, identity };
    if (detail !== undefined) entry.detail = detail;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, JSON.stringify(entry) + "\n", "utf8");
      await this.trim();
    } catch (e) {
      process.stderr.write(`krimto: activity log write failed (ignored): ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  /** Return the last `n` entries, oldest-first. Returns [] when the file is absent or unreadable. */
  async tail(n: number): Promise<ActivityEntry[]> {
    try {
      const text = await fs.readFile(this.file, "utf8");
      const lines = text.split("\n").filter((l) => l.length > 0);
      return lines.slice(-n).map((line) => JSON.parse(line) as ActivityEntry);
    } catch {
      return [];
    }
  }

  /**
   * Gap #5 — count calls by category within a recent window. Used to detect "many recalls, zero
   * writes" which is the smell of another memory system (Claude Code's per-session auto-memory)
   * intercepting "remember X" before krimto_write gets a chance.
   */
  async stats(windowMs: number = 5 * 60 * 1000, now: Date = new Date()): Promise<{ recalls: number; writes: number; total: number }> {
    const since = now.getTime() - windowMs;
    let recalls = 0;
    let writes = 0;
    let total = 0;
    try {
      const text = await fs.readFile(this.file, "utf8");
      for (const line of text.split("\n")) {
        if (!line) continue;
        const entry = JSON.parse(line) as ActivityEntry;
        const t = Date.parse(entry.timestamp);
        if (Number.isNaN(t) || t < since) continue;
        total++;
        if (entry.tool === "krimto_recall") recalls++;
        else if (entry.tool === "krimto_write" || entry.tool === "krimto_supersede" || entry.tool === "krimto_delete") writes++;
      }
    } catch {
      /* no file yet */
    }
    return { recalls, writes, total };
  }

  /** Drop everything older than the most recent MAX_ENTRIES to keep the file bounded. */
  private async trim(): Promise<void> {
    const text = await fs.readFile(this.file, "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    if (lines.length <= MAX_ENTRIES) return;
    await fs.writeFile(this.file, lines.slice(-MAX_ENTRIES).join("\n") + "\n", "utf8");
  }
}
