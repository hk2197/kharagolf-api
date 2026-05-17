/**
 * Integration tests: controller dashboard drill-down endpoint that lists
 * the members who opened the export-expiring reminder but never came
 * back to download their archive (Task #1297).
 *
 *   GET /api/organizations/:orgId/members-360/data-requests/expiring-reminder-stalled
 *
 * Coverage:
 *   - eligibility surface: only rows where `expiringReminderEmailOpenedAt
 *     IS NOT NULL`, `artifactDownloadedAt IS NULL`, `artifactUrl IS NOT
 *     NULL`, and `resolvedAt` still inside DATA_EXPORT_VALID_DAYS.
 *   - downloaded rows are excluded (the member is no longer at risk).
 *   - rows past the validity window are excluded (purger will drop them).
 *   - rows from a different org are excluded (org scoping).
 *   - filter=opened-only excludes clicked rows; filter=clicked includes
 *     only clicked rows; counts always reflect the unfiltered surface so
 *     the UI can label the filter tabs correctly.
 *   - each row carries member name + number + email plus a materialised
 *     `purgesAt` timestamp (resolvedAt + retention window).
 *   - authz: org_admin required; player + unauthenticated are rejected.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberDataRequestsTable,
  memberAuditLogTable,
} from "@workspace/db";
import { inArray, sql } from "drizzle-orm";

import { createTestApp, type TestUser, uid } from "./helpers.js";

async function ensureSchema() {
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS expiring_reminder_tracking_token text`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS expiring_reminder_email_opened_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS expiring_reminder_email_clicked_at timestamptz`);
  await db.execute(sql`ALTER TABLE member_data_requests ADD COLUMN IF NOT EXISTS artifact_downloaded_at timestamptz`);
}

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const createdMemberIds: number[] = [];

async function makeOrg(label: string): Promise<number> {
  const tag = uid(label);
  const [o] = await db.insert(organizationsTable).values({
    name: `ExpStalled_${tag}`,
    slug: `exp-stalled-${tag}`.toLowerCase(),
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

async function makeMember(
  orgId: number,
  overrides: Partial<typeof clubMembersTable.$inferInsert> = {},
): Promise<number> {
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    firstName: "Stalled",
    lastName: "Member",
    email: `${uid("m")}@test.local`,
    ...overrides,
  }).returning({ id: clubMembersTable.id });
  createdMemberIds.push(m.id);
  return m.id;
}

async function seedRequest(
  orgId: number, memberId: number,
  overrides: Partial<typeof memberDataRequestsTable.$inferInsert> = {},
) {
  const [row] = await db.insert(memberDataRequestsTable).values({
    organizationId: orgId,
    clubMemberId: memberId,
    requestType: "access",
    status: "completed",
    requestedAt: new Date(),
    ...overrides,
  }).returning();
  return row;
}

afterAll(async () => {
  if (createdOrgIds.length) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.organizationId, createdOrgIds));
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

const ROUTE = (orgId: number) =>
  `/api/organizations/${orgId}/members-360/data-requests/expiring-reminder-stalled`;

const DAY_MS = 24 * 60 * 60 * 1000;

describe("GET /members-360/data-requests/expiring-reminder-stalled", () => {
  it("lists opened-but-not-downloaded rows and computes counts + purge time", async () => {
    await ensureSchema();
    const orgId = await makeOrg("base");
    const admin = await makeAdmin(orgId);
    const member = await makeMember(orgId, {
      firstName: "Asha", lastName: "Patel", memberNumber: "M-12",
      email: "asha@test.local",
    });
    const now = Date.now();

    // Eligible: opened, not clicked, not downloaded, archive still valid.
    const openedOnlyResolvedAt = new Date(now - 5 * DAY_MS);
    const openedAtA = new Date(now - 1 * DAY_MS);
    const openedOnly = await seedRequest(orgId, member, {
      resolvedAt: openedOnlyResolvedAt,
      artifactUrl: "/objects/exports/openedOnly.json",
      lastNotificationKind: "export_expiring",
      expiringNoticeSentAt: new Date(now - 2 * DAY_MS),
      expiringReminderTrackingToken: uid("oo"),
      expiringReminderEmailOpenedAt: openedAtA,
    });

    // Eligible: opened AND clicked, still not downloaded.
    const clickedResolvedAt = new Date(now - 4 * DAY_MS);
    const clickedRow = await seedRequest(orgId, member, {
      resolvedAt: clickedResolvedAt,
      artifactUrl: "/objects/exports/clicked.json",
      lastNotificationKind: "export_expiring",
      expiringNoticeSentAt: new Date(now - 2 * DAY_MS),
      expiringReminderTrackingToken: uid("cl"),
      expiringReminderEmailOpenedAt: new Date(now - 12 * 60 * 60 * 1000),
      expiringReminderEmailClickedAt: new Date(now - 11 * 60 * 60 * 1000),
    });

    // Excluded: opened AND downloaded — no longer at risk.
    await seedRequest(orgId, member, {
      resolvedAt: new Date(now - 3 * DAY_MS),
      artifactUrl: "/objects/exports/downloaded.json",
      artifactDownloadedAt: new Date(now - 1 * DAY_MS),
      expiringReminderTrackingToken: uid("dl"),
      expiringReminderEmailOpenedAt: new Date(now - 2 * DAY_MS),
    });

    // Excluded: never opened the reminder.
    await seedRequest(orgId, member, {
      resolvedAt: new Date(now - 3 * DAY_MS),
      artifactUrl: "/objects/exports/unopened.json",
      expiringReminderTrackingToken: uid("un"),
    });

    // Excluded: archive already purged (artifactUrl IS NULL).
    await seedRequest(orgId, member, {
      resolvedAt: new Date(now - 6 * DAY_MS),
      artifactUrl: null,
      expiringReminderTrackingToken: uid("pu"),
      expiringReminderEmailOpenedAt: new Date(now - 2 * DAY_MS),
    });

    // Excluded: resolvedAt is older than the 7-day validity window — the
    // signed URL has died and the purger will sweep this row shortly.
    await seedRequest(orgId, member, {
      resolvedAt: new Date(now - 8 * DAY_MS),
      artifactUrl: "/objects/exports/expired.json",
      expiringReminderTrackingToken: uid("ex"),
      expiringReminderEmailOpenedAt: new Date(now - 7 * DAY_MS),
    });

    const app = createTestApp(admin);
    const res = await request(app).get(ROUTE(orgId)).expect(200);

    expect(res.body.filter).toBe("all");
    expect(res.body.validDays).toBe(7);
    expect(res.body.counts).toEqual({ total: 2, openedOnly: 1, clicked: 1 });
    expect(res.body.items).toHaveLength(2);

    // Most-recently-opened-first ordering — the openedOnly row was opened
    // 1 day ago, the clicked row 12h ago, so clicked comes first.
    const ids = res.body.items.map((i: { id: number }) => i.id);
    expect(ids).toEqual([clickedRow.id, openedOnly.id]);

    const first = res.body.items[0];
    expect(first.memberFirstName).toBe("Asha");
    expect(first.memberLastName).toBe("Patel");
    expect(first.memberNumber).toBe("M-12");
    expect(first.memberEmail).toBe("asha@test.local");
    expect(first.expiringReminderEmailOpenedAt).toBeTruthy();
    expect(first.expiringReminderEmailClickedAt).toBeTruthy();
    // purgesAt = resolvedAt + 7d (DATA_EXPORT_VALID_DAYS)
    expect(new Date(first.purgesAt).getTime()).toBe(
      new Date(clickedResolvedAt).getTime() + 7 * DAY_MS,
    );
  });

  it("filter=opened-only returns rows that were opened but not clicked", async () => {
    await ensureSchema();
    const orgId = await makeOrg("opened");
    const admin = await makeAdmin(orgId);
    const member = await makeMember(orgId);
    const now = Date.now();

    const openedOnly = await seedRequest(orgId, member, {
      resolvedAt: new Date(now - 3 * DAY_MS),
      artifactUrl: "/objects/exports/oo.json",
      expiringReminderEmailOpenedAt: new Date(now - 1 * DAY_MS),
    });
    await seedRequest(orgId, member, {
      resolvedAt: new Date(now - 3 * DAY_MS),
      artifactUrl: "/objects/exports/cl.json",
      expiringReminderEmailOpenedAt: new Date(now - 1 * DAY_MS),
      expiringReminderEmailClickedAt: new Date(now - 12 * 60 * 60 * 1000),
    });

    const app = createTestApp(admin);
    const res = await request(app)
      .get(ROUTE(orgId))
      .query({ filter: "opened-only" })
      .expect(200);

    expect(res.body.filter).toBe("opened-only");
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(openedOnly.id);
    expect(res.body.items[0].expiringReminderEmailClickedAt).toBeNull();
    // counts always reflect the unfiltered surface
    expect(res.body.counts).toEqual({ total: 2, openedOnly: 1, clicked: 1 });
  });

  it("filter=clicked returns only rows the member clicked through", async () => {
    await ensureSchema();
    const orgId = await makeOrg("clicked");
    const admin = await makeAdmin(orgId);
    const member = await makeMember(orgId);
    const now = Date.now();

    await seedRequest(orgId, member, {
      resolvedAt: new Date(now - 3 * DAY_MS),
      artifactUrl: "/objects/exports/oo.json",
      expiringReminderEmailOpenedAt: new Date(now - 1 * DAY_MS),
    });
    const clicked = await seedRequest(orgId, member, {
      resolvedAt: new Date(now - 3 * DAY_MS),
      artifactUrl: "/objects/exports/cl.json",
      expiringReminderEmailOpenedAt: new Date(now - 1 * DAY_MS),
      expiringReminderEmailClickedAt: new Date(now - 12 * 60 * 60 * 1000),
    });

    const app = createTestApp(admin);
    const res = await request(app)
      .get(ROUTE(orgId))
      .query({ filter: "clicked" })
      .expect(200);

    expect(res.body.filter).toBe("clicked");
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(clicked.id);
    expect(res.body.items[0].expiringReminderEmailClickedAt).toBeTruthy();
  });

  it("scopes the list to the requested org", async () => {
    await ensureSchema();
    const orgA = await makeOrg("scopeA");
    const orgB = await makeOrg("scopeB");
    const admin = await makeAdmin(orgA);
    const memberA = await makeMember(orgA);
    const memberB = await makeMember(orgB);
    const now = Date.now();

    const inOrg = await seedRequest(orgA, memberA, {
      resolvedAt: new Date(now - 3 * DAY_MS),
      artifactUrl: "/objects/exports/a.json",
      expiringReminderEmailOpenedAt: new Date(now - 1 * DAY_MS),
    });
    // Same telemetry but in a different org — must NOT leak across.
    await seedRequest(orgB, memberB, {
      resolvedAt: new Date(now - 3 * DAY_MS),
      artifactUrl: "/objects/exports/b.json",
      expiringReminderEmailOpenedAt: new Date(now - 1 * DAY_MS),
    });

    const app = createTestApp(admin);
    const res = await request(app).get(ROUTE(orgA)).expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(inOrg.id);
  });

  it("returns an empty list (not an error) when nothing is stalled", async () => {
    await ensureSchema();
    const orgId = await makeOrg("empty");
    const admin = await makeAdmin(orgId);

    const app = createTestApp(admin);
    const res = await request(app).get(ROUTE(orgId)).expect(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.counts).toEqual({ total: 0, openedOnly: 0, clicked: 0 });
  });

  it("rejects unauthenticated and non-admin callers", async () => {
    await ensureSchema();
    const orgId = await makeOrg("authz");

    await request(createTestApp())
      .get(ROUTE(orgId))
      .expect(401);

    const player = await makePlayer(orgId);
    await request(createTestApp(player))
      .get(ROUTE(orgId))
      .expect(403);
  });

  // Task #1528 — the widget now needs to know "who last nudged this row"
  // so two admins working in parallel don't double-fire the same export
  // reminder. The endpoint joins the latest entity='data_request_notification'
  // / action='resend' row in `memberAuditLogTable` (the same shape the
  // POST .../resend handler writes) and returns lastNudgedAt +
  // lastNudgedByDisplayName per item.
  it("surfaces the latest resend audit row as lastNudgedAt + lastNudgedByDisplayName", async () => {
    await ensureSchema();
    const orgId = await makeOrg("nudge");
    const admin = await makeAdmin(orgId);

    // A second admin so we can prove "last writer wins" picks the most
    // recent of two resends and that the live displayName is preferred
    // over the snapshot stored in memberAuditLogTable.actorName.
    const tag = uid("admin2");
    const [secondAdmin] = await db.insert(appUsersTable).values({
      replitUserId: tag, username: tag, email: `${tag}@test.local`,
      displayName: "Asha Patel", role: "org_admin", organizationId: orgId,
    }).returning({ id: appUsersTable.id });
    createdUserIds.push(secondAdmin.id);

    const member = await makeMember(orgId);
    const now = Date.now();

    // Stalled row that has been nudged twice: first by the original admin,
    // then by Asha. The endpoint must surface Asha's nudge (newest first).
    const nudgedRow = await seedRequest(orgId, member, {
      resolvedAt: new Date(now - 3 * DAY_MS),
      artifactUrl: "/objects/exports/nudged.json",
      expiringReminderTrackingToken: uid("nu"),
      expiringReminderEmailOpenedAt: new Date(now - 1 * DAY_MS),
    });

    // Stalled row with no nudge history at all — must come back with both
    // lastNudgedAt and lastNudgedByDisplayName set to null.
    const untouchedRow = await seedRequest(orgId, member, {
      resolvedAt: new Date(now - 3 * DAY_MS),
      artifactUrl: "/objects/exports/untouched.json",
      expiringReminderTrackingToken: uid("ut"),
      expiringReminderEmailOpenedAt: new Date(now - 2 * 60 * 60 * 1000),
    });

    const olderResendAt = new Date(now - 30 * 60 * 1000);
    const newerResendAt = new Date(now - 5 * 60 * 1000);
    await db.insert(memberAuditLogTable).values([
      {
        organizationId: orgId,
        clubMemberId: member,
        actorUserId: admin.id,
        actorName: "Admin",
        entity: "data_request_notification",
        entityId: nudgedRow.id,
        action: "resend",
        reason: "first nudge",
        createdAt: olderResendAt,
      },
      {
        organizationId: orgId,
        clubMemberId: member,
        actorUserId: secondAdmin.id,
        // Stored snapshot intentionally stale — endpoint should prefer the
        // live appUsers.displayName ("Asha Patel") via the LEFT JOIN.
        actorName: "stale-snapshot",
        entity: "data_request_notification",
        entityId: nudgedRow.id,
        action: "resend",
        reason: "second nudge",
        createdAt: newerResendAt,
      },
      // Noise: a different action / entity on the same row that must NOT
      // be picked as a "nudge". Guards against a future regression where
      // someone widens the filter.
      {
        organizationId: orgId,
        clubMemberId: member,
        actorUserId: admin.id,
        actorName: "Admin",
        entity: "data_request_notification",
        entityId: nudgedRow.id,
        action: "view",
        reason: "viewed",
        createdAt: new Date(now - 1 * 60 * 1000),
      },
      {
        organizationId: orgId,
        clubMemberId: member,
        actorUserId: admin.id,
        actorName: "Admin",
        entity: "data_request",
        entityId: nudgedRow.id,
        action: "resend",
        reason: "wrong entity",
        createdAt: new Date(now - 2 * 60 * 1000),
      },
    ]);

    const app = createTestApp(admin);
    const res = await request(app).get(ROUTE(orgId)).expect(200);

    expect(res.body.items).toHaveLength(2);
    const byId = new Map<number, { lastNudgedAt: string | null; lastNudgedByDisplayName: string | null }>(
      res.body.items.map((i: { id: number; lastNudgedAt: string | null; lastNudgedByDisplayName: string | null }) =>
        [i.id, { lastNudgedAt: i.lastNudgedAt, lastNudgedByDisplayName: i.lastNudgedByDisplayName }]),
    );

    const nudged = byId.get(nudgedRow.id);
    expect(nudged?.lastNudgedAt).toBeTruthy();
    expect(new Date(nudged!.lastNudgedAt!).getTime()).toBe(newerResendAt.getTime());
    // Live display name (post-rename safe), not the snapshot in actorName.
    expect(nudged?.lastNudgedByDisplayName).toBe("Asha Patel");

    const untouched = byId.get(untouchedRow.id);
    expect(untouched?.lastNudgedAt).toBeNull();
    expect(untouched?.lastNudgedByDisplayName).toBeNull();
  });

  // Task #1891 — the dashboard widget shows a per-channel ✓/✗ row under the
  // "Nudged Xm ago by Asha" line so admins know whether the personal nudge
  // actually went out (or whether push/SMS bounced and they should retry)
  // before assuming the member was reached. The endpoint surfaces that
  // detail by reading the latest resend audit row's `metadata.channels`
  // (the same shape the per-member resend-history popover already renders).
  it("returns the latest resend's metadata.channels as lastNudgedChannels", async () => {
    await ensureSchema();
    const orgId = await makeOrg("channels");
    const admin = await makeAdmin(orgId);
    const member = await makeMember(orgId);
    const now = Date.now();

    const stalledRow = await seedRequest(orgId, member, {
      resolvedAt: new Date(now - 3 * DAY_MS),
      artifactUrl: "/objects/exports/channels.json",
      expiringReminderTrackingToken: uid("ch"),
      expiringReminderEmailOpenedAt: new Date(now - 1 * DAY_MS),
    });

    // Stalled row with no resend audit history at all — must come back
    // with both lastNudgedAt and lastNudgedChannels set to null so the UI
    // skips the channel row entirely.
    const untouchedRow = await seedRequest(orgId, member, {
      resolvedAt: new Date(now - 3 * DAY_MS),
      artifactUrl: "/objects/exports/untouched.json",
      expiringReminderTrackingToken: uid("ut2"),
      expiringReminderEmailOpenedAt: new Date(now - 2 * 60 * 60 * 1000),
    });

    // Two resends on the stalled row: an older one with everything ok
    // and a newer one where push failed with a provider error. The
    // endpoint must surface the *newest* row's per-channel detail so the
    // admin sees the freshest delivery state.
    const olderResendAt = new Date(now - 30 * 60 * 1000);
    const newerResendAt = new Date(now - 5 * 60 * 1000);
    const olderEmailAt = new Date(now - 30 * 60 * 1000 + 100).toISOString();
    const newerEmailAt = new Date(now - 5 * 60 * 1000 + 100).toISOString();
    const newerInAppAt = new Date(now - 5 * 60 * 1000 + 200).toISOString();
    const newerPushAt = new Date(now - 5 * 60 * 1000 + 300).toISOString();
    const newerSmsAt = new Date(now - 5 * 60 * 1000 + 400).toISOString();
    await db.insert(memberAuditLogTable).values([
      {
        organizationId: orgId,
        clubMemberId: member,
        actorUserId: admin.id,
        actorName: "Admin",
        entity: "data_request_notification",
        entityId: stalledRow.id,
        action: "resend",
        reason: "expiring notice resent — email:sent, in_app:sent, push:sent, sms:skipped",
        metadata: {
          kind: "expiring",
          channels: {
            email: { status: "sent", at: olderEmailAt, error: null },
            inApp: { status: "sent", at: olderEmailAt, error: null },
            push: { status: "sent", at: olderEmailAt, error: null },
            sms: { status: "skipped", at: olderEmailAt, error: null },
          },
        },
        createdAt: olderResendAt,
      },
      {
        organizationId: orgId,
        clubMemberId: member,
        actorUserId: admin.id,
        actorName: "Admin",
        entity: "data_request_notification",
        entityId: stalledRow.id,
        action: "resend",
        reason: "expiring notice resent — email:sent, in_app:sent, push:failed, sms:skipped",
        metadata: {
          kind: "expiring",
          channels: {
            email: { status: "sent", at: newerEmailAt, error: null },
            inApp: { status: "sent", at: newerInAppAt, error: null },
            push: { status: "failed", at: newerPushAt, error: "FCM token expired" },
            sms: { status: "skipped", at: newerSmsAt, error: null },
          },
        },
        createdAt: newerResendAt,
      },
    ]);

    const app = createTestApp(admin);
    const res = await request(app).get(ROUTE(orgId)).expect(200);

    type ChannelDetail = { status: string; at: string | null; error: string | null } | null;
    type LastNudgedChannels = {
      email: ChannelDetail;
      inApp: ChannelDetail;
      push: ChannelDetail;
      sms: ChannelDetail;
    } | null;
    type ItemEntry = {
      lastNudgedAt: string | null;
      lastNudgedChannels: LastNudgedChannels;
    };
    const byId = new Map<number, ItemEntry>((res.body.items as Array<{
      id: number;
      lastNudgedAt: string | null;
      lastNudgedChannels: LastNudgedChannels;
    }>).map((i) => [i.id, { lastNudgedAt: i.lastNudgedAt, lastNudgedChannels: i.lastNudgedChannels }]));

    const stalled = byId.get(stalledRow.id);
    expect(stalled?.lastNudgedAt).toBeTruthy();
    expect(stalled?.lastNudgedChannels).toBeTruthy();
    // The newest row's channel detail wins — push:failed with the
    // provider error string preserved verbatim so the UI tooltip can
    // surface it on hover.
    expect(stalled!.lastNudgedChannels!.email).toEqual({
      status: "sent", at: newerEmailAt, error: null,
    });
    expect(stalled!.lastNudgedChannels!.inApp).toEqual({
      status: "sent", at: newerInAppAt, error: null,
    });
    expect(stalled!.lastNudgedChannels!.push).toEqual({
      status: "failed", at: newerPushAt, error: "FCM token expired",
    });
    expect(stalled!.lastNudgedChannels!.sms).toEqual({
      status: "skipped", at: newerSmsAt, error: null,
    });

    // Untouched row: no audit history, so the widget knows to skip
    // rendering the channel row entirely.
    const untouched = byId.get(untouchedRow.id);
    expect(untouched?.lastNudgedAt).toBeNull();
    expect(untouched?.lastNudgedChannels).toBeNull();
  });

  // Legacy fallback — audit rows persisted before the resend handler started
  // writing structured metadata.channels still carry the per-channel statuses
  // in the free-form reason string ("email:sent, in_app:sent, push:failed,
  // sms:skipped"). The endpoint must recover those statuses (without the
  // timestamps or provider errors, which were never recorded that way).
  it("falls back to parsing channels from the reason string for legacy audit rows", async () => {
    await ensureSchema();
    const orgId = await makeOrg("legacy");
    const admin = await makeAdmin(orgId);
    const member = await makeMember(orgId);
    const now = Date.now();

    const stalledRow = await seedRequest(orgId, member, {
      resolvedAt: new Date(now - 3 * DAY_MS),
      artifactUrl: "/objects/exports/legacy.json",
      expiringReminderTrackingToken: uid("lg"),
      expiringReminderEmailOpenedAt: new Date(now - 1 * DAY_MS),
    });

    await db.insert(memberAuditLogTable).values({
      organizationId: orgId,
      clubMemberId: member,
      actorUserId: admin.id,
      actorName: "Admin",
      entity: "data_request_notification",
      entityId: stalledRow.id,
      action: "resend",
      // Legacy reason string from before metadata.channels existed.
      reason: "expiring notice resent — email:sent, in_app:sent, push:failed, sms:skipped",
      metadata: null,
      createdAt: new Date(now - 5 * 60 * 1000),
    });

    const app = createTestApp(admin);
    const res = await request(app).get(ROUTE(orgId)).expect(200);

    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(item.lastNudgedChannels).toBeTruthy();
    // Status recovered, but at/error are null — the legacy reason string
    // never recorded those fields. The UI degrades gracefully (status-only
    // tooltip with no timestamp / provider error).
    expect(item.lastNudgedChannels.email).toEqual({ status: "sent", at: null, error: null });
    expect(item.lastNudgedChannels.inApp).toEqual({ status: "sent", at: null, error: null });
    expect(item.lastNudgedChannels.push).toEqual({ status: "failed", at: null, error: null });
    expect(item.lastNudgedChannels.sms).toEqual({ status: "skipped", at: null, error: null });
  });

  // Cross-org guard — a resend audit row in a different org for a row with
  // the same entityId (across orgs id space can collide) must not bleed
  // through into the response. Catches a future bug where someone drops
  // the organizationId predicate from the audit-log lookup.
  it("does not leak nudges from other orgs even when entityIds collide", async () => {
    await ensureSchema();
    const orgA = await makeOrg("nudgeA");
    const orgB = await makeOrg("nudgeB");
    const adminA = await makeAdmin(orgA);
    const adminB = await makeAdmin(orgB);
    const memberA = await makeMember(orgA);
    const memberB = await makeMember(orgB);
    const now = Date.now();

    const rowA = await seedRequest(orgA, memberA, {
      resolvedAt: new Date(now - 3 * DAY_MS),
      artifactUrl: "/objects/exports/a.json",
      expiringReminderEmailOpenedAt: new Date(now - 1 * DAY_MS),
    });

    // Audit row in orgB with the SAME entityId as orgA's stalled row.
    // If the endpoint forgets the organizationId filter on the join, it
    // will surface adminB as the nudger for adminA's row.
    await db.insert(memberAuditLogTable).values({
      organizationId: orgB,
      clubMemberId: memberB,
      actorUserId: adminB.id,
      actorName: "AdminB",
      entity: "data_request_notification",
      entityId: rowA.id, // <-- intentional collision
      action: "resend",
      reason: "cross-org bleed",
      createdAt: new Date(now - 5 * 60 * 1000),
    });

    const app = createTestApp(adminA);
    const res = await request(app).get(ROUTE(orgA)).expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(rowA.id);
    expect(res.body.items[0].lastNudgedAt).toBeNull();
    expect(res.body.items[0].lastNudgedByDisplayName).toBeNull();
  });
});
