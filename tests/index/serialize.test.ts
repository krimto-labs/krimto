import { describe, it, expect } from "vitest";
import { Serializer } from "../../src/index/serialize";

describe("Serializer", () => {
  it("runs queued tasks one at a time, in order", async () => {
    const s = new Serializer();
    const log: number[] = [];
    const slow = (n: number, ms: number) =>
      s.run(async () => {
        await new Promise((r) => setTimeout(r, ms));
        log.push(n);
      });
    await Promise.all([slow(1, 30), slow(2, 5), slow(3, 1)]);
    expect(log).toEqual([1, 2, 3]); // FIFO despite differing durations
  });

  it("returns each task's result and isolates failures", async () => {
    const s = new Serializer();
    await expect(s.run(async () => 42)).resolves.toBe(42);
    await expect(s.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    // a rejected task must not break the chain for subsequent tasks
    await expect(s.run(async () => "ok")).resolves.toBe("ok");
  });
});
