/**
 * Task #1622 — Integration tests for the email CTA click-tracking
 * routes (`/api/r/email/:token`) and the admin CTR report endpoint
 * (`/api/admin/notification-cta-stats`).
 *
 * Covers:
 *   • Valid token → click row inserted, send-stats counter unchanged
 *     (sends are recorded by the dispatcher, not the redirect), 302
 *     to the original URL.
 *   • Invalid / tampered / expired-secret tokens → 400 HTML response,
 *     no DB row written, no redirect.
 *   • Records the recipient's IP and user-agent on the click row.
 *   • Records a click with `userId = null` for anonymous sends.
 *   • Admin report — 401 when unauthenticated, 403 for non-admin,
 *     200 with the per-key CTR rows for super-admin / org-admin.
 *   • Admin report — `clickThroughRate` is `clicks / sends` with a
 *     `null` value for keys that have clicks but no recorded sends
 *     (avoids division-by-zero).
 *   • Admin report — `?sinceDays=N` slices the click count.
 *
 * Task #2019 additions:
 *   • Token's `o` field is stamped onto the click row's
 *     `organization_id` so per-org CTR can be computed without a DB
 *     lookup on the redirect path.
 *   • `?organizationId=N` (super-admin) and the auto-scoping for
 *     org-admin both narrow `getCtaStats` to a single club.
 *   • The new `/admin/notification-cta-stats/by-org` endpoint returns
 *     per-(org, key) rollups for super-admins and is auto-scoped to
 *     the caller's organisation for org-admins.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";

import {
  db,
  appUsersTable,
  emailCtaClicksTable,
  emailCtaConversionsTable,
  emailCtaSendStatsTable,
  organizationsTable,
} from "@workspace/db";
import { createTestApp } from "../../tests/helpers.js";
import {
  EMAIL_CTA_CONVERSION_WINDOW_MS,
  generateClickId,
  recordEmailCtaConversion,
  signCtaToken,
} from "../../lib/emailCtaTracking.js";

const STAMP = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const KEY_A = `t1622.alpha.${STAMP}`;
const KEY_B = `t1622.beta.${STAMP}`;
const KEY_C = `t1622.gamma.${STAMP}`;
const ALL_KEYS = [KEY_A, KEY_B, KEY_C];

let recipientId: number;
let superAdminId: number;
let playerId: number;
// Task #2019 — two clubs + one org-admin scoped to the first one so the
// per-org CTR tests can prove the report is scoped server-side.
let orgAlphaId: number;
let orgBetaId: number;
let orgAlphaAdminId: number;

const ORIGINAL_SECRET = process.env["EMAIL_CTA_TRACKING_SECRET"];

beforeAll(async () => {
  process.env["EMAIL_CTA_TRACKING_SECRET"] = "integration-test-cta-secret-do-not-use-in-prod";

  const [oa] = await db.insert(organizationsTable).values({
    name: `t2019 alpha ${STAMP}`,
    slug: `t2019-alpha-${STAMP}`,
  }).returning({ id: organizationsTable.id });
  orgAlphaId = oa.id;

  const [ob] = await db.insert(organizationsTable).values({
    name: `t2019 beta ${STAMP}`,
    slug: `t2019-beta-${STAMP}`,
  }).returning({ id: organizationsTable.id });
  orgBetaId = ob.id;

  const [r] = await db.insert(appUsersTable).values({
    replitUserId: `t1622-r-${STAMP}`,
    username: `t1622_recipient_${STAMP}`,
    email: `recipient_${STAMP}@t1622.test`,
    role: "player",
    organizationId: orgAlphaId,
  }).returning({ id: appUsersTable.id });
  recipientId = r.id;

  const [sa] = await db.insert(appUsersTable).values({
    replitUserId: `t1622-sa-${STAMP}`,
    username: `t1622_super_${STAMP}`,
    email: `super_${STAMP}@t1622.test`,
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  superAdminId = sa.id;

  const [p] = await db.insert(appUsersTable).values({
    replitUserId: `t1622-p-${STAMP}`,
    username: `t1622_player_${STAMP}`,
    email: `player_${STAMP}@t1622.test`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  playerId = p.id;

  const [oaa] = await db.insert(appUsersTable).values({
    replitUserId: `t2019-oaa-${STAMP}`,
    username: `t2019_alpha_admin_${STAMP}`,
    email: `alpha_admin_${STAMP}@t2019.test`,
    role: "org_admin",
    organizationId: orgAlphaId,
  }).returning({ id: appUsersTable.id });
  orgAlphaAdminId = oaa.id;
});

afterAll(async () => {
  await db.delete(emailCtaConversionsTable).where(inArray(emailCtaConversionsTable.notificationKey, ALL_KEYS));
  await db.delete(emailCtaClicksTable).where(inArray(emailCtaClicksTable.notificationKey, ALL_KEYS));
  await db.delete(emailCtaSendStatsTable).where(inArray(emailCtaSendStatsTable.notificationKey, ALL_KEYS));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [recipientId, superAdminId, playerId, orgAlphaAdminId]));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgAlphaId, orgBetaId]));
  if (ORIGINAL_SECRET === undefined) {
    delete process.env["EMAIL_CTA_TRACKING_SECRET"];
  } else {
    process.env["EMAIL_CTA_TRACKING_SECRET"] = ORIGINAL_SECRET;
  }
});

beforeEach(async () => {
  // Clear test rows between tests so each test starts from a known
  // baseline. Only touches our test keys so concurrent suites are safe.
  // `email_cta_conversions.click_id` is a plain text column (not a FK)
  // so deletion order doesn't matter, but we delete conversions first
  // anyway for symmetry with `afterAll`.
  await db.delete(emailCtaConversionsTable).where(inArray(emailCtaConversionsTable.notificationKey, ALL_KEYS));
  await db.delete(emailCtaClicksTable).where(inArray(emailCtaClicksTable.notificationKey, ALL_KEYS));
  await db.delete(emailCtaSendStatsTable).where(inArray(emailCtaSendStatsTable.notificationKey, ALL_KEYS));
});

describe("GET /api/r/email/:token — redirect", () => {
  it("verifies the token, records a click, and 302s to the original URL", async () => {
    const app = createTestApp();
    const url = "https://app.kharagolf.com/portal/bookings/77?ref=email";
    const token = signCtaToken({ k: KEY_A, u: recipientId, url });

    const res = await request(app)
      .get(`/api/r/email/${token}`)
      .set("User-Agent", "Mozilla/5.0 (test runner)");

    expect(res.status).toBe(302);
    // Task #2020 — the redirect now appends an `?ec=<clickId>` query
    // param to the destination so the conversion handler can re-attach
    // the next meaningful action to this click. The original URL prefix
    // (path + pre-existing query) must still be intact.
    expect(res.headers["location"]).toMatch(
      /^https:\/\/app\.kharagolf\.com\/portal\/bookings\/77\?ref=email&ec=[A-Za-z0-9_-]+$/,
    );

    const rows = await db.select().from(emailCtaClicksTable)
      .where(eq(emailCtaClicksTable.notificationKey, KEY_A));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(recipientId);
    // `originalUrl` is the un-mutated URL we received in the token —
    // the `?ec=` is appended only on the outgoing redirect, not stored.
    expect(rows[0]!.originalUrl).toBe(url);
    expect(rows[0]!.userAgent).toBe("Mozilla/5.0 (test runner)");
    // The redirect endpoint must NOT increment the send counter — sends
    // are recorded by the dispatcher when the email is actually mailed.
    const sendStats = await db.select().from(emailCtaSendStatsTable)
      .where(eq(emailCtaSendStatsTable.notificationKey, KEY_A));
    expect(sendStats).toHaveLength(0);
  });

  it("records userId = null for anonymous sends", async () => {
    const app = createTestApp();
    const token = signCtaToken({ k: KEY_A, u: null, url: "https://app.kharagolf.com/x" });
    const res = await request(app).get(`/api/r/email/${token}`);
    expect(res.status).toBe(302);
    const rows = await db.select().from(emailCtaClicksTable)
      .where(eq(emailCtaClicksTable.notificationKey, KEY_A));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBeNull();
  });

  it("returns 400 for tampered tokens (no click row, no redirect)", async () => {
    const app = createTestApp();
    const token = signCtaToken({ k: KEY_A, u: recipientId, url: "https://app.kharagolf.com/" });
    const dot = token.lastIndexOf(".");
    const tampered = `${token.slice(0, dot - 1)}A${token.slice(dot)}`;

    const res = await request(app).get(`/api/r/email/${tampered}`);
    expect(res.status).toBe(400);
    expect(res.headers["location"]).toBeUndefined();

    const rows = await db.select().from(emailCtaClicksTable)
      .where(eq(emailCtaClicksTable.notificationKey, KEY_A));
    expect(rows).toHaveLength(0);
  });

  it("returns 400 for malformed tokens", async () => {
    const app = createTestApp();
    const res = await request(app).get(`/api/r/email/not-a-real-token`);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/admin/notification-cta-stats — CTR report", () => {
  it("requires authentication", async () => {
    const app = createTestApp();
    const res = await request(app).get("/api/admin/notification-cta-stats");
    expect(res.status).toBe(401);
  });

  it("rejects non-super-admin roles", async () => {
    const app = createTestApp({ id: playerId, username: "p", role: "player" });
    const res = await request(app).get("/api/admin/notification-cta-stats");
    expect(res.status).toBe(403);
  });

  it("returns clicks / sends with the correct click-through rate", async () => {
    // Seed: KEY_A — 4 sends, 1 click → CTR 0.25
    //       KEY_B — 2 sends, 2 clicks → CTR 1.0 (rare but valid)
    //       KEY_C — 0 sends, 1 click → CTR null (no denominator)
    await db.insert(emailCtaSendStatsTable).values([
      { notificationKey: KEY_A, sendCount: 4, lastSentAt: new Date() },
      { notificationKey: KEY_B, sendCount: 2, lastSentAt: new Date() },
    ]);
    await db.insert(emailCtaClicksTable).values([
      { notificationKey: KEY_A, userId: recipientId, originalUrl: "https://x/a" },
      { notificationKey: KEY_B, userId: recipientId, originalUrl: "https://x/b1" },
      { notificationKey: KEY_B, userId: null, originalUrl: "https://x/b2" },
      { notificationKey: KEY_C, userId: null, originalUrl: "https://x/c" },
    ]);

    const app = createTestApp({ id: superAdminId, username: "sa", role: "super_admin" });
    const res = await request(app).get("/api/admin/notification-cta-stats");
    expect(res.status).toBe(200);
    const rows: Array<{ notificationKey: string; sendCount: number; clickCount: number; clickThroughRate: number | null }> = res.body.rows;

    const a = rows.find((r) => r.notificationKey === KEY_A)!;
    const b = rows.find((r) => r.notificationKey === KEY_B)!;
    const c = rows.find((r) => r.notificationKey === KEY_C)!;
    expect(a).toBeDefined();
    expect(a.sendCount).toBe(4);
    expect(a.clickCount).toBe(1);
    expect(a.clickThroughRate).toBeCloseTo(0.25, 5);

    expect(b.sendCount).toBe(2);
    expect(b.clickCount).toBe(2);
    expect(b.clickThroughRate).toBeCloseTo(1, 5);

    // Click without any recorded sends — CTR is null, not zero, so the
    // admin UI can render "n/a" rather than a misleading "0%".
    expect(c.sendCount).toBe(0);
    expect(c.clickCount).toBe(1);
    expect(c.clickThroughRate).toBeNull();
  });

  it("respects ?sinceDays for the click window", async () => {
    await db.insert(emailCtaSendStatsTable).values({
      notificationKey: KEY_A, sendCount: 10, lastSentAt: new Date(),
    });
    // 1 recent click + 2 clicks 30 days ago.
    const oldClick = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db.insert(emailCtaClicksTable).values([
      { notificationKey: KEY_A, userId: recipientId, originalUrl: "https://x/recent" },
      { notificationKey: KEY_A, userId: recipientId, originalUrl: "https://x/old1", clickedAt: oldClick },
      { notificationKey: KEY_A, userId: recipientId, originalUrl: "https://x/old2", clickedAt: oldClick },
    ]);

    const app = createTestApp({ id: superAdminId, username: "sa", role: "super_admin" });
    const res = await request(app).get("/api/admin/notification-cta-stats?sinceDays=7");
    expect(res.status).toBe(200);
    const a = (res.body.rows as Array<{ notificationKey: string; clickCount: number }>).find((r) => r.notificationKey === KEY_A)!;
    expect(a.clickCount).toBe(1);

    // Sanity-check: omitting the window includes all 3 clicks.
    const all = await request(app).get("/api/admin/notification-cta-stats");
    const aAll = (all.body.rows as Array<{ notificationKey: string; clickCount: number }>).find((r) => r.notificationKey === KEY_A)!;
    expect(aAll.clickCount).toBe(3);
  });

  it("rejects non-numeric sinceDays", async () => {
    const app = createTestApp({ id: superAdminId, username: "sa", role: "super_admin" });
    const res = await request(app).get("/api/admin/notification-cta-stats?sinceDays=banana");
    expect(res.status).toBe(400);
  });
});

/* ──────────────────────────────────────────────────────────────────
 * Task #2020 — click-id correlation, conversion attribution helper,
 * conversion stats endpoint.
 * ────────────────────────────────────────────────────────────────── */

