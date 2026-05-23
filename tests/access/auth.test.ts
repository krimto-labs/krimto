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

  it("lists keys without exposing the hash", async () => {
    await store.issue("alice@acme.com", "live", "laptop");
    const listed = await store.list();
    expect(listed[0]).toMatchObject({ identity: "alice@acme.com", prefix: "krm_live_", label: "laptop" });
    expect(listed[0]).not.toHaveProperty("hash");
  });

  it("persists across store instances", async () => {
    const { key } = await store.issue("bob@acme.com");
    const reopened = new ApiKeyStore(path.join(dir, "secrets", "keys.json"));
    expect(await reopened.resolveIdentity(key)).toBe("bob@acme.com");
  });
});
