/**
 * Integration tests: GET /portal/handicap/notifications cursor pagination
 * (Task #1685 — speed up the mobile inbox by paging older items in instead
 * of downloading the entire backlog on every open).
 *
 * Locks in:
 *   1. The default page size is small (25) so heavily-used committee
 *      inboxes don't blow up the first-render payload.
 *   2. The response shape includes `nextCursor: number | null`.
 *      `nextCursor` is set to the last item's id when the page is full
 *      (older items may exist) and `null` when the inbox fits in one page.
 *   3. Passing `before=<cursor>` returns the next page of older items
 *      (notifications with `id < before`), in the same `createdAt desc, id
 *      desc` order as the first page, with no overlap.
 *   4. `unreadCount` is the user's total unread count (independent of the
 *      cursor) so the inbox header keeps showing the correct badge no
 *      matter which page is loaded.
 *   5. The page size is capped (the server clamps absurdly large `limit`
 *      values to 100).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  organizationsTable,
  appUsersTable,
  handicapReviewCasesTable,
  handicapCaseNotificationsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";

let orgId: number;
let callerUserId: number;
let caseId: number;
const insertedNotificationIds: number[] = [];

beforeAll(async () => {
  const tag = uid("hcp_notif_page");
  const [org] = await db.insert(organizationsTable).values({
    name: `Hcp Notif Page Org ${tag}`,
    slug: `hcp-notif-page-${tag}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [caller] = await db.insert(appUsersTable).values({
    replitUserId: `hcp-notif-page-caller-${tag}`,
    username: `hcp_notif_page_caller_${tag}`,
    displayName: `Caller ${tag}`,
    email: `caller-${tag}@hcp-notif-page.test`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  callerUserId = caller.id;

  const [reviewCase] = await db.insert(handicapReviewCasesTable).values({
    organizationId: orgId,
    kind: "peer_review",
    status: "open",
    subjectUserId: callerUserId,
  }).returning({ id: handicapReviewCasesTable.id });
  caseId = reviewCase.id;

  // Insert 60 notifications, mostly read with a few unread sprinkled in,
  // so we can exercise pagination + the unreadCount aggregate.
  for (let i = 0; i < 60; i++) {
    const [row] = await db.insert(handicapCaseNotificationsTable).values({
      subjectUserId: callerUserId,
      caseId,
      organizationId: orgId,
      event: "opened",
      title: `Notification #${i}`,
      body: `Body ${i}`,
      payload: { deepLink: "/handicap-profile" },
      readAt: i % 10 === 0 ? null : new Date(),
    }).returning({ id: handicapCaseNotificationsTable.id });
    insertedNotificationIds.push(row.id);
  }
});

afterAll(async () => {
  if (insertedNotificationIds.length > 0) {
    await db.delete(handicapCaseNotificationsTable)
      .where(inArray(handicapCaseNotificationsTable.id, insertedNotificationIds));
  }
  await db.delete(handicapReviewCasesTable).where(eq(handicapReviewCasesTable.id, caseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, callerUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

function callerApp() {
  const user: TestUser = {
    id: callerUserId,
    username: "caller",
    role: "player",
  };
  return createTestApp(user);
}

describe("GET /portal/handicap/notifications — cursor pagination (Task #1685)", () => {
  it("returns a small first page (default 25) plus a continuation cursor", async () => {
    const app = callerApp();
    const res = await request(app)
      .get("/api/portal/handicap/notifications")
      .expect(200);

    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBe(25);
    expect(typeof res.body.nextCursor).toBe("number");
    // The cursor is the smallest id on the page (we ordered desc by id).
    const lastItemId = res.body.items[res.body.items.length - 1].id;
    expect(res.body.nextCursor).toBe(lastItemId);
    // unreadCount counts ALL unread notifications, not just those on this
    // page. We seeded 6 unread (every 10th of 60).
    expect(res.body.unreadCount).toBe(6);
  });

  it("`before=<cursor>` returns the next page of older items with no overlap", async () => {
    const app = callerApp();
    const first = await request(app)
      .get("/api/portal/handicap/notifications")
      .expect(200);
    expect(first.body.items.length).toBe(25);
    const firstIds = new Set<number>(first.body.items.map((i: { id: number }) => i.id));
    const cursor = first.body.nextCursor;

    const second = await request(app)
      .get(`/api/portal/handicap/notifications?before=${cursor}`)
      .expect(200);
    expect(second.body.items.length).toBe(25);
    // No overlap — every item in the second page has id < cursor.
    for (const item of second.body.items as Array<{ id: number }>) {
      expect(firstIds.has(item.id)).toBe(false);
      expect(item.id).toBeLessThan(cursor);
    }
    // unreadCount remains the total, independent of the cursor.
    expect(second.body.unreadCount).toBe(6);
  });

  it("returns `nextCursor: null` once the last page is reached", async () => {
    const app = callerApp();
    // We seeded 60 rows. With limit=25 we need 3 pages: 25, 25, 10.
    const p1 = await request(app)
      .get("/api/portal/handicap/notifications")
      .expect(200);
    const p2 = await request(app)
      .get(`/api/portal/handicap/notifications?before=${p1.body.nextCursor}`)
      .expect(200);
    const p3 = await request(app)
      .get(`/api/portal/handicap/notifications?before=${p2.body.nextCursor}`)
      .expect(200);
    expect(p3.body.items.length).toBe(10);
    expect(p3.body.nextCursor).toBeNull();
  });

  it("clamps absurdly large page sizes (caller asks for 9999, server returns at most 100)", async () => {
    const app = callerApp();
    const res = await request(app)
      .get("/api/portal/handicap/notifications?limit=9999")
      .expect(200);
    expect(res.body.items.length).toBeLessThanOrEqual(100);
    // We only seeded 60, so the actual page should be 60 here.
    expect(res.body.items.length).toBe(60);
    // With every notification on a single page, there is no continuation.
    expect(res.body.nextCursor).toBeNull();
  });
});