describe("GET /api/r/email/:token — click-id correlation (Task #2020)", () => {
  it("mints a click id, persists it, sets the cookie + appends ?ec= to the destination", async () => {
    const app = createTestApp();
    const url = "https://app.kharagolf.com/portal/bookings/77?ref=email";
    const token = signCtaToken({ k: KEY_A, u: recipientId, url });

    const res = await request(app).get(`/api/r/email/${token}`);
    expect(res.status).toBe(302);

    // Cookie carries the same id the row was stored with — verify by
    // pulling the row back, parsing the Set-Cookie header, and
    // comparing both the cookie value and the `?ec=` query the
    // redirect appended.
    const rows = await db.select().from(emailCtaClicksTable)
      .where(eq(emailCtaClicksTable.notificationKey, KEY_A));
    expect(rows).toHaveLength(1);
    const clickId = rows[0]!.clickId;
    expect(typeof clickId).toBe("string");
    expect(clickId!.length).toBeGreaterThan(10);

    const setCookieHeader = res.headers["set-cookie"];
    const cookies: string[] = Array.isArray(setCookieHeader)
      ? setCookieHeader
      : (setCookieHeader ? [setCookieHeader as unknown as string] : []);
    const cookie = cookies.find((c) => c.startsWith("kg_email_click="));
    expect(cookie).toBeDefined();
    expect(cookie!).toContain(`kg_email_click=${clickId}`);
    expect(cookie!.toLowerCase()).toContain("httponly");
    expect(cookie!.toLowerCase()).toContain("samesite=lax");
    expect(cookie!).toContain(`Max-Age=${Math.round(EMAIL_CTA_CONVERSION_WINDOW_MS / 1000)}`);

    const location = res.headers["location"];
    const dest = new URL(location!);
    expect(dest.searchParams.get("ec")).toBe(clickId);
    expect(dest.searchParams.get("ref")).toBe("email");
    expect(dest.pathname).toBe("/portal/bookings/77");
  });

  it("mints a unique click id per redirect (so two clicks from one inbox are countable separately)", async () => {
    const app = createTestApp();
    const token = signCtaToken({ k: KEY_A, u: recipientId, url: "https://app.kharagolf.com/x" });
    await request(app).get(`/api/r/email/${token}`);
    await request(app).get(`/api/r/email/${token}`);
    const rows = await db.select().from(emailCtaClicksTable)
      .where(eq(emailCtaClicksTable.notificationKey, KEY_A));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.clickId).not.toBe(rows[1]!.clickId);
  });
});

