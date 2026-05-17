/**
 * Task #437 — Short-lived HMAC tokens for previewing unpublished
 * marketing-site drafts. Modeled on `watch-token.ts`: shared secret,
 * `<payload>.<signature>` shape, 1-hour TTL.
 *
 * The token binds a specific organizationId so an admin can only
 * preview their own club (and so leaked tokens don't expose other
 * clubs' drafts).
 */
import { createHmac, randomBytes } from "crypto";

if (!process.env.SESSION_SECRET) {
  console.warn(
    "[marketing-preview-token] SESSION_SECRET is not set. Preview tokens use a " +
    "cryptographically random per-process fallback. Set SESSION_SECRET in production.",
  );
}

const SECRET: string =
  process.env.SESSION_SECRET ?? randomBytes(32).toString("hex");

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export function issueMarketingPreviewToken(organizationId: number): string {
  const payload = Buffer.from(
    JSON.stringify({ organizationId, iat: Date.now() }),
  ).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function verifyMarketingPreviewToken(token: string): number | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", SECRET).update(payload).digest("hex");
  if (sig !== expected) return null;
  try {
    const { organizationId, iat } = JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    );
    if (!organizationId || typeof organizationId !== "number") return null;
    if (Date.now() - iat > TOKEN_TTL_MS) return null;
    return organizationId as number;
  } catch {
    return null;
  }
}

export const MARKETING_PREVIEW_TOKEN_TTL_MS = TOKEN_TTL_MS;
