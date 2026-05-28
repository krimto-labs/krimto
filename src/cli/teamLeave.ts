// `krimto team leave` — the verb a teammate reaches for after joining someone else's team. It's
// the same per-machine editor rewrite as `team disband`, but framed for the joiner: disconnect
// this machine and make clear that fully leaving (being removed from the roster) is the admin's job.

import { runTeamDisband, type DisbandOptions, type DisbandResult } from "./teamDisband";

export async function runTeamLeave(opts: DisbandOptions = {}): Promise<DisbandResult | null> {
  return runTeamDisband({ ...opts, asLeave: true });
}