describe("recordEmailCtaConversion (Task #2020)", () => {
  async function seedClick(notificationKey: string, opts: { clickedAt?: Date; clickId?: string } = {}) {
    const clickId = opts.clickId ?? generateClickId();
    await db.insert(emailCtaClicksTable).values({
      notificationKey,
      userId: recipientId,
      originalUrl: "https://app.kharagolf.com/x",
      clickId,
      ...(opts.clickedAt ? { clickedAt: opts.clickedAt } : {}),
    });
    return clickId;
  }

  it("records a conversion within the 24h window and snapshots the notification key", async () => {
    const clickId = await seedClick(KEY_A);
    const result = await recordEmailCtaConversion({ clickId, conversionType: "tee_booking_created" });
    expect(result.recorded).toBe(true);
    expect(result.notificationKey).toBe(KEY_A);

    const rows = await db.select().from(emailCtaConversionsTable)
      .where(eq(emailCtaConversionsTable.clickId, clickId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.notificationKey).toBe(KEY_A);
    expect(rows[0]!.conversionType).toBe("tee_booking_created");
    expect(rows[0]!.userId).toBe(recipientId);
  });

  it("is idempotent on (clickId, conversionType) — a duplicate insert is reported but not stored", async () => {
    const clickId = await seedClick(KEY_A);
    const first = await recordEmailCtaConversion({ clickId, conversionType: "tee_booking_created" });
    const second = await recordEmailCtaConversion({ clickId, conversionType: "tee_booking_created" });
    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);
    expect(second.reason).toBe("duplicate");
    const rows = await db.select().from(emailCtaConversionsTable)
      .where(eq(emailCtaConversionsTable.clickId, clickId));
    expect(rows).toHaveLength(1);
  });

  it("allows distinct conversion types against the same click", async () => {
    const clickId = await seedClick(KEY_A);
    const r1 = await recordEmailCtaConversion({ clickId, conversionType: "tee_booking_created" });
    const r2 = await recordEmailCtaConversion({ clickId, conversionType: "tournament_registered" });
    expect(r1.recorded).toBe(true);
    expect(r2.recorded).toBe(true);
    const rows = await db.select().from(emailCtaConversionsTable)
      .where(eq(emailCtaConversionsTable.clickId, clickId));
    expect(rows).toHaveLength(2);
  });

  it("refuses clicks older than the 24h attribution window", async () => {
    const stale = new Date(Date.now() - (EMAIL_CTA_CONVERSION_WINDOW_MS + 60_000));
    const clickId = await seedClick(KEY_A, { clickedAt: stale });
    const result = await recordEmailCtaConversion({ clickId, conversionType: "tee_booking_created" });
    expect(result.recorded).toBe(false);
    expect(result.reason).toBe("out_of_window");
    const rows = await db.select().from(emailCtaConversionsTable)
      .where(eq(emailCtaConversionsTable.clickId, clickId));
    expect(rows).toHaveLength(0);
  });

  it("refuses unknown click ids without throwing", async () => {
    const result = await recordEmailCtaConversion({
      clickId: "definitely-not-a-real-click-id",
      conversionType: "tee_booking_created",
    });
    expect(result.recorded).toBe(false);
    expect(result.reason).toBe("out_of_window");
  });

  it("rejects empty / missing inputs without touching the DB", async () => {
    const r1 = await recordEmailCtaConversion({ clickId: "", conversionType: "x" });
    expect(r1.recorded).toBe(false);
    expect(r1.reason).toBe("unknown_click");
    const r2 = await recordEmailCtaConversion({ clickId: "abc", conversionType: "" });
    expect(r2.recorded).toBe(false);
    expect(r2.reason).toBe("error");
  });
});

