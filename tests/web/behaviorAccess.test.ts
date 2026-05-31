import { describe, it, expect } from "vitest";
import { mayManageBehavior } from "../../src/web/router";

// H1 — Settings▸Behavior actions (remote re-point / sync / reindex). In team mode only an org
// admin may run them; in solo mode (no login) the trust boundary is "the request came from a
// loopback peer" — a remote teammate (or an exposed-host visitor) must never reach them.
describe("mayManageBehavior", () => {
  it("solo mode: allows a loopback peer", () => {
    expect(mayManageBehavior({ teamMode: false, isOrgAdmin: false, isLoopback: true })).toBe(true);
  });

  it("solo mode: denies a non-loopback peer (the H1 hole)", () => {
    expect(mayManageBehavior({ teamMode: false, isOrgAdmin: false, isLoopback: false })).toBe(false);
  });

  it("team mode: allows an org admin", () => {
    expect(mayManageBehavior({ teamMode: true, isOrgAdmin: true, isLoopback: true })).toBe(true);
  });

  it("team mode: denies a non-admin even on loopback", () => {
    expect(mayManageBehavior({ teamMode: true, isOrgAdmin: false, isLoopback: true })).toBe(false);
  });
});
