/**
 * Integration tests: Peer-review invitation "seen" lifecycle (Task #745 / #894).
 *
 * Covers:
 *   - POST /portal/handicap/peer-invites/:id/seen
 *       * 401 when unauthenticated
 *       * 200 + { updated: 0 } no-op when called by an unrelated user
 *         (verifies seen_at is NOT stamped on the underlying row)
 *       * First call from the real reviewer stamps seen_at (updated: 1)
 *       * Second call from the same reviewer is idempotent (updated: 0,
 *         seen_at unchanged)
 *   - GET /portal/handicap/my-peer-invites returns seenAt (null before, ISO
 *     string after) and continues to include the row even when it has been
 *     seen. Responded and expired invites are still excluded from the list.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  appUsersTable,
  organizationsTable,
  handicapReviewCasesTable,
  handicapCasePeerReviewsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

const userIds: number[] = [];
let orgId: number;
let reviewerUserId: number;
let strangerUserId: number;
let subjectUserId: number;
let caseId: number;

let userSeq = 0;
async function makeUser(): Promise<number> {
  userSeq += 1;
  const tag = `${Date.now()}_${userSeq}_${Math.random().toString(36).slice(2, 8)}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `peer-seen-test-${tag}`,
    username: `peer_seen_test_${tag}`,
    displayName: `Peer Seen ${tag}`,
    email: `peer-seen-${tag}@example.com`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
  return u.id;
}

async function makeInvite(overrides: Partial<{
  reviewerUserId: number;
  respondedAt: Date | null;
  expiresAt: Date | null;
  seenAt: Date | null;
}> = {}) {
  const token = `peer-seen-tok-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const [row] = await db.insert(handicapCasePeerReviewsTable).values({
    caseId,
    reviewerUserId: overrides.reviewerUserId ?? reviewerUserId,
    token,
    invitedAt: new Date(),
    respondedAt: overrides.respondedAt ?? null,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 14 * 86_400_000),
    seenAt: overrides.seenAt ?? null,
  }).returning();
  return row;
}

beforeAll(async () => {
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `Peer Seen Org ${tag}`,
    slug: `peer-seen-${tag}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  reviewerUserId = await makeUser();
  strangerUserId = await makeUser();
  subjectUserId = await makeUser();

  const [c] = await db.insert(handicapReviewCasesTable).values({
    organizationId: orgId,
    subjectUserId,
    kind: "anomalous",
    periodLabel: `Peer seen test ${tag}`,
    details: "Test case for peer-invite seen lifecycle.",
    status: "open",
  }).returning({ id: handicapReviewCasesTable.id });
  caseId = c.id;
});

afterAll(async () => {
  await db.delete(handicapCasePeerReviewsTable).where(eq(handicapCasePeerReviewsTable.caseId, caseId));
  await db.delete(handicapReviewCasesTable).where(eq(handicapReviewCasesTable.id, caseId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (userIds.length) await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
});

describe("POST /portal/handicap/peer-invites/:id/seen", () => {
  it("returns 401 when no user is authenticated", async () => {
    const invite = await makeInvite();
    const app = createTestApp(); // no user
    const res = await request(app)
      .post(`/api/portal/handicap/peer-invites/${invite.id}/seen`);
    expect(res.status).toBe(401);

    const [row] = await db.select({ seenAt: handicapCasePeerReviewsTable.seenAt })
      .from(handicapCasePeerReviewsTable)
      .where(eq(handicapCasePeerReviewsTable.id, invite.id));
    expect(row.seenAt).toBeNull();
  });

  it("is a no-op (200, updated:0) when called by a user who is not the reviewer", async () => {
    const invite = await makeInvite();
    const app = createTestApp({
      id: strangerUserId,
      username: "stranger",
      role: "player",
    });
    const res = await request(app)
      .post(`/api/portal/handicap/peer-invites/${invite.id}/seen`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, updated: 0 });

    const [row] = await db.select({ seenAt: handicapCasePeerReviewsTable.seenAt })
      .from(handicapCasePeerReviewsTable)
      .where(eq(handicapCasePeerReviewsTable.id, invite.id));
    expect(row.seenAt).toBeNull();
  });

  it("stamps seen_at on the first call from the real reviewer and is idempotent on replay", async () => {
    const invite = await makeInvite();
    const app = createTestApp({
      id: reviewerUserId,
      username: "reviewer",
      role: "player",
    });

    const first = await request(app)
      .post(`/api/portal/handicap/peer-invites/${invite.id}/seen`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ success: true, updated: 1 });

    const [afterFirst] = await db.select({ seenAt: handicapCasePeerReviewsTable.seenAt })
      .from(handicapCasePeerReviewsTable)
      .where(eq(handicapCasePeerReviewsTable.id, invite.id));
    expect(afterFirst.seenAt).toBeInstanceOf(Date);
    const stampedAt = afterFirst.seenAt as Date;

    // Second call must be a no-op AND must NOT update seen_at again.
    const second = await request(app)
      .post(`/api/portal/handicap/peer-invites/${invite.id}/seen`);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ success: true, updated: 0 });

    const [afterSecond] = await db.select({ seenAt: handicapCasePeerReviewsTable.seenAt })
      .from(handicapCasePeerReviewsTable)
      .where(eq(handicapCasePeerReviewsTable.id, invite.id));
    expect(afterSecond.seenAt).toBeInstanceOf(Date);
    expect((afterSecond.seenAt as Date).getTime()).toBe(stampedAt.getTime());
  });

  it("returns 400 when the id is not a finite integer", async () => {
    const app = createTestApp({
      id: reviewerUserId,
      username: "reviewer",
      role: "player",
    });
    const res = await request(app)
      .post(`/api/portal/handicap/peer-invites/not-a-number/seen`);
    expect(res.status).toBe(400);
  });
});

describe("GET /portal/handicap/my-peer-invites — seenAt + filtering", () => {
  it("includes seenAt (null before seen, ISO string after) and continues to list seen invites", async () => {
    const invite = await makeInvite();
    const app = createTestApp({
      id: reviewerUserId,
      username: "reviewer",
      role: "player",
    });

    // Before: seenAt is null but the invite is in the list.
    const before = await request(app).get("/api/portal/handicap/my-peer-invites");
    expect(before.status).toBe(200);
    const beforeRow = (before.body as Array<{ id: number; seenAt: string | null }>)
      .find(r => r.id === invite.id);
    expect(beforeRow).toBeDefined();
    expect(beforeRow!.seenAt).toBeNull();

    // Mark seen.
    const seenRes = await request(app)
      .post(`/api/portal/handicap/peer-invites/${invite.id}/seen`);
    expect(seenRes.status).toBe(200);

    // After: still in the list, but with an ISO-formatted seenAt.
    const after = await request(app).get("/api/portal/handicap/my-peer-invites");
    expect(after.status).toBe(200);
    const afterRow = (after.body as Array<{ id: number; seenAt: string | null }>)
      .find(r => r.id === invite.id);
    expect(afterRow).toBeDefined();
    expect(typeof afterRow!.seenAt).toBe("string");
    expect(() => new Date(afterRow!.seenAt as string).toISOString()).not.toThrow();
  });

  it("excludes responded and expired invites even when they were previously seen", async () => {
    const respondedInvite = await makeInvite({
      respondedAt: new Date(),
      seenAt: new Date(),
    });
    const expiredInvite = await makeInvite({
      expiresAt: new Date(Date.now() - 60_000),
      seenAt: new Date(),
    });
    const liveInvite = await makeInvite();

    const app = createTestApp({
      id: reviewerUserId,
      username: "reviewer",
      role: "player",
    });
    const res = await request(app).get("/api/portal/handicap/my-peer-invites");
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number }>).map(r => r.id);
    expect(ids).toContain(liveInvite.id);
    expect(ids).not.toContain(respondedInvite.id);
    expect(ids).not.toContain(expiredInvite.id);
  });
});
