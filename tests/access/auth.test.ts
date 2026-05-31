import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ApiKeyStore,
  generateApiKey,
  hashKey,
  keyMatches,
} from "../../src/access/auth";

describe("generateApiKey", () => {
  it("produces a prefixed key, a 64-hex hash, and the identity", () => {
    const { key, record } = generateApiKey("alice@acme.com", "live");
    expect(key.startsWith("krm_live_")).toBe(true);
    expect(key.length).toBe("krm_live_".length + 32);
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.identity).toBe("alice@acme.com");
    expect(record.prefix).toBe("krm_live_");
  });

  it("uses the test prefix for the sandbox environment", () => {
    expect(generateApiKey("a@x.com", "test").key.startsWith("krm_test_")).toBe(true);
  });

  it("never repeats a key", () => {
    expect(generateApiKey("a@x.com").key).not.toBe(generateApiKey("a@x.com").key);
  });
});

describe("hashKey / keyMatches", () => {
  it("hashes deterministically and matches in constant time", () => {
    const { key, record } = generateApiKey("a@x.com");
    expect(hashKey(key)).toBe(record.hash);
    expect(keyMatches(key, record.hash)).toBe(true);
    expect(keyMatches("krm_live_wrong", record.hash)).toBe(false);
  });
});

describe("ApiKeyStore", () => {
  let dir: string;
  let store: ApiKeyStore;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-keys-"));
    store = new ApiKeyStore(path.join(dir, "secrets", "keys.json"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("issues a key and resolves it back to its identity", async () => {
    const { key } = await store.issue("alice@acme.com", "live", "laptop");
    expect(await store.resolveIdentity(key)).toBe("alice@acme.com");
  });

  it("returns null for an unknown key", async () => {
    await store.issue("alice@acme.com");
    expect(await store.resolveIdentity("krm_live_nope")).toBeNull();
  });

  it("lists keys including the hash (used for revocation)", async () => {
    await store.issue("alice@acme.com", "live", "laptop");
    const listed = await store.list();
    expect(listed[0]).toMatchObject({ identity: "alice@acme.com", prefix: "krm_live_", label: "laptop" });
    expect(listed[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("persists across store instances", async () => {
    const { key } = await store.issue("bob@acme.com");
    const reopened = new ApiKeyStore(path.join(dir, "secrets", "keys.json"));
    expect(await reopened.resolveIdentity(key)).toBe("bob@acme.com");
  });

  it("revoke removes a key so it no longer resolves, and exposes hash in list()", async () => {
    const store2 = new ApiKeyStore(path.join(dir, "revoke-keys.json"));
    const { key } = await store2.issue("alice@x.com");
    expect(await store2.resolveIdentity(key)).toBe("alice@x.com");
    const listed = await store2.list();
    expect(listed[0]!.hash).toBeTruthy();
    expect(await store2.revoke(listed[0]!.hash)).toBe(true);
    expect(await store2.resolveIdentity(key)).toBeNull();
    expect(await store2.list()).toHaveLength(0);
    expect(await store2.revoke("does-not-exist")).toBe(false);
  });

  it("does not lose updates when many keys are issued concurrently", async () => {
    const n = 20;
    await Promise.all(
      Array.from({ length: n }, (_, i) => store.issue(`u${i}@acme.com`, "live", `k${i}`)),
    );
    expect(await store.list()).toHaveLength(n);
  });

  it("stays consistent across interleaved concurrent issue and revoke", async () => {
    const seed = await store.issue("seed@acme.com");
    const seedHash = (await store.list())[0]!.hash;
    await Promise.all([
      store.issue("a@acme.com"),
      store.issue("b@acme.com"),
      store.revoke(seedHash),
      store.issue("c@acme.com"),
    ]);
    const listed = await store.list();
    expect(listed).toHaveLength(3); // 4 issued (incl. seed) − 1 revoked
    expect(listed.some((k) => k.hash === seedHash)).toBe(false);
    expect(await store.resolveIdentity(seed.key)).toBeNull();
  });

  it("never leaves a partial temp file beside keys.json (atomic write)", async () => {
    const file = path.join(dir, "atomic", "keys.json");
    const s = new ApiKeyStore(file);
    await Promise.all(Array.from({ length: 5 }, (_, i) => s.issue(`u${i}@acme.com`)));
    expect(await fs.readdir(path.dirname(file))).toEqual(["keys.json"]);
  });
});
