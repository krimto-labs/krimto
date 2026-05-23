// Gap 19 — Telemetry. Off by default. When opted in, only bucketed counts are sent —
// never fact content, identities, queries, scope paths, or git remotes.

export interface TelemetryConfig {
  enabled: boolean;
  installId: string;
  deploymentType: "self-hosted" | "cloud";
  endpoint?: string;
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
