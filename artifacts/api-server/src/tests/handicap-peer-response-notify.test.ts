/**
 * Unit tests: Committee notification fan-out when a peer reviewer responds
 * (Task #592). Verifies that `recordPeerResponse` triggers a push + a durable
 * inbox row for every committee member of the case's org, while excluding the
 * case subject and the responding reviewer themselves.
 *
 * Mocks the comms module so no real push provider is hit; the DB is real so
 * the org / membership / case lookup paths execute against the same schema as
 * production.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/comms.js", async () => {
  return {
    sendTransactionalPush: vi.fn(async (
      userIds: number[],
      _title: string,
      _body: string,
      _data?: Record<string, unknown>,
    ) => ({
      attempted: userIds.length,
      sent: userIds.length,
      failed: 0,
      invalid: 0,
    })),
  };
});

import {
  db,
  appUsersTable,
  organizationsTable,
  orgMembershipsTable,
  handicapReviewCasesTable,
  handicapCasePeerReviewsTable,
  handicapCaseNotificationsTable,
  orgRoleEnum,
} from "@workspace/db";

type OrgRole = (typeof orgRoleEnum.enumValues)[number];
import { eq, inArray } from "drizzle-orm";
import {
  recordPeerResponse,
  invitePeerReviewer,
  createCase,
  getCommitteeMemberUserIds,
} from "../lib/handicap-cases.js";
import { sendTransactionalPush } from "../lib/comms.js";

const pushMock = vi.mocked(sendTransactionalPush);

let orgId: number;
const userIds: number[] = [];
let subjectUserId: number;
let reviewerUserId: number;
let committeeUserIds: number[] = [];

let userSeq = 0;
async function makeUser(role: OrgRole = "player"): Promise<number> {
  userSeq += 1;
  const tag = `${Date.now()}_${userSeq}_${Math.random().toString(36).slice(2, 8)}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `peer-notif-test-${tag}`,
    username: `peer_notif_test_${tag}`,
    displayName: `Peer Notif ${tag}`,
    email: `peer-notif-${tag}@example.com`,
    role,
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
  return u.id;
}

beforeAll(async () => {
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `Peer Notif Org ${tag}`,
    slug: `peer-notif-${tag}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  // Three committee members (different role paths) + a subject + a reviewer.
  const adminViaMembership = await makeUser("player");
  const directorViaMembership = await makeUser("player");
  const committeeMember = await makeUser("player");
  await db.insert(orgMembershipsTable).values([
    { organizationId: orgId, userId: adminViaMembership, role: "org_admin" },
    { organizationId: orgId, userId: directorViaMembership, role: "tournament_director" },
    { organizationId: orgId, userId: committeeMember, role: "committee_member" },
  ]);

  subjectUserId = await makeUser("player");
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: subjectUserId, role: "player",
  });

  reviewerUserId = await makeUser("player");
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: reviewerUserId, role: "player",
  });

  committeeUserIds = [adminViaMembership, directorViaMembership, committeeMember];
});

afterAll(async () => {
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgId));
  await db.delete(handicapCaseNotificationsTable).where(eq(handicapCaseNotificationsTable.organizationId, orgId));
  await db.delete(handicapCasePeerReviewsTable).where(inArray(handicapCasePeerReviewsTable.reviewerUserId, [reviewerUserId]));
  await db.delete(handicapReviewCasesTable).where(eq(handicapReviewCasesTable.organizationId, orgId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (userIds.length) await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
});

beforeEach(() => {
  pushMock.mockClear();
});

describe("Peer response → committee notifications", () => {
  it("getCommitteeMemberUserIds returns membership-role committee members", async () => {
    const ids = await getCommitteeMemberUserIds(orgId);
    for (const id of committeeUserIds) expect(ids).toContain(id);
    expect(ids).not.toContain(subjectUserId);
    expect(ids).not.toContain(reviewerUserId);
  });

  it("notifies every committee member with push + inbox row when a peer responds", async () => {
    const c = await createCase({
      organizationId: orgId,
      subjectUserId,
      kind: "anomalous",
      periodLabel: `Peer notif test ${Date.now()}`,
      details: "Test case for peer response fan-out.",
    });
    const invite = await invitePeerReviewer({
      caseId: c.id,
      reviewerUserId,
      invitedByUserId: null,
    });

    pushMock.mockClear();
    const result = await recordPeerResponse({
      token: invite.token,
      recommendation: "confirm",
      comment: "Looks accurate to me.",
    });
    expect(result).toEqual({ caseId: c.id });

    // Allow the fire-and-forget notification to settle.
    await new Promise(r => setTimeout(r, 50));

    expect(pushMock).toHaveBeenCalledTimes(1);
    const [recipients, title, body, data] = pushMock.mock.calls[0]! as [number[], string, string, Record<string, unknown>];
    for (const id of committeeUserIds) expect(recipients).toContain(id);
    expect(recipients).not.toContain(subjectUserId);
    expect(recipients).not.toContain(reviewerUserId);
    expect(title).toMatch(/peer review response/i);
    expect(body).toMatch(/confirm/i);
    expect(data.type).toBe("handicap_peer_response");
    expect(data.caseId).toBe(c.id);
    expect(typeof data.url).toBe("string");
    expect(String(data.url)).toContain(`caseId=${c.id}`);

    const inbox = await db.select().from(handicapCaseNotificationsTable)
      .where(eq(handicapCaseNotificationsTable.caseId, c.id));
    const peerRows = inbox.filter(r => r.event === "peer_responded");
    expect(peerRows.length).toBe(committeeUserIds.length);
    const inboxRecipients = peerRows.map(r => r.subjectUserId).sort();
    expect(inboxRecipients).toEqual([...committeeUserIds].sort());
    for (const r of peerRows) {
      expect(r.title).toMatch(/peer review response/i);
      expect((r.payload as Record<string, unknown>)?.recommendation).toBe("confirm");
      expect((r.payload as Record<string, unknown>)?.deepLink).toContain(`caseId=${c.id}`);
    }
  });

  it("does not re-notify when the same token is replayed", async () => {
    const c = await createCase({
      organizationId: orgId,
      subjectUserId,
      kind: "not_posted",
      periodLabel: `Peer notif replay ${Date.now()}`,
      details: "Replay test.",
    });
    const invite = await invitePeerReviewer({
      caseId: c.id,
      reviewerUserId,
      invitedByUserId: null,
    });
    await recordPeerResponse({ token: invite.token, recommendation: "dispute", comment: null });
    await new Promise(r => setTimeout(r, 50));
    const firstCalls = pushMock.mock.calls.length;
    pushMock.mockClear();

    // Replay — already responded, must short-circuit (no new push, no new rows).
    const replay = await recordPeerResponse({ token: invite.token, recommendation: "confirm", comment: null });
    expect(replay).toEqual({ caseId: c.id });
    await new Promise(r => setTimeout(r, 50));
    expect(pushMock).not.toHaveBeenCalled();
    expect(firstCalls).toBeGreaterThan(0);

    const inbox = await db.select().from(handicapCaseNotificationsTable)
      .where(eq(handicapCaseNotificationsTable.caseId, c.id));
    const peerRows = inbox.filter(r => r.event === "peer_responded");
    expect(peerRows.length).toBe(committeeUserIds.length); // unchanged
  });
});
