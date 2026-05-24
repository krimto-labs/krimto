// Signed-cookie sessions for the /ui surface. The cookie holds the identity plus an
// HMAC-SHA256 signature — never the raw API key. No external dependency.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "krimto_session";

const b64url = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
const unb64url = (s: string): string => Buffer.from(s, "base64url").toString("utf8");
const mac = (payload: string, secret: string): string =>
  createHmac("sha256", secret).update(payload).digest("hex");

export function signSession(identity: string, secret: string): string {
  const payload = b64url(identity);
  return `${payload}.${mac(payload, secret)}`;
}

export function verifySession(value: string | undefined, secret: string): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const sig = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(mac(payload, secret));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  try {
    const id = unb64url(payload);
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k) out[k] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function sessionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): { secret: string } {
  return { secret: env.KRIMTO_SESSION_SECRET || randomBytes(32).toString("hex") };
}
