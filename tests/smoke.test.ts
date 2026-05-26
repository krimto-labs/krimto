import { describe, expect, it } from "vitest";
import { KRIMTO_VERSION } from "../src/server/index";

describe("krimto scaffold", () => {
  it("exposes the package version", () => {
    expect(KRIMTO_VERSION).toBe("0.2.17-5");
  });
});
