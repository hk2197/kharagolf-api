/**
 * Task #1214 — Pin the contract for the combined badge-count endpoint
 * that powers every More-menu badge in the mobile app.
 *
 *   GET /api/portal/badge-counts
 *
 * Response shape (one round-trip replaces 5+ legacy fan-out calls):
 *   {
 *     notifications,    // unread handicap-committee notifications
 *     announcements,    // tournament announcements newer than the
 *                       //   client's last-seen marker (or full backlog
 *                       //   when announcementsSince is omitted/0)
 *     peerInvites,      // pending peer-review invitations
 *     notices,          // unread notice-board articles in the active org
 *     feedSinceTs,      // org feed posts since the client's last visit
 *                       //   (deliberately 0 when feedSince is omitted/0
 *                       //   so first-visit doesn't flood the badge)
 *     walletPending,    // pending wallet withdrawals in the active org
 *   }
 *
 * Filtering rules covered:
 *   • orgId membership is required for the org-scoped rows; passing an
 *     orgId the caller is not a member of silently scopes those rows to
 *     zero (no leak).
 *   • announcements obeys the `announcementsSince` threshold; with
 *     since=0 (first sync) every enrolled-tournament announcement counts
 *     as unread.
 *   • feed obeys the `feedSince` threshold; with since=0 (first visit)
 *     the count is 0 even when posts exist.
 *   • walletPending only counts pending|processing|dispatch_unknown.
 *   • notice board honours published / scheduled-in-the-past / read-by
 *     filtering.
 *   • peer invites only count rows with no respondedAt, no seenAt, and
 *     either no expiry or expiry in the future.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  coursesTable,
  tournamentsTable,
  playersTable,
  tournamentAnnouncementsTable,
  handicapCaseNotificationsTable,
  handicapReviewCasesTable,
  handicapCasePeerReviewsTable,
  noticeBoardArticlesTable,
  noticeBoardReadsTable,
  feedPostsTable,
  clubWalletsTable,
  clubWalletWithdrawalsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "../../tests/helpers.js";

let orgId: number;
let otherOrgId: number;
let callerUserId: number;
let callerWalletId: number;
let courseId: number;
let tournamentId: number;
let caseId: number;
const callerEmail = `caller_${Date.now()}@badge-counts.test`;

// Reference timestamps for the "since" thresholds.
const ANNOUNCEMENTS_SINCE_MS = Date.UTC(2026, 0, 10, 12, 0, 0); // Jan 10 2026
const FEED_SINCE_MS = Date.UTC(2026, 0, 15, 12, 0, 0);          // Jan 15 2026
const BEFORE_ANNOUNCEMENTS_MS = ANNOUNCEMENTS_SINCE_MS - 60_000;
const AFTER_ANNOUNCEMENTS_MS = ANNOUNCEMENTS_SINCE_MS + 60_000;
const BEFORE_FEED_MS = FEED_SINCE_MS - 60_000;
const AFTER_FEED_MS = FEED_SINCE_MS + 60_000;

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Caller's home org — the one we pass via ?orgId=. Use enterprise so the
  // mobileApp feature gate is unambiguously satisfied.
  const [org] = await db.insert(organizationsTable).values({
    name: `T1214_${stamp}`, slug: `t1214-${stamp}`, subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  // A second org the caller is NOT a member of — used to assert the
  // "non-member orgId silently falls back to zero" branch.
  const [otherOrg] = await db.insert(organizationsTable).values({
    name: `T1214_other_${stamp}`, slug: `t1214-other-${stamp}`, subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  otherOrgId = otherOrg.id;

  const [caller] = await db.insert(appUsersTable).values({
    replitUserId: `t1214-caller-${stamp}`,
    username: `t1214_caller_${stamp}`,
    email: callerEmail,
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  callerUserId = caller.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: callerUserId, role: "player",
  });

  // Tournament + enrollment so the announcements join finds the caller.
  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId, name: "T1214 Course",
    slug: `t1214-course-${stamp}`, holes: 18, par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId, courseId, name: `T1214 Tournament ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  tournamentId = tournament.id;

  await db.insert(playersTable).values({
    tournamentId, userId: callerUserId,
    firstName: "Cal", lastName: "Ler", email: callerEmail,
  });

  // ── Notifications ────────────────────────────────────────────────────
  // Two unread + one already-read for the caller (only the unread
  // count should be returned). One unread for an unrelated user (must
  // not leak into the caller's count).
  const [otherForNotifs] = await db.insert(appUsersTable).values({
    replitUserId: `t1214-otherNotifs-${stamp}`,
    username: `t1214_othernotifs_${stamp}`,
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });

  const [reviewCase] = await db.insert(handicapReviewCasesTable).values({
    organizationId: orgId,
    subjectUserId: callerUserId,
    kind: "anomalous",
    status: "open",
  }).returning({ id: handicapReviewCasesTable.id });
  caseId = reviewCase.id;

  await db.insert(handicapCaseNotificationsTable).values([
    { subjectUserId: callerUserId, caseId, organizationId: orgId,
      event: "opened", title: "Case opened", body: "..." },
    { subjectUserId: callerUserId, caseId, organizationId: orgId,
      event: "decided", title: "Case decided", body: "..." },
    { subjectUserId: callerUserId, caseId, organizationId: orgId,
      event: "closed", title: "Already read", body: "...",
      readAt: new Date() },
    { subjectUserId: otherForNotifs.id, caseId, organizationId: orgId,
      event: "opened", title: "Other user", body: "..." },
  ]);

  // ── Tournament announcements ─────────────────────────────────────────
  // 3 announcements — one before the threshold, two after. With
  // announcementsSince=ANNOUNCEMENTS_SINCE_MS the count should be 2;
  // with since=0 the count should be 3 (full backlog).
  await db.insert(tournamentAnnouncementsTable).values([
    { tournamentId, body: "old announcement",
      sentAt: new Date(BEFORE_ANNOUNCEMENTS_MS) },
    { tournamentId, body: "fresh announcement #1",
      sentAt: new Date(AFTER_ANNOUNCEMENTS_MS) },
    { tournamentId, body: "fresh announcement #2",
      sentAt: new Date(AFTER_ANNOUNCEMENTS_MS + 5_000) },
  ]);

  // Announcement on a tournament the caller is NOT enrolled in — must
  // never leak into the caller's count.
  const [otherTournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId, courseId, name: `T1214 Other Tournament ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  await db.insert(tournamentAnnouncementsTable).values({
    tournamentId: otherTournament.id, body: "stranger's announcement",
    sentAt: new Date(AFTER_ANNOUNCEMENTS_MS),
  });

  // ── Peer invites ────────────────────────────────────────────────────
  // Four reviewer rows for the caller, only one of which is "actionable":
  //   • active   — neither responded nor seen, no expiry          → counts
  //   • seen     — opened the inbox card, no response yet         → skipped
  //   • answered — already submitted a recommendation             → skipped
  //   • expired  — expiry in the past                             → skipped
  // Plus one row for an unrelated reviewer that must not leak in.
  const [otherReviewer] = await db.insert(appUsersTable).values({
    replitUserId: `t1214-otherReviewer-${stamp}`,
    username: `t1214_otherreviewer_${stamp}`,
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });

  await db.insert(handicapCasePeerReviewsTable).values([
    { caseId, reviewerUserId: callerUserId,
      token: `tok_active_${stamp}` },
    { caseId, reviewerUserId: callerUserId,
      token: `tok_seen_${stamp}`, seenAt: new Date() },
    { caseId, reviewerUserId: callerUserId,
      token: `tok_answered_${stamp}`, respondedAt: new Date(),
      recommendation: "confirm" },
    { caseId, reviewerUserId: callerUserId,
      token: `tok_expired_${stamp}`,
      expiresAt: new Date(Date.now() - 60_000) },
    { caseId, reviewerUserId: otherReviewer.id,
      token: `tok_other_${stamp}` },
  ]);

  // ── Notice-board articles ───────────────────────────────────────────
  // Five articles in the caller's org:
  //   • published, unread                     → counts
  //   • scheduled, publishAt in the past, unread → counts
  //   • scheduled, publishAt in the future, unread → skipped
  //   • published, but already read by caller → skipped
  //   • draft (never visible)                 → skipped
  // Plus one published article in *another* org — must not leak in.
  const [a1] = await db.insert(noticeBoardArticlesTable).values({
    organizationId: orgId, title: "Published / unread",
    body: "...", status: "published",
  }).returning({ id: noticeBoardArticlesTable.id });

  await db.insert(noticeBoardArticlesTable).values({
    organizationId: orgId, title: "Scheduled (past) / unread",
    body: "...", status: "scheduled",
    publishAt: new Date(Date.now() - 60_000),
  });

  await db.insert(noticeBoardArticlesTable).values({
    organizationId: orgId, title: "Scheduled (future) / unread",
    body: "...", status: "scheduled",
    publishAt: new Date(Date.now() + 60 * 60_000),
  });

  const [a4] = await db.insert(noticeBoardArticlesTable).values({
    organizationId: orgId, title: "Published / already read",
    body: "...", status: "published",
  }).returning({ id: noticeBoardArticlesTable.id });
  await db.insert(noticeBoardReadsTable).values({
    articleId: a4.id, userId: callerUserId,
  });

  await db.insert(noticeBoardArticlesTable).values({
    organizationId: orgId, title: "Draft", body: "...", status: "draft",
  });

  await db.insert(noticeBoardArticlesTable).values({
    organizationId: otherOrgId, title: "Stranger org notice",
    body: "...", status: "published",
  });
  // Touch a1 just so eslint doesn't complain it's unused.
  void a1;

  // ── Feed posts ──────────────────────────────────────────────────────
  // 4 posts in the caller's org:
  //   • after feedSince, visible            → counts
  //   • after feedSince, hidden             → skipped (isHidden)
  //   • before feedSince, visible           → skipped (too old)
  //   • another after-feedSince visible     → counts (so total = 2)
  // Plus one post in another org — must not leak in.
  await db.insert(feedPostsTable).values([
    { organizationId: orgId, body: "fresh visible #1",
      createdAt: new Date(AFTER_FEED_MS) },
    { organizationId: orgId, body: "fresh hidden", isHidden: true,
      createdAt: new Date(AFTER_FEED_MS + 1_000) },
    { organizationId: orgId, body: "old visible",
      createdAt: new Date(BEFORE_FEED_MS) },
    { organizationId: orgId, body: "fresh visible #2",
      createdAt: new Date(AFTER_FEED_MS + 2_000) },
    { organizationId: otherOrgId, body: "stranger org post",
      createdAt: new Date(AFTER_FEED_MS) },
  ]);

  // ── Wallet withdrawals ──────────────────────────────────────────────
  // 5 withdrawals for the caller × org. Only pending|processing|
  // dispatch_unknown should count toward walletPending.
  const [wallet] = await db.insert(clubWalletsTable).values({
    organizationId: orgId, userId: callerUserId, currency: "INR",
  }).returning({ id: clubWalletsTable.id });
  callerWalletId = wallet.id;

  await db.insert(clubWalletWithdrawalsTable).values([
    { walletId: callerWalletId, organizationId: orgId, userId: callerUserId,
      amount: "100.00", method: "upi", status: "pending" },
    { walletId: callerWalletId, organizationId: orgId, userId: callerUserId,
      amount: "100.00", method: "upi", status: "processing" },
    { walletId: callerWalletId, organizationId: orgId, userId: callerUserId,
      amount: "100.00", method: "upi", status: "dispatch_unknown" },
    { walletId: callerWalletId, organizationId: orgId, userId: callerUserId,
      amount: "100.00", method: "upi", status: "processed" },
    { walletId: callerWalletId, organizationId: orgId, userId: callerUserId,
      amount: "100.00", method: "upi", status: "cancelled" },
  ]);
});

afterAll(async () => {
  await db.delete(clubWalletWithdrawalsTable)
    .where(eq(clubWalletWithdrawalsTable.walletId, callerWalletId));
  await db.delete(clubWalletsTable)
    .where(eq(clubWalletsTable.id, callerWalletId));
  await db.delete(feedPostsTable)
    .where(inArray(feedPostsTable.organizationId, [orgId, otherOrgId]));
  await db.delete(noticeBoardReadsTable)
    .where(eq(noticeBoardReadsTable.userId, callerUserId));
  await db.delete(noticeBoardArticlesTable)
    .where(inArray(noticeBoardArticlesTable.organizationId, [orgId, otherOrgId]));
  await db.delete(handicapCasePeerReviewsTable)
    .where(eq(handicapCasePeerReviewsTable.caseId, caseId));
  await db.delete(handicapCaseNotificationsTable)
    .where(eq(handicapCaseNotificationsTable.caseId, caseId));
  await db.delete(handicapReviewCasesTable)
    .where(eq(handicapReviewCasesTable.id, caseId));
  await db.delete(tournamentAnnouncementsTable)
    .where(inArray(tournamentAnnouncementsTable.tournamentId,
      db.select({ id: tournamentsTable.id })
        .from(tournamentsTable)
        .where(eq(tournamentsTable.organizationId, orgId))));
  await db.delete(playersTable)
    .where(eq(playersTable.tournamentId, tournamentId));
  await db.delete(tournamentsTable)
    .where(eq(tournamentsTable.organizationId, orgId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(orgMembershipsTable)
    .where(eq(orgMembershipsTable.organizationId, orgId));
  await db.delete(appUsersTable)
    .where(inArray(appUsersTable.organizationId, [orgId, otherOrgId]));
  await db.delete(organizationsTable)
    .where(inArray(organizationsTable.id, [orgId, otherOrgId]));
});

function asCaller(): TestUser {
  return {
    id: callerUserId,
    username: "caller",
    role: "player",
    organizationId: orgId,
  };
}

async function fetchBadgeCounts(qs: Record<string, string | number> = {}) {
  const app = createTestApp(asCaller());
  const url = "/api/portal/badge-counts"
    + (Object.keys(qs).length
      ? "?" + Object.entries(qs).map(([k, v]) => `${k}=${v}`).join("&")
      : "");
  const res = await request(app).get(url);
  expect(res.status).toBe(200);
  return res.body as {
    notifications: number;
    announcements: number;
    peerInvites: number;
    notices: number;
    feedSinceTs: number;
    walletPending: number;
  };
}

describe("GET /api/portal/badge-counts", () => {
  it("returns the expected counts for every category when fully populated", async () => {
    const body = await fetchBadgeCounts({
      orgId,
      announcementsSince: ANNOUNCEMENTS_SINCE_MS,
      feedSince: FEED_SINCE_MS,
    });

    expect(body).toEqual({
      notifications: 2,    // 2 unread + 1 read + 1 for stranger user
      announcements: 2,    // 2 after threshold, 1 before, 1 for stranger tournament
      peerInvites: 1,      // 1 active out of 4 caller rows + 1 stranger
      notices: 2,          // published-unread + scheduled-past-unread
      feedSinceTs: 2,      // 2 visible posts after threshold
      walletPending: 3,    // pending|processing|dispatch_unknown
    });
  });

  it("zeros out org-scoped rows when orgId is omitted (notices, feed, wallet)", async () => {
    // Without ?orgId= the route never resolves an org context, so
    // notice-board, feed and wallet-withdrawal queries short-circuit to
    // zero. The user-scoped rows (notifications, announcements,
    // peerInvites) must still come through unchanged.
    const body = await fetchBadgeCounts({
      announcementsSince: ANNOUNCEMENTS_SINCE_MS,
      feedSince: FEED_SINCE_MS,
    });

    expect(body).toEqual({
      notifications: 2,
      announcements: 2,
      peerInvites: 1,
      notices: 0,
      feedSinceTs: 0,
      walletPending: 0,
    });
  });

  it("zeros out org-scoped rows when caller is not a member of the requested org", async () => {
    // Passing an orgId the caller does NOT belong to must NOT leak the
    // other org's notice / feed / wallet activity. The route silently
    // falls back to orgId=null in that case.
    const body = await fetchBadgeCounts({
      orgId: otherOrgId,
      announcementsSince: ANNOUNCEMENTS_SINCE_MS,
      feedSince: FEED_SINCE_MS,
    });

    expect(body).toEqual({
      notifications: 2,
      announcements: 2,
      peerInvites: 1,
      notices: 0,
      feedSinceTs: 0,
      walletPending: 0,
    });
  });

  it("counts the full announcement backlog and zero feed posts on the first visit (since=0)", async () => {
    // First-sync semantics:
    //   • announcementsSince omitted → every announcement on every
    //     enrolled tournament is treated as "unread" so the user sees
    //     everything they've never confirmed.
    //   • feedSince omitted          → 0, so the badge does NOT light up
    //     with the entire backlog the moment they install the app.
    const body = await fetchBadgeCounts({ orgId });

    expect(body.announcements).toBe(3); // 2 fresh + 1 old, all backlog
    expect(body.feedSinceTs).toBe(0);   // first-visit feed → 0
    // Other rows are unaffected.
    expect(body.notifications).toBe(2);
    expect(body.peerInvites).toBe(1);
    expect(body.notices).toBe(2);
    expect(body.walletPending).toBe(3);
  });

  it("treats explicit since=0 the same as omitted (full announcement backlog, zero feed)", async () => {
    // The route comment explicitly calls out that
    // `announcementsSince=0` / `feedSince=0` must behave the same as
    // omitting the param, because the mobile client sends `0` on its
    // very first sync. Pin that contract directly.
    const body = await fetchBadgeCounts({
      orgId,
      announcementsSince: 0,
      feedSince: 0,
    });

    expect(body.announcements).toBe(3);
    expect(body.feedSinceTs).toBe(0);
    expect(body.notifications).toBe(2);
    expect(body.peerInvites).toBe(1);
    expect(body.notices).toBe(2);
    expect(body.walletPending).toBe(3);
  });

  it("returns 401 when the caller is not authenticated", async () => {
    // Sanity check on requirePlayer — without a session user the
    // endpoint must refuse the call, not return zeroed counts.
    const app = createTestApp();
    const res = await request(app).get("/api/portal/badge-counts");
    expect(res.status).toBe(401);
  });
});
