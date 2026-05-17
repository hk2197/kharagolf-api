/**
 * Unit tests: Committee peer-response digest "since last send" semantics
 * (Task #592, follow-up from code review).
 *
 * Verifies that `sendCommitteePeerResponsesDigests` is exactly-once per peer
 * response across multiple cron invocations:
 *   - First run picks up all in-window responses and emails them.
 *   - Immediate re-run does NOT re-email (audit-row watermark suppresses).
 *   - A new response after the first run IS picked up by the next run, and
 *     prior responses are not duplicated.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/comms.js", async () => ({
  sendTransactionalPush: vi.fn(async (
    userIds: number[],
    _title: string,
    _body: string,
    _data?: Record<string, unknown>,
  ) => ({
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
let reviewerA: number;
let reviewerB: number;
let committeeMember: number;

let userSeq = 0;
async function makeUser(): Promise<number> {
  userSeq += 1;
  const tag = `${Date.now()}_${userSeq}_${Math.random().toString(36).slice(2, 8)}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `peer-digest-test-${tag}`,
    username: `peer_digest_test_${tag}`,
    displayName: `Peer Digest ${tag}`,
    email: `peer-digest-${tag}@example.com`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
  return u.id;
}

beforeAll(async () => {
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `Peer Digest Org ${tag}`,
    slug: `peer-digest-${tag}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  committeeMember = await makeUser();
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: committeeMember, role: "committee_member",
  });
  subjectUserId = await makeUser();
  reviewerA = await makeUser();
  reviewerB = await makeUser();
});

afterAll(async () => {
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgId));
  await db.delete(handicapCaseAuditLogTable)
    .where(inArray(handicapCaseAuditLogTable.action, ["committee_digest_emailed"]));
  await db.delete(handicapCaseNotificationsTable).where(eq(handicapCaseNotificationsTable.organizationId, orgId));
  await db.delete(handicapCasePeerReviewsTable)
    .where(inArray(handicapCasePeerReviewsTable.reviewerUserId, [reviewerA, reviewerB]));
  await db.delete(handicapReviewCasesTable).where(eq(handicapReviewCasesTable.organizationId, orgId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (userIds.length) await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
});

beforeEach(() => {
  emailMock.mockClear();
});

describe("sendCommitteePeerResponsesDigests — exactly-once watermark", () => {
  it("emails new responses on first run, suppresses on immediate re-run, picks up later additions", async () => {
    // Seed: one case with reviewer A who responds.
    const c1 = await createCase({
      organizationId: orgId,
      subjectUserId,
      kind: "anomalous",
      periodLabel: `Window test ${Date.now()}`,
      details: "Watermark test.",
    });
    const inv1 = await invitePeerReviewer({ caseId: c1.id, reviewerUserId: reviewerA, invitedByUserId: null });
    await recordPeerResponse({ token: inv1.token, recommendation: "confirm", comment: "ok" });

    type EmailArg = { to: string; responses: Array<{ caseId: number; peerReviewId: number }> };
    const callsForOurOrg = (): EmailArg[] => emailMock.mock.calls
      .map(c => c[0] as unknown as EmailArg)
      .filter(a => a.responses.some(r => r.caseId === c1.id));

    // First digest run — should email our committee member at least once.
    emailMock.mockClear();
    const r1 = await sendCommitteePeerResponsesDigests();
    expect(r1.emails).toBeGreaterThanOrEqual(1);
    const ourCallsRun1 = callsForOurOrg();
    expect(ourCallsRun1.length).toBeGreaterThan(0);
    const responsesIncludedRun1 = ourCallsRun1[0].responses;
    expect(responsesIncludedRun1.some(r => r.peerReviewId === inv1.id)).toBe(true);

    // Immediate re-run — must NOT re-email our org (watermark suppresses).
    emailMock.mockClear();
    await sendCommitteePeerResponsesDigests();
    expect(callsForOurOrg().length).toBe(0);

    // Add a brand-new response after the first send.
    const inv2 = await invitePeerReviewer({ caseId: c1.id, reviewerUserId: reviewerB, invitedByUserId: null });
    await recordPeerResponse({ token: inv2.token, recommendation: "dispute", comment: "no" });

    // Next digest run — must include only the new response, not the prior one.
    emailMock.mockClear();
    await sendCommitteePeerResponsesDigests();
    const ourCallsRun3 = callsForOurOrg();
    expect(ourCallsRun3.length).toBeGreaterThan(0);
    const includedIds = ourCallsRun3[0].responses.map(r => r.peerReviewId);
    expect(includedIds).toContain(inv2.id);
    expect(includedIds).not.toContain(inv1.id);

    // And one more re-run after the second send is again a no-op for us.
    emailMock.mockClear();
    await sendCommitteePeerResponsesDigests();
    expect(callsForOurOrg().length).toBe(0);
  });
});
