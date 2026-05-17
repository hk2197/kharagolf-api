/**
 * Task #1462 — smoke-test the two push-notification call sites that were
 * fixed to use the correct positional `sendPushToUsers(userIds, title, body, data?)`
 * signature:
 *
 *   - `routes/event-staffing.ts` — POST volunteer assignment fires a
 *     "Volunteer Assignment" push to the linked user.
 *   - `routes/marketing.ts`      — `dispatchCampaign` fires a marketing
 *     push to each eligible recipient when the campaign's channels include
 *     "push".
 *
 * Both paths used to pass the title/body/data as an *object* instead of as
 * positional arguments. That meant `title` was always `undefined` and `body`
 * was an `[object Object]` string at runtime, so the notifications either
 * silently no-op'd or went out malformed. These tests assert the mock is
 * called with the correct positional shape so the regression cannot recur.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

const { sendPushToUsersMock } = vi.hoisted(() => ({
  sendPushToUsersMock: vi.fn(
    async (
      _userIds: number[],
      _title: string,
      _body: string,
      _data?: Record<string, unknown>,
    ) => ({
      attempted: 1, sent: 1, failed: 0, invalid: 0,
    }),
  ),
}));

vi.mock("../lib/push.js", () => ({
  sendPushToUsers: sendPushToUsersMock,
}));

// The marketing /send route fans out emails via `sendBroadcastEmail`. We
// don't want to actually send mail during the smoke test, so stub it.
vi.mock("../lib/mailer.js", () => ({
  sendBroadcastEmail: vi.fn(async () => undefined),
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
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";

const createdOrgIds: number[] = [];
const createdCourseIds: number[] = [];
const createdTournamentIds: number[] = [];
const createdRoleIds: number[] = [];
const createdUserIds: number[] = [];
const createdCampaignIds: number[] = [];

beforeAll(() => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = "test-session-secret-for-push-call-sig-smoke";
  }
});

beforeEach(() => {
  sendPushToUsersMock.mockClear();
});

afterAll(async () => {
  if (createdCampaignIds.length) {
    await db.delete(campaignRecipientsTable).where(inArray(campaignRecipientsTable.campaignId, createdCampaignIds));
    await db.delete(marketingCampaignsTable).where(inArray(marketingCampaignsTable.id, createdCampaignIds));
  }
  if (createdRoleIds.length) {
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
    name: `PushSig_${tag}`,
    slug: `push-sig-${tag}`,
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
    displayName: `Push Sig ${label}`,
    role,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return { id: u.id, username: tag, displayName: `Push Sig ${label}`, role };
}

describe("Task #1462 — push call-site signatures", () => {
  it("event-staffing volunteer assignment dispatches push with positional args", async () => {
    const orgId = await makeOrg("evtstaff");
    const admin = await makeUser("admin_evt", "super_admin");
    const member = await makeUser("vol_member", "player");

    const courseSlug = uid("course");
    const [course] = await db.insert(coursesTable).values({
      organizationId: orgId,
      name: "Push Sig Course",
      slug: courseSlug,
      holes: 18,
      par: 72,
    }).returning({ id: coursesTable.id });
    createdCourseIds.push(course.id);

    const [tournament] = await db.insert(tournamentsTable).values({
      organizationId: orgId,
      courseId: course.id,
      name: "Push Sig Open",
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

    await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/tournaments/${tournament.id}/volunteer-roles/${role.id}/assignments`)
      .send({
        userId: member.id,
        firstName: "Vol",
        lastName: "Member",
      })
      .expect(201);

    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    const [userIds, title, body, data] = sendPushToUsersMock.mock.calls[0]!;
    expect(userIds).toEqual([member.id]);
    expect(title).toBe("Volunteer Assignment");
    expect(typeof body).toBe("string");
    expect(body).toContain("Course Marshal");
    expect(body).toContain("Push Sig Open");
    expect(data).toMatchObject({
      type: "volunteer_assignment",
      tournamentId: tournament.id,
      roleId: role.id,
    });
  });

  it("marketing campaign push channel dispatches push with positional args", async () => {
    const orgId = await makeOrg("mktg");
    const admin = await makeUser("admin_mktg", "super_admin");
    const recipient = await makeUser("mktg_recipient", "player");

    await db.insert(orgMembershipsTable).values({
      organizationId: orgId,
      userId: recipient.id,
      role: "player",
    });

    const [campaign] = await db.insert(marketingCampaignsTable).values({
      organizationId: orgId,
      name: "Push Sig Campaign",
      subject: "Tee Time Tonight",
      bodyHtml: "<p>Don't miss the sunset round.</p>",
      bodyText: "Don't miss the sunset round.",
      channels: ["push"],
      status: "draft",
    }).returning({ id: marketingCampaignsTable.id });
    createdCampaignIds.push(campaign.id);

    await request(createTestApp(admin))
      .post(`/api/organizations/${orgId}/marketing/campaigns/${campaign.id}/send`)
      .send({})
      .expect(200);

    // /send dispatches the campaign asynchronously (fire-and-forget). Poll
    // briefly for the mock to be invoked rather than racing on a fixed sleep.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && sendPushToUsersMock.mock.calls.length === 0) {
      await new Promise(r => setTimeout(r, 25));
    }

    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    const [userIds, title, body, data] = sendPushToUsersMock.mock.calls[0]!;
    expect(userIds).toEqual([recipient.id]);
    expect(title).toBe("Tee Time Tonight");
    expect(typeof body).toBe("string");
    expect(body).toContain("sunset round");
    expect(data).toMatchObject({ campaignId: String(campaign.id) });
  });
});
