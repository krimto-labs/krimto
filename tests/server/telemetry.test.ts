import { describe, it, expect, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  TelemetrySender,
  telemetryConfigFromEnv,
  resolveInstallId,
  type TelemetryInput,
  type TelemetryPost,
} from "../../src/server/telemetry";

const input: TelemetryInput = { version: "0.2.0", factCount: 5, teamCount: 2, activeUserCount: 3 };

describe("telemetryConfigFromEnv", () => {
  it("is disabled without an endpoint, enabled with one", () => {
    expect(telemetryConfigFromEnv({}, "id1").enabled).toBe(false);
    const c = telemetryConfigFromEnv({ KRIMTO_TELEMETRY_ENDPOINT: "https://t.example/ping" }, "id1");
    expect(c.enabled).toBe(true);
    expect(c.endpoint).toBe("https://t.example/ping");
    expect(c.installId).toBe("id1");
    expect(c.intervalMs).toBe(86_400_000);
  });
});

describe("resolveInstallId", () => {
  it("creates an id once and returns it stably", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-tid-"));
    const a = await resolveInstallId(dir);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
    const b = await resolveInstallId(dir);
    expect(b).toBe(a);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("TelemetrySender", () => {
  it("sends only bucketed, content-free counts when enabled", async () => {
    const postMock = vi.fn<TelemetryPost>(async () => {});
    const cfg = telemetryConfigFromEnv({ KRIMTO_TELEMETRY_ENDPOINT: "https://t.example/ping" }, "id1");
    const sender = new TelemetrySender(cfg, () => input, postMock);
    await sender.sendOnce();
    expect(postMock).toHaveBeenCalledTimes(1);
    const [url, payload] = postMock.mock.calls[0]!;
    expect(url).toBe("https://t.example/ping");
    expect(Object.keys(payload).sort()).toEqual(
      ["active_user_count_bucket", "deployment_type", "fact_count_bucket", "install_id", "team_count_bucket", "version"],
    );
    expect(JSON.stringify(payload)).not.toMatch(/alice|user\/|team\/|query/i);
  });

  it("does nothing when disabled", async () => {
    const post: TelemetryPost = vi.fn(async () => {});
    const sender = new TelemetrySender(telemetryConfigFromEnv({}, "id1"), () => input, post);
    await sender.sendOnce();
    expect(post).not.toHaveBeenCalled();
  });

  it("never throws when the post fails", async () => {
    const post: TelemetryPost = vi.fn(async () => { throw new Error("network down"); });
    const cfg = telemetryConfigFromEnv({ KRIMTO_TELEMETRY_ENDPOINT: "https://t.example/ping" }, "id1");
    await expect(new TelemetrySender(cfg, () => input, post).sendOnce()).resolves.toBeUndefined();
  });
});
