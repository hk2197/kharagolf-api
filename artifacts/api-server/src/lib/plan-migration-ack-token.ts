/**
 * Task #980 — Short-lived HMAC tokens that let a super admin acknowledge a
 * plan-migration audit row directly from the digest email (Task #835), with
 * one click and without re-logging-in.
 *
 * Modeled on `marketing-preview-token.ts`: shared `SESSION_SECRET`,
 * `<payload>.<signature>` shape, base64url-encoded JSON payload.
 *
 * The token binds two ids:
 *   - `auditId`  — the specific `member_audit_log` row to acknowledge.
 *   - `userId`   — the super admin the digest was sent to. Recorded in the
 *                  audit metadata as `acknowledgedByUserId` so we know who
 *                  triaged.
 *
 * Single-use is enforced at the call site by the route's WHERE clause:
 * the row is updated only when its current metadata.acknowledged is not
 * already `true`. Subsequent clicks on the same link see "already
 * acknowledged" instead of stamping a fresh ack.
 */
import { createHmac, randomBytes } from "crypto";

if (!process.env.SESSION_SECRET) {
  console.warn(
    "[plan-migration-ack-token] SESSION_SECRET is not set. Tokens use a " +
    "cryptographically random per-process fallback. Set SESSION_SECRET in production.",
  );
}

const SECRET: string =
  process.env.SESSION_SECRET ?? randomBytes(32).toString("hex");

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface PlanMigrationAckTokenPayload {
  auditId: number;
  userId: number;
}

export function issuePlanMigrationAckToken(
  payload: PlanMigrationAckTokenPayload,
): string {
  const body = Buffer.from(
    JSON.stringify({
      auditId: payload.auditId,
      userId: payload.userId,
      iat: Date.now(),
    }),
  ).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(body).digest("hex");
  return `${body}.${sig}`;
}

export function verifyPlanMigrationAckToken(
  token: string,
): PlanMigrationAckTokenPayload | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", SECRET).update(body).digest("hex");
  if (sig !== expected) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString()) as {
      auditId?: unknown;
      userId?: unknown;
      iat?: unknown;
    };
    const auditId = typeof parsed.auditId === "number" ? parsed.auditId : NaN;
    const userId = typeof parsed.userId === "number" ? parsed.userId : NaN;
    const iat = typeof parsed.iat === "number" ? parsed.iat : NaN;
    if (!Number.isFinite(auditId) || !Number.isFinite(userId) || !Number.isFinite(iat)) {
      return null;
    }
    if (Date.now() - iat > TOKEN_TTL_MS) return null;
    return { auditId, userId };
  } catch {
    return null;
  }
}

export const PLAN_MIGRATION_ACK_TOKEN_TTL_MS = TOKEN_TTL_MS;
