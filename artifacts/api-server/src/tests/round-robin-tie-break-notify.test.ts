/**
 * Task #743 — round-robin tie-break required notification.
 *
 * Verifies notifyRoundRobinTieBreak:
 *   - Sends a push to the tournament directors (org_admin and
 *     tournament_director memberships) plus the two tied players.
 *   - Writes an in-app inbox row for each recipient that is also a
 *     club_member of the tournament's organization.
 *   - Honours preferPush=false (excludes the user from the push but still
 *     writes their inbox row when they are a club member).
 *   - Surfaces a deep-link payload with tournamentId / bracketId / matchId
 *     so the mobile/web client can jump directly to the new tie-break
 *     match.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { sendPushToUsersMock, sendRoundRobinTieBreakAlertEmailMock, classifyMailerErrorMock } = vi.hoisted(() => ({
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
  // Task #1502 — classifier is consulted in the email-error catch.
  // Default to "transient" so existing failure tests keep flowing through
  // the standard `failed` path; individual tests override per-call for the
  // provider-not-configured branch.
  classifyMailerErrorMock: vi.fn((_err: unknown) => "transient" as
    | "transient"
    | "provider_unconfigured"
    | "hard_bounce"),
}));

vi.mock("../lib/push.js", () => ({
  sendPushToUsers: sendPushToUsersMock,
}));

vi.mock("../lib/mailer.js", () => ({
  sendRoundRobinTieBreakAlertEmail: sendRoundRobinTieBreakAlertEmailMock,
  classifyMailerError: classifyMailerErrorMock,
}));

import {
  db,
  appUsersTable,
  organizationsTable,
  orgMembershipsTable,
  tournamentsTable,
  coursesTable,
  playersTable,
  matchPlayBracketTable,
  bracketRoundsTable,
  bracketMatchesTable,
  clubMembersTable,
  memberCommPrefsTable,
  memberMessagesTable,
  userNotificationPrefsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { notifyRoundRobinTieBreak } from "../lib/roundRobinTieBreakNotify.js";

let orgId: number;
let tournamentId: number;
let bracketId: number;
let tieBreakMatchId: number;

let directorUserId: number;
let adminUserId: number;
let optedOutDirectorUserId: number;
let player1UserId: number;
let player2UserId: number;
let unrelatedUserId: number;

let player1Id: number;
let player2Id: number;

const userIds: number[] = [];

beforeAll(async () => {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const [org] = await db.insert(organizationsTable).values({
    name: `T743-${ts}`,
    slug: `t743-${ts}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  async function makeUser(tag: string): Promise<number> {
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `t743_${tag}_${ts}`,
      username: `t743_${tag}_${ts}`,
      email: `${tag}_${ts}@example.test`,
      displayName: `T743 ${tag}`,
      role: "player",
    }).returning({ id: appUsersTable.id });
    userIds.push(u.id);
    return u.id;
  }

  directorUserId = await makeUser("dir");
  adminUserId = await makeUser("admin");
  // Task #1044 — give the primary director a non-English preferredLanguage so
  // the test below can assert the caller forwards the per-user locale.
  await db.update(appUsersTable)
    .set({ preferredLanguage: "fr" })
    .where(eq(appUsersTable.id, directorUserId));
  optedOutDirectorUserId = await makeUser("optout_dir");
  player1UserId = await makeUser("p1");
  player2UserId = await makeUser("p2");
  unrelatedUserId = await makeUser("unrelated");

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgId, userId: directorUserId, role: "tournament_director" },
    { organizationId: orgId, userId: adminUserId, role: "org_admin" },
    { organizationId: orgId, userId: optedOutDirectorUserId, role: "tournament_director" },
    // committee_member is intentionally NOT a recipient.
  ]);

  // Director #2 has push opted-out.
  await db.insert(userNotificationPrefsTable).values({
    userId: optedOutDirectorUserId, preferPush: false,
  });

  // Club members for two of the recipients (director and player1) — only
  // they should receive an in-app inbox row.
  await db.insert(clubMembersTable).values([
    { organizationId: orgId, userId: directorUserId, firstName: "Dir", lastName: "T" },
    { organizationId: orgId, userId: player1UserId, firstName: "Tied", lastName: "One" },
  ]);

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId, name: "T743 Course", slug: `t743-course-${ts}`,
  }).returning({ id: coursesTable.id });

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId: course.id,
    name: "T743 RR Cup",
    rounds: 1,
    status: "active",
  }).returning({ id: tournamentsTable.id });
  tournamentId = tournament.id;

  const [p1] = await db.insert(playersTable).values({
    tournamentId, userId: player1UserId, firstName: "Tied", lastName: "One",
  }).returning({ id: playersTable.id });
  player1Id = p1.id;

  const [p2] = await db.insert(playersTable).values({
    tournamentId, userId: player2UserId, firstName: "Tied", lastName: "Two",
  }).returning({ id: playersTable.id });
  player2Id = p2.id;

  const [bracket] = await db.insert(matchPlayBracketTable).values({
    tournamentId, format: "round_robin", tieBreakRule: "sudden_death",
  }).returning({ id: matchPlayBracketTable.id });
  bracketId = bracket.id;

  const [round] = await db.insert(bracketRoundsTable).values({
    bracketId, roundNumber: 99, name: "Tie-Break", bracketType: "main",
  }).returning({ id: bracketRoundsTable.id });

  const [match] = await db.insert(bracketMatchesTable).values({
    bracketId, roundId: round.id, matchNumber: 1, bracketType: "main",
    player1Id, player2Id, result: "pending", holeResults: {},
  }).returning({ id: bracketMatchesTable.id });
  tieBreakMatchId = match.id;
});

afterAll(async () => {
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, orgId));
  await db.delete(bracketMatchesTable).where(eq(bracketMatchesTable.bracketId, bracketId));
  await db.delete(bracketRoundsTable).where(eq(bracketRoundsTable.bracketId, bracketId));
  await db.delete(matchPlayBracketTable).where(eq(matchPlayBracketTable.id, bracketId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, tournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, orgId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgId));
  if (userIds.length > 0) {
    await db.delete(userNotificationPrefsTable).where(inArray(userNotificationPrefsTable.userId, userIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(() => {
  sendPushToUsersMock.mockClear();
  sendRoundRobinTieBreakAlertEmailMock.mockClear();
});

describe("notifyRoundRobinTieBreak", () => {
  it("notifies tournament directors and the two tied players, writes inbox rows for club members, and respects preferPush=false", async () => {
    await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, orgId));

    const result = await notifyRoundRobinTieBreak({
      bracketId, tournamentId, tieBreakMatchId,
      player1Id, player2Id,
    });

    expect(result.status).toBe("sent");
    // Recipients: 2 directors + admin + 2 tied players = 5 (unrelated user excluded).
    expect(result.recipients.sort()).toEqual(
      [directorUserId, adminUserId, optedOutDirectorUserId, player1UserId, player2UserId].sort(),
    );
    expect(result.recipients).not.toContain(unrelatedUserId);

    // Push fan-out: opted-out director must be filtered out.
    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    const [pushUserIds, pushTitle, pushBody, pushData] = sendPushToUsersMock.mock.calls[0];
    expect(pushUserIds.sort()).toEqual(
      [directorUserId, adminUserId, player1UserId, player2UserId].sort(),
    );
    expect(pushUserIds).not.toContain(optedOutDirectorUserId);
    expect(pushTitle).toMatch(/tie-break/i);
    expect(pushBody).toContain("T743 RR Cup");
    expect(pushData).toMatchObject({
      type: "round_robin_tie_break_required",
      tournamentId, bracketId, matchId: tieBreakMatchId,
      organizationId: orgId,
    });

    // Inbox rows: only directorUserId and player1UserId have club_members rows.
    const inbox = await db.select().from(memberMessagesTable)
      .where(eq(memberMessagesTable.organizationId, orgId));
    expect(inbox).toHaveLength(2);
    for (const row of inbox) {
      expect(row.relatedEntity).toBe("round_robin_tie_break");
      expect(row.relatedEntityId).toBe(tieBreakMatchId);
      expect(row.body).toContain("T743 RR Cup");
    }
    expect(result.inApp.written).toBe(2);

    // Email fan-out (Task #898): only directors/admins receive emails — the
    // tied players do not. Push opt-out does NOT carry over to email; the
    // opted-out director still gets the email because preferEmail defaults to true.
    expect(sendRoundRobinTieBreakAlertEmailMock).toHaveBeenCalledTimes(3);
    const emailToAddrs = sendRoundRobinTieBreakAlertEmailMock.mock.calls
      .map(c => (c[0] as { to: string }).to)
      .sort();
    expect(emailToAddrs).toHaveLength(3);
    // Look up the seeded director's email so we can pin the per-user locale
    // assertion below.
    const [dirRow] = await db.select({ email: appUsersTable.email })
      .from(appUsersTable).where(eq(appUsersTable.id, directorUserId));
    const directorEmail = dirRow.email;
    let sawDirectorWithFr = false;
    for (const args of sendRoundRobinTieBreakAlertEmailMock.mock.calls) {
      const opts = args[0] as {
        to: string; tournamentName: string; matchUrl: string; recipientName: string;
        lang?: string | null;
      };
      expect(opts.tournamentName).toBe("T743 RR Cup");
      expect(opts.matchUrl).toContain(`/tournaments/${tournamentId}`);
      expect(opts.matchUrl).toContain(`/matches/${tieBreakMatchId}`);
      // Task #1044 — caller must propagate the recipient's preferred language
      // so the mailer can render the email in their locale.
      expect(opts).toHaveProperty("lang");
      if (opts.to === directorEmail) {
        // The director was seeded with preferredLanguage="fr" — the mailer
        // call for that director MUST receive the same value.
        expect(opts.lang).toBe("fr");
        sawDirectorWithFr = true;
      }
    }
    expect(sawDirectorWithFr).toBe(true);
    expect(result.email.attempted).toBe(3);
    expect(result.email.sent).toBe(3);
    expect(result.email.bounced).toBe(0);
  });

  it("skips email for directors with preferEmail=false and counts a bounced delivery", async () => {
    await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, orgId));

    // Director #2 (admin): opt-out of email entirely.
    await db.insert(userNotificationPrefsTable).values({
      userId: adminUserId, preferEmail: false,
    });

    // Make the next email send fail to verify bounce accounting.
    sendRoundRobinTieBreakAlertEmailMock.mockImplementationOnce(async () => {
      throw new Error("smtp_bounce");
    });

    const result = await notifyRoundRobinTieBreak({
      bracketId, tournamentId, tieBreakMatchId,
      player1Id, player2Id,
    });

    // adminUserId is excluded from email, so 2 attempts (directorUserId + optedOutDirectorUserId).
    expect(result.email.attempted).toBe(2);
    expect(result.email.sent + result.email.bounced).toBe(2);
    expect(result.email.bounced).toBe(1);

    const [adminUser] = await db.select({ email: appUsersTable.email })
      .from(appUsersTable).where(eq(appUsersTable.id, adminUserId));
    const sentToAdmin = sendRoundRobinTieBreakAlertEmailMock.mock.calls.some(c =>
      (c[0] as { to: string }).to === adminUser.email
    );
    expect(sentToAdmin).toBe(false);

    // Cleanup the pref so other tests are unaffected.
    await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, adminUserId));
  });

  it("excludes a director who disabled the per-category 'tournaments' email opt-in", async () => {
    await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, orgId));

    // directorUserId already has a club_members row in this org (set up in beforeAll).
    const [member] = await db.select({ id: clubMembersTable.id })
      .from(clubMembersTable)
      .where(and(
        eq(clubMembersTable.organizationId, orgId),
        eq(clubMembersTable.userId, directorUserId),
      ));
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: member.id,
      organizationId: orgId,
      category: "tournaments",
      emailEnabled: false,
    });

    const result = await notifyRoundRobinTieBreak({
      bracketId, tournamentId, tieBreakMatchId,
      player1Id, player2Id,
    });

    // 3 directors total; directorUserId opted out via member-comm prefs ⇒ 2 attempts.
    expect(result.email.attempted).toBe(2);
    expect(result.email.sent).toBe(2);
    expect(result.email.bounced).toBe(0);

    const [dirUser] = await db.select({ email: appUsersTable.email })
      .from(appUsersTable).where(eq(appUsersTable.id, directorUserId));
    const sentToDir = sendRoundRobinTieBreakAlertEmailMock.mock.calls.some(c =>
      (c[0] as { to: string }).to === dirUser.email
    );
    expect(sentToDir).toBe(false);

    // Cleanup.
    await db.delete(memberCommPrefsTable).where(eq(memberCommPrefsTable.clubMemberId, member.id));
  });

  // Task #1502 / Task #1850 — provider_unconfigured branch (lib line 342).
  // The fan-out loop must classify a misconfigured mailer as an env-wide
  // condition: decrement the speculative `email.attempted` counter (since
  // the recipient was never actually billed an attempt) and `break` out
  // of the loop so subsequent recipients aren't logged as N separate
  // bounces for the same env issue. We assert that:
  //   1. only the FIRST send was attempted (the loop broke), and
  //   2. NO warn line was emitted (the silent-skip contract).
  // Push still fans out independently because it owns its own try/catch.
  it("provider_unconfigured: breaks out of the email loop after the first throw and emits no warn line", async () => {
    await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, orgId));

    const { logger } = await import("../lib/logger.js");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    classifyMailerErrorMock.mockReturnValueOnce("provider_unconfigured");
    sendRoundRobinTieBreakAlertEmailMock.mockImplementationOnce(async () => {
      throw new Error("SMTP host not configured");
    });

    try {
      const result = await notifyRoundRobinTieBreak({
        bracketId, tournamentId, tieBreakMatchId,
        player1Id, player2Id,
      });

      // Exactly one send was attempted; the helper broke out of the loop
      // before billing the next director(s) for the same env issue.
      expect(sendRoundRobinTieBreakAlertEmailMock).toHaveBeenCalledTimes(1);
      // attempted was decremented back to 0 for that recipient since it
      // never genuinely landed an attempt — the env was the problem.
      expect(result.email.attempted).toBe(0);
      expect(result.email.sent).toBe(0);
      expect(result.email.bounced).toBe(0);

      // No warn line for the provider_unconfigured branch — admins
      // shouldn't see N copies of the same env-config alert per fan-out.
      const provWarnCalls = warnSpy.mock.calls.filter(args => {
        const ctx = args[0] as { errMsg?: string } | undefined;
        const msg = (typeof args[1] === "string" ? args[1] : "");
        return msg.includes("[rr-tiebreak-notify]")
          || (ctx?.errMsg ?? "").includes("SMTP host not configured");
      });
      expect(provWarnCalls).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns skipped with no_recipients when org has no directors and tied players have no linked users", async () => {
    // Use a brand-new org/tournament with no memberships and players with no userId.
    const ts2 = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const [org2] = await db.insert(organizationsTable).values({
      name: `T743b-${ts2}`, slug: `t743b-${ts2}`,
    }).returning({ id: organizationsTable.id });
    const [course2] = await db.insert(coursesTable).values({
      organizationId: org2.id, name: "T743b Course", slug: `t743b-course-${ts2}`,
    }).returning({ id: coursesTable.id });
    const [t2] = await db.insert(tournamentsTable).values({
      organizationId: org2.id, courseId: course2.id, name: "Lonely RR", rounds: 1,
    }).returning({ id: tournamentsTable.id });
    const [pa] = await db.insert(playersTable).values({
      tournamentId: t2.id, firstName: "A", lastName: "X",
    }).returning({ id: playersTable.id });
    const [pb] = await db.insert(playersTable).values({
      tournamentId: t2.id, firstName: "B", lastName: "Y",
    }).returning({ id: playersTable.id });
    const [b2] = await db.insert(matchPlayBracketTable).values({
      tournamentId: t2.id, format: "round_robin", tieBreakRule: "sudden_death",
    }).returning({ id: matchPlayBracketTable.id });
    const [r2] = await db.insert(bracketRoundsTable).values({
      bracketId: b2.id, roundNumber: 1, name: "Tie-Break", bracketType: "main",
    }).returning({ id: bracketRoundsTable.id });
    const [m2] = await db.insert(bracketMatchesTable).values({
      bracketId: b2.id, roundId: r2.id, matchNumber: 1, bracketType: "main",
      player1Id: pa.id, player2Id: pb.id, result: "pending", holeResults: {},
    }).returning({ id: bracketMatchesTable.id });

    const result = await notifyRoundRobinTieBreak({
      bracketId: b2.id, tournamentId: t2.id, tieBreakMatchId: m2.id,
      player1Id: pa.id, player2Id: pb.id,
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_recipients");
    expect(sendPushToUsersMock).not.toHaveBeenCalled();

    // Cleanup.
    await db.delete(bracketMatchesTable).where(eq(bracketMatchesTable.bracketId, b2.id));
    await db.delete(bracketRoundsTable).where(eq(bracketRoundsTable.bracketId, b2.id));
    await db.delete(matchPlayBracketTable).where(eq(matchPlayBracketTable.id, b2.id));
    await db.delete(playersTable).where(eq(playersTable.tournamentId, t2.id));
    await db.delete(tournamentsTable).where(eq(tournamentsTable.id, t2.id));
    await db.delete(coursesTable).where(eq(coursesTable.id, course2.id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, org2.id));
  });
});
