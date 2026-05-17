/**
 * Task #626 / #784 — Token-bucket rate limiter for unauthenticated
 * public endpoints (course photo + review submissions).
 *
 * Task #626 introduced the per-IP / per-course throttle. Task #784
 * moved the bucket state out of an in-process Map and into Postgres so
 * that horizontally-scaled API processes share a single view of every
 * bucket. Without that, a spammer hitting two replicas behind a load
 * balancer effectively gets 2× the intended quota.
 *
 * How it works:
 *  - Each `BucketSpec` maps to one row in `public_rate_limit_buckets`
 *    keyed by `spec.key`. Rows store the current refilled token count
 *    plus the timestamp of the last refill.
 *  - `checkAndConsume()` opens a single transaction, ensures every
 *    needed row exists (INSERT … ON CONFLICT DO NOTHING), then
 *    `SELECT … FOR UPDATE`s them in deterministic key order to avoid
 *    cross-request deadlocks. The refill calculation, the
 *    "have we got at least one token in every bucket?" decision, and
 *    the per-row UPDATE all happen inside that same transaction, so
 *    two concurrent processes can't double-spend a token.
 *  - On exhaustion we still persist the refill timestamps (so the next
 *    call sees an accurate clock) but consume nothing.
 */
import type { Request, Response } from "express";
import { db, publicRateLimitBucketsTable } from "@workspace/db";
import { inArray, lt, sql } from "drizzle-orm";

export interface BucketSpec {
  key: string;
  capacity: number;
  refillPerSec: number;
}

const STALE_MS = 60 * 60 * 1000;
// Opportunistic eviction: at most once every PRUNE_INTERVAL_MS we sweep
// rows untouched for STALE_MS. Stops the table growing unbounded while
// keeping the hot path free of an extra query on every request.
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
let lastPruneAt = 0;

async function pruneIfNeeded(now: number): Promise<void> {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  try {
    await pruneStaleRateLimitBuckets(now);
  } catch {
    // Pruning is best-effort; never fail a real request because of it.
  }
}

/**
 * Task #930 — Delete `public_rate_limit_buckets` rows untouched for more
 * than `STALE_MS` (1h). Exposed so the cron scheduler can call it on a
 * fixed cadence; the request hot path also calls it opportunistically via
 * `pruneIfNeeded`. Combined, this keeps the table bounded both during
 * traffic lulls (cron does the work) and during sudden IP-rotation
 * bursts that would otherwise grow the table between cron runs (the hot
 * path nudges a sweep at most every 5 minutes).
 *
 * Returns the number of rows deleted.
 */
export async function pruneStaleRateLimitBuckets(
  nowMs: number = Date.now(),
): Promise<number> {
  const cutoff = new Date(nowMs - STALE_MS);
  // Use the driver's row-count from the DELETE rather than `RETURNING key`
  // — under a large IP-rotation burst the stale set can be very large and
  // we don't want to materialise every key just to log a count.
  const result = await db
    .delete(publicRateLimitBucketsTable)
    .where(lt(publicRateLimitBucketsTable.lastRefillAt, cutoff));
  return result.rowCount ?? 0;
}

/**
 * Atomically check & consume one token from every supplied bucket.
 * If any bucket is empty the call is rejected and no tokens are
 * consumed (refill timestamps are still updated so the next check sees
 * accurate refill).
 */
