import { describe, expect, it } from "vitest";
import { KrimtoError, httpStatus, jsonRpcCode, toJsonRpcError } from "../../src/server/errors";
import { healthLive, healthReady, type ReadyChecks } from "../../src/server/health";
import { RateLimiter } from "../../src/server/ratelimit";
import { buildTelemetryPayload, defaultTelemetryConfig } from "../../src/server/telemetry";

describe("error mapping (Gap 16)", () => {
  it("maps codes to JSON-RPC and HTTP", () => {
    expect(jsonRpcCode("unauthorized")).toBe(-32000);
    expect(jsonRpcCode("forbidden")).toBe(-32001);
    expect(jsonRpcCode("rate_limited")).toBe(-32002);
    expect(jsonRpcCode("not_found")).toBe(-32003);
    expect(jsonRpcCode("invalid_params")).toBe(-32602);
    expect(httpStatus("forbidden")).toBe(403);
    expect(httpStatus("not_found")).toBe(404);
    expect(httpStatus("rate_limited")).toBe(429);
    expect(httpStatus("invalid_params")).toBe(422);
  });
  it("serializes a KrimtoError to a JSON-RPC error object", () => {
    const e = new KrimtoError("forbidden", "nope", { scope: "team/x" });
    expect(toJsonRpcError(e)).toEqual({ code: -32001, message: "nope", data: { scope: "team/x" } });
  });
});

describe("health (Gap 17)", () => {
  const ok = { status: "ok" as const };
  it("liveness is minimal", () => {
    expect(healthLive("0.2.0", 8472.9)).toEqual({ status: "alive", version: "0.2.0", uptime_seconds: 8472 });
  });
  it("ready when sqlite + index are ok", () => {
    const checks: ReadyChecks = { sqlite: ok, index: ok, git_remote: ok };
    expect(healthReady("0.2.0", checks).http).toBe(200);
  });
  it("not ready while the index is building", () => {
    const checks: ReadyChecks = { sqlite: ok, index: { status: "building", progress: 0.3 }, git_remote: ok };
    const r = healthReady("0.2.0", checks);
    expect(r.http).toBe(503);
    expect(r.body.status).toBe("not_ready");
  });
  it("a failing git remote does NOT block readiness", () => {
    const checks: ReadyChecks = { sqlite: ok, index: ok, git_remote: { status: "error" } };
    expect(healthReady("0.2.0", checks).http).toBe(200);
  });
});

describe("rate limiting (Gap 18)", () => {
  it("is a no-op when disabled (self-host default)", () => {
    const rl = new RateLimiter({ enabled: false, perKeyPerMinute: 60 });
    for (let i = 0; i < 1000; i++) expect(rl.check("k").allowed).toBe(true);
  });

  it("allows up to the limit, then 429s with Retry-After", () => {
    let now = 0;
    const rl = new RateLimiter({ enabled: true, perKeyPerMinute: 2 }, () => now);
    expect(rl.check("k").allowed).toBe(true);
    expect(rl.check("k").allowed).toBe(true);
    const blocked = rl.check("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    // next window
    now += 60_000;
    expect(rl.check("k").allowed).toBe(true);
  });

  it("emits X-RateLimit-* headers", () => {
    const rl = new RateLimiter({ enabled: true, perKeyPerMinute: 5 });
    const headers = rl.headers(rl.check("k"));
    expect(headers).toHaveProperty("X-RateLimit-Limit", "5");
    expect(headers).toHaveProperty("X-RateLimit-Remaining", "4");
    expect(headers["X-RateLimit-Reset"]).toMatch(/^\d+$/);
  });
});

describe("telemetry (Gap 19)", () => {
  it("is off by default", () => {
    expect(defaultTelemetryConfig.enabled).toBe(false);
  });
  it("emits only bucketed, content-free fields", () => {
    const payload = buildTelemetryPayload(
      { enabled: true, installId: "uuid-123", deploymentType: "self-hosted" },
      { version: "0.2.0", factCount: 5000, teamCount: 3, activeUserCount: 1 },
    );
    expect(payload).toEqual({
      version: "0.2.0",
      install_id: "uuid-123",
      deployment_type: "self-hosted",
      fact_count_bucket: "1K-10K",
      team_count_bucket: "2-5",
      active_user_count_bucket: "1",
    });
    // no raw counts, content, identities, or scopes leak
    expect(Object.keys(payload).sort()).toEqual([
      "active_user_count_bucket",
      "deployment_type",
      "fact_count_bucket",
      "install_id",
      "team_count_bucket",
      "version",
    ]);
  });
});
