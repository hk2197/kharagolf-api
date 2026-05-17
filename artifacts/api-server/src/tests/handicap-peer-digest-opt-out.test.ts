/**
 * Unit test: per-user opt-out for the daily committee peer-response digest
 * (Task #754).
 *
 * Verifies that `sendCommitteePeerResponsesDigests` skips committee members
 * whose `user_notification_prefs.notify_committee_peer_digest` flag is
 * `false`, while still emailing other committee members in the same org.
 * The default (true / no row) preserves existing behaviour.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/comms.js", async () => ({
  sendTransactionalPush: vi.fn(async (userIds: number[]) => ({
    attempted: userIds.length, sent: userIds.length, failed: 0, invalid: 0,
  })),
}));
vi.mock("../lib/mailer.js", async () => ({
  sendCommitteePeerResponseDigestEmail: vi.fn(async () => undefined),
}));

import {
  db,
  appUsersTable,
  organizationsTable,
  orgMembershipsTable,
  handicapReviewCasesTable,
  handicapCasePeerReviewsTable,
  handicapCaseAuditLogTable,
  handicapCaseNotificationsTable,
  userNotificationPrefsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  createCase,
  invitePeerReviewer,
  recordPeerResponse,
  sendCommitteePeerResponsesDigests,
} from "../lib/handicap-cases.js";
import { sendCommitteePeerResponseDigestEmail } from "../lib/mailer.js";

const emailMock = vi.mocked(sendCommitteePeerResponseDigestEmail);

let orgId: number;
const userIds: number[] = [];
let subjectUserId: number;
let reviewerUserId: number;
let optedInMember: number;
let optedOutMember: number;

let userSeq = 0;
async function makeUser(emailLocal: string): Promise<number> {
  userSeq += 1;
  const tag = `${Date.now()}_${userSeq}_${Math.random().toString(36).slice(2, 8)}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `peer-digest-optout-${tag}`,
    username: `peer_digest_optout_${tag}`,
    displayName: `Peer Digest OptOut ${tag}`,
    email: `${emailLocal}-${tag}@example.com`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
  return u.id;
}

beforeAll(async () => {
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `Peer Digest OptOut Org ${tag}`,
    slug: `peer-digest-optout-${tag}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  optedInMember = await makeUser("opted-in");
  optedOutMember = await makeUser("opted-out");
  await db.insert(orgMembershipsTable).values([
    { organizationId: orgId, userId: optedInMember, role: "committee_member" },
    { organizationId: orgId, userId: optedOutMember, role: "committee_member" },
  ]);
  // Mark the second member as opted out of the daily digest.
  await db.insert(userNotificationPrefsTable).values({
    userId: optedOutMember,
    notifyCommitteePeerDigest: false,
  });

  subjectUserId = await makeUser("subject");
  reviewerUserId = await makeUser("reviewer");
});

afterAll(async () => {
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgId));
  // Scope audit cleanup to our org's cases — other parallel test files share
  // the database and the digest watermark table, so a blanket delete would
  // wipe their watermarks and cause cross-test flakes.
  const ourCaseIds = (await db.select({ id: handicapReviewCasesTable.id })
    .from(handicapReviewCasesTable)
    .where(eq(handicapReviewCasesTable.organizationId, orgId))).map(r => r.id);
  if (ourCaseIds.length > 0) {
    await db.delete(handicapCaseAuditLogTable)
      .where(inArray(handicapCaseAuditLogTable.caseId, ourCaseIds));
  }
  await db.delete(handicapCaseNotificationsTable).where(eq(handicapCaseNotificationsTable.organizationId, orgId));
  await db.delete(handicapCasePeerReviewsTable)
    .where(inArray(handicapCasePeerReviewsTable.reviewerUserId, [reviewerUserId]));
  await db.delete(handicapReviewCasesTable).where(eq(handicapReviewCasesTable.organizationId, orgId));
  await db.delete(userNotificationPrefsTable).where(inArray(userNotificationPrefsTable.userId, userIds));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (userIds.length) await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
});

beforeEach(() => {
  emailMock.mockClear();
});

describe("sendCommitteePeerResponsesDigests — per-user opt-out (Task #754)", () => {
  it("skips committee members whose notifyCommitteePeerDigest is false", async () => {
    const c = await createCase({
      organizationId: orgId,
      subjectUserId,
      kind: "anomalous",
      periodLabel: `OptOut test ${Date.now()}`,
      details: "Opt-out test.",
    });
    const inv = await invitePeerReviewer({ caseId: c.id, reviewerUserId, invitedByUserId: null });
    await recordPeerResponse({ token: inv.token, recommendation: "confirm", comment: "ok" });

    type EmailArg = { to: string; responses: Array<{ caseId: number }> };
    const callsForOurOrg = (): EmailArg[] => emailMock.mock.calls
      .map(c => c[0] as EmailArg)
      .filter(a => a.responses.some(r => r.caseId === c.id));

    await sendCommitteePeerResponsesDigests();

    const calls = callsForOurOrg();
    const recipientEmails = calls.map(c => c.to);
    // The opted-in committee member receives exactly one digest …
    expect(recipientEmails.filter(e => e.startsWith("opted-in")).length).toBe(1);
    // … and the opted-out committee member receives none.
    expect(recipientEmails.filter(e => e.startsWith("opted-out")).length).toBe(0);
  });
});
