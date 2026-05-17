// Task #1786 — Track delivery success for volunteer-assignment and
// marketing-campaign push notifications.
//
// Background
// ----------
// Both push call sites fixed in Task #1462 used to wrap `sendPushToUsers`
// in a bare try/catch that ignored the error and never inspected the
// returned `PushDeliveryResult`. When push fan-out failed (Expo down,
// all tokens invalid, batch rejected) nothing surfaced in the
// notification audit or admin dashboards — operators had no way to
// know members were missed.
//
// Task #1786 wires both paths to `classifyPushDelivery` (the canonical
// sent / failed / no_address mapping shared with every other notify
// helper, see Task #1070) and:
//
//   - Volunteer assignment push (POST volunteer assignment) writes a
//     row in `notification_audit_log` on `failed`.
//   - Marketing campaign push fan-out classifies per recipient AND
//     bumps the per-campaign `total_push_sent` / `total_push_failed`
//     counters; the `/stats` endpoint surfaces the counters so failures
//     are visible on the campaign stats page.
//
// This suite simulates Expo failures and asserts they are reflected in
// the audit log and campaign stats (not silently dropped). It mirrors
// the existing `push-call-signature-smoke.test.ts` fixture shape so
// the two regression families stay close.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

const { sendPushToUsersMock } = vi.hoisted(() => ({
  sendPushToUsersMock: vi.fn(async (_userIds: number[]) => ({
    attempted: 1, sent: 0, failed: 1, invalid: 0,
  })),
}));

vi.mock("../lib/push.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/push.js")>("../lib/push.js");
  return {
    ...actual,
    sendPushToUsers: sendPushToUsersMock,
  };
});

// We do not want to actually send mail during these smoke tests.
vi.mock("../lib/mailer.js", () => ({
  sendBroadcastEmail: vi.fn(async () => undefined),
  fetchPostmarkMessageDetails: vi.fn(async () => null),
}));

import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  tournamentsTable,
  volunteerRolesTable,
  volunteerAssignmentsTable,
  appUsersTable,
  orgMembershipsTable,
  marketingCampaignsTable,
  campaignRecipientsTable,
  notificationAuditLogTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";

const createdOrgIds: number[] = [];
const createdCourseIds: number[] = [];
const createdTournamentIds: number[] = [];
const createdRoleIds: number[] = [];
const createdUserIds: number[] = [];
const createdCampaignIds: number[] = [];

beforeAll(() => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = "test-session-secret-for-push-delivery-failure-tracking";
  }
});

beforeEach(() => {
  sendPushToUsersMock.mockReset();
});

