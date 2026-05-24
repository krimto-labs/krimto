// Gap 19 — Telemetry. Off by default. When opted in, only bucketed counts are sent —
// never fact content, identities, queries, scope paths, or git remotes.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ulid } from "ulid";

export interface TelemetryConfig {
  enabled: boolean;
  installId: string;
  deploymentType: "self-hosted" | "cloud";
  endpoint?: string;
  /** Send interval; defaults to daily when omitted. */
  intervalMs?: number;
}

export interface TelemetryInput {
  version: string;
  factCount: number;
  teamCount: number;
  activeUserCount: number;
}

export interface TelemetryPayload {
  version: string;
  install_id: string;
  deployment_type: "self-hosted" | "cloud";
  fact_count_bucket: string;
  team_count_bucket: string;
  active_user_count_bucket: string;
}

function bucketFacts(n: number): string {
  if (n <= 100) return "0-100";
  if (n <= 1000) return "100-1K";
  if (n <= 10000) return "1K-10K";
  return "10K+";
}
function bucketTeams(n: number): string {
  if (n <= 1) return "1";
  if (n <= 5) return "2-5";
  if (n <= 20) return "6-20";
  return "20+";
}
function bucketUsers(n: number): string {
  if (n <= 1) return "1";
  if (n <= 10) return "2-10";
  if (n <= 50) return "11-50";
  return "50+";
}

/** Build the (bucketed, content-free) telemetry payload. */
export function buildTelemetryPayload(config: TelemetryConfig, input: TelemetryInput): TelemetryPayload {
  return {
    version: input.version,
    install_id: config.installId,
    deployment_type: config.deploymentType,
    fact_count_bucket: bucketFacts(input.factCount),
    team_count_bucket: bucketTeams(input.teamCount),
    active_user_count_bucket: bucketUsers(input.activeUserCount),
  };
}

export const defaultTelemetryConfig: TelemetryConfig = {
  enabled: false,
  installId: "",
  deploymentType: "self-hosted",
};

/** Telemetry config from env; enabled only when KRIMTO_TELEMETRY_ENDPOINT is set. Off by default. */
export function telemetryConfigFromEnv(env: NodeJS.ProcessEnv, installId: string): TelemetryConfig {
  const endpoint = env.KRIMTO_TELEMETRY_ENDPOINT;
  const rawInterval = env.KRIMTO_TELEMETRY_INTERVAL_MS;
  const n = rawInterval === undefined ? NaN : Number(rawInterval);
  const intervalMs = Number.isInteger(n) && n >= 1000 ? n : 86_400_000;
  return { enabled: Boolean(endpoint), installId, deploymentType: "self-hosted", endpoint, intervalMs };
}

/** Read or create a stable install id at <dataDir>/.krimto/telemetry-id (not a secret). */
export async function resolveInstallId(dataDir: string): Promise<string> {
  const file = path.join(dataDir, ".krimto", "telemetry-id");
  try {
    const existing = (await fs.readFile(file, "utf8")).trim();
    if (existing) return existing;
  } catch {
    /* not created yet */
  }
  const id = ulid();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${id}\n`, "utf8");
  return id;
}

export type TelemetryPost = (url: string, payload: TelemetryPayload) => Promise<void>;

const fetchPost: TelemetryPost = async (url, payload) => {
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
};

/** Periodically POSTs bucketed, content-free counts. Off by default; best-effort; never throws. */
export class TelemetrySender {
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private readonly config: TelemetryConfig,
    private readonly collect: () => TelemetryInput,
    private readonly post: TelemetryPost = fetchPost,
  ) {}

  async sendOnce(): Promise<void> {
    if (!this.config.enabled || !this.config.endpoint) return;
    try {
      await this.post(this.config.endpoint, buildTelemetryPayload(this.config, this.collect()));
    } catch (e) {
      process.stderr.write(`krimto: telemetry send failed (ignored): ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  start(): void {
    if (this.timer || !this.config.enabled) return;
    void this.sendOnce();
    this.timer = setInterval(() => void this.sendOnce(), this.config.intervalMs ?? 86_400_000);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
