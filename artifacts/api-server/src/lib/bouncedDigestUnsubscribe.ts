import crypto from "crypto";

/**
 * Token signing for the per-user "schedule-change email" unsubscribe link
 * (Task #387). Uses SESSION_SECRET as the HMAC key so we don't need a new
 * secret to manage. Format: base64url("v1:<userId>:<orgId>:<sig>") where
 * <sig> is HMAC-SHA256(SESSION_SECRET, "v1:<userId>:<orgId>") in base64url.
 *
 * Tokens are intentionally non-expiring: an admin who silenced these
 * notifications a year ago should still be able to use the link from any
 * old email, and the opt-out itself is what enforces the silence.
 */

function getSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is required to sign bounced-digest schedule-change unsubscribe tokens");
  return s;
}

export function signBouncedDigestScheduleOptOutToken(userId: number, orgId: number): string {
  const payload = `v1:${userId}:${orgId}`;
  const sig = crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
  return Buffer.from(`${payload}:${sig}`, "utf8").toString("base64url");
}

/**
 * Token signing for the per-(user, org) "round-robin tie-break required"
 * email unsubscribe link (Task #1045). Same shape and threat model as the
 * bounced-digest schedule-change token above — non-expiring, HMAC-SHA256
 * over a versioned payload, signed with SESSION_SECRET — but uses a
 * distinct payload prefix (`tb1:` instead of `v1:`) so a leaked tie-break
 * token cannot be used against the bounced-digest opt-out endpoint and
 * vice versa.
 */
export function signTieBreakEmailOptOutToken(userId: number, orgId: number): string {
  const payload = `tb1:${userId}:${orgId}`;
  const sig = crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
  return Buffer.from(`${payload}:${sig}`, "utf8").toString("base64url");
}

export function verifyTieBreakEmailOptOutToken(token: string): { userId: number; orgId: number } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split(":");
  if (parts.length !== 4 || parts[0] !== "tb1") return null;
  const userId = Number(parts[1]);
  const orgId = Number(parts[2]);
  const sig = parts[3];
  if (!Number.isInteger(userId) || !Number.isInteger(orgId) || userId <= 0 || orgId <= 0) return null;
  const payload = `tb1:${userId}:${orgId}`;
  let expected: string;
  try {
    expected = crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
  } catch {
    return null;
  }
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return { userId, orgId };
}

/**
 * Token signing for the per-(user, org) "stuck erasure cleanup daily
 * digest" unsubscribe link (Task #1242). Same shape and threat model as
 * the bounced-digest schedule-change token above — non-expiring,
 * HMAC-SHA256 over a versioned payload, signed with SESSION_SECRET — but
 * uses a distinct payload prefix (`esd1:` instead of `v1:`) so a leaked
 * erasure-digest token cannot be used against the bounced-digest opt-out
 * endpoint and vice versa. The opt-out persists on the user-level
 * `userNotificationPrefs.notifyErasureStorageDigest` flag; the orgId is
 * carried so the public confirmation page can name the club the
 * recipient just unsubscribed from, not so it scopes the opt-out.
 */
export function signErasureStorageDigestOptOutToken(userId: number, orgId: number): string {
  const payload = `esd1:${userId}:${orgId}`;
  const sig = crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
  return Buffer.from(`${payload}:${sig}`, "utf8").toString("base64url");
}

export function verifyErasureStorageDigestOptOutToken(token: string): { userId: number; orgId: number } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split(":");
  if (parts.length !== 4 || parts[0] !== "esd1") return null;
  const userId = Number(parts[1]);
  const orgId = Number(parts[2]);
  const sig = parts[3];
  if (!Number.isInteger(userId) || !Number.isInteger(orgId) || userId <= 0 || orgId <= 0) return null;
  const payload = `esd1:${userId}:${orgId}`;
  let expected: string;
  try {
    expected = crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
  } catch {
    return null;
  }
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return { userId, orgId };
}

/**
 * Task #1489 — Token signing for the per-(user, org) "monthly member
 * notification-preferences digest" unsubscribe link. Same shape and
 * threat model as the erasure-digest token above — non-expiring,
 * HMAC-SHA256 over a versioned payload, signed with SESSION_SECRET — but
 * uses a distinct payload prefix (`mpd1:`) so a leaked
 * member-prefs-digest token cannot be used against any other digest's
 * opt-out endpoint and vice versa. The opt-out persists on the
 * user-level `userNotificationPrefs.notifyMemberPrefsDigest` flag; the
 * orgId is carried so the public confirmation page can name the club
 * the recipient just unsubscribed from, not so it scopes the opt-out.
 */
export function signMemberPrefsDigestOptOutToken(userId: number, orgId: number): string {
  const payload = `mpd1:${userId}:${orgId}`;
  const sig = crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
  return Buffer.from(`${payload}:${sig}`, "utf8").toString("base64url");
}

