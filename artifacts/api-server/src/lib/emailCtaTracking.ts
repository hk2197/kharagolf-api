/**
 * Task #1622 — Email CTA click-through tracking.
 *
 * Branded notification emails (`notificationEmailTemplates.ts`) emit a
 * single CTA button per template (e.g. "View booking", "Watch highlight").
 * Before this task we had no way to measure whether recipients actually
 * clicked those buttons, so we couldn't tell which notification keys
 * drive engagement.
 *
 * This module is the click-tracking layer:
 *
 *   1. `wrapCtaUrl(notificationKey, userId, organizationId, originalUrl)`
 *      — used by the email renderer (via `wrap()` in
 *      `notificationEmailTemplates.ts`) to swap a bare CTA href for a
 *      tracking redirect of the form `<origin>/api/r/email/<token>`.
 *      The token is an HMAC-signed base64url JSON payload carrying
 *      `{k, u, o, url}` so the redirect route can validate the click
 *      came from one of our emails (no DB lookup on the hot path).
 *   2. `verifyCtaToken(token)` — used by the redirect route. Rejects
 *      tokens that fail HMAC verification (tampered or signed with a
 *      different secret).
 *   3. `recordCtaClick(...)` — INSERTs into `email_cta_clicks`. Failures
 *      are logged and swallowed so a transient DB hiccup never blocks
 *      the redirect.
 *   4. `recordCtaSend(notificationKey, organizationId)` — UPSERTs into
 *      `email_cta_send_stats`, incrementing the per-(key, org) counter
 *      the admin CTR report divides clicks by.
 *   5. `getCtaStats({ since?, organizationId? })` — admin report query:
 *      per-key `sendCount`, `clickCount`, `clickThroughRate`,
 *      `lastClickAt`, optionally filtered to a single organisation.
 *   6. `getCtaStatsByOrg({ since?, organizationId? })` — Task #2019
 *      per-org rollup variant. When `organizationId` is supplied, only
 *      that org's rows are returned; otherwise every org with at least
 *      one send or click is returned, plus the "unaffiliated" bucket
 *      (`organizationId: null`) for sends to recipients with no org.
 *
 * The redirect URL keeps the same origin as the destination (we parse
 * it out of `originalUrl`) so the click never leaves the user-facing
 * domain — phishing filters and corporate firewalls are happier with
 * that than a separate tracking host.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import {
  db,
  emailCtaClicksTable,
  emailCtaConversionsTable,
  emailCtaSendStatsTable,
} from "@workspace/db";
import { logger } from "./logger.js";

/* ─── conversion attribution window ─────────────────────────────── */

/**
 * Task #2020 — A click is only credited as the cause of a conversion
 * if the conversion happens within this window of the click. 24h is
 * generous enough to cover "I'll deal with it tomorrow" recipients
 * without crediting an unrelated booking made a week later that just
 * happened to share a cookie.
 */
export const EMAIL_CTA_CONVERSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/* ─── token signing ─────────────────────────────────────────────── */

/**
 * Secret used to HMAC-sign tracking tokens. Reuses the same fallback
 * chain as `swingUploadToken.ts` so a single shared deployment secret
 * (`SESSION_SECRET`) covers both. Tracking tokens never expire — they
 * encode the destination URL itself, so an old link still works for
 * the recipient — but we still HMAC them so an attacker can't forge a
 * redirect to an arbitrary URL through our domain.
 */
function getTrackingSecret(): string {
  const s = process.env["EMAIL_CTA_TRACKING_SECRET"]
    ?? process.env["SESSION_SECRET"]
    ?? process.env["ENCRYPTION_SECRET"];
  if (!s) {
    throw new Error(
      "EMAIL_CTA_TRACKING_SECRET (or SESSION_SECRET) is required to sign email CTA tracking tokens",
    );
  }
  return s;
}