afterAll(async () => {
  if (createdCampaignIds.length) {
    await db.delete(notificationAuditLogTable).where(
      and(
        eq(notificationAuditLogTable.notificationKey, "marketing.campaign.push"),
        inArray(notificationAuditLogTable.userId, createdUserIds),
      ),
    );
    await db.delete(campaignRecipientsTable).where(inArray(campaignRecipientsTable.campaignId, createdCampaignIds));
    await db.delete(marketingCampaignsTable).where(inArray(marketingCampaignsTable.id, createdCampaignIds));
  }
  if (createdRoleIds.length) {
    await db.delete(notificationAuditLogTable).where(
      and(
        eq(notificationAuditLogTable.notificationKey, "volunteer.assignment.assigned"),
        inArray(notificationAuditLogTable.userId, createdUserIds),
      ),
    );
    await db.delete(volunteerAssignmentsTable).where(inArray(volunteerAssignmentsTable.roleId, createdRoleIds));
    await db.delete(volunteerRolesTable).where(inArray(volunteerRolesTable.id, createdRoleIds));
  }
  if (createdTournamentIds.length) {
    await db.delete(tournamentsTable).where(inArray(tournamentsTable.id, createdTournamentIds));
  }
  if (createdCourseIds.length) {
    await db.delete(coursesTable).where(inArray(coursesTable.id, createdCourseIds));
  }
  if (createdUserIds.length) {
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

async function makeOrg(label: string): Promise<number> {
  const tag = uid(label);
  const [org] = await db.insert(organizationsTable).values({
    name: `PushAudit_${tag}`,
    slug: `push-audit-${tag}`,
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(org.id);
  return org.id;
}

async function makeUser(label: string, role: "super_admin" | "player" = "player"): Promise<TestUser> {
  const tag = uid(label);
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: `${tag}@test.local`,
    displayName: `Push Audit ${label}`,
    role,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return { id: u.id, username: tag, displayName: `Push Audit ${label}`, role };
}

describe("Task #1786 — push delivery failure tracking", () => {
  describe("volunteer-assignment push", () => {
    it("writes a notification_audit_log row on failed Expo delivery", async () => {
      const orgId = await makeOrg("evtstaff_fail");
      const admin = await makeUser("admin_evt_fail", "super_admin");
      const member = await makeUser("vol_member_fail", "player");

      const courseSlug = uid("course");
      const [course] = await db.insert(coursesTable).values({
        organizationId: orgId,
        name: "Audit Push Course",
        slug: courseSlug,
        holes: 18,
        par: 72,
      }).returning({ id: coursesTable.id });
      createdCourseIds.push(course.id);

      const [tournament] = await db.insert(tournamentsTable).values({
        organizationId: orgId,
        courseId: course.id,
        name: "Audit Push Open",
        format: "stroke_play",
        status: "upcoming",
        rounds: 1,
        startDate: new Date(),
        endDate: new Date(Date.now() + 86_400_000),
        maxPlayers: 16,
      }).returning({ id: tournamentsTable.id });
      createdTournamentIds.push(tournament.id);

      const [role] = await db.insert(volunteerRolesTable).values({
        tournamentId: tournament.id,
        organizationId: orgId,
        title: "Course Marshal",
        maxVolunteers: 5,
        qrToken: uid("qr"),
      }).returning({ id: volunteerRolesTable.id });
      createdRoleIds.push(role.id);

      // Simulate Expo rejecting the push (e.g. provider down, batch rejected).
      sendPushToUsersMock.mockResolvedValueOnce({
        attempted: 1, sent: 0, failed: 1, invalid: 0,
      });

      await request(createTestApp(admin))
        .post(`/api/organizations/${orgId}/tournaments/${tournament.id}/volunteer-roles/${role.id}/assignments`)
        .send({
          userId: member.id,
          firstName: "Vol",
          lastName: "Member",
        })
        .expect(201);

      expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);

      const auditRows = await db.select().from(notificationAuditLogTable)
        .where(and(
          eq(notificationAuditLogTable.notificationKey, "volunteer.assignment.assigned"),
          eq(notificationAuditLogTable.userId, member.id),
        ));

      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]!.channel).toBe("push");
      expect(auditRows[0]!.status).toBe("failed");
      expect(auditRows[0]!.reason).toBe("push_provider_failed");
      const payload = auditRows[0]!.payload as Record<string, unknown>;
      expect(payload.tournamentId).toBe(tournament.id);
      expect(payload.roleId).toBe(role.id);
      expect(payload.organizationId).toBe(orgId);
      expect(payload.failed).toBe(1);
    });

    it("does NOT write an audit row when the recipient simply has no Expo token (no_address is benign)", async () => {
      const orgId = await makeOrg("evtstaff_noaddr");
      const admin = await makeUser("admin_evt_noaddr", "super_admin");
      const member = await makeUser("vol_member_noaddr", "player");

      const courseSlug = uid("course");
      const [course] = await db.insert(coursesTable).values({
        organizationId: orgId,
        name: "No-addr Course",
        slug: courseSlug,
        holes: 18,
        par: 72,
      }).returning({ id: coursesTable.id });
      createdCourseIds.push(course.id);

      const [tournament] = await db.insert(tournamentsTable).values({
        organizationId: orgId,
        courseId: course.id,
        name: "No-addr Open",
        format: "stroke_play",
        status: "upcoming",
        rounds: 1,
        startDate: new Date(),
        endDate: new Date(Date.now() + 86_400_000),
        maxPlayers: 16,
      }).returning({ id: tournamentsTable.id });
      createdTournamentIds.push(tournament.id);

      const [role] = await db.insert(volunteerRolesTable).values({
        tournamentId: tournament.id,
        organizationId: orgId,
        title: "Starter",
        maxVolunteers: 2,
        qrToken: uid("qr"),
      }).returning({ id: volunteerRolesTable.id });
      createdRoleIds.push(role.id);

      // Member has no Expo tokens registered → no_address (benign).
      sendPushToUsersMock.mockResolvedValueOnce({
        attempted: 1, sent: 0, failed: 0, invalid: 0,
      });

      await request(createTestApp(admin))
        .post(`/api/organizations/${orgId}/tournaments/${tournament.id}/volunteer-roles/${role.id}/assignments`)
        .send({
          userId: member.id,
          firstName: "Vol",
          lastName: "Member",
        })
        .expect(201);

      const auditRows = await db.select().from(notificationAuditLogTable)
        .where(and(
          eq(notificationAuditLogTable.notificationKey, "volunteer.assignment.assigned"),
          eq(notificationAuditLogTable.userId, member.id),
        ));
      expect(auditRows).toHaveLength(0);
    });
  });

  describe("marketing-campaign push", () => {
    it("classifies per recipient, bumps per-campaign counters, and surfaces failures on the stats page", async () => {
      const orgId = await makeOrg("mktg_fail");
      const admin = await makeUser("admin_mktg_fail", "super_admin");
      const sentRecipient = await makeUser("mktg_sent", "player");
      const failedRecipient = await makeUser("mktg_failed", "player");
      const noAddrRecipient = await makeUser("mktg_noaddr", "player");

      for (const u of [sentRecipient, failedRecipient, noAddrRecipient]) {
        await db.insert(orgMembershipsTable).values({
          organizationId: orgId,
          userId: u.id,
          role: "player",
        });
      }

      const [campaign] = await db.insert(marketingCampaignsTable).values({
        organizationId: orgId,
        name: "Fan-out Test Campaign",
        subject: "Tee Off Tonight",
        bodyHtml: "<p>Don't miss the sunset round.</p>",
        bodyText: "Don't miss the sunset round.",
        channels: ["push"],
        status: "draft",
      }).returning({ id: marketingCampaignsTable.id });
      createdCampaignIds.push(campaign.id);

      // The dispatcher iterates `eligible` in DB order. Recipients are
      // resolved by joining on org memberships — we can't deterministically
      // pin the iteration order, so we drive the mock by per-call userId
      // rather than per-call ordinal.
      sendPushToUsersMock.mockImplementation(async (userIds: number[]) => {
        const uid = userIds[0];
        if (uid === sentRecipient.id) {
          return { attempted: 1, sent: 1, failed: 0, invalid: 0 };
        }
        if (uid === failedRecipient.id) {
          return { attempted: 1, sent: 0, failed: 1, invalid: 0 };
        }
        // noAddrRecipient — no Expo tokens registered.
        return { attempted: 1, sent: 0, failed: 0, invalid: 0 };
      });

      await request(createTestApp(admin))
        .post(`/api/organizations/${orgId}/marketing/campaigns/${campaign.id}/send`)
        .send({})
        .expect(200);

      // /send dispatches asynchronously — poll briefly for the campaign
      // row to flip to `status='sent'` (the dispatcher's last write).
      const deadline = Date.now() + 10_000;
      let sentRow: typeof marketingCampaignsTable.$inferSelect | undefined;
      while (Date.now() < deadline) {
        const [row] = await db.select().from(marketingCampaignsTable)
          .where(eq(marketingCampaignsTable.id, campaign.id));
        if (row?.status === "sent") {
          sentRow = row;
          break;
        }
        await new Promise(r => setTimeout(r, 25));
      }
      expect(sentRow).toBeDefined();
      expect(sentRow!.totalPushSent).toBe(1);
      expect(sentRow!.totalPushFailed).toBe(1);

      // Audit log: one row for the failed recipient, none for the
      // sent / no_address recipients.
      const auditRows = await db.select().from(notificationAuditLogTable)
        .where(and(
          eq(notificationAuditLogTable.notificationKey, "marketing.campaign.push"),
          inArray(notificationAuditLogTable.userId, [sentRecipient.id, failedRecipient.id, noAddrRecipient.id]),
        ));
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]!.userId).toBe(failedRecipient.id);
      expect(auditRows[0]!.channel).toBe("push");
      expect(auditRows[0]!.status).toBe("failed");
      const payload = auditRows[0]!.payload as Record<string, unknown>;
      expect(payload.campaignId).toBe(campaign.id);
      expect(payload.organizationId).toBe(orgId);

      // Stats endpoint surfaces the counters.
      const statsRes = await request(createTestApp(admin))
        .get(`/api/organizations/${orgId}/marketing/campaigns/${campaign.id}/stats`)
        .expect(200);

      expect(statsRes.body.stats.totalPushSent).toBe(1);
      expect(statsRes.body.stats.totalPushFailed).toBe(1);
      expect(statsRes.body.stats.totalPushAttempted).toBe(2);
      expect(statsRes.body.stats.pushFailureRate).toBe(50);
    });
  });
});
