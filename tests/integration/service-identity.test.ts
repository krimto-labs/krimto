// Tests for per-data-dir service identity (the "each install gets its own slot" fix).
//
// Background: every Krimto install used a FIXED service label (`com.krimto.server`) on a FIXED
// port (8080). Two installs pointing at different data dirs on one machine collided — the second
// `launchctl bootstrap`/`kickstart` hijacked the first's running service, and both fought over
// :8080. The fix derives a STABLE label + port from the data-dir path, so distinct data dirs get
// distinct slots, while the canonical `~/.krimto` keeps the legacy `com.krimto.server` / :8080
// identity unchanged (so normal single-install users — and every existing doc — are unaffected).

import { describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

import { serviceLabel, servicePort, serviceSlug, SERVICE_LABEL } from "../../src/cli/service";

const DEFAULT = path.join(os.homedir(), ".krimto");

describe("serviceSlug", () => {
  it("is empty for the canonical ~/.krimto (legacy identity preserved)", () => {
    expect(serviceSlug(DEFAULT)).toBe("");
  });

  it("is empty when dataDir resolves to the default even via a non-normalized path", () => {
    expect(serviceSlug(path.join(DEFAULT, "..", ".krimto"))).toBe("");
  });

  it("is 8 lowercase hex chars for a non-default data dir", () => {
    expect(serviceSlug("/Users/maria/.krimto")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic — same path always yields the same slug", () => {
    expect(serviceSlug("/Users/maria/.krimto")).toBe(serviceSlug("/Users/maria/.krimto"));
  });

  it("differs for different data dirs", () => {
    expect(serviceSlug("/Users/a/.krimto")).not.toBe(serviceSlug("/Users/b/.krimto"));
  });

  it("honors an explicit defaultDir override (for tests / non-default homes)", () => {
    expect(serviceSlug("/x/.krimto", "/x/.krimto")).toBe("");
    expect(serviceSlug("/y/.krimto", "/x/.krimto")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("treats a KRIMTO_DATA-set non-default dir as NON-canonical (the env is the install, not the default)", () => {
    // Regression: at runtime a non-default install sets KRIMTO_DATA=/projX/.krimto. The "default"
    // a slug is measured against must stay ~/.krimto — otherwise the install's own dir reads as
    // canonical → slug "" → port 8080 → it collides with the real canonical install.
    const prev = process.env.KRIMTO_DATA;
    process.env.KRIMTO_DATA = "/Users/maria/projX/.krimto";
    try {
      expect(serviceSlug("/Users/maria/projX/.krimto")).toMatch(/^[0-9a-f]{8}$/);
      expect(servicePort("/Users/maria/projX/.krimto")).not.toBe(8080);
    } finally {
      if (prev === undefined) delete process.env.KRIMTO_DATA;
      else process.env.KRIMTO_DATA = prev;
    }
  });
});

describe("serviceLabel", () => {
  it("is the bare legacy label for the canonical data dir", () => {
    expect(serviceLabel(DEFAULT)).toBe(SERVICE_LABEL);
    expect(serviceLabel(DEFAULT)).toBe("com.krimto.server");
  });

  it("suffixes the slug for a non-default data dir", () => {
    expect(serviceLabel("/Users/maria/.krimto")).toBe(`${SERVICE_LABEL}.${serviceSlug("/Users/maria/.krimto")}`);
    expect(serviceLabel("/Users/maria/.krimto")).toMatch(/^com\.krimto\.server\.[0-9a-f]{8}$/);
  });
});

describe("servicePort", () => {
  it("is 8080 for the canonical data dir (legacy port preserved)", () => {
    expect(servicePort(DEFAULT)).toBe(8080);
  });

  it("is a stable port in 8081..8980 for a non-default data dir", () => {
    const p = servicePort("/Users/maria/.krimto");
    expect(p).toBeGreaterThanOrEqual(8081);
    expect(p).toBeLessThanOrEqual(8980);
    expect(p).toBe(servicePort("/Users/maria/.krimto")); // deterministic
  });

  it("never returns 8080 for a non-default data dir (no collision with the canonical install)", () => {
    expect(servicePort("/Users/a/.krimto")).not.toBe(8080);
    expect(servicePort("/Users/b/.krimto")).not.toBe(8080);
  });
});
