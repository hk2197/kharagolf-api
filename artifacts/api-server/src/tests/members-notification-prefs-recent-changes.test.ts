/**
 * Tests for the admin "Recently changed prefs" summary endpoint
 * (Task #1490).
 *
 * Endpoint: GET /organizations/:orgId/members/notification-prefs/recent-changes
 *
 * The CSV export already carries the per-row "Updated At" + "Has Custom
 * Prefs" columns, but the admin members page itself had no signal about
 * who has opted out of which channel/category recently. Treasurers want
 * to spot a sudden spike in opt-outs (e.g. after a noisy email push) so
 * they can investigate before the next billing run.
 *
 * Covers:
 *   - 401 anonymous, 403 non-admin / wrong-org admin
 *   - 200 org_admin gets back the right shape (windowDays, totalUsersChanged, rows)
 *   - Each row exposes `key`, `label`, `group`, `optedOutCount` and `userIds`
 *   - Members with `updated_at` outside the 30-day window are excluded
 *   - Members of other orgs do not leak in (defence-in-depth on top of
 *     the per-org admin guard)
 *   - Side-game receipts opt-out (Task #1106), per-channel opt-out
 *     (preferEmail/Push/Sms/Whatsapp) and per-category notify* flags
 *     all surface their opted-out user lists correctly
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  userNotificationPrefsTable,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgId: number;
let otherOrgId: number;
let adminUserId: number;
let otherOrgAdminUserId: number;
let nonAdminUserId: number;
// Member who opted out of side-game receipts AND email channel inside the window.
let recentOptOutUserId: number;
// Member whose row is older than 30 days — should be filtered out.
let staleOptOutUserId: number;
// Member who is opted-IN inside the window — should not appear in any row.
let optedInUserId: number;
// Different-org member opted out inside the window — must not leak.
let otherOrgMemberUserId: number;
// Task #1833 — member opted out 10 days ago: contributes to the prior
// 7-day bucket (8–14 days ago) but NOT the current 7-day bucket.
let priorWeekOptOutUserId: number;
// Task #1833 — member opted out 20 days ago: contributes to the
// 30-day total but to neither weekly bucket.
let middleWindowOptOutUserId: number;

let appAsAdmin: ReturnType<typeof createTestApp>;
let appAsNonAdmin: ReturnType<typeof createTestApp>;
let appAsOtherOrgAdmin: ReturnType<typeof createTestApp>;
let appAnonymous: ReturnType<typeof createTestApp>;

async function makeUser(suffix: string) {
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `notif-recent-${suffix}-${stamp}`,
    username: `notif_recent_${suffix}_${stamp}`,
    email: `notif_recent_${suffix}_${stamp}@example.com`,
    displayName: `Recent ${suffix}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  return u.id;
}

beforeAll(async () => {
  // Defensively ensure the newer push-side opt-out column exists — mirrors
  // the pattern in the CSV export test so we are not order-dependent on
  // the numbered migration that introduced it.
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_erasure_storage_digest_push boolean NOT NULL DEFAULT true`);

  const [org] = await db.insert(organizationsTable).values({
    name: `NotifRecent_${stamp}`,
    slug: `notif-recent-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [otherOrg] = await db.insert(organizationsTable).values({
    name: `NotifRecentOther_${stamp}`,
    slug: `notif-recent-other-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  otherOrgId = otherOrg.id;

  adminUserId = await makeUser("admin");
  otherOrgAdminUserId = await makeUser("otheradmin");
  nonAdminUserId = await makeUser("nonadmin");
  recentOptOutUserId = await makeUser("recent");
  staleOptOutUserId = await makeUser("stale");
  optedInUserId = await makeUser("in");
  otherOrgMemberUserId = await makeUser("other");
  priorWeekOptOutUserId = await makeUser("priorweek");
  middleWindowOptOutUserId = await makeUser("middle");

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgId, userId: adminUserId, role: "org_admin" },
    { organizationId: orgId, userId: nonAdminUserId, role: "player" },
    { organizationId: orgId, userId: recentOptOutUserId, role: "player" },
    { organizationId: orgId, userId: staleOptOutUserId, role: "player" },
    { organizationId: orgId, userId: optedInUserId, role: "player" },
    { organizationId: orgId, userId: priorWeekOptOutUserId, role: "player" },
    { organizationId: orgId, userId: middleWindowOptOutUserId, role: "player" },
    { organizationId: otherOrgId, userId: otherOrgAdminUserId, role: "org_admin" },
    { organizationId: otherOrgId, userId: otherOrgMemberUserId, role: "player" },
  ]);

  // Recent opt-out: side-game receipts + email channel + push channel.
  // updatedAt = now (defaults to now() on insert).
  await db.insert(userNotificationPrefsTable).values({
    userId: recentOptOutUserId,
    preferEmail: false,
    preferPush: false,
    preferSms: false,
    preferWhatsapp: false,
    notifySideGameReceipts: false,
  });

  // Stale opt-out: same set of opt-outs but updated 60 days ago — must
  // not appear in any row.
  await db.insert(userNotificationPrefsTable).values({
    userId: staleOptOutUserId,
    preferEmail: false,
    notifySideGameReceipts: false,
  });
  await db.execute(sql`UPDATE user_notification_prefs SET updated_at = NOW() - INTERVAL '60 days' WHERE user_id = ${staleOptOutUserId}`);

  // Opted-in row inside the window — must not contribute to any opt-out
  // count even though the timestamp is fresh.
  await db.insert(userNotificationPrefsTable).values({
    userId: optedInUserId,
    preferEmail: true,
    preferPush: true,
    notifySideGameReceipts: true,
  });

  // Cross-org opt-out — must never appear in this org's response.
  await db.insert(userNotificationPrefsTable).values({
    userId: otherOrgMemberUserId,
    preferEmail: false,
    notifySideGameReceipts: false,
  });

  // Task #1833 — opt-out 10 days ago. This must land in the prior 7-day
  // window (8–14 days ago) and contribute to `priorWeekOptedOutCount`,
  // but NOT to `currentWeekOptedOutCount`.
  await db.insert(userNotificationPrefsTable).values({
    userId: priorWeekOptOutUserId,
    preferEmail: false,
    notifySideGameReceipts: false,
  });
  await db.execute(sql`UPDATE user_notification_prefs SET updated_at = NOW() - INTERVAL '10 days' WHERE user_id = ${priorWeekOptOutUserId}`);

  // Task #1833 — opt-out 20 days ago. Inside the 30-day total but
  // outside both weekly buckets, so it must NOT contribute to either
  // current or prior week counts (regression guard for the bucket math).
  await db.insert(userNotificationPrefsTable).values({
    userId: middleWindowOptOutUserId,
    preferEmail: false,
    notifySideGameReceipts: false,
  });
  await db.execute(sql`UPDATE user_notification_prefs SET updated_at = NOW() - INTERVAL '20 days' WHERE user_id = ${middleWindowOptOutUserId}`);

  appAsAdmin = createTestApp({ id: adminUserId, username: `notif_recent_admin_${stamp}`, role: "org_admin", organizationId: orgId });
  appAsNonAdmin = createTestApp({ id: nonAdminUserId, username: `notif_recent_nonadmin_${stamp}`, role: "player", organizationId: orgId });
  const otherAdmin: TestUser = {
    id: otherOrgAdminUserId,
    username: `notif_recent_otheradmin_${stamp}`,
    role: "org_admin",
    organizationId: otherOrgId,
  };
  appAsOtherOrgAdmin = createTestApp(otherAdmin);
  appAnonymous = createTestApp();
});

afterAll(async () => {
  const userIds = [
    adminUserId, otherOrgAdminUserId, nonAdminUserId,
    recentOptOutUserId, staleOptOutUserId, optedInUserId, otherOrgMemberUserId,
    priorWeekOptOutUserId, middleWindowOptOutUserId,
  ].filter(Boolean);
  if (userIds.length) {
    await db.delete(userNotificationPrefsTable).where(inArray(userNotificationPrefsTable.userId, userIds));
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, userIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  }
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (otherOrgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrgId));
});

describe("GET /organizations/:orgId/members/notification-prefs/recent-changes", () => {
  it("requires authentication", async () => {
    const res = await request(appAnonymous)
      .get(`/api/organizations/${orgId}/members/notification-prefs/recent-changes`);
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin caller in the same org", async () => {
    const res = await request(appAsNonAdmin)
      .get(`/api/organizations/${orgId}/members/notification-prefs/recent-changes`);
    expect(res.status).toBe(403);
  });

  it("returns 403 for an admin of a different org", async () => {
    const res = await request(appAsOtherOrgAdmin)
      .get(`/api/organizations/${orgId}/members/notification-prefs/recent-changes`);
    expect(res.status).toBe(403);
  });

  it("returns the expected shape for an org admin", async () => {
    const res = await request(appAsAdmin)
      .get(`/api/organizations/${orgId}/members/notification-prefs/recent-changes`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.windowDays).toBe(30);
    expect(typeof res.body.cutoff).toBe("string");
    expect(Array.isArray(res.body.rows)).toBe(true);
    // Every row carries the contract the frontend depends on.
    for (const r of res.body.rows) {
      expect(typeof r.key).toBe("string");
      expect(typeof r.label).toBe("string");
      expect(["channel", "category"]).toContain(r.group);
      expect(typeof r.optedOutCount).toBe("number");
      expect(Array.isArray(r.userIds)).toBe(true);
      expect(r.userIds.length).toBe(r.optedOutCount);
      // Task #1833 — week-over-week buckets used by the frontend to
      // render the trend indicator + spike highlight.
      expect(typeof r.currentWeekOptedOutCount).toBe("number");
      expect(typeof r.priorWeekOptedOutCount).toBe("number");
      // Sanity: each weekly bucket cannot exceed the 30-day total, and
      // current + prior cannot exceed the 30-day total either (the two
      // weekly buckets are non-overlapping subsets of it).
      expect(r.currentWeekOptedOutCount).toBeLessThanOrEqual(r.optedOutCount);
      expect(r.priorWeekOptedOutCount).toBeLessThanOrEqual(r.optedOutCount);
      expect(r.currentWeekOptedOutCount + r.priorWeekOptedOutCount)
        .toBeLessThanOrEqual(r.optedOutCount);
    }
    // Channels + categories the task explicitly calls out are all present.
    const keys = res.body.rows.map((r: { key: string }) => r.key);
    for (const expected of [
      "preferEmail", "preferPush", "preferSms", "preferWhatsapp",
      "notifySideGameReceipts", "notifyMemberDocuments", "notifyCommitteePeerDigest",
    ]) {
      expect(keys).toContain(expected);
    }
  });

  it("counts only members opted out inside the 30-day window", async () => {
    const res = await request(appAsAdmin)
      .get(`/api/organizations/${orgId}/members/notification-prefs/recent-changes`);
    expect(res.status).toBe(200);
    type Row = { key: string; userIds: number[]; optedOutCount: number };
    const byKey = new Map<string, Row>(
      (res.body.rows as Row[]).map(r => [r.key, r]),
    );

    // Recent opt-out user shows up across each channel/category they muted.
    const sideGame = byKey.get("notifySideGameReceipts")!;
    expect(sideGame.userIds).toContain(recentOptOutUserId);
    const email = byKey.get("preferEmail")!;
    expect(email.userIds).toContain(recentOptOutUserId);
    const push = byKey.get("preferPush")!;
    expect(push.userIds).toContain(recentOptOutUserId);

    // Stale row (updated > 30 days ago) is filtered out everywhere.
    expect(sideGame.userIds).not.toContain(staleOptOutUserId);
    expect(email.userIds).not.toContain(staleOptOutUserId);

    // Opted-in user never appears even though their row is fresh.
    expect(sideGame.userIds).not.toContain(optedInUserId);
    expect(email.userIds).not.toContain(optedInUserId);

    // totalUsersChanged counts distinct in-window prefs rows for this
    // org: recentOptOutUserId, optedInUserId, priorWeekOptOutUserId
    // (10d ago) and middleWindowOptOutUserId (20d ago). The 60-day-old
    // stale row and the cross-org member must not count.
    expect(res.body.totalUsersChanged).toBe(4);
  });

  it("buckets opted-out members into the current vs prior 7-day window (Task #1833)", async () => {
    const res = await request(appAsAdmin)
      .get(`/api/organizations/${orgId}/members/notification-prefs/recent-changes`);
    expect(res.status).toBe(200);
    type Row = {
      key: string;
      userIds: number[];
      optedOutCount: number;
      currentWeekOptedOutCount: number;
      priorWeekOptedOutCount: number;
    };
    const byKey = new Map<string, Row>(
      (res.body.rows as Row[]).map(r => [r.key, r]),
    );

    // Side-game receipts row carries opt-outs from three in-org members:
    //   - recentOptOutUserId        (now,    < 7 days)
    //   - priorWeekOptOutUserId     (10d ago, in prior 7-day window)
    //   - middleWindowOptOutUserId  (20d ago, in 30-day total but
    //                                outside both weekly buckets)
    // The stale 60-day-old row and the cross-org member must not
    // contribute. Same userIds also cover the email channel row.
    const sideGame = byKey.get("notifySideGameReceipts")!;
    expect(sideGame.userIds).toEqual(expect.arrayContaining([
      recentOptOutUserId,
      priorWeekOptOutUserId,
      middleWindowOptOutUserId,
    ]));
    expect(sideGame.userIds).not.toContain(staleOptOutUserId);
    expect(sideGame.optedOutCount).toBe(3);
    expect(sideGame.currentWeekOptedOutCount).toBe(1); // recentOptOutUserId
    expect(sideGame.priorWeekOptedOutCount).toBe(1);   // priorWeekOptOutUserId

    const email = byKey.get("preferEmail")!;
    expect(email.optedOutCount).toBe(3);
    expect(email.currentWeekOptedOutCount).toBe(1);
    expect(email.priorWeekOptedOutCount).toBe(1);

    // Push channel only had the recent member opt out — the prior-week
    // and middle-window users left preferPush at its default true. So
    // the row exists but its weekly buckets are 1/0, exercising the
    // "prior week is zero, current is non-zero" path the frontend
    // treats as a brand-new spike.
    const push = byKey.get("preferPush")!;
    expect(push.userIds).toEqual([recentOptOutUserId]);
    expect(push.currentWeekOptedOutCount).toBe(1);
    expect(push.priorWeekOptedOutCount).toBe(0);

    // Categories nobody opted out of return zero across all buckets.
    const memberDocs = byKey.get("notifyMemberDocuments")!;
    expect(memberDocs.optedOutCount).toBe(0);
    expect(memberDocs.currentWeekOptedOutCount).toBe(0);
    expect(memberDocs.priorWeekOptedOutCount).toBe(0);
  });

  it("does not leak opt-outs from other organizations", async () => {
    const res = await request(appAsAdmin)
      .get(`/api/organizations/${orgId}/members/notification-prefs/recent-changes`);
    expect(res.status).toBe(200);
    type Row = { userIds: number[] };
    for (const r of res.body.rows as Row[]) {
      expect(r.userIds).not.toContain(otherOrgMemberUserId);
    }
  });
});
