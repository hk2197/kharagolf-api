/**
 * Integration test: portal notification-preferences endpoint exposes
 * `isCommitteeMember` and supports the daily peer-response digest opt-out
 * (Task #754).
 *
 * Covers the case the code review flagged: a user whose app-level role is
 * `player` but whose `org_memberships` row grants `committee_member` is
 * still committee-eligible and must therefore see / be able to toggle the
 * digest preference.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  appUsersTable,
  organizationsTable,
  orgMembershipsTable,
  userNotificationPrefsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";

let orgId: number;
let playerOnlyUserId: number;
let committeeViaMembershipUserId: number;

beforeAll(async () => {
  const tag = uid("portal-prefs-committee");
  const [org] = await db.insert(organizationsTable).values({
    name: `Portal Prefs Committee Org ${tag}`,
    slug: tag,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-player`,
    username: `${tag}_player`,
    displayName: "Player Only",
    email: `${tag}-player@example.com`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  playerOnlyUserId = u1.id;

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-committee`,
    username: `${tag}_committee`,
    displayName: "Committee Via Membership",
    email: `${tag}-committee@example.com`,
    role: "player", // intentionally NOT a committee role at the app level
  }).returning({ id: appUsersTable.id });
  committeeViaMembershipUserId = u2.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId: committeeViaMembershipUserId,
    role: "committee_member",
  });
});

afterAll(async () => {
  await db.delete(userNotificationPrefsTable)
    .where(eq(userNotificationPrefsTable.userId, committeeViaMembershipUserId));
  await db.delete(userNotificationPrefsTable)
    .where(eq(userNotificationPrefsTable.userId, playerOnlyUserId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, committeeViaMembershipUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, playerOnlyUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("GET /api/portal/notification-preferences — isCommitteeMember", () => {
  it("returns isCommitteeMember=false for a plain player with no committee membership", async () => {
    const app = createTestApp({
      id: playerOnlyUserId, username: "p", role: "player",
    });
    const res = await request(app).get("/api/portal/notification-preferences");
    expect(res.status).toBe(200);
    expect(res.body.isCommitteeMember).toBe(false);
    // Default preference is opted-in (preserves existing behaviour).
    expect(res.body.notifyCommitteePeerDigest).toBe(true);
  });

  it("returns isCommitteeMember=true when the user only holds the role via org_memberships", async () => {
    const app = createTestApp({
      id: committeeViaMembershipUserId, username: "c", role: "player",
    });
    const res = await request(app).get("/api/portal/notification-preferences");
    expect(res.status).toBe(200);
    expect(res.body.isCommitteeMember).toBe(true);
    expect(res.body.notifyCommitteePeerDigest).toBe(true);
  });
});

describe("PATCH /api/portal/notification-preferences — notifyCommitteePeerDigest", () => {
  it("persists the opt-out and returns it on the next GET", async () => {
    const app = createTestApp({
      id: committeeViaMembershipUserId, username: "c", role: "player",
    });

    const patch = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyCommitteePeerDigest: false });
    expect(patch.status).toBe(200);
    expect(patch.body.notifyCommitteePeerDigest).toBe(false);

    const get = await request(app).get("/api/portal/notification-preferences");
    expect(get.status).toBe(200);
    expect(get.body.notifyCommitteePeerDigest).toBe(false);
    expect(get.body.isCommitteeMember).toBe(true);

    // Flip back on so cleanup is clean.
    const reset = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyCommitteePeerDigest: true });
    expect(reset.body.notifyCommitteePeerDigest).toBe(true);
  });
});