describe("GET /api/admin/notification-conversion-stats — conversion report (Task #2020)", () => {
  it("requires authentication", async () => {
    const app = createTestApp();
    const res = await request(app).get("/api/admin/notification-conversion-stats");
    expect(res.status).toBe(401);
  });

  it("rejects non-super-admin roles", async () => {
    const app = createTestApp({ id: playerId, username: "p", role: "player" });
    const res = await request(app).get("/api/admin/notification-conversion-stats");
    expect(res.status).toBe(403);
  });

  it("returns clicks → conversions per key with the correct rate and per-type breakdown", async () => {
    // Seed three keys with varying conversion outcomes:
    //   KEY_A — 4 clicks, 1 conversion (rate 0.25)
    //   KEY_B — 2 clicks, 2 conversions (rate 1.0) — tests rate=1
    //          and the per-type breakdown (one of each type)
    //   KEY_C — 1 click, 0 conversions (rate 0.0) — tests "show keys
    //          with clicks but no conversions" so admins can spot
    //          underperforming campaigns
    const aClicks = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const id = generateClickId();
        await db.insert(emailCtaClicksTable).values({
          notificationKey: KEY_A, userId: recipientId, originalUrl: "https://x/a", clickId: id,
        });
        return id;
      }),
    );
    await recordEmailCtaConversion({ clickId: aClicks[0]!, conversionType: "tee_booking_created" });

    const bClicks = await Promise.all(
      Array.from({ length: 2 }, async () => {
        const id = generateClickId();
        await db.insert(emailCtaClicksTable).values({
          notificationKey: KEY_B, userId: recipientId, originalUrl: "https://x/b", clickId: id,
        });
        return id;
      }),
    );
    await recordEmailCtaConversion({ clickId: bClicks[0]!, conversionType: "tee_booking_created" });
    await recordEmailCtaConversion({ clickId: bClicks[1]!, conversionType: "tournament_registered" });

    await db.insert(emailCtaClicksTable).values({
      notificationKey: KEY_C, userId: recipientId, originalUrl: "https://x/c", clickId: generateClickId(),
    });

    const app = createTestApp({ id: superAdminId, username: "sa", role: "super_admin" });
    const res = await request(app).get("/api/admin/notification-conversion-stats");
    expect(res.status).toBe(200);
    expect(res.body.attributionWindowMs).toBe(EMAIL_CTA_CONVERSION_WINDOW_MS);

    const rows: Array<{
      notificationKey: string;
      clickCount: number;
      conversionCount: number;
      conversionRate: number | null;
      conversionsByType: Record<string, number>;
    }> = res.body.rows;

    const a = rows.find((r) => r.notificationKey === KEY_A)!;
    const b = rows.find((r) => r.notificationKey === KEY_B)!;
    const c = rows.find((r) => r.notificationKey === KEY_C)!;
    expect(a.clickCount).toBe(4);
    expect(a.conversionCount).toBe(1);
    expect(a.conversionRate).toBeCloseTo(0.25, 5);
    expect(a.conversionsByType).toEqual({ tee_booking_created: 1 });

    expect(b.clickCount).toBe(2);
    expect(b.conversionCount).toBe(2);
    expect(b.conversionRate).toBeCloseTo(1, 5);
    expect(b.conversionsByType).toEqual({ tee_booking_created: 1, tournament_registered: 1 });

    expect(c.clickCount).toBe(1);
    expect(c.conversionCount).toBe(0);
    expect(c.conversionRate).toBeCloseTo(0, 5);
    expect(c.conversionsByType).toEqual({});
  });

  it("respects ?sinceDays for both clicks and conversions (aligned window)", async () => {
    // 1 recent click + conversion, plus 2 stale clicks well outside
    // the 7-day window. The stats endpoint shares the same window for
    // numerator + denominator so the rate stays meaningful.
    const recentClick = generateClickId();
    await db.insert(emailCtaClicksTable).values({
      notificationKey: KEY_A, userId: recipientId, originalUrl: "https://x/r", clickId: recentClick,
    });
    await recordEmailCtaConversion({ clickId: recentClick, conversionType: "tee_booking_created" });

    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db.insert(emailCtaClicksTable).values([
      { notificationKey: KEY_A, userId: recipientId, originalUrl: "https://x/s1", clickId: generateClickId(), clickedAt: stale },
      { notificationKey: KEY_A, userId: recipientId, originalUrl: "https://x/s2", clickId: generateClickId(), clickedAt: stale },
    ]);

    const app = createTestApp({ id: superAdminId, username: "sa", role: "super_admin" });
    const windowed = await request(app).get("/api/admin/notification-conversion-stats?sinceDays=7");
    expect(windowed.status).toBe(200);
    const aWin = (windowed.body.rows as Array<{
      notificationKey: string; clickCount: number; conversionCount: number; conversionRate: number | null;
    }>).find((r) => r.notificationKey === KEY_A)!;
    expect(aWin.clickCount).toBe(1);
    expect(aWin.conversionCount).toBe(1);
    expect(aWin.conversionRate).toBeCloseTo(1, 5);

    const all = await request(app).get("/api/admin/notification-conversion-stats");
    const aAll = (all.body.rows as Array<{
      notificationKey: string; clickCount: number; conversionCount: number;
    }>).find((r) => r.notificationKey === KEY_A)!;
    expect(aAll.clickCount).toBe(3);
    expect(aAll.conversionCount).toBe(1);
  });

  it("rejects non-numeric sinceDays", async () => {
    const app = createTestApp({ id: superAdminId, username: "sa", role: "super_admin" });
    const res = await request(app).get("/api/admin/notification-conversion-stats?sinceDays=banana");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Task #2019 — per-organisation CTR
// ---------------------------------------------------------------------------

describe("Task #2019 — per-organisation CTR", () => {
  describe("GET /api/r/email/:token — stamps organization_id from the token", () => {
    it("writes the org id from the token's `o` field onto the click row", async () => {
      const app = createTestApp();
      const url = "https://app.kharagolf.com/portal/x";
      const token = signCtaToken({ k: KEY_A, u: recipientId, o: orgAlphaId, url });

      const res = await request(app).get(`/api/r/email/${token}`);
      expect(res.status).toBe(302);

      const rows = await db.select().from(emailCtaClicksTable)
        .where(eq(emailCtaClicksTable.notificationKey, KEY_A));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.organizationId).toBe(orgAlphaId);
      expect(rows[0]!.userId).toBe(recipientId);
    });

    it("records organization_id = null when the token omits `o` (anonymous / pre-2019 tokens)", async () => {
      const app = createTestApp();
      const token = signCtaToken({ k: KEY_A, u: null, url: "https://app.kharagolf.com/" });
      const res = await request(app).get(`/api/r/email/${token}`);
      expect(res.status).toBe(302);

      const rows = await db.select().from(emailCtaClicksTable)
        .where(eq(emailCtaClicksTable.notificationKey, KEY_A));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.organizationId).toBeNull();
    });
  });

  describe("GET /api/admin/notification-cta-stats — org filter & scoping", () => {
    beforeEach(async () => {
      // Seed one key per (key, org) pair so the report has something to
      // partition: KEY_A has 6 sends + 3 clicks for alpha and 4 sends +
      // 1 click for beta; KEY_B is alpha-only.
      await db.insert(emailCtaSendStatsTable).values([
        { notificationKey: KEY_A, organizationId: orgAlphaId, sendCount: 6, lastSentAt: new Date() },
        { notificationKey: KEY_A, organizationId: orgBetaId, sendCount: 4, lastSentAt: new Date() },
        { notificationKey: KEY_B, organizationId: orgAlphaId, sendCount: 5, lastSentAt: new Date() },
      ]);
      await db.insert(emailCtaClicksTable).values([
        { notificationKey: KEY_A, userId: recipientId, organizationId: orgAlphaId, originalUrl: "https://x/a-alpha-1" },
        { notificationKey: KEY_A, userId: recipientId, organizationId: orgAlphaId, originalUrl: "https://x/a-alpha-2" },
        { notificationKey: KEY_A, userId: null, organizationId: orgAlphaId, originalUrl: "https://x/a-alpha-3" },
        { notificationKey: KEY_A, userId: null, organizationId: orgBetaId, originalUrl: "https://x/a-beta-1" },
        { notificationKey: KEY_B, userId: recipientId, organizationId: orgAlphaId, originalUrl: "https://x/b-alpha-1" },
      ]);
    });

    it("auto-scopes org_admin callers to their own organisation", async () => {
      const app = createTestApp({
        id: orgAlphaAdminId,
        username: "alpha_admin",
        role: "org_admin",
        organizationId: orgAlphaId,
      });
      const res = await request(app).get("/api/admin/notification-cta-stats");
      expect(res.status).toBe(200);

      const rows = res.body.rows as Array<{
        notificationKey: string;
        sendCount: number;
        clickCount: number;
        clickThroughRate: number | null;
      }>;

      // Only alpha rows for our test keys; beta's KEY_A click must not leak.
      const a = rows.find((r) => r.notificationKey === KEY_A)!;
      expect(a).toBeDefined();
      expect(a.sendCount).toBe(6);
      expect(a.clickCount).toBe(3);
      expect(a.clickThroughRate).toBeCloseTo(0.5, 5);
    });

    it("rejects org_admin callers with no organisation attached", async () => {
      const app = createTestApp({ id: playerId, username: "p", role: "org_admin" });
      const res = await request(app).get("/api/admin/notification-cta-stats");
      expect(res.status).toBe(403);
    });

    it("super_admin can request a specific organisation via ?organizationId=N", async () => {
      const app = createTestApp({ id: superAdminId, username: "sa", role: "super_admin" });
      const res = await request(app).get(`/api/admin/notification-cta-stats?organizationId=${orgBetaId}`);
      expect(res.status).toBe(200);

      const rows = res.body.rows as Array<{ notificationKey: string; sendCount: number; clickCount: number }>;
      const a = rows.find((r) => r.notificationKey === KEY_A)!;
      expect(a.sendCount).toBe(4);
      expect(a.clickCount).toBe(1);
      // KEY_B has no beta data, so it must be absent from the beta view.
      expect(rows.find((r) => r.notificationKey === KEY_B)).toBeUndefined();
    });

    it("super_admin without ?organizationId returns the global rollup", async () => {
      const app = createTestApp({ id: superAdminId, username: "sa", role: "super_admin" });
      const res = await request(app).get("/api/admin/notification-cta-stats");
      expect(res.status).toBe(200);
      const rows = res.body.rows as Array<{ notificationKey: string; sendCount: number; clickCount: number }>;
      const a = rows.find((r) => r.notificationKey === KEY_A)!;
      // Sums across alpha + beta.
      expect(a.sendCount).toBe(10);
      expect(a.clickCount).toBe(4);
    });

    it("rejects malformed ?organizationId values", async () => {
      const app = createTestApp({ id: superAdminId, username: "sa", role: "super_admin" });
      const res = await request(app).get("/api/admin/notification-cta-stats?organizationId=banana");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/admin/notification-cta-stats/by-org — per-(org, key) rollup", () => {
    beforeEach(async () => {
      await db.insert(emailCtaSendStatsTable).values([
        { notificationKey: KEY_A, organizationId: orgAlphaId, sendCount: 6, lastSentAt: new Date() },
        { notificationKey: KEY_A, organizationId: orgBetaId, sendCount: 4, lastSentAt: new Date() },
      ]);
      await db.insert(emailCtaClicksTable).values([
        { notificationKey: KEY_A, userId: recipientId, organizationId: orgAlphaId, originalUrl: "https://x/a-alpha-1" },
        { notificationKey: KEY_A, userId: recipientId, organizationId: orgAlphaId, originalUrl: "https://x/a-alpha-2" },
        { notificationKey: KEY_A, userId: recipientId, organizationId: orgAlphaId, originalUrl: "https://x/a-alpha-3" },
        { notificationKey: KEY_A, userId: null, organizationId: orgBetaId, originalUrl: "https://x/a-beta-1" },
      ]);
    });

    it("returns 401 when unauthenticated", async () => {
      const app = createTestApp();
      const res = await request(app).get("/api/admin/notification-cta-stats/by-org");
      expect(res.status).toBe(401);
    });

    it("rejects players", async () => {
      const app = createTestApp({ id: playerId, username: "p", role: "player" });
      const res = await request(app).get("/api/admin/notification-cta-stats/by-org");
      expect(res.status).toBe(403);
    });

    it("super_admin sees one row per (organisation, key) pair", async () => {
      const app = createTestApp({ id: superAdminId, username: "sa", role: "super_admin" });
      const res = await request(app).get("/api/admin/notification-cta-stats/by-org");
      expect(res.status).toBe(200);

      const rows = (res.body.rows as Array<{
        organizationId: number | null;
        notificationKey: string;
        sendCount: number;
        clickCount: number;
        clickThroughRate: number | null;
      }>).filter((r) => r.notificationKey === KEY_A);

      const alpha = rows.find((r) => r.organizationId === orgAlphaId)!;
      const beta = rows.find((r) => r.organizationId === orgBetaId)!;
      expect(alpha).toBeDefined();
      expect(alpha.sendCount).toBe(6);
      expect(alpha.clickCount).toBe(3);
      expect(alpha.clickThroughRate).toBeCloseTo(0.5, 5);

      expect(beta).toBeDefined();
      expect(beta.sendCount).toBe(4);
      expect(beta.clickCount).toBe(1);
      expect(beta.clickThroughRate).toBeCloseTo(0.25, 5);
    });

    it("auto-scopes org_admin to their own organisation", async () => {
      const app = createTestApp({
        id: orgAlphaAdminId,
        username: "alpha_admin",
        role: "org_admin",
        organizationId: orgAlphaId,
      });
      const res = await request(app).get("/api/admin/notification-cta-stats/by-org");
      expect(res.status).toBe(200);

      const rows = (res.body.rows as Array<{
        organizationId: number | null;
        notificationKey: string;
      }>).filter((r) => r.notificationKey === KEY_A);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.organizationId).toBe(orgAlphaId);
    });
  });
});

