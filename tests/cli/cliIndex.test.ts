import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openCliIndex } from "../../src/cli/cliIndex";

// H5 — `reindex` / `sync` / `rm` used to hardcode `dimensions: 0` + `new FactIndex(db)` (no provider),
// so they rebuilt lexical-only and silently killed vector search until a server restart. They now go
// through openCliIndex, which resolves the configured provider + dimensions like the server does.
describe("openCliIndex (H5)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-cliidx-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("resolves the configured provider + dimensions (not lexical-only)", () => {
    const env = {
      KRIMTO_EMBED_PROVIDER: "custom",
      KRIMTO_EMBED_API_KEY: "k",
      KRIMTO_EMBED_MODEL: "m",
      KRIMTO_EMBED_BASE_URL: "http://localhost:9",
      KRIMTO_EMBED_DIMENSIONS: "4",
    } as NodeJS.ProcessEnv;
    const { provider, indexConfig, db } = openCliIndex(dir, env);
    expect(provider).not.toBeNull();
    expect(provider?.dimensions).toBe(4);
    expect(indexConfig).toMatchObject({ provider: "custom", dimensions: 4 });
    const hasVec =
      (db.prepare("select count(*) c from sqlite_master where name='facts_vec'").get() as { c: number }).c > 0;
    expect(hasVec).toBe(true); // facts_vec present so a reindex can populate vectors
    db.close();
  });

  it("stays lexical-only when no provider is configured", () => {
    const { provider, indexConfig, db } = openCliIndex(dir, { KRIMTO_EMBED_PROVIDER: "none" } as NodeJS.ProcessEnv);
    expect(provider).toBeNull();
    expect(indexConfig.dimensions).toBe(0);
    db.close();
  });
});
