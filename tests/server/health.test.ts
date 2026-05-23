import { describe, it, expect } from "vitest";
import { openIndexDb } from "../../src/index/db";
import { FactIndex } from "../../src/index/factIndex";
import { sqliteHealth, indexHealth, healthReady } from "../../src/server/health";

describe("health checks reflect real index state", () => {
  it("reports ok sqlite and a fact count once built", () => {
    const db = openIndexDb(":memory:", { provider: "none", dimensions: 0 });
    const idx = new FactIndex(db);
    expect(sqliteHealth(db).status).toBe("ok");
    expect(indexHealth(idx, false)).toMatchObject({ status: "ok", fact_count: 0 });
    expect(indexHealth(idx, true)).toMatchObject({ status: "building" });
    db.close();
  });

  it("healthReady is 200 only when sqlite and index are ok", () => {
    const ok = { status: "ok" } as const;
    const ready = healthReady("0.2.0", { sqlite: ok, index: { status: "ok", fact_count: 3 }, git_remote: ok });
    expect(ready.http).toBe(200);
    const notReady = healthReady("0.2.0", { sqlite: ok, index: { status: "building" }, git_remote: ok });
    expect(notReady.http).toBe(503);
  });
});