export async function checkAndConsume(
  scopes: BucketSpec[],
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  if (scopes.length === 0) return { ok: true };

  // De-duplicate by key (very rare, but a caller could pass two specs
  // with the same key) and sort to give every transaction the same
  // lock order across rows — this is what prevents deadlocks between
  // concurrent requests touching overlapping bucket sets.
  const specsByKey = new Map<string, BucketSpec>();
  for (const s of scopes) specsByKey.set(s.key, s);
  const orderedSpecs = [...specsByKey.values()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  const orderedKeys = orderedSpecs.map((s) => s.key);

  const now = Date.now();
  const nowDate = new Date(now);

  const result = await db.transaction(async (tx) => {
    // Make sure every bucket row exists with a full allotment so the
    // FOR UPDATE below sees a row to lock. Sorted insertion + ON CONFLICT
    // DO NOTHING is safe under contention.
    await tx
      .insert(publicRateLimitBucketsTable)
      .values(
        orderedSpecs.map((s) => ({
          key: s.key,
          tokens: s.capacity,
          lastRefillAt: nowDate,
        })),
      )
      .onConflictDoNothing();

    // Lock the rows for the duration of the transaction.
    const rows = await tx
      .select()
      .from(publicRateLimitBucketsTable)
      .where(inArray(publicRateLimitBucketsTable.key, orderedKeys))
      .orderBy(publicRateLimitBucketsTable.key)
      .for("update");

    const byKey = new Map(rows.map((r) => [r.key, r]));

    const view = orderedSpecs.map((spec) => {
      const row = byKey.get(spec.key);
      const lastMs = row ? row.lastRefillAt.getTime() : now;
      const baseTokens = row ? Number(row.tokens) : spec.capacity;
      const elapsedSec = Math.max(0, (now - lastMs) / 1000);
      const refilled = Math.min(
        spec.capacity,
        baseTokens + elapsedSec * spec.refillPerSec,
      );
      return { spec, tokens: refilled };
    });

    const failing = view.filter((v) => v.tokens < 1);

    if (failing.length > 0) {
      // Persist refill state without consuming any tokens. We update
      // every row so the next request sees fresh refill clocks.
      for (const v of view) {
        await tx
          .update(publicRateLimitBucketsTable)
          .set({ tokens: v.tokens, lastRefillAt: nowDate })
          .where(sql`${publicRateLimitBucketsTable.key} = ${v.spec.key}`);
      }
      // Take the *largest* wait across every exhausted bucket so the
      // client doesn't get a Retry-After hint that's too optimistic and
      // immediately bounces off another empty bucket on retry.
      let retryAfter = 1;
      for (const f of failing) {
        const need = 1 - f.tokens;
        const wait = Math.max(1, Math.ceil(need / f.spec.refillPerSec));
        if (wait > retryAfter) retryAfter = wait;
      }
      return { ok: false as const, retryAfter };
    }

    for (const v of view) {
      await tx
        .update(publicRateLimitBucketsTable)
        .set({ tokens: v.tokens - 1, lastRefillAt: nowDate })
        .where(sql`${publicRateLimitBucketsTable.key} = ${v.spec.key}`);
    }

    return { ok: true as const };
  });

  void pruneIfNeeded(now);
  return result;
}

/**
 * Convenience wrapper: check the supplied scopes and, if exhausted,
 * write a 429 with `Retry-After` and a JSON body. Returns true when
 * the caller may proceed.
 */
export async function enforceRateLimit(
  res: Response,
  scopes: BucketSpec[],
): Promise<boolean> {
  const result = await checkAndConsume(scopes);
  if (result.ok) return true;
  res.setHeader("Retry-After", String(result.retryAfter));
  res.status(429).json({
    error: "Too many requests. Please slow down and try again later.",
    retryAfter: result.retryAfter,
  });
  return false;
}

/**
 * Trusted client IP extraction. We deliberately do NOT parse
 * `X-Forwarded-For` ourselves: a spammer could otherwise rotate that
 * header on every request and bypass the per-IP buckets entirely.
 *
 * Instead we rely on Express's built-in `req.ip`, which already honours
 * `X-Forwarded-For` only when the application is configured with
 * `app.set("trust proxy", …)` to identify the upstream proxy chain.
 * In production the API process is fronted by a known reverse proxy
 * and `trust proxy` is configured to trust it; in unconfigured
 * environments `req.ip` falls back to the raw TCP peer address, which
 * a client cannot spoof. Either way the bucket key is non-bypassable
 * by a malicious client.
 */
export function getClientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

/** Test-only: clear all buckets between assertions. */
export async function _resetRateLimiterForTests(): Promise<void> {
  lastPruneAt = 0;
  await db.delete(publicRateLimitBucketsTable);
}

/* ── Bucket presets for marketing-site public endpoints ───────────── */

const perHour = (n: number) => n / 3600;

/**
 * Public photo upload-URL issuance (step 1 of two-step upload). Slightly
 * tighter than the finalise step because each call mints a presigned
 * write-URL against object storage.
 */
export function photoUploadUrlScopes(ip: string, courseId: number): BucketSpec[] {
  return [
    { key: `photo-url:ip:${ip}`, capacity: 30, refillPerSec: perHour(30) },
    { key: `photo-url:course:${courseId}`, capacity: 200, refillPerSec: perHour(200) },
    { key: `photo-url:ip+course:${ip}:${courseId}`, capacity: 10, refillPerSec: perHour(10) },
  ];
}

/** Public photo finalise (creates the moderation-queue media row). */
export function photoSubmitScopes(ip: string, courseId: number): BucketSpec[] {
  return [
    { key: `photo:ip:${ip}`, capacity: 20, refillPerSec: perHour(20) },
    { key: `photo:course:${courseId}`, capacity: 100, refillPerSec: perHour(100) },
    { key: `photo:ip+course:${ip}:${courseId}`, capacity: 10, refillPerSec: perHour(10) },
  ];
}

/** Public course-review submission. */
export function reviewSubmitScopes(ip: string, courseId: number): BucketSpec[] {
  return [
    { key: `review:ip:${ip}`, capacity: 5, refillPerSec: perHour(5) },
    { key: `review:course:${courseId}`, capacity: 30, refillPerSec: perHour(30) },
    { key: `review:ip+course:${ip}:${courseId}`, capacity: 3, refillPerSec: perHour(3) },
  ];
}

/**
 * Task #1083 — Public profile share-event submission. Visitors who tap the
 * Copy / Native share / QR buttons on `/p/<handle>` fire one of these per
 * action. Buckets are intentionally tighter than badge shares because the
 * event is essentially identity-free (any visitor on any IP can spam) and
 * the "Shared N times" badge only needs a rough order-of-magnitude count.
 */
export function profileShareEventScopes(ip: string, handle: string): BucketSpec[] {
  return [
    { key: `pshare:ip:${ip}`, capacity: 30, refillPerSec: perHour(30) },
    { key: `pshare:handle:${handle}`, capacity: 200, refillPerSec: perHour(200) },
    { key: `pshare:ip+handle:${ip}:${handle}`, capacity: 10, refillPerSec: perHour(10) },
  ];
}

/**
 * Task #1096 — Public badge share-event submission. Mirrors
 * `profileShareEventScopes` but adds a per-IP / per-handle / per-badge
 * bucket so a single client can't pump up the share count for one
 * specific badge while staying under the broader handle quota. Also
 * tighter overall: a viral badge typically receives far fewer shares
 * per IP than the profile itself, so a low cap is a reasonable signal
 * of abuse.
 */
export function badgeShareEventScopes(
  ip: string,
  handle: string,
  badgeType: string,
): BucketSpec[] {
  return [
    { key: `bshare:ip:${ip}`, capacity: 30, refillPerSec: perHour(30) },
    { key: `bshare:handle:${handle}`, capacity: 200, refillPerSec: perHour(200) },
    { key: `bshare:ip+handle:${ip}:${handle}`, capacity: 10, refillPerSec: perHour(10) },
    { key: `bshare:ip+handle+badge:${ip}:${handle}:${badgeType}`, capacity: 5, refillPerSec: perHour(5) },
  ];
}

/**
 * Task #1798 — Public badge-page visit pings. Caps per (IP+handle+badge)
 * at 10/hour so a single visitor cannot single-handedly inflate the
 * conversion-rate numerator, with looser per-IP and per-handle ceilings
 * to absorb legitimate viral traffic.
 */
export function badgeShareVisitScopes(
  ip: string,
  handle: string,
  badgeType: string,
): BucketSpec[] {
  return [
    { key: `bvisit:ip:${ip}`, capacity: 60, refillPerSec: perHour(60) },
    { key: `bvisit:handle:${handle}`, capacity: 400, refillPerSec: perHour(400) },
    { key: `bvisit:ip+handle:${ip}:${handle}`, capacity: 20, refillPerSec: perHour(20) },
    { key: `bvisit:ip+handle+badge:${ip}:${handle}:${badgeType}`, capacity: 10, refillPerSec: perHour(10) },
  ];
}

/**
 * Task #1282 — Public year-in-golf recap share assets. Both the PNG card
 * (`/api/public/recap/:handle/card.png`) and the OG HTML stub
 * (`/api/public/recap/:handle/og`) trigger the full `computeYearInGolf`
 * aggregation on a miss, so a scraper retry storm or a viral share could
 * pin DB CPU. Buckets mirror the profile-share shape: per-IP, per-handle,
 * and per-(IP+handle), keeping the limits identity-free since the
 * endpoints accept any visitor on any IP.
 */
export function recapShareScopes(ip: string, handle: string): BucketSpec[] {
  return [
    { key: `recap:ip:${ip}`, capacity: 60, refillPerSec: perHour(60) },
    { key: `recap:handle:${handle}`, capacity: 300, refillPerSec: perHour(300) },
    { key: `recap:ip+handle:${ip}:${handle}`, capacity: 20, refillPerSec: perHour(20) },
  ];
}

/**
 * Task #2152 — Public follower / following list endpoints. Each request
 * pages through `user_follows` joined with `app_users`. The cost is small
 * but a scraper hitting a viral handle could otherwise enumerate the
 * full social graph, so we mirror the profile-share scopes (per-IP,
 * per-handle, and per-(IP+handle)) with comparable ceilings — slightly
 * looser per-IP cap because legitimate visitors can browse multiple
 * handles in a single session.
 */
export function publicFollowsListScopes(ip: string, handle: string): BucketSpec[] {
  return [
    { key: `pflist:ip:${ip}`, capacity: 60, refillPerSec: perHour(60) },
    { key: `pflist:handle:${handle}`, capacity: 300, refillPerSec: perHour(300) },
    { key: `pflist:ip+handle:${ip}:${handle}`, capacity: 30, refillPerSec: perHour(30) },
  ];
}

/** Public review-report submission (abuse flag). */
export function reviewReportScopes(ip: string, reviewId: number): BucketSpec[] {
  return [
    { key: `report:ip:${ip}`, capacity: 10, refillPerSec: perHour(10) },
    { key: `report:ip+review:${ip}:${reviewId}`, capacity: 3, refillPerSec: perHour(3) },
  ];
}

/**
 * Task #1748 — Wallet top-up refund schedule "send preview" cooldown.
 *
 * `POST /api/admin/wallet-topup-refunds/email-schedule/send-preview` fires
 * a real digest email on every click and bypasses the suppression-pause
 * logic that the cron path uses. A treasurer (or a stuck UI loop) could
 * otherwise rapid-fire many emails into the same inbox. We cap each
 * (user, org) pair to one preview per 60 seconds.
 */
export const WALLET_TOPUP_REFUND_SEND_PREVIEW_COOLDOWN_SECONDS = 60;
export function walletTopupRefundSendPreviewScopes(
  userId: number,
  orgId: number,
): BucketSpec[] {
  return [
    {
      key: `wallet-topup-refund-preview:user+org:${userId}:${orgId}`,
      capacity: 1,
      refillPerSec: 1 / WALLET_TOPUP_REFUND_SEND_PREVIEW_COOLDOWN_SECONDS,
    },
  ];
}

/**
 * Task #2174 — Wallet top-up refund schedule "send now" cooldown.
 *
 * `POST /api/admin/wallet-topup-refunds/email-schedule/send-now` triggers
 * a real digest run that fans out to **every** configured recipient
 * (finance@, ops@, …). Unlike the preview path it does honour the
 * suppression-pause logic, but a 5-click misfire still blasts up to 5
 * real digest emails to every non-suppressed recipient. We cap each
 * (user, org) pair to one manual run per 60 seconds — same shape as the
 * preview cooldown — so a stuck UI loop or an impatient double-click
 * cannot rapid-fire the digest.
 */
export const WALLET_TOPUP_REFUND_SEND_NOW_COOLDOWN_SECONDS = 60;
export function walletTopupRefundSendNowScopes(
  userId: number,
  orgId: number,
): BucketSpec[] {
  return [
    {
      key: `wallet-topup-refund-send-now:user+org:${userId}:${orgId}`,
      capacity: 1,
      refillPerSec: 1 / WALLET_TOPUP_REFUND_SEND_NOW_COOLDOWN_SECONDS,
    },
  ];
}
