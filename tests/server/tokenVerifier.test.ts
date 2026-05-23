import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { ApiKeyStore } from "../../src/access/auth";
import { type Membership } from "../../src/access/membership";
import { KrimtoTokenVerifier } from "../../src/server/tokenVerifier";

const membership: Membership = {
  org: { slug: "acme", admins: ["alice@x.com"] },
  teams: [{ slug: "payments", members: ["alice@x.com"], leads: [] }],
  users: [],
};

async function newStore(): Promise<ApiKeyStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "krimto-keys-"));
  return new ApiKeyStore(path.join(dir, "keys.json"));
}

describe("KrimtoTokenVerifier", () => {
  it("resolves a valid key to AuthInfo with identity + teams", async () => {
    const store = await newStore();
    const { key } = await store.issue("alice@x.com");
    const v = new KrimtoTokenVerifier(store, () => membership);
    const info = await v.verifyAccessToken(key);
    expect(info.clientId).toBe("alice@x.com");
    expect(info.token).toBe(key);
    expect(info.extra).toEqual({ identity: "alice@x.com", teams: ["payments"] });
    expect(typeof info.expiresAt).toBe("number");
  });
  it("rejects an unknown key", async () => {
    const store = await newStore();
    const v = new KrimtoTokenVerifier(store, () => membership);
    await expect(v.verifyAccessToken("krm_live_nope")).rejects.toBeInstanceOf(InvalidTokenError);
  });
});