interface CtaTokenPayload {
  /** Notification key (e.g. `booking.confirmed`). */
  k: string;
  /** Recipient user id, when known. `null` for anonymous sends. */
  u: number | null;
  /**
   * Task #2019 — Recipient's organisation id at send time, when known.
   * `null` for recipients with no organisation (unaffiliated players,
   * system users) AND for tokens minted before Task #2019 shipped (the
   * field is optional in `verifyCtaToken` so old links still resolve).
   */
  o?: number | null;
  /** Destination URL to 302 to. */
  url: string;
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(body: string, secret: string): string {
  return base64urlEncode(createHmac("sha256", secret).update(body).digest());
}

/**
 * Sign a tracking token. Returns `<base64url(JSON(payload))>.<sig>`.
 * Token has no expiry — old emails should keep working — but the
 * signature prevents any third party from minting a redirect through
 * our domain.
 */
export function signCtaToken(payload: CtaTokenPayload): string {
  const secret = getTrackingSecret();
  // Omit `o` from the encoded body when it's null/undefined to keep
  // the on-the-wire format identical to pre-Task-#2019 tokens — that
  // way an old email link still verifies byte-for-byte against the
  // same signature it was minted with.
  const body = base64urlEncode(Buffer.from(JSON.stringify(
    payload.o == null
      ? { k: payload.k, u: payload.u, url: payload.url }
      : payload,
  ), "utf8"));
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify a tracking token and return its payload.
 * Returns `null` for any token that is malformed, signed with a
 * different secret, or carries an invalid (non-string / non-http) URL.
 */
export function verifyCtaToken(token: unknown): CtaTokenPayload | null {
  if (typeof token !== "string" || token.length === 0) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot >= token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let secret: string;
  try {
    secret = getTrackingSecret();
  } catch {
    return null;
  }
  let expected: string;
  try {
    expected = sign(body, secret);
  } catch {
    return null;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(base64urlDecode(body).toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const k = p["k"];
  const url = p["url"];
  const u = p["u"];
  const o = p["o"];
  if (typeof k !== "string" || k.length === 0) return null;
  if (typeof url !== "string" || url.length === 0) return null;
  // Refuse anything that isn't an http(s) absolute URL — the redirect
  // route should never bounce a user onto e.g. `javascript:` or `file:`.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const userId = u === null ? null : (typeof u === "number" && Number.isFinite(u) ? u : null);
  // Task #2019 — `o` is optional. Accept `undefined` (pre-2019 token),
  // `null`, or a finite number. Anything else is silently coerced to
  // `null` so a malformed-but-validly-signed token still produces a
  // working redirect — we'd rather log the click as "unaffiliated"
  // than 400 the recipient on the basis of a corrupt org tag.
  const orgId = o === undefined || o === null
    ? null
    : (typeof o === "number" && Number.isFinite(o) ? o : null);
  return { k, u: userId, o: orgId, url };
}

/* ─── URL wrapping ──────────────────────────────────────────────── */

/**
 * Wrap a CTA destination URL with a tracking redirect. Returns the
 * original URL unchanged if:
 *   - it isn't a valid absolute http(s) URL (we have nowhere to point
 *     the redirect), or
 *   - the tracking secret isn't configured (so we can't sign), or
 *   - signing throws for any other reason — we never want to lose the
 *     CTA itself just because tracking failed.
 *
 * The redirect URL keeps the same origin as the destination, so links
 * stay on the user-facing domain.
 *
 * Task #2019 — `organizationId` is the recipient's organisation at
 * send time (or `null` for unaffiliated recipients). It's encoded into
 * the signed token so the redirect route can stamp it on the click row
 * without a DB lookup on the hot path.
 */
export function wrapCtaUrl(
  notificationKey: string,
  userId: number | null,
  organizationId: number | null,
  originalUrl: string,
): string {
  if (typeof originalUrl !== "string" || originalUrl.length === 0) return originalUrl;
  let parsed: URL;
  try {
    parsed = new URL(originalUrl);
  } catch {
    return originalUrl;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return originalUrl;
  let token: string;
  try {
    token = signCtaToken({ k: notificationKey, u: userId, o: organizationId, url: originalUrl });
  } catch (err) {
    logger.warn({ notificationKey, err }, "[email-cta] failed to sign tracking token; falling back to bare URL");
    return originalUrl;
  }
  return `${parsed.origin}/api/r/email/${token}`;
}

/* ─── click + send recording ────────────────────────────────────── */

export interface RecordClickInput {
  notificationKey: string;
  userId: number | null;
  /**
   * Task #2019 — Recipient's organisation at send time. Stamped from
   * the signed token (not looked up on the hot path) so the redirect
   * stays a single INSERT + a 302.
   */
  organizationId: number | null;
  originalUrl: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** Task #2020 — correlation id minted by the redirect handler. */
  clickId?: string | null;
}

/**
 * Persist a CTA click. Failures are logged and swallowed so a flaky
 * DB never blocks the recipient's 302 redirect.
 */
export async function recordCtaClick(input: RecordClickInput): Promise<void> {
  try {
    await db.insert(emailCtaClicksTable).values({
      notificationKey: input.notificationKey,
      userId: input.userId,
      organizationId: input.organizationId,
      originalUrl: input.originalUrl,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      clickId: input.clickId ?? null,
    });
  } catch (err) {
    logger.warn({ notificationKey: input.notificationKey, err }, "[email-cta] click insert failed");
  }
}

/**
 * Task #2020 — Generate a short, URL-safe correlation id used to link
 * a click row to its eventual conversion. ~22 chars of base64url
 * (≈132 bits of entropy) keeps the cookie + query string compact while
 * staying collision-free at any realistic click volume.
 */
export function generateClickId(): string {
  return base64urlEncode(randomBytes(16));
}

/**
 * Increment the per-(key, org) send counter (UPSERT). Failures are
 * logged and swallowed so a flaky DB never breaks the email send
 * itself.
 *
 * Task #2019 — `organizationId` is the recipient's organisation at
 * send time (or `null` for unaffiliated recipients). The unique
 * constraint backing the upsert is declared with NULLS NOT DISTINCT
 * (see schema) so all sends to recipients without an org share a
 * single "unaffiliated" bucket instead of proliferating one row per
 * send.
 */
export async function recordCtaSend(
  notificationKey: string,
  organizationId: number | null,
): Promise<void> {
  try {
    // We can't use drizzle's `.onConflictDoUpdate({ target: [...] })`
    // here: drizzle's conflict-target generator emits a bare
    // `ON CONFLICT (notification_key, organization_id)` which Postgres
    // refuses to match against a UNIQUE NULLS NOT DISTINCT constraint
    // (the inferred index has different null-distinctness semantics).
    // Naming the constraint explicitly via `ON CONSTRAINT` is the
    // documented escape hatch for that mismatch.
    await db.execute(sql`
      INSERT INTO ${emailCtaSendStatsTable} (notification_key, organization_id, send_count, last_sent_at)
      VALUES (${notificationKey}, ${organizationId}, 1, now())
      ON CONFLICT ON CONSTRAINT email_cta_send_stats_key_org_unique
      DO UPDATE SET
        send_count   = ${emailCtaSendStatsTable.sendCount} + 1,
        last_sent_at = now()
    `);
  } catch (err) {
    logger.warn({ notificationKey, organizationId, err }, "[email-cta] send counter upsert failed");
  }
}

/* ─── conversion recording (Task #2020) ─────────────────────────── */

export interface RecordConversionInput {
  /** Click correlation id (read from cookie / `?ec=` / body). */
  clickId: string;
  /** Free-form label for the conversion (e.g. "tee_booking_created"). */
  conversionType: string;
  /** Override the user id snapshotted from the click row. */
  userId?: number | null;
}

export interface RecordConversionResult {
  /** True iff a new row was inserted (false on out-of-window / unknown click / duplicate). */
  recorded: boolean;
  /** Why the recorder didn't insert, when `recorded` is false. */
  reason?: "unknown_click" | "out_of_window" | "duplicate" | "error";
  /** Notification key the click belonged to, when known. */
  notificationKey?: string;
}

/**
 * Persist one conversion row, attributing it back to the click that
 * drove the recipient here. Returns a result object rather than
 * throwing so destination flows can call this best-effort and keep
 * serving the user even if attribution fails.
 *
 * Behaviour:
 *   - Looks the click up by `clickId` (unique index on
 *     `email_cta_clicks.click_id`).
 *   - Refuses clicks older than `EMAIL_CTA_CONVERSION_WINDOW_MS` (24h)
 *     so a stale cookie doesn't credit an unrelated action.
 *   - Snapshots `notificationKey` and `userId` from the click row so
 *     the per-key admin report doesn't have to re-join.
 *   - Inserts with `ON CONFLICT (click_id, conversion_type) DO NOTHING`
 *     — a double-fired flow only counts once.
 */
export async function recordEmailCtaConversion(
  input: RecordConversionInput,
): Promise<RecordConversionResult> {
  const { clickId, conversionType } = input;
  if (typeof clickId !== "string" || clickId.length === 0) {
    return { recorded: false, reason: "unknown_click" };
  }
  if (typeof conversionType !== "string" || conversionType.length === 0) {
    return { recorded: false, reason: "error" };
  }
  try {
    const cutoff = new Date(Date.now() - EMAIL_CTA_CONVERSION_WINDOW_MS);
    const [click] = await db
      .select({
        notificationKey: emailCtaClicksTable.notificationKey,
        userId: emailCtaClicksTable.userId,
        clickedAt: emailCtaClicksTable.clickedAt,
      })
      .from(emailCtaClicksTable)
      .where(
        and(
          eq(emailCtaClicksTable.clickId, clickId),
          gte(emailCtaClicksTable.clickedAt, cutoff),
        ),
      )
      .limit(1);
    if (!click) {
      // Either the click id is unknown to us, or it's older than the
      // attribution window. We treat both as "no attribution"; the
      // distinction is logged for the admin report's caveats but never
      // surfaced as an error to the calling flow.
      return { recorded: false, reason: "out_of_window" };
    }
    const inserted = await db
      .insert(emailCtaConversionsTable)
      .values({
        clickId,
        notificationKey: click.notificationKey,
        userId: input.userId ?? click.userId,
        conversionType,
      })
      .onConflictDoNothing({
        target: [
          emailCtaConversionsTable.clickId,
          emailCtaConversionsTable.conversionType,
        ],
      })
      .returning({ id: emailCtaConversionsTable.id });
    if (inserted.length === 0) {
      return { recorded: false, reason: "duplicate", notificationKey: click.notificationKey };
    }
    return { recorded: true, notificationKey: click.notificationKey };
  } catch (err) {
    logger.warn(
      { clickId, conversionType, err },
      "[email-cta] conversion insert failed",
    );
    return { recorded: false, reason: "error" };
  }
}

/* ─── reporting ─────────────────────────────────────────────────── */

export interface CtaStatsRow {
  notificationKey: string;
  sendCount: number;
  clickCount: number;
  /** clickCount / sendCount, in the range [0, 1]. `null` when sendCount is 0. */
  clickThroughRate: number | null;
  /** ISO timestamp of the most recent click, or `null` if none. */
  lastClickAt: string | null;
  /** ISO timestamp of the most recent send, or `null` if none. */
  lastSentAt: string | null;
}

/**
 * Build a per-key click-through-rate report. Includes every key that
 * has at least one send OR at least one click — keys with no activity
 * either way are omitted (they'd just be noise on the admin page).
 *
 * `since` (optional) restricts the click count and `lastClickAt` to
 * clicks within the window, but the send counter is a running total
 * (we don't store per-send rows, so we can't slice it by date). Admins
 * comparing windowed CTR should keep that asymmetry in mind; in
 * practice the running send total is good enough to spot trends.
 *
 * Task #2019 — `organizationId` (optional) restricts BOTH the click
 * aggregation and the send aggregation to a single organisation, so
 * org-admins see only their own club's CTR. `null` means "unaffiliated
 * recipients only" — explicitly opt-in (omit the field for the global
 * view) so a missing query parameter doesn't accidentally collapse to
 * the unaffiliated bucket.
 */
export async function getCtaStats(opts?: { since?: Date; organizationId?: number | null }): Promise<CtaStatsRow[]> {
  const sinceClause = opts?.since ? sql`AND clicked_at >= ${opts.since.toISOString()}::timestamptz` : sql``;
  const orgFilter = opts && "organizationId" in opts;
  const sendOrgClause = orgFilter
    ? (opts.organizationId === null
        ? sql`WHERE s.organization_id IS NULL`
        : sql`WHERE s.organization_id = ${opts.organizationId}`)
    : sql``;
  const clickOrgClause = orgFilter
    ? (opts.organizationId === null
        ? sql`AND organization_id IS NULL`
        : sql`AND organization_id = ${opts.organizationId}`)
    : sql``;
  // Single round-trip: full outer join sends ↔ aggregated clicks per key.
  // The send aggregator collapses the per-(key, org) rows back down to
  // per-key totals when the caller didn't restrict to a single org —
  // the report shape is unchanged from pre-Task-#2019 callers.
  const rows = await db.execute<{
    notification_key: string;
    send_count: number | string | null;
    click_count: string | number | null;
    last_click_at: Date | string | null;
    last_sent_at: Date | string | null;
  }>(sql`
    SELECT
      COALESCE(s.notification_key, c.notification_key) AS notification_key,
      s.send_count,
      c.click_count,
      c.last_click_at,
      s.last_sent_at
    FROM (
      SELECT notification_key,
             SUM(send_count)::bigint AS send_count,
             MAX(last_sent_at) AS last_sent_at
        FROM ${emailCtaSendStatsTable} AS s
        ${sendOrgClause}
       GROUP BY notification_key
    ) AS s
    FULL OUTER JOIN (
      SELECT notification_key,
             COUNT(*)::bigint AS click_count,
             MAX(clicked_at) AS last_click_at
        FROM ${emailCtaClicksTable}
       WHERE 1=1
        ${clickOrgClause}
        ${sinceClause}
       GROUP BY notification_key
    ) AS c ON c.notification_key = s.notification_key
    ORDER BY notification_key ASC
  `);
  // pg returns rows in `.rows` for `db.execute(sql`…`)`.
  const list = (rows as unknown as { rows: Array<{
    notification_key: string;
    send_count: number | string | null;
    click_count: string | number | null;
    last_click_at: Date | string | null;
    last_sent_at: Date | string | null;
  }> }).rows;
  return list.map((r) => {
    const sendCount = Number(r.send_count ?? 0);
    const clickCount = Number(r.click_count ?? 0);
    const ctr = sendCount > 0 ? clickCount / sendCount : null;
    const toIso = (v: Date | string | null): string | null => {
      if (v == null) return null;
      if (v instanceof Date) return v.toISOString();
      // pg may already return an ISO string for timestamptz.
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    };
    return {
      notificationKey: r.notification_key,
      sendCount,
      clickCount,
      clickThroughRate: ctr,
      lastClickAt: toIso(r.last_click_at),
      lastSentAt: toIso(r.last_sent_at),
    };
  });
}

/* ─── conversion reporting (Task #2020) ─────────────────────────── */

export interface CtaConversionStatsRow {
  notificationKey: string;
  /** Distinct clicks counted in the window (denominator for the rate). */
  clickCount: number;
  /** Conversions counted in the window. */
  conversionCount: number;
  /** Conversions broken down by `conversionType`. */
  conversionsByType: Record<string, number>;
  /** conversionCount / clickCount, in the range [0, 1]. `null` when clickCount is 0. */
  conversionRate: number | null;
  /** ISO timestamp of the most recent conversion, or `null` if none. */
  lastConversionAt: string | null;
}

/**
 * Per-key clicks → conversions report. The denominator is *clicks*
 * (not sends) because the only signal we have about whether a click
 * converted is the click row itself — we can't know if a recipient
 * who never opened the email might still have, say, booked a tee
 * time through some other surface. Comparing conversions to clicks
 * answers the actual question this task was created to answer:
 * "of the people who clicked the CTA, how many actually completed
 * the action?"
 *
 * `since` (optional) restricts both the click count and the
 * conversion count to rows in the window. The two are aligned (same
 * window for numerator + denominator) so the rate is meaningful.
 *
 * Includes every key with at least one conversion OR at least one
 * click in the window — keys with no activity either way are omitted.
 */
export async function getCtaConversionStats(opts?: { since?: Date }): Promise<CtaConversionStatsRow[]> {
  const sinceClicks = opts?.since
    ? sql`WHERE clicked_at >= ${opts.since.toISOString()}::timestamptz`
    : sql``;
  const sinceConvs = opts?.since
    ? sql`WHERE converted_at >= ${opts.since.toISOString()}::timestamptz`
    : sql``;
  const rows = await db.execute<{
    notification_key: string;
    click_count: string | number | null;
    conversion_count: string | number | null;
    last_conversion_at: Date | string | null;
    conversions_by_type: Record<string, number> | string | null;
  }>(sql`
    WITH clicks AS (
      SELECT notification_key, COUNT(*)::bigint AS click_count
        FROM ${emailCtaClicksTable}
        ${sinceClicks}
       GROUP BY notification_key
    ), convs_per_type AS (
      SELECT notification_key,
             conversion_type,
             COUNT(*)::bigint AS type_count,
             MAX(converted_at)  AS last_converted_at
        FROM ${emailCtaConversionsTable}
        ${sinceConvs}
       GROUP BY notification_key, conversion_type
    ), convs AS (
      SELECT notification_key,
             SUM(type_count)::bigint AS conversion_count,
             MAX(last_converted_at)  AS last_conversion_at,
             jsonb_object_agg(conversion_type, type_count) AS conversions_by_type
        FROM convs_per_type
       GROUP BY notification_key
    )
    SELECT
      COALESCE(clicks.notification_key, convs.notification_key) AS notification_key,
      clicks.click_count,
      convs.conversion_count,
      convs.last_conversion_at,
      convs.conversions_by_type
    FROM clicks
    FULL OUTER JOIN convs
      ON convs.notification_key = clicks.notification_key
    ORDER BY notification_key ASC
  `);
  const list = (rows as unknown as { rows: Array<{
    notification_key: string;
    click_count: string | number | null;
    conversion_count: string | number | null;
    last_conversion_at: Date | string | null;
    conversions_by_type: Record<string, number> | string | null;
  }> }).rows;
  const toIso = (v: Date | string | null): string | null => {
    if (v == null) return null;
    if (v instanceof Date) return v.toISOString();
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  const parseByType = (v: Record<string, number> | string | null): Record<string, number> => {
    if (v == null) return {};
    if (typeof v === "string") {
      try { v = JSON.parse(v) as Record<string, number>; } catch { return {}; }
    }
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v)) {
      const num = Number(n);
      if (Number.isFinite(num) && num > 0) out[k] = num;
    }
    return out;
  };
  return list.map((r) => {
    const clickCount = Number(r.click_count ?? 0);
    const conversionCount = Number(r.conversion_count ?? 0);
    const conversionRate = clickCount > 0 ? conversionCount / clickCount : null;
    return {
      notificationKey: r.notification_key,
      clickCount,
      conversionCount,
      conversionsByType: parseByType(r.conversions_by_type),
      conversionRate,
      lastConversionAt: toIso(r.last_conversion_at),
    };
  });
}

/* ─── per-org reporting (Task #2019) ────────────────────────────── */

export interface CtaStatsByOrgRow extends CtaStatsRow {
  /**
   * Recipient organisation. `null` is the explicit "unaffiliated"
   * bucket — sends/clicks for recipients with no organisation OR
   * pre-Task-#2019 historical rows that were never tagged.
   */
  organizationId: number | null;
}

/**
 * Task #2019 — Per-(org, key) click-through-rate report. Returns one
 * row per (organisation, notification_key) pair with at least one send
 * or one click; rows with neither are omitted to keep the admin page
 * readable.
 *
 * Authorisation is a caller responsibility:
 *   - super-admins call this with NO `organizationId` to see every
 *     org (plus the unaffiliated bucket).
 *   - org-admins MUST pass their own `organizationId` so the query
 *     scopes down server-side; the route layer enforces this.
 *
 * Same `since` caveat as `getCtaStats`: the click aggregation is
 * windowed but the send counter is a running total per (key, org).
 */
export async function getCtaStatsByOrg(opts?: {
  since?: Date;
  organizationId?: number | null;
}): Promise<CtaStatsByOrgRow[]> {
  const sinceClause = opts?.since ? sql`AND clicked_at >= ${opts.since.toISOString()}::timestamptz` : sql``;
  const orgFilter = opts && "organizationId" in opts;
  const sendOrgClause = orgFilter
    ? (opts.organizationId === null
        ? sql`WHERE organization_id IS NULL`
        : sql`WHERE organization_id = ${opts.organizationId}`)
    : sql``;
  const clickOrgClause = orgFilter
    ? (opts.organizationId === null
        ? sql`AND organization_id IS NULL`
        : sql`AND organization_id = ${opts.organizationId}`)
    : sql``;
  const rows = await db.execute<{
    organization_id: number | null;
    notification_key: string;
    send_count: number | string | null;
    click_count: string | number | null;
    last_click_at: Date | string | null;
    last_sent_at: Date | string | null;
  }>(sql`
    SELECT
      COALESCE(s.organization_id, c.organization_id) AS organization_id,
      COALESCE(s.notification_key, c.notification_key) AS notification_key,
      s.send_count,
      c.click_count,
      c.last_click_at,
      s.last_sent_at
    FROM (
      SELECT organization_id,
             notification_key,
             send_count,
             last_sent_at
        FROM ${emailCtaSendStatsTable}
        ${sendOrgClause}
    ) AS s
    FULL OUTER JOIN (
      SELECT organization_id,
             notification_key,
             COUNT(*)::bigint AS click_count,
             MAX(clicked_at) AS last_click_at
        FROM ${emailCtaClicksTable}
       WHERE 1=1
        ${clickOrgClause}
        ${sinceClause}
       GROUP BY organization_id, notification_key
    ) AS c
      ON c.notification_key = s.notification_key
     AND c.organization_id IS NOT DISTINCT FROM s.organization_id
    ORDER BY organization_id ASC NULLS FIRST, notification_key ASC
  `);
  const list = (rows as unknown as { rows: Array<{
    organization_id: number | null;
    notification_key: string;
    send_count: number | string | null;
    click_count: string | number | null;
    last_click_at: Date | string | null;
    last_sent_at: Date | string | null;
  }> }).rows;
  return list.map((r) => {
    const sendCount = Number(r.send_count ?? 0);
    const clickCount = Number(r.click_count ?? 0);
    const ctr = sendCount > 0 ? clickCount / sendCount : null;
    const toIso = (v: Date | string | null): string | null => {
      if (v == null) return null;
      if (v instanceof Date) return v.toISOString();
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    };
    return {
      organizationId: r.organization_id == null ? null : Number(r.organization_id),
      notificationKey: r.notification_key,
      sendCount,
      clickCount,
      clickThroughRate: ctr,
      lastClickAt: toIso(r.last_click_at),
      lastSentAt: toIso(r.last_sent_at),
    };
  });
}
