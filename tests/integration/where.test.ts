// `krimto where` prints the data directory, so a user who runs npx from some other folder isn't
// surprised about where their facts landed (they default to ~/.krimto, not the cwd).

import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/krimto.mjs");

describe("krimto where", () => {
  it("prints the resolved data dir, honoring KRIMTO_DATA", async () => {
    const { stdout } = await exec(process.execPath, [BIN, "where"], {
      env: { ...process.env, KRIMTO_DATA: "/tmp/krimto-where-test" },
    });
    expect(stdout.trim()).toBe("/tmp/krimto-where-test");
  }, 30000);

  it("defaults to ~/.krimto when KRIMTO_DATA is unset", async () => {
    const env = { ...process.env };
    delete env.KRIMTO_DATA;
    const { stdout } = await exec(process.execPath, [BIN, "where"], { env });
    expect(stdout.trim()).toMatch(/\.krimto$/);
  }, 30000);
});
