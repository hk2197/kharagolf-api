/**
 * Task #1045 — directors can unsubscribe from the tie-break required email
 * with one click.
 *
 * Coverage:
 *   - HMAC-signed (userId, orgId) token round-trips and rejects tampering.
 *   - GET and POST /api/public/tie-break-email-unsubscribe insert a per-(org,
 *     user) opt-out row, are idempotent, and reject bad tokens.
 *   - GET /api/public/tie-break-email-resubscribe clears the row and is
 *     idempotent.
 *   - The portal email-subscriptions catalog surfaces
 *     `round_robin_tie_break_email`, and a click here suppresses the email
 *     in the next `notifyRoundRobinTieBreak` fan-out.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

const { sendPushToUsersMock, sendRoundRobinTieBreakAlertEmailMock } = vi.hoisted(() => ({
  sendPushToUsersMock: vi.fn(
    async (
      userIds: number[],
      _title: string,
      _body: string,
      _data?: Record<string, unknown>,
    ) => ({
      attempted: userIds.length,
      sent: userIds.length,
      failed: 0,
      invalid: 0,
    }),
  ),
  sendRoundRobinTieBreakAlertEmailMock: vi.fn(async (_opts: unknown) => undefined),
}));

vi.mock("../lib/push.js", () => ({
  sendPushToUsers: sendPushToUsersMock,
}));

vi.mock("../lib/mailer.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/mailer.js")>("../lib/mailer.js");
  return {
    ...actual,
    sendRoundRobinTieBreakAlertEmail: sendRoundRobinTieBreakAlertEmailMock,
  };
});

import {
  db,
  organizationsTable,
  appUsersTable,
  orgRoleEnum,
  orgMembershipsTable,
  tournamentsTable,
  coursesTable,
  playersTable,
  matchPlayBracketTable,
  bracketRoundsTable,
  bracketMatchesTable,
  roundRobinTieBreakEmailOptOutsTable,
  memberMessagesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

import { createTestApp, type TestUser, uid } from "./helpers.js";
import {
  signTieBreakEmailOptOutToken,
  verifyTieBreakEmailOptOutToken,
  signBouncedDigestScheduleOptOutToken,
  verifyBouncedDigestScheduleOptOutToken,
} from "../lib/bouncedDigestUnsubscribe.js";
import { notifyRoundRobinTieBreak } from "../lib/roundRobinTieBreakNotify.js";

type OrgRole = (typeof orgRoleEnum.enumValues)[number];

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const createdTournamentIds: number[] = [];
const createdCourseIds: number[] = [];

beforeAll(() => {
  if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = "test-session-secret-for-tie-break-opt-out";
});

async function makeOrg(label: string): Promise<number> {
  const tag = uid(label);
  const [o] = await db.insert(organizationsTable).values({
    name: `TBOpt_${tag}`,
    slug: `tbopt-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(o.id);
  return o.id;
}

async function makeUser(orgId: number | null, role: OrgRole): Promise<TestUser> {
  const tag = uid(role);
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: `${tag}@test.local`,
    displayName: role,
    role,
    organizationId: role === "org_admin" ? orgId : null,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return {
    id: u.id,
    username: tag,
    displayName: role,
    role,
    organizationId: role === "org_admin" ? (orgId ?? undefined) : undefined,
  };
}

afterAll(async () => {
  if (createdTournamentIds.length) {
    await db.delete(memberMessagesTable).where(inArray(memberMessagesTable.organizationId, createdOrgIds));
    await db.delete(bracketMatchesTable).where(inArray(bracketMatchesTable.bracketId,
      (await db.select({ id: matchPlayBracketTable.id }).from(matchPlayBracketTable)
        .where(inArray(matchPlayBracketTable.tournamentId, createdTournamentIds))).map(r => r.id)));
    await db.delete(bracketRoundsTable).where(inArray(bracketRoundsTable.bracketId,
      (await db.select({ id: matchPlayBracketTable.id }).from(matchPlayBracketTable)
        .where(inArray(matchPlayBracketTable.tournamentId, createdTournamentIds))).map(r => r.id)));
    await db.delete(matchPlayBracketTable).where(inArray(matchPlayBracketTable.tournamentId, createdTournamentIds));
    await db.delete(playersTable).where(inArray(playersTable.tournamentId, createdTournamentIds));
    await db.delete(tournamentsTable).where(inArray(tournamentsTable.id, createdTournamentIds));
  }
  if (createdCourseIds.length) {
    await db.delete(coursesTable).where(inArray(coursesTable.id, createdCourseIds));
  }
  if (createdUserIds.length) {
    await db.delete(roundRobinTieBreakEmailOptOutsTable).where(inArray(roundRobinTieBreakEmailOptOutsTable.userId, createdUserIds));
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

beforeEach(() => {
  sendPushToUsersMock.mockClear();
  sendRoundRobinTieBreakAlertEmailMock.mockClear();
});

describe("tie-break email opt-out token", () => {
  it("round-trips a signed (userId, orgId) token", () => {
    const t = signTieBreakEmailOptOutToken(42, 7);
    expect(verifyTieBreakEmailOptOutToken(t)).toEqual({ userId: 42, orgId: 7 });
  });

  it("rejects tampered, malformed, and empty tokens", () => {
    expect(verifyTieBreakEmailOptOutToken("")).toBeNull();
    expect(verifyTieBreakEmailOptOutToken("not-a-token")).toBeNull();
    const t = signTieBreakEmailOptOutToken(1, 2);
    const flipped = t.slice(0, -2) + (t.endsWith("aa") ? "bb" : "aa");
    expect(verifyTieBreakEmailOptOutToken(flipped)).toBeNull();
  });

  it("does not accept a bounced-digest token (distinct namespace)", () => {
    const bd = signBouncedDigestScheduleOptOutToken(42, 7);
    expect(verifyTieBreakEmailOptOutToken(bd)).toBeNull();
    const tb = signTieBreakEmailOptOutToken(42, 7);
    expect(verifyBouncedDigestScheduleOptOutToken(tb)).toBeNull();
  });
});

describe("GET/POST /api/public/tie-break-email-unsubscribe", () => {
  it("records an opt-out row for a valid GET token and is idempotent", async () => {
    const orgId = await makeOrg("public_unsub");
    const user = await makeUser(orgId, "org_admin");
    const token = signTieBreakEmailOptOutToken(user.id, orgId);

    const res = await request(createTestApp())
      .get(`/api/public/tie-break-email-unsubscribe?token=${encodeURIComponent(token)}`)
      .expect(200);
    expect(res.text).toMatch(/unsubscribed/i);
    expect(res.text).toContain(`/api/public/tie-break-email-resubscribe?token=${encodeURIComponent(token)}`);

    const rows = await db.select().from(roundRobinTieBreakEmailOptOutsTable).where(and(
      eq(roundRobinTieBreakEmailOptOutsTable.organizationId, orgId),
      eq(roundRobinTieBreakEmailOptOutsTable.userId, user.id),
    ));
    expect(rows).toHaveLength(1);

    await request(createTestApp())
      .get(`/api/public/tie-break-email-unsubscribe?token=${encodeURIComponent(token)}`)
      .expect(200);
    const rowsAfter = await db.select().from(roundRobinTieBreakEmailOptOutsTable).where(and(
      eq(roundRobinTieBreakEmailOptOutsTable.organizationId, orgId),
      eq(roundRobinTieBreakEmailOptOutsTable.userId, user.id),
    ));
    expect(rowsAfter).toHaveLength(1);
  });

  it("accepts a POST one-click unsubscribe (RFC 8058)", async () => {
    const orgId = await makeOrg("public_unsub_post");
    const user = await makeUser(orgId, "org_admin");
    const token = signTieBreakEmailOptOutToken(user.id, orgId);

    await request(createTestApp())
      .post(`/api/public/tie-break-email-unsubscribe?token=${encodeURIComponent(token)}`)
      .expect(200);

    const rows = await db.select().from(roundRobinTieBreakEmailOptOutsTable).where(and(
      eq(roundRobinTieBreakEmailOptOutsTable.organizationId, orgId),
      eq(roundRobinTieBreakEmailOptOutsTable.userId, user.id),
    ));
    expect(rows).toHaveLength(1);
  });

  it("rejects an invalid token without writing anything", async () => {
    const before = await db.select().from(roundRobinTieBreakEmailOptOutsTable);
    const res = await request(createTestApp())
      .get(`/api/public/tie-break-email-unsubscribe?token=garbage`)
      .expect(400);
    expect(res.text).toMatch(/invalid/i);
    const after = await db.select().from(roundRobinTieBreakEmailOptOutsTable);
    expect(after.length).toBe(before.length);
  });
});

describe("GET /api/public/tie-break-email-resubscribe", () => {
  it("clears the opt-out for a valid token and is idempotent", async () => {
    const orgId = await makeOrg("public_resub");
    const user = await makeUser(orgId, "org_admin");
    await db.insert(roundRobinTieBreakEmailOptOutsTable).values({
      organizationId: orgId, userId: user.id,
    });
    const token = signTieBreakEmailOptOutToken(user.id, orgId);

    const res = await request(createTestApp())
      .get(`/api/public/tie-break-email-resubscribe?token=${encodeURIComponent(token)}`)
      .expect(200);
    expect(res.text).toMatch(/re-subscribed/i);

    const rows = await db.select().from(roundRobinTieBreakEmailOptOutsTable).where(and(
      eq(roundRobinTieBreakEmailOptOutsTable.organizationId, orgId),
      eq(roundRobinTieBreakEmailOptOutsTable.userId, user.id),
    ));
    expect(rows).toHaveLength(0);

    await request(createTestApp())
      .get(`/api/public/tie-break-email-resubscribe?token=${encodeURIComponent(token)}`)
      .expect(200);
  });
});

describe("portal email-subscriptions surfaces tie-break email", () => {
  it("lists the new emailType and toggling it updates the underlying row", async () => {
    const orgId = await makeOrg("portal_catalog");
    const admin = await makeUser(orgId, "org_admin");
    await db.insert(orgMembershipsTable).values({
      organizationId: orgId, userId: admin.id, role: "org_admin",
    });

    const list = await request(createTestApp(admin))
      .get(`/api/portal/email-subscriptions`)
      .expect(200);
    const types = (list.body.types as Array<{ key: string }>).map(t => t.key);
    expect(types).toContain("round_robin_tie_break_email");

    const sub = (list.body.subscriptions as Array<{ orgId: number; emailType: string; optedOut: boolean }>)
      .find(s => s.orgId === orgId && s.emailType === "round_robin_tie_break_email");
    expect(sub?.optedOut).toBe(false);

    await request(createTestApp(admin))
      .post(`/api/portal/email-subscriptions/unsubscribe`)
      .send({ orgId, emailType: "round_robin_tie_break_email" })
      .expect(204);

    const rows = await db.select().from(roundRobinTieBreakEmailOptOutsTable).where(and(
      eq(roundRobinTieBreakEmailOptOutsTable.organizationId, orgId),
      eq(roundRobinTieBreakEmailOptOutsTable.userId, admin.id),
    ));
    expect(rows).toHaveLength(1);

    await request(createTestApp(admin))
      .post(`/api/portal/email-subscriptions/resubscribe`)
      .send({ orgId, emailType: "round_robin_tie_break_email" })
      .expect(204);

    const rowsAfter = await db.select().from(roundRobinTieBreakEmailOptOutsTable).where(and(
      eq(roundRobinTieBreakEmailOptOutsTable.organizationId, orgId),
      eq(roundRobinTieBreakEmailOptOutsTable.userId, admin.id),
    ));
    expect(rowsAfter).toHaveLength(0);
  });
});

describe("sendRoundRobinTieBreakAlertEmail propagates List-Unsubscribe headers", () => {
  it("forwards List-Unsubscribe / List-Unsubscribe-Post through to the active mail provider", async () => {
    // Use a fresh dynamic import of the (real) mailer + adapter so the
    // module-level vi.mock above (which intercepts the named export
    // `sendRoundRobinTieBreakAlertEmail`) does not also intercept the
    // adapter call. We spy on the active provider's `send` and assert the
    // RFC 2369 headers reach it verbatim.
    const adapter = await vi.importActual<typeof import("../lib/email/adapter.js")>("../lib/email/adapter.js");
    const realMailer = await vi.importActual<typeof import("../lib/mailer.js")>("../lib/mailer.js");
    const provider = adapter.getActiveMailProvider();
    const sendSpy = vi.spyOn(provider, "send")
      .mockResolvedValue({ ok: true, provider: provider.name });
    const isConfiguredSpy = vi.spyOn(provider, "isConfigured").mockReturnValue(true);
    try {
      await realMailer.sendRoundRobinTieBreakAlertEmail({
        to: "director@example.test",
        recipientName: "Dir",
        tournamentName: "Header Test Cup",
        matchUrl: "https://app.kharagolf.com/m/1",
        unsubscribeUrl: "https://app.kharagolf.com/api/public/tie-break-email-unsubscribe?token=abc",
      });
      expect(sendSpy).toHaveBeenCalledTimes(1);
      const sent = sendSpy.mock.calls[0][0];
      expect(sent.extraHeaders).toBeDefined();
      expect(sent.extraHeaders!["List-Unsubscribe"]).toBe(
        "<https://app.kharagolf.com/api/public/tie-break-email-unsubscribe?token=abc>",
      );
      expect(sent.extraHeaders!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    } finally {
      sendSpy.mockRestore();
      isConfiguredSpy.mockRestore();
    }
  });
});

describe("notifyRoundRobinTieBreak respects the per-(org, user) opt-out", () => {
  it("skips an opted-out director's email but still pushes; sends to the other directors with a signed unsubscribe URL", async () => {
    const orgId = await makeOrg("notify_optout");
    const dir1 = await makeUser(orgId, "player");
    const dir2 = await makeUser(orgId, "player");
    await db.insert(orgMembershipsTable).values([
      { organizationId: orgId, userId: dir1.id, role: "tournament_director" },
      { organizationId: orgId, userId: dir2.id, role: "tournament_director" },
    ]);
    // dir1 has opted out of the tie-break email for this org.
    await db.insert(roundRobinTieBreakEmailOptOutsTable).values({
      organizationId: orgId, userId: dir1.id,
    });

    const tag = uid("c");
    const [course] = await db.insert(coursesTable).values({
      organizationId: orgId, name: `TBOpt Course ${tag}`, slug: `tbopt-course-${tag}`.toLowerCase(),
    }).returning({ id: coursesTable.id });
    createdCourseIds.push(course.id);
    const [tournament] = await db.insert(tournamentsTable).values({
      organizationId: orgId, courseId: course.id, name: "TBOpt RR Cup", rounds: 1, status: "active",
    }).returning({ id: tournamentsTable.id });
    createdTournamentIds.push(tournament.id);
    const [p1] = await db.insert(playersTable).values({
      tournamentId: tournament.id, firstName: "P", lastName: "One",
    }).returning({ id: playersTable.id });
    const [p2] = await db.insert(playersTable).values({
      tournamentId: tournament.id, firstName: "P", lastName: "Two",
    }).returning({ id: playersTable.id });
    const [bracket] = await db.insert(matchPlayBracketTable).values({
      tournamentId: tournament.id, format: "round_robin", tieBreakRule: "sudden_death",
    }).returning({ id: matchPlayBracketTable.id });
    const [round] = await db.insert(bracketRoundsTable).values({
      bracketId: bracket.id, roundNumber: 1, name: "Tie-Break", bracketType: "main",
    }).returning({ id: bracketRoundsTable.id });
    const [match] = await db.insert(bracketMatchesTable).values({
      bracketId: bracket.id, roundId: round.id, matchNumber: 1, bracketType: "main",
      player1Id: p1.id, player2Id: p2.id, result: "pending", holeResults: {},
    }).returning({ id: bracketMatchesTable.id });

    const result = await notifyRoundRobinTieBreak({
      bracketId: bracket.id,
      tournamentId: tournament.id,
      tieBreakMatchId: match.id,
      player1Id: p1.id, player2Id: p2.id,
    });

    // dir1 is opted out of the email but still receives push.
    expect(result.email.attempted).toBe(1);
    expect(result.email.sent).toBe(1);
    const sentTos = sendRoundRobinTieBreakAlertEmailMock.mock.calls.map(
      c => (c[0] as { to: string }).to,
    );
    const dir1Email = (await db.select({ email: appUsersTable.email })
      .from(appUsersTable).where(eq(appUsersTable.id, dir1.id)))[0].email;
    const dir2Email = (await db.select({ email: appUsersTable.email })
      .from(appUsersTable).where(eq(appUsersTable.id, dir2.id)))[0].email;
    expect(sentTos).not.toContain(dir1Email);
    expect(sentTos).toContain(dir2Email);

    // The email that DID get sent carries a signed unsubscribe URL pointing
    // at the public route, and the token decodes back to (dir2.id, orgId).
    const sentArgs = sendRoundRobinTieBreakAlertEmailMock.mock.calls[0][0] as {
      unsubscribeUrl?: string;
    };
    expect(sentArgs.unsubscribeUrl).toBeTruthy();
    const url = new URL(sentArgs.unsubscribeUrl!);
    expect(url.pathname).toBe("/api/public/tie-break-email-unsubscribe");
    const token = url.searchParams.get("token") ?? "";
    expect(verifyTieBreakEmailOptOutToken(token)).toEqual({ userId: dir2.id, orgId });

    // Push fan-out is unaffected by the email opt-out.
    const [pushUserIds] = sendPushToUsersMock.mock.calls[0];
    expect((pushUserIds as number[]).sort()).toEqual([dir1.id, dir2.id].sort());
  });
});
