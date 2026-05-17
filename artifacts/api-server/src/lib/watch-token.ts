/**
 * Shared watch token utilities — single source of truth for HMAC secret,
 * token issuance, and token verification.
 *
 * Importing this module from both portal.ts and ws-watch.ts guarantees they
 * share one secret per process, even when SESSION_SECRET is not configured.
 * A random-per-file approach would make tokens issued by REST unverifiable
 * over WebSocket in the same process when the env var is absent.
 */
import { createHmac, randomBytes } from "crypto";

if (!process.env.SESSION_SECRET) {
  console.warn(
    "[watch-token] SESSION_SECRET is not set. Watch tokens use a cryptographically " +
    "random per-process fallback. Set SESSION_SECRET in production.",
  );
}

// Evaluated once at module load; shared across all importers within the process.
// Fallback uses crypto.randomBytes (not Date.now) so it is not predictable.
export const WATCH_TOKEN_SECRET: string =
  process.env.SESSION_SECRET ?? randomBytes(32).toString("hex");

// 4-hour lifetime balances security (short-lived) with usability (covers a full round).
const TOKEN_TTL_MS = 4 * 60 * 60 * 1000;

export function issueWatchToken(userId: number): string {
  const payload = Buffer.from(JSON.stringify({ userId, iat: Date.now() })).toString("base64url");
  const sig = createHmac("sha256", WATCH_TOKEN_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function verifyWatchToken(token: string): number | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", WATCH_TOKEN_SECRET).update(payload).digest("hex");
  if (sig !== expected) return null;
  try {
    const { userId, iat } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!userId || Date.now() - iat > TOKEN_TTL_MS) return null;
    return userId as number;
  } catch {
    return null;
  }
}
