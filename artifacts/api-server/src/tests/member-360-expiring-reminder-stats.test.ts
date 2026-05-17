/**
 * Integration tests: controller dashboard endpoint that aggregates
 * export-expiring reminder open/click telemetry (Task #1124).
 *
 *   GET /api/organizations/:orgId/members-360/data-requests/expiring-reminder-stats
 *
 * Coverage:
 *   - aggregation correctness: sent counts only the rows the new
 *     pipeline actually instrumented (`expiringNoticeSentAt IS NOT NULL`
 *     AND `expiringReminderTrackingToken IS NOT NULL`); legacy rows are
 *     excluded so they don't deflate the open rate.
 *   - opened/clicked counts and the derived openRate/clickRate match.
 *   - rows outside the requested `?days=` window are excluded.
 *   - rows belonging to a different org are excluded (org scoping).
 *   - empty dataset returns null rates instead of dividing by zero.
 *   - authz: org_admin required; player + unauthenticated rejected.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberDataRequestsTable,
} from "@workspace/db";
import { inArray, sql } from "drizzle-orm";

import { createTestApp, type TestUser, uid } from "./helpers.js";

async function ensureSchema() {
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS expiring_reminder_tracking_token text`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS expiring_reminder_email_opened_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS expiring_reminder_email_clicked_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS expiring_reminder_email_prefetched_at timestamptz`);
}

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const createdMemberIds: number[] = [];

async function makeOrg(label: string): Promise<number> {
  const tag = uid(label);
  const [o] = await db.insert(organizationsTable).values({
    name: `ExpStats_${tag}`,
    slug: `exp-stats-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(o.id);
  return o.id;
}

async function makeAdmin(orgId: number): Promise<TestUser> {
  const tag = uid("admin");
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag, username: tag, email: `${tag}@test.local`,
    displayName: "Admin", role: "org_admin", organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return { id: u.id, username: tag, displayName: "Admin", role: "org_admin", organizationId: orgId };
}

async function makePlayer(orgId: number): Promise<TestUser> {
  const tag = uid("player");
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag, username: tag, email: `${tag}@test.local`,
    displayName: "Player", role: "player", organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return { id: u.id, username: tag, displayName: "Player", role: "player", organizationId: orgId };
}

async function makeMember(orgId: number): Promise<number> {
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId, firstName: "Stats", lastName: "Tester",
    email: `${uid("m")}@test.local`,
  }).returning({ id: clubMembersTable.id });
  createdMemberIds.push(m.id);
  return m.id;
}

async function seedRequest(
  orgId: number, memberId: number, overrides: Partial<typeof memberDataRequestsTable.$inferInsert> = {},
) {
  const [row] = await db.insert(memberDataRequestsTable).values({
    organizationId: orgId, clubMemberId: memberId,
    requestType: "access", status: "completed",
    requestedAt: new Date(),
    ...overrides,
  }).returning();
  return row;
}

afterAll(async () => {
  if (createdOrgIds.length) {
    await db.delete(memberDataRequestsTable).where(inArray(memberDataRequestsTable.organizationId, createdOrgIds));
    await db.delete(clubMembersTable).where(inArray(clubMembersTable.organizationId, createdOrgIds));
  }
  if (createdUserIds.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

describe("GET /members-360/data-requests/expiring-reminder-stats", () => {
  it("aggregates sent/opened/clicked and derives the rates", async () => {
    await ensureSchema();
    const orgId = await makeOrg("agg");
    const admin = await makeAdmin(orgId);
    const member = await makeMember(orgId);
    const now = Date.now();

    // 4 sent + tracked rows: 3 opened (1 also clicked), 1 not opened.
    await seedRequest(orgId, member, {
      expiringNoticeSentAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
      expiringReminderTrackingToken: uid("t1"),
      expiringReminderEmailOpenedAt: new Date(now - 1 * 24 * 60 * 60 * 1000),
      expiringReminderEmailClickedAt: new Date(now - 1 * 24 * 60 * 60 * 1000),
    });
    await seedRequest(orgId, member, {
      expiringNoticeSentAt: new Date(now - 3 * 24 * 60 * 60 * 1000),
      expiringReminderTrackingToken: uid("t2"),
      expiringReminderEmailOpenedAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
    });
    await seedRequest(orgId, member, {
      expiringNoticeSentAt: new Date(now - 4 * 24 * 60 * 60 * 1000),
      expiringReminderTrackingToken: uid("t3"),
      expiringReminderEmailOpenedAt: new Date(now - 3 * 24 * 60 * 60 * 1000),
    });
    await seedRequest(orgId, member, {
      expiringNoticeSentAt: new Date(now - 5 * 24 * 60 * 60 * 1000),
      expiringReminderTrackingToken: uid("t4"),
    });
    // Legacy row: notice sent but no tracking token (pre-Task-#1124).
    // Must NOT be counted in `sent` — would deflate the open rate.
    await seedRequest(orgId, member, {
      expiringNoticeSentAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
    });

    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/organizations/${orgId}/members-360/data-requests/expiring-reminder-stats`)
      .expect(200);

    expect(res.body.sent).toBe(4);
    expect(res.body.opened).toBe(3);
    expect(res.body.clicked).toBe(1);
    expect(res.body.openRate).toBeCloseTo(0.75, 5);
    expect(res.body.clickRate).toBeCloseTo(0.25, 5);
    expect(res.body.windowDays).toBe(30);
    expect(typeof res.body.since).toBe("string");
  });

  it("excludes rows outside the requested window", async () => {
    await ensureSchema();
    const orgId = await makeOrg("window");
    const admin = await makeAdmin(orgId);
    const member = await makeMember(orgId);
    const now = Date.now();

    // Inside the 7-day window
    await seedRequest(orgId, member, {
      expiringNoticeSentAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
      expiringReminderTrackingToken: uid("in"),
      expiringReminderEmailOpenedAt: new Date(now - 1 * 24 * 60 * 60 * 1000),
    });
    // Outside the 7-day window — must be excluded
    await seedRequest(orgId, member, {
      expiringNoticeSentAt: new Date(now - 10 * 24 * 60 * 60 * 1000),
      expiringReminderTrackingToken: uid("out"),
      expiringReminderEmailOpenedAt: new Date(now - 9 * 24 * 60 * 60 * 1000),
    });

    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/organizations/${orgId}/members-360/data-requests/expiring-reminder-stats`)
      .query({ days: "7" })
      .expect(200);
    expect(res.body.sent).toBe(1);
    expect(res.body.opened).toBe(1);
    expect(res.body.windowDays).toBe(7);
  });

  it("scopes counts to the requested org", async () => {
    await ensureSchema();
    const orgA = await makeOrg("scopeA");
    const orgB = await makeOrg("scopeB");
    const admin = await makeAdmin(orgA);
    const memberA = await makeMember(orgA);
    const memberB = await makeMember(orgB);
    const now = Date.now();

    await seedRequest(orgA, memberA, {
      expiringNoticeSentAt: new Date(now - 1 * 24 * 60 * 60 * 1000),
      expiringReminderTrackingToken: uid("a"),
      expiringReminderEmailOpenedAt: new Date(now - 12 * 60 * 60 * 1000),
    });
    // Different org — must NOT contribute
    await seedRequest(orgB, memberB, {
      expiringNoticeSentAt: new Date(now - 1 * 24 * 60 * 60 * 1000),
      expiringReminderTrackingToken: uid("b"),
      expiringReminderEmailOpenedAt: new Date(now - 12 * 60 * 60 * 1000),
      expiringReminderEmailClickedAt: new Date(now - 11 * 60 * 60 * 1000),
    });

    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/organizations/${orgA}/members-360/data-requests/expiring-reminder-stats`)
      .expect(200);
    expect(res.body.sent).toBe(1);
    expect(res.body.opened).toBe(1);
    expect(res.body.clicked).toBe(0);
  });

  it("returns null rates when there is nothing to divide by", async () => {
    await ensureSchema();
    const orgId = await makeOrg("empty");
    const admin = await makeAdmin(orgId);
    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/organizations/${orgId}/members-360/data-requests/expiring-reminder-stats`)
      .expect(200);
    expect(res.body.sent).toBe(0);
    expect(res.body.opened).toBe(0);
    expect(res.body.clicked).toBe(0);
    expect(res.body.openRate).toBeNull();
    expect(res.body.clickRate).toBeNull();
  });

  it("excludes prefetch-only rows from `opened` by default but reports them in `prefetched`", async () => {
    // Task #1298 — prefetches stamped by Apple Mail Privacy Protection
    // and friends shouldn't inflate the open rate. The pixel handler
    // routes them into `expiringReminderEmailPrefetchedAt`; this endpoint
    // must hide them from `opened` unless the admin opts in.
    await ensureSchema();
    const orgId = await makeOrg("prefetch");
    const admin = await makeAdmin(orgId);
    const member = await makeMember(orgId);
    const now = Date.now();

    // 1 real human open
    await seedRequest(orgId, member, {
      expiringNoticeSentAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
      expiringReminderTrackingToken: uid("real"),
      expiringReminderEmailOpenedAt: new Date(now - 1 * 24 * 60 * 60 * 1000),
    });
    // 2 prefetch-only rows — must be hidden from `opened` by default
    await seedRequest(orgId, member, {
      expiringNoticeSentAt: new Date(now - 3 * 24 * 60 * 60 * 1000),
      expiringReminderTrackingToken: uid("pf1"),
      expiringReminderEmailPrefetchedAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
    });
    await seedRequest(orgId, member, {
      expiringNoticeSentAt: new Date(now - 4 * 24 * 60 * 60 * 1000),
      expiringReminderTrackingToken: uid("pf2"),
      expiringReminderEmailPrefetchedAt: new Date(now - 3 * 24 * 60 * 60 * 1000),
    });
    // 1 sent-but-untouched row
    await seedRequest(orgId, member, {
      expiringNoticeSentAt: new Date(now - 5 * 24 * 60 * 60 * 1000),
      expiringReminderTrackingToken: uid("none"),
    });

    const app = createTestApp(admin);

    // Default: prefetches excluded from `opened`.
    const def = await request(app)
      .get(`/api/organizations/${orgId}/members-360/data-requests/expiring-reminder-stats`)
      .expect(200);
    expect(def.body.sent).toBe(4);
    expect(def.body.opened).toBe(1);
    expect(def.body.prefetched).toBe(2);
    expect(def.body.includePrefetches).toBe(false);
    expect(def.body.openRate).toBeCloseTo(0.25, 5);

    // With `?includePrefetches=1`, prefetches fold into `opened`.
    const inc = await request(app)
      .get(`/api/organizations/${orgId}/members-360/data-requests/expiring-reminder-stats`)
      .query({ includePrefetches: "1" })
      .expect(200);
    expect(inc.body.sent).toBe(4);
    expect(inc.body.opened).toBe(3);
    expect(inc.body.prefetched).toBe(2);
    expect(inc.body.includePrefetches).toBe(true);
    expect(inc.body.openRate).toBeCloseTo(0.75, 5);
  });

  it("returns a per-day breakdown that rolls up to the aggregate (Task #1890)", async () => {
    // The dashboard sparkline needs daily buckets so admins can see
    // whether the open rate is climbing, falling, or flat. Real opens
    // and prefetches must be reported separately so the sparkline can
    // visually distinguish privacy-proxy noise from genuine reads.
    await ensureSchema();
    const orgId = await makeOrg("daily");
    const admin = await makeAdmin(orgId);
    const member = await makeMember(orgId);
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    // Day -3 (UTC): 1 sent, 1 real open, 0 prefetched, 0 clicked.
    await seedRequest(orgId, member, {
      expiringNoticeSentAt: new Date(now - 3 * dayMs),
      expiringReminderTrackingToken: uid("d1"),
      expiringReminderEmailOpenedAt: new Date(now - 3 * dayMs + 60_000),
    });
    // Day -2 (UTC): 2 sent, 1 real open, 1 prefetched (separately), 1 clicked.
    await seedRequest(orgId, member, {
      expiringNoticeSentAt: new Date(now - 2 * dayMs),
      expiringReminderTrackingToken: uid("d2a"),
      expiringReminderEmailOpenedAt: new Date(now - 2 * dayMs + 60_000),
      expiringReminderEmailClickedAt: new Date(now - 2 * dayMs + 120_000),
    });
    await seedRequest(orgId, member, {
      expiringNoticeSentAt: new Date(now - 2 * dayMs),
      expiringReminderTrackingToken: uid("d2b"),
      expiringReminderEmailPrefetchedAt: new Date(now - 2 * dayMs + 60_000),
    });
    // Day -1 (UTC): 1 sent, 0 opened, 0 prefetched.
    await seedRequest(orgId, member, {
      expiringNoticeSentAt: new Date(now - 1 * dayMs),
      expiringReminderTrackingToken: uid("d3"),
    });

    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/organizations/${orgId}/members-360/data-requests/expiring-reminder-stats`)
      .query({ days: "7" })
      .expect(200);

    expect(Array.isArray(res.body.daily)).toBe(true);
    // 7-day window pads zero-buckets so the sparkline reads continuously
    // (admins must be able to tell a quiet stretch from a recent outage).
    expect(res.body.daily.length).toBeGreaterThanOrEqual(7);

    // Every bucket has the expected shape regardless of activity.
    for (const b of res.body.daily) {
      expect(typeof b.date).toBe("string");
      expect(b.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof b.sent).toBe("number");
      expect(typeof b.opened).toBe("number");
      expect(typeof b.prefetched).toBe("number");
      expect(typeof b.clicked).toBe("number");
    }

    // The per-day numbers must roll up to the aggregate so the headline
    // and the chart can never disagree (the most jarring failure mode).
    const totalSent = res.body.daily.reduce((n: number, b: { sent: number }) => n + b.sent, 0);
    const totalOpened = res.body.daily.reduce((n: number, b: { opened: number }) => n + b.opened, 0);
    const totalPrefetched = res.body.daily.reduce((n: number, b: { prefetched: number }) => n + b.prefetched, 0);
    const totalClicked = res.body.daily.reduce((n: number, b: { clicked: number }) => n + b.clicked, 0);
    expect(totalSent).toBe(res.body.sent);
    // Daily `opened` is always real-only regardless of includePrefetches
    // (the toggle only affects the headline aggregate). Sanity-check by
    // looking up the row that we know is the only real human open.
    expect(totalOpened).toBe(res.body.opened);
    expect(totalPrefetched).toBe(res.body.prefetched);
    expect(totalClicked).toBe(res.body.clicked);

    // And critically: real opens and prefetches are reported in
    // *separate* fields per day (not collapsed). The day-2 bucket has
    // both, and they must not have been folded together.
    const dayWithBoth = res.body.daily.find(
      (b: { opened: number; prefetched: number }) => b.opened > 0 && b.prefetched > 0,
    );
    expect(dayWithBoth).toBeDefined();
    expect(dayWithBoth.opened).toBe(1);
    expect(dayWithBoth.prefetched).toBe(1);
  });

  it("daily breakdown ignores includePrefetches (toggle only affects the headline)", async () => {
    // The sparkline always wants the two series broken out so it can
    // stack them as distinct visual layers. Whether the *headline*
    // collapses prefetches into opens shouldn't change the per-day
    // shape — flipping the toggle would otherwise reshape the chart
    // and confuse the trend reading.
    await ensureSchema();
    const orgId = await makeOrg("dailyToggle");
    const admin = await makeAdmin(orgId);
    const member = await makeMember(orgId);
    const now = Date.now();
    await seedRequest(orgId, member, {
      expiringNoticeSentAt: new Date(now - 1 * 24 * 60 * 60 * 1000),
      expiringReminderTrackingToken: uid("real"),
      expiringReminderEmailOpenedAt: new Date(now - 12 * 60 * 60 * 1000),
    });
    await seedRequest(orgId, member, {
      expiringNoticeSentAt: new Date(now - 1 * 24 * 60 * 60 * 1000),
      expiringReminderTrackingToken: uid("pf"),
      expiringReminderEmailPrefetchedAt: new Date(now - 12 * 60 * 60 * 1000),
    });

    const app = createTestApp(admin);
    const def = await request(app)
      .get(`/api/organizations/${orgId}/members-360/data-requests/expiring-reminder-stats`)
      .query({ days: "3" })
      .expect(200);
    const inc = await request(app)
      .get(`/api/organizations/${orgId}/members-360/data-requests/expiring-reminder-stats`)
      .query({ days: "3", includePrefetches: "1" })
      .expect(200);

    // Same shape, same per-day numbers — the toggle only moved the
    // headline open count, not the chart series.
    expect(def.body.daily.length).toBe(inc.body.daily.length);
    const sumOpen = (rows: { opened: number }[]) => rows.reduce((n, r) => n + r.opened, 0);
    const sumPf = (rows: { prefetched: number }[]) => rows.reduce((n, r) => n + r.prefetched, 0);
    expect(sumOpen(def.body.daily)).toBe(1);
    expect(sumOpen(inc.body.daily)).toBe(1);
    expect(sumPf(def.body.daily)).toBe(1);
    expect(sumPf(inc.body.daily)).toBe(1);

    // Headline still flips as before — that contract isn't disturbed.
    expect(def.body.opened).toBe(1);
    expect(inc.body.opened).toBe(2);
  });

  it("rejects unauthenticated and non-admin callers", async () => {
    await ensureSchema();
    const orgId = await makeOrg("authz");
    const anon = createTestApp();
    await request(anon)
      .get(`/api/organizations/${orgId}/members-360/data-requests/expiring-reminder-stats`)
      .expect(401);

    const player = await makePlayer(orgId);
    const playerApp = createTestApp(player);
    await request(playerApp)
      .get(`/api/organizations/${orgId}/members-360/data-requests/expiring-reminder-stats`)
      .expect(403);
  });
});
