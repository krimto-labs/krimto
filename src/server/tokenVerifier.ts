// Gap 06 — bridges Krimto's ApiKeyStore to the MCP SDK's bearer-auth middleware. A presented
// `krm_*` key resolves to the issuing identity; the requester's teams are attached for access checks.

import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { type ApiKeyStore } from "../access/auth";
import { teamsOf, type Membership } from "../access/membership";

export class KrimtoTokenVerifier implements OAuthTokenVerifier {
  constructor(
    private readonly keys: ApiKeyStore,
    private readonly membership: () => Membership,
  ) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const identity = await this.keys.resolveIdentity(token);
    if (!identity) throw new InvalidTokenError("invalid or unknown API key");
    const teams = teamsOf(this.membership(), identity);
    return {
      token,
      clientId: identity,
      scopes: [],
      expiresAt: Math.floor(Date.now() / 1000) + 3600 * 24 * 365 * 100, // ~100y; Krimto keys don't expire
      extra: { identity, teams },
    };
  }
}
