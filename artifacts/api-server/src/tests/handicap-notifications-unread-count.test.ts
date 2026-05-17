/**
 * Integration tests: GET /portal/handicap/notifications/unread-count
 * (Task #1396 — lightweight count endpoint that powers the mobile home
 * screen committee-inbox badge so we no longer download the full
 * notifications list just to count unread peer responses).
 *
 * Locks in:
 *   1. Authentication is required (401 when no caller).
 *   2. With no notifications for the caller, returns
 *      `{ unreadCount: 0, hasAny: false }`.
 *   3. Counts are scoped to the signed-in user (a different user's
 *      peer-response rows must not bleed in).
 *   4. The optional `event` filter only counts rows whose `event` matches;
 *      `event=peer_responded` ignores `opened`/`decided` rows even when the
 *      user has them.
 *   5. Already-read rows do not contribute to `unreadCount` but still flip
 *      `hasAny` to true (so the inbox entry still shows after the user has
 *      cleared every peer response).
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
let otherUserId: number;
let caseId: number;
const insertedNotificationIds: number[] = [];

beforeAll(async () => {
  const tag = uid("hcp_notif_count");
  const [org] = await db.insert(organizationsTable).values({
    name: `Hcp Notif Count Org ${tag}`,
    slug: `hcp-notif-count-${tag}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [caller] = await db.insert(appUsersTable).values({
    replitUserId: `hcp-notif-count-caller-${tag}`,
    username: `hcp_notif_count_caller_${tag}`,
    displayName: `Caller ${tag}`,
    email: `caller-${tag}@hcp-notif-count.test`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  callerUserId = caller.id;

  const [other] = await db.insert(appUsersTable).values({
    replitUserId: `hcp-notif-count-other-${tag}`,
    username: `hcp_notif_count_other_${tag}`,
    displayName: `Other ${tag}`,
    email: `other-${tag}@hcp-notif-count.test`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  otherUserId = other.id;

  // A single review case to attach notifications to (the endpoint counts
  // notifications, not cases).
  const [reviewCase] = await db.insert(handicapReviewCasesTable).values({
    organizationId: orgId,
    kind: "peer_review",
    status: "open",
    subjectUserId: otherUserId,
  }).returning({ id: handicapReviewCasesTable.id });
  caseId = reviewCase.id;
});

afterAll(async () => {
  if (insertedNotificationIds.length > 0) {
    await db.delete(handicapCaseNotificationsTable)
      .where(inArray(handicapCaseNotificationsTable.id, insertedNotificationIds));
  }
  await db.delete(handicapReviewCasesTable).where(eq(handicapReviewCasesTable.id, caseId));
  await db.delete(appUsersTable)
    .where(inArray(appUsersTable.id, [callerUserId, otherUserId]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

async function insertNotif(opts: {
  subjectUserId: number;
  event: string;
  read?: boolean;
}): Promise<number> {
  const [row] = await db.insert(handicapCaseNotificationsTable).values({
    subjectUserId: opts.subjectUserId,
    caseId,
    organizationId: orgId,
    event: opts.event,
    title: `${opts.event} title`,
    body: `${opts.event} body`,
    payload: { deepLink: "/(tabs)/notifications" },
    readAt: opts.read ? new Date() : null,
  }).returning({ id: handicapCaseNotificationsTable.id });
  insertedNotificationIds.push(row.id);
  return row.id;
}

function callerApp() {
  const user: TestUser = {
    id: callerUserId,
    username: "caller",
    role: "player",
  };
  return createTestApp(user);
}

describe("GET /portal/handicap/notifications/unread-count (Task #1396)", () => {
  it("requires authentication", async () => {
    const res = await request(createTestApp())
      .get("/api/portal/handicap/notifications/unread-count")
      .query({ event: "peer_responded" });
    expect(res.status).toBe(401);
  });

  it("returns zero counts and hasAny=false when the caller has no notifications", async () => {
    const res = await request(callerApp())
      .get("/api/portal/handicap/notifications/unread-count")
      .query({ event: "peer_responded" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unreadCount: 0, hasAny: false });
  });

  it("only counts the signed-in user's notifications", async () => {
    // A peer-response notification belonging to a different user must not
    // leak into the caller's counts.
    await insertNotif({ subjectUserId: otherUserId, event: "peer_responded", read: false });

    const res = await request(callerApp())
      .get("/api/portal/handicap/notifications/unread-count")
      .query({ event: "peer_responded" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unreadCount: 0, hasAny: false });
  });

  it("filters by `event` and ignores other event types", async () => {
    // Caller has two unread non-peer-response notifications; with the
    // peer_responded filter both must be excluded.
    await insertNotif({ subjectUserId: callerUserId, event: "opened", read: false });
    await insertNotif({ subjectUserId: callerUserId, event: "decided", read: false });
    // …and one unread peer_responded that SHOULD count.
    await insertNotif({ subjectUserId: callerUserId, event: "peer_responded", read: false });

    const filtered = await request(callerApp())
      .get("/api/portal/handicap/notifications/unread-count")
      .query({ event: "peer_responded" });
    expect(filtered.status).toBe(200);
    expect(filtered.body).toEqual({ unreadCount: 1, hasAny: true });

    // Without the filter, all three unread notifications are counted.
    const unfiltered = await request(callerApp())
      .get("/api/portal/handicap/notifications/unread-count");
    expect(unfiltered.status).toBe(200);
    expect(unfiltered.body).toEqual({ unreadCount: 3, hasAny: true });
  });

  it("hasAny stays true when every peer response has been read, but unreadCount drops to zero", async () => {
    // Mark the single unread peer_responded row from the previous test as
    // read so the only peer_responded rows for the caller are read.
    await db.update(handicapCaseNotificationsTable)
      .set({ readAt: new Date() })
      .where(eq(handicapCaseNotificationsTable.subjectUserId, callerUserId));

    // Add one more, already-read, peer_responded row to be explicit.
    await insertNotif({ subjectUserId: callerUserId, event: "peer_responded", read: true });

    const res = await request(callerApp())
      .get("/api/portal/handicap/notifications/unread-count")
      .query({ event: "peer_responded" });
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(0);
    expect(res.body.hasAny).toBe(true);
  });
});