export function verifyMemberPrefsDigestOptOutToken(token: string): { userId: number; orgId: number } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split(":");
  if (parts.length !== 4 || parts[0] !== "mpd1") return null;
  const userId = Number(parts[1]);
  const orgId = Number(parts[2]);
  const sig = parts[3];
  if (!Number.isInteger(userId) || !Number.isInteger(orgId) || userId <= 0 || orgId <= 0) return null;
  const payload = `mpd1:${userId}:${orgId}`;
  let expected: string;
  try {
    expected = crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
  } catch {
    return null;
  }
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return { userId, orgId };
}

/**
 * Task #1734 — Token signing for the per-(user, key) "mute this alert"
 * footer link inside admin alert emails (currently
 * `wallet.refund.digest.failed` and `side_game.receipt.digest.failed`).
 * Same HMAC-SHA256-over-versioned-payload shape as the other
 * unsubscribe tokens in this file, but uses a distinct payload prefix
 * (`pem1:` for "per-event mute, v1") so a leaked event-mute token
 * cannot be replayed against any of the digest-level opt-out endpoints
 * and vice versa.
 *
 * Unlike the other tokens here the payload includes an issued-at
 * timestamp (unix seconds) so {@link verifyEventMuteToken} can reject
 * tokens older than its TTL — defence-in-depth against replay even
 * though the underlying flag flip is naturally idempotent. The TTL is
 * generous (90 days by default) so an admin who lets the alert sit in
 * their inbox for a few weeks can still mute it; sooner-than-default
 * expiries can be supplied at verify time.
 *
 * `slug` is a short opcode that maps to a notification key (and the
 * matching column on `userNotificationPrefs`) via
 * {@link import("./notifyDispatch.js").EVENT_MUTE_KEY_FOR_SLUG}. We
 * carry the slug rather than the full registry key so the encoded
 * tokens stay short, and so a future renamed key keeps working as long
 * as the slug map is updated in lockstep.
 *
 * `orgId` is carried so the public confirmation page can name the club
 * the alert came from; the opt-out itself is user-scoped (mirroring the
 * other per-event opt-outs). Set to 0 if no org context is available.
 */
export function signEventMuteToken(
  userId: number,
  slug: string,
  orgId: number,
  now: Date = new Date(),
): string {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("signEventMuteToken: userId must be a positive integer");
  if (!Number.isInteger(orgId) || orgId < 0) throw new Error("signEventMuteToken: orgId must be a non-negative integer");
  if (!/^[a-z0-9]{1,16}$/.test(slug)) throw new Error("signEventMuteToken: slug must be 1-16 lowercase ascii alphanumerics");
  const iat = Math.floor(now.getTime() / 1000);
  const payload = `pem1:${userId}:${slug}:${orgId}:${iat}`;
  const sig = crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
  return Buffer.from(`${payload}:${sig}`, "utf8").toString("base64url");
}

export interface EventMuteTokenPayload {
  userId: number;
  slug: string;
  orgId: number;
  /** Issued-at, in epoch seconds. */
  iat: number;
}

export interface VerifyEventMuteTokenOpts {
  /** Defaults to `new Date()` — exposed for deterministic tests. */
  now?: Date;
  /** Defaults to 90 days. Set to 0 to disable the freshness check. */
  ttlSeconds?: number;
}

/** Default TTL for {@link verifyEventMuteToken} — 90 days in seconds. */
export const EVENT_MUTE_TOKEN_DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;

export function verifyEventMuteToken(
  token: string,
  opts: VerifyEventMuteTokenOpts = {},
): EventMuteTokenPayload | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split(":");
  if (parts.length !== 6 || parts[0] !== "pem1") return null;
  const userId = Number(parts[1]);
  const slug = parts[2];
  const orgId = Number(parts[3]);
  const iat = Number(parts[4]);
  const sig = parts[5];
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (!Number.isInteger(orgId) || orgId < 0) return null;
  if (!Number.isInteger(iat) || iat <= 0) return null;
  if (!/^[a-z0-9]{1,16}$/.test(slug)) return null;
  const payload = `pem1:${userId}:${slug}:${orgId}:${iat}`;
  let expected: string;
  try {
    expected = crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
  } catch {
    return null;
  }
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  const ttl = opts.ttlSeconds ?? EVENT_MUTE_TOKEN_DEFAULT_TTL_SECONDS;
  if (ttl > 0) {
    const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
    // Reject tokens older than the TTL. Tokens issued in the future are
    // also rejected (clock skew → consider rejecting only if very far
    // ahead, but 0-tolerance keeps the check simple and secure).
    if (nowSec - iat > ttl) return null;
    if (iat - nowSec > 60) return null; // tolerate up to 60s of clock skew
  }
  return { userId, slug, orgId, iat };
}

