/**
 * Task #1932 — Stateless HMAC token that lets an affected member open a
 * "this wasn't me" dispute / revert page for an admin-driven contact-email
 * change without requiring a logged-in session.
 *
 * Modeled on `marketing-preview-token.ts`: shared SESSION_SECRET, opaque
 * `<base64url(payload)>.<hex(hmac)>` shape, server-side TTL check on
 * verify. The payload binds the dispute to one specific
 * `member_audit_log` row (the original `email_suppression`
 * `reenable_with_replacement` action) so a leaked token cannot be
 * pivoted onto a different member or a different change. The previous
 * and new email addresses ride inside the payload so the public
 * endpoint can run the safe-revert checks without trusting any
 * caller-supplied input beyond the token itself.
 *
 * Lifetime is 30 days: long enough for a member who was on holiday or
 * who only checks email weekly to still act, but short enough that a
 * stale leaked token from a year-old change can't quietly revert
 * something an admin set up legitimately later.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

if (!process.env.SESSION_SECRET) {
  console.warn(
    "[email-change-dispute-token] SESSION_SECRET is not set. Dispute tokens use a " +
    "cryptographically random per-process fallback. Set SESSION_SECRET in production.",
  );
}

const SECRET: string =
  process.env.SESSION_SECRET ?? randomBytes(32).toString("hex");

export const EMAIL_CHANGE_DISPUTE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface EmailChangeDisputeTokenPayload {
  /** Schema version. Bump when the payload shape changes. */
  v: 1;
  /** Organization the original change happened in. */
  o: number;
  /** app_users.id whose contact email was overwritten. */
  u: number;
  /** member_audit_log.id of the original `reenable_with_replacement` row. */
  a: number;
  /** Suppressed address that was replaced. */
  p: string;
  /** New address now on file (also the address the dispute notice was sent to). */
  n: string;
  /** issued-at, epoch ms. */
  iat: number;
}

function sign(payloadB64: string): string {
  return createHmac("sha256", SECRET).update(payloadB64).digest("hex");
}

export function issueEmailChangeDisputeToken(
  payload: Omit<EmailChangeDisputeTokenPayload, "v" | "iat">,
): string {
  const full: EmailChangeDisputeTokenPayload = {
    v: 1,
    o: payload.o,
    u: payload.u,
    a: payload.a,
    p: payload.p,
    n: payload.n,
    iat: Date.now(),
  };
  const payloadB64 = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${payloadB64}.${sign(payloadB64)}`;
}

export type EmailChangeDisputeTokenError =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "unsupported_version";

export function verifyEmailChangeDisputeToken(
  token: string,
):
  | { ok: true; payload: EmailChangeDisputeTokenPayload }
  | { ok: false; error: EmailChangeDisputeTokenError } {
  if (typeof token !== "string" || !token.includes(".")) {
    return { ok: false, error: "malformed" };
  }
  const dot = token.indexOf(".");
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!payloadB64 || !sig) return { ok: false, error: "malformed" };

  const expected = sign(payloadB64);
  // Length-mismatched buffers crash timingSafeEqual; treat as bad.
  if (sig.length !== expected.length) return { ok: false, error: "bad_signature" };
  let sigOk = false;
  try {
    sigOk = timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return { ok: false, error: "bad_signature" };
  }
  if (!sigOk) return { ok: false, error: "bad_signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "malformed" };
  const payload = parsed as Partial<EmailChangeDisputeTokenPayload>;
  if (payload.v !== 1) return { ok: false, error: "unsupported_version" };
  if (
    typeof payload.o !== "number" ||
    typeof payload.u !== "number" ||
    typeof payload.a !== "number" ||
    typeof payload.p !== "string" ||
    typeof payload.n !== "string" ||
    typeof payload.iat !== "number"
  ) {
    return { ok: false, error: "malformed" };
  }
  if (Date.now() - payload.iat > EMAIL_CHANGE_DISPUTE_TOKEN_TTL_MS) {
    return { ok: false, error: "expired" };
  }
  return {
    ok: true,
    payload: payload as EmailChangeDisputeTokenPayload,
  };
}

/**
 * Build the absolute URL the member follows from their inbox / email.
 * Mirrors the resolution order used by digest helpers in `cron.ts` so a
 * preview / staging deployment with `APP_BASE_URL` set drops members on
 * the right host.
 */
export function buildEmailChangeDisputeUrl(token: string): string {
  const raw =
    process.env.APP_BASE_URL ??
    process.env.PUBLIC_BASE_URL ??
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "https://kharagolf.com");
  const trimmed = raw.replace(/\/+$/, "");
  return `${trimmed}/portal/email-change-dispute/${encodeURIComponent(token)}`;
}
