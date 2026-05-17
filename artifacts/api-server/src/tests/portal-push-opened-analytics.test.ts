/**
 * Task #1317 — Track when players actually open mobile push notifications.
 *
 * Pins the contract for the new
 *   POST /api/portal/notifications/push-opened
 * endpoint that the mobile app calls from its native push-tap handlers
 * (cold-start `getLastNotificationResponseAsync` and warm-start
 * `addNotificationResponseReceivedListener`).
 *
 * Each successful call writes a `notification_opened` row to
 * `analytics_events` with `surface: "mobile"` so the existing admin
 * analytics dashboard surfaces native-push opens alongside the in-app
 * portal opens that already feed it (handicap-cases routes).
 *
 * Specifically covered:
 *   • 401 when unauthenticated (no `req.user`).
 *   • 200 + analytics row written for an authenticated push-opened tap.
 *     - The row uses `surface: "mobile"` to distinguish from in-app opens.
 *     - The push `data.type`, `messageId`, deep-link `url`, and the small
 *       allow-listed context fields (tournamentId, payoutId, reelId, …)
 *       all flow through into the payload.
 *   • organizationId from the body is dropped when the caller is NOT a
 *     member of that org (no analytics leak across organisations).
 *   • organizationId from the body is preserved when the caller IS a
 *     member of that org, even if their session org points elsewhere.
 *   • Empty body (no payload) still returns 200 and writes a row — the
 *     mobile client may not always be able to extract a `data` blob.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import {
  db,
  analyticsEventsTable,
  appUsersTable,
  organizationsTable,
  orgMembershipsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

let memberOrgId: number;
let strangerOrgId: number;
let memberUserId: number;
const userIds: number[] = [];
const orgIds: number[] = [];

beforeAll(async () => {
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Both orgs are on enterprise so the deviceTokenRouter `mobileApp`
  // feature gate is unambiguously satisfied for the caller's session org.
  const [memberOrg] = await db.insert(organizationsTable).values({
    name: `T1317 Member ${tag}`,
    slug: `t1317-member-${tag}`,
    subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  memberOrgId = memberOrg.id;
  orgIds.push(memberOrgId);

  const [strangerOrg] = await db.insert(organizationsTable).values({
    name: `T1317 Stranger ${tag}`,
    slug: `t1317-stranger-${tag}`,
    subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  strangerOrgId = strangerOrg.id;
  orgIds.push(strangerOrgId);

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `t1317-user-${tag}`,
    username: `t1317_user_${tag}`,
    email: `t1317-${tag}@example.com`,
    role: "player",
    organizationId: memberOrgId,
  }).returning({ id: appUsersTable.id });
  memberUserId = user.id;
  userIds.push(memberUserId);

  await db.insert(orgMembershipsTable).values({
    organizationId: memberOrgId,
    userId: memberUserId,
    role: "player",
  });
});

afterAll(async () => {
  await db.delete(analyticsEventsTable)
    .where(inArray(analyticsEventsTable.userId, userIds));
  await db.delete(orgMembershipsTable)
    .where(inArray(orgMembershipsTable.userId, userIds));
  await db.delete(appUsersTable)
    .where(inArray(appUsersTable.id, userIds));
  await db.delete(organizationsTable)
    .where(inArray(organizationsTable.id, orgIds));
});

beforeEach(async () => {
  // Each test asserts on the rows it wrote — start clean so we don't have
  // to filter by per-call discriminators.
  await db.delete(analyticsEventsTable)
    .where(inArray(analyticsEventsTable.userId, userIds));
});

function asMember() {
  return {
    id: memberUserId,
    username: "t1317_user",
    role: "player",
    organizationId: memberOrgId,
  };
}

async function readEvents() {
  return db.select().from(analyticsEventsTable)
    .where(and(
      eq(analyticsEventsTable.eventName, "notification_opened"),
      eq(analyticsEventsTable.userId, memberUserId),
    ));
}

describe("POST /api/portal/notifications/push-opened (Task #1317)", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const app = createTestApp(); // no user injected
    const res = await request(app)
      .post("/api/portal/notifications/push-opened")
      .send({ type: "handicap_case_update" });
    expect(res.status).toBe(401);

    const rows = await readEvents();
    expect(rows).toHaveLength(0);
  });

  it("writes a `notification_opened` analytics row with surface=mobile and the push payload", async () => {
    const app = createTestApp(asMember());
    const res = await request(app)
      .post("/api/portal/notifications/push-opened")
      .send({
        messageId: "expo-msg-abc-123",
        type: "highlight_render_complete",
        url: "/highlights",
        reelId: 4242,
        tournamentId: 99,
        // Unknown / not-allow-listed keys must NOT leak into the payload.
        ssn: "leak-me-not",
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const rows = await readEvents();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.surface).toBe("mobile");
    expect(row.organizationId).toBe(memberOrgId); // session fallback
    const payload = row.payload as Record<string, unknown>;
    expect(payload.channel).toBe("push");
    expect(payload.pushType).toBe("highlight_render_complete");
    expect(payload.messageId).toBe("expo-msg-abc-123");
    expect(payload.url).toBe("/highlights");
    expect(payload.reelId).toBe(4242);
    expect(payload.tournamentId).toBe(99);
    expect(payload).not.toHaveProperty("ssn");
  });

  it("drops body.organizationId silently when the caller is NOT a member of that org", async () => {
    const app = createTestApp(asMember());
    const res = await request(app)
      .post("/api/portal/notifications/push-opened")
      .send({
        type: "handicap_case_update",
        organizationId: strangerOrgId, // caller is not a member
      });
    expect(res.status).toBe(200);

    const rows = await readEvents();
    expect(rows).toHaveLength(1);
    // Falls back to the caller's session org rather than stamping the
    // attacker-controlled value — analytics must not leak across orgs.
    expect(rows[0].organizationId).toBe(memberOrgId);
  });

  it("preserves body.organizationId when the caller IS a member of that org", async () => {
    const app = createTestApp(asMember());
    const res = await request(app)
      .post("/api/portal/notifications/push-opened")
      .send({
        type: "handicap_case_update",
        organizationId: memberOrgId, // caller is a member
      });
    expect(res.status).toBe(200);

    const rows = await readEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0].organizationId).toBe(memberOrgId);
  });

  it("accepts a string organizationId from the push payload (Expo serialises numbers as strings)", async () => {
    // The Expo push notification `data` blob serialises every value as a
    // string on the wire. The endpoint must therefore accept the org id
    // as either a number or a numeric string and still validate
    // membership before stamping it.
    const app = createTestApp(asMember());
    const res = await request(app)
      .post("/api/portal/notifications/push-opened")
      .send({
        type: "handicap_case_update",
        organizationId: String(memberOrgId),
      });
    expect(res.status).toBe(200);

    const rows = await readEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0].organizationId).toBe(memberOrgId);
  });

  it("does NOT write a second row when the same (userId, messageId) is reported twice (Task #1564)", async () => {
    // The mobile push-tap reporter has two entry points: the cold-start
    // `getLastNotificationResponseAsync` and the warm-start
    // `addNotificationResponseReceivedListener`. On some Expo / OS
    // combinations both fire for the SAME tap, which would inflate the
    // `notification_opened` analytics count. The wire payload already
    // carries `messageId` (the Expo notification request identifier), so
    // the server dedupes on (userId, messageId) within a short window.
    const app = createTestApp(asMember());

    // First call: writes the row.
    const first = await request(app)
      .post("/api/portal/notifications/push-opened")
      .send({
        messageId: "expo-msg-dedupe-key-1564",
        type: "handicap_case_update",
        url: "/handicap",
      });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true });

    let rows = await readEvents();
    expect(rows).toHaveLength(1);

    // Second call with the same messageId (and same caller): silently
    // no-ops. The endpoint still returns 200 so the mobile tap handler
    // treats both entry points as success.
    const second = await request(app)
      .post("/api/portal/notifications/push-opened")
      .send({
        messageId: "expo-msg-dedupe-key-1564",
        type: "handicap_case_update",
        url: "/handicap",
      });
    expect(second.status).toBe(200);

    rows = await readEvents();
    expect(rows).toHaveLength(1);

    // A *different* messageId from the same user must still write — only
    // exact duplicates are suppressed, not unrelated taps.
    const third = await request(app)
      .post("/api/portal/notifications/push-opened")
      .send({
        messageId: "expo-msg-different-tap",
        type: "handicap_case_update",
      });
    expect(third.status).toBe(200);

    rows = await readEvents();
    expect(rows).toHaveLength(2);
  });

  it("does NOT dedupe when messageId is missing (Task #1564 best-effort key)", async () => {
    // The dedupe key is the Expo `messageId`. If the mobile client
    // couldn't extract one (older clients, malformed pushes), we have no
    // safe way to tell two taps apart, so we fall back to writing each
    // call as its own row rather than silently dropping legitimate
    // opens.
    const app = createTestApp(asMember());

    const first = await request(app)
      .post("/api/portal/notifications/push-opened")
      .send({ type: "handicap_case_update" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/api/portal/notifications/push-opened")
      .send({ type: "handicap_case_update" });
    expect(second.status).toBe(200);

    const rows = await readEvents();
    expect(rows).toHaveLength(2);
  });

  it("returns 200 and writes a row with null fields when the body is empty", async () => {
    // The Expo notification listener may invoke the handler with an
    // undefined `data` payload (older clients, malformed pushes). We
    // still want a row so the dashboard sees the open even if the type
    // discriminator is missing.
    const app = createTestApp(asMember());
    const res = await request(app)
      .post("/api/portal/notifications/push-opened")
      .send({});
    expect(res.status).toBe(200);

    const rows = await readEvents();
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.channel).toBe("push");
    expect(payload.pushType).toBeNull();
    expect(payload.messageId).toBeNull();
    expect(payload.url).toBeNull();
  });
});