/**
 * Task #1776 — Token signing for the per-(user, org, channels) "revert
 * the in-portal mute of the stuck-erasure digest" link. Embedded in the
 * one-time confirmation email sent when a controller toggles
 * `notifyErasureStorageDigest` (email) or `notifyErasureStorageDigestPush`
 * (push) from true→false via PATCH /portal/notification-preferences.
 *
 * Same HMAC-SHA256-over-versioned-payload shape as the per-event mute
 * token above (`pem1:`) but uses a distinct payload prefix (`emr1:` for
 * "erasure mute revert, v1") so a leaked revert token cannot be replayed
 * against any of the other digest opt-out endpoints and vice versa.
 *
 * `channels` is a one-character opcode encoding which channels were just
 * muted, and which the revert link should re-enable:
 *   - "e" → email only (`notifyErasureStorageDigest`)
 *   - "p" → push only  (`notifyErasureStorageDigestPush`)
 *   - "b" → both       (email + push)
 * The cron / dispatcher columns flipped on revert match what was muted —
 * a controller who only muted email gets a link that only re-enables the
 * email side. This keeps the link narrow: clicking revert never undoes a
 * prior, intentional mute on the *other* channel.
 *
 * `orgId` is carried so the public confirmation page can name the club
 * that controller is a member of; the opt-out flags themselves are
 * user-scoped (mirroring the other per-event opt-outs). Set to 0 when no
 * org context is available (rare — a controller with no org membership
 * cannot have received the digest in the first place).
 *
 * The token carries an issued-at timestamp so {@link verifyErasureDigestMuteRevertToken}
 * can reject stale links — the task spec calls for a ~7 day validity
 * window, mirroring how other "I just did X by accident, undo it" emails
 * (Task #1734's per-event mute footer link) age out so a leaked or
 * forwarded link cannot be replayed indefinitely.
 */
export type ErasureDigestMuteRevertChannels = "e" | "p" | "b";

export const ERASURE_DIGEST_MUTE_REVERT_TOKEN_DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

export function signErasureDigestMuteRevertToken(
  userId: number,
  orgId: number,
  channels: ErasureDigestMuteRevertChannels,
  now: Date = new Date(),
): string {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("signErasureDigestMuteRevertToken: userId must be a positive integer");
  if (!Number.isInteger(orgId) || orgId < 0) throw new Error("signErasureDigestMuteRevertToken: orgId must be a non-negative integer");
  if (channels !== "e" && channels !== "p" && channels !== "b") throw new Error("signErasureDigestMuteRevertToken: channels must be one of 'e', 'p', 'b'");
  const iat = Math.floor(now.getTime() / 1000);
  const payload = `emr1:${userId}:${orgId}:${channels}:${iat}`;
  const sig = crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
  return Buffer.from(`${payload}:${sig}`, "utf8").toString("base64url");
}

export interface ErasureDigestMuteRevertTokenPayload {
  userId: number;
  orgId: number;
  channels: ErasureDigestMuteRevertChannels;
  /** Issued-at, in epoch seconds. */
  iat: number;
}

export interface VerifyErasureDigestMuteRevertTokenOpts {
  /** Defaults to `new Date()` — exposed for deterministic tests. */
  now?: Date;
  /** Defaults to {@link ERASURE_DIGEST_MUTE_REVERT_TOKEN_DEFAULT_TTL_SECONDS} (7 days). Set to 0 to disable the freshness check. */
  ttlSeconds?: number;
}

export function verifyErasureDigestMuteRevertToken(
  token: string,
  opts: VerifyErasureDigestMuteRevertTokenOpts = {},
): ErasureDigestMuteRevertTokenPayload | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split(":");
  if (parts.length !== 6 || parts[0] !== "emr1") return null;
  const userId = Number(parts[1]);
  const orgId = Number(parts[2]);
  const channels = parts[3];
  const iat = Number(parts[4]);
  const sig = parts[5];
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (!Number.isInteger(orgId) || orgId < 0) return null;
  if (channels !== "e" && channels !== "p" && channels !== "b") return null;
  if (!Number.isInteger(iat) || iat <= 0) return null;
  const payload = `emr1:${userId}:${orgId}:${channels}:${iat}`;
  let expected: string;
  try {
    expected = crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
  } catch {
    return null;
  }
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  const ttl = opts.ttlSeconds ?? ERASURE_DIGEST_MUTE_REVERT_TOKEN_DEFAULT_TTL_SECONDS;
  if (ttl > 0) {
    const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
    if (nowSec - iat > ttl) return null;
    if (iat - nowSec > 60) return null; // tolerate up to 60s of clock skew
  }
  return { userId, orgId, channels: channels as ErasureDigestMuteRevertChannels, iat };
}

/**
 * Task #2219 — Token signing for the per-(user, org, digest) "revert
 * the in-portal mute of a sibling controller digest" link. Embedded in
 * the one-time confirmation email sent when a controller toggles one of
 * the registry'd digest opt-outs (e.g.
 * `notifyWalletRefundDigestFailed`, `notifyLevyLedgerDigestFailed`,
 * `notifySilentAlertsDigest`) from true→false via PATCH
 * /portal/notification-preferences.
 *
 * Same HMAC-SHA256-over-versioned-payload shape as the per-channel
 * stuck-erasure revert token above (`emr1:`) but uses a distinct payload
 * prefix (`pdr1:` for "portal digest revert, v1") so a leaked sibling-
 * digest revert token cannot be replayed against the stuck-erasure
 * endpoint and vice versa.
 *
 * `slug` is the short opcode from
 * {@link import("./portalDigestMuteRegistry.js").PORTAL_DIGEST_MUTE_REGISTRY}
 * — we carry it rather than the full `notify*Failed` column name so the
 * encoded token stays short, and so a future renamed column keeps
 * working as long as the registry is updated in lockstep. Slugs are
 * lowercase ascii alphanumerics, 1–8 chars.
 *
 * `orgId` is carried so the public confirmation page can name the club
 * the controller is a member of; the opt-out flag itself is user-scoped
 * (matches the per-event opt-out pattern). Set to 0 when no org context
 * is available.
 *
 * The token carries an issued-at timestamp so {@link verifyPortalDigestMuteRevertToken}
 * can reject stale links — the spec calls for a 7-day validity window,
 * mirroring the existing erasure revert token (Task #1776). Same TTL
 * constant exposed below so the test suite can assert the window
 * without hard-coding the value in two places.
 */
export const PORTAL_DIGEST_MUTE_REVERT_TOKEN_DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

export function signPortalDigestMuteRevertToken(
  userId: number,
  orgId: number,
  slug: string,
  now: Date = new Date(),
): string {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("signPortalDigestMuteRevertToken: userId must be a positive integer");
  if (!Number.isInteger(orgId) || orgId < 0) throw new Error("signPortalDigestMuteRevertToken: orgId must be a non-negative integer");
  if (!/^[a-z0-9]{1,8}$/.test(slug)) throw new Error("signPortalDigestMuteRevertToken: slug must be 1-8 lowercase ascii alphanumerics");
  const iat = Math.floor(now.getTime() / 1000);
  const payload = `pdr1:${userId}:${orgId}:${slug}:${iat}`;
  const sig = crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
  return Buffer.from(`${payload}:${sig}`, "utf8").toString("base64url");
}

export interface PortalDigestMuteRevertTokenPayload {
  userId: number;
  orgId: number;
  slug: string;
  /** Issued-at, in epoch seconds. */
  iat: number;
}

export interface VerifyPortalDigestMuteRevertTokenOpts {
  /** Defaults to `new Date()` — exposed for deterministic tests. */
  now?: Date;
  /** Defaults to {@link PORTAL_DIGEST_MUTE_REVERT_TOKEN_DEFAULT_TTL_SECONDS} (7 days). Set to 0 to disable the freshness check. */
  ttlSeconds?: number;
}

export function verifyPortalDigestMuteRevertToken(
  token: string,
  opts: VerifyPortalDigestMuteRevertTokenOpts = {},
): PortalDigestMuteRevertTokenPayload | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split(":");
  if (parts.length !== 6 || parts[0] !== "pdr1") return null;
  const userId = Number(parts[1]);
  const orgId = Number(parts[2]);
  const slug = parts[3];
  const iat = Number(parts[4]);
  const sig = parts[5];
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (!Number.isInteger(orgId) || orgId < 0) return null;
  if (!/^[a-z0-9]{1,8}$/.test(slug)) return null;
  if (!Number.isInteger(iat) || iat <= 0) return null;
  const payload = `pdr1:${userId}:${orgId}:${slug}:${iat}`;
  let expected: string;
  try {
    expected = crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
  } catch {
    return null;
  }
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  const ttl = opts.ttlSeconds ?? PORTAL_DIGEST_MUTE_REVERT_TOKEN_DEFAULT_TTL_SECONDS;
  if (ttl > 0) {
    const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
    if (nowSec - iat > ttl) return null;
    if (iat - nowSec > 60) return null; // tolerate up to 60s of clock skew
  }
  return { userId, orgId, slug, iat };
}

export function verifyBouncedDigestScheduleOptOutToken(token: string): { userId: number; orgId: number } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const userId = Number(parts[1]);
  const orgId = Number(parts[2]);
  const sig = parts[3];
  if (!Number.isInteger(userId) || !Number.isInteger(orgId) || userId <= 0 || orgId <= 0) return null;
  const payload = `v1:${userId}:${orgId}`;
  let expected: string;
  try {
    expected = crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
  } catch {
    return null;
  }
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return { userId, orgId };
}
