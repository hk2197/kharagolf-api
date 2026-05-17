/**
 * Analytics event metadata: category column (Task #1569).
 *
 * Routes under test (mounted under /api/organizations/:orgId/analytics):
 *   GET  /events/names                — returns metadata[evt].category and a
 *                                        top-level `categories` array
 *   GET  /events/metadata             — returns category for each row
 *   PUT  /events/metadata/:eventName  — accepts/persists category (max 64)
 *
 * Guards:
 *   - PUT round-trips the category and exposes it on subsequent GETs.
 *   - GET /events/names exposes a deduped non-empty categories list.
 *   - PUT rejects category strings longer than 64 chars.
 *   - Empty/null category clears the field.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  analyticsEventsTable,
  analyticsEventMetadataTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgId: number;
let adminUserId: number;
let adminUser: TestUser;
let adminApp: ReturnType<typeof createTestApp>;

const stamp = Date.now();
const evtA = `task1569_evt_a_${stamp}`;
const evtB = `task1569_evt_b_${stamp}`;
const evtC = `task1569_evt_c_${stamp}`;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_T1569_${stamp}`,
    slug: `test-t1569-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-t1569-admin-${stamp}`,
    username: `t1569_admin_${stamp}`,
    email: `t1569_admin_${stamp}@example.com`,
    displayName: "T1569 Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  adminUser = {
    id: adminUserId,
    username: `t1569_admin_${stamp}`,
    role: "org_admin",
    organizationId: orgId,
  };
  adminApp = createTestApp(adminUser);

  // Seed a few analytics events so /events/names returns them.
  await db.insert(analyticsEventsTable).values([
    { organizationId: orgId, eventName: evtA, payload: {}, occurredAt: new Date() },
    { organizationId: orgId, eventName: evtB, payload: {}, occurredAt: new Date() },
    { organizationId: orgId, eventName: evtC, payload: {}, occurredAt: new Date() },
  ]);
});

afterAll(async () => {
  await db.delete(analyticsEventMetadataTable).where(eq(analyticsEventMetadataTable.organizationId, orgId));
  await db.delete(analyticsEventsTable).where(eq(analyticsEventsTable.organizationId, orgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("Task #1569 — analytics event metadata category", () => {
  it("PUT persists category, GET /events/metadata returns it", async () => {
    const putRes = await request(adminApp)
      .put(`/api/organizations/${orgId}/analytics/events/metadata/${evtA}`)
      .send({ displayName: "Event A", category: "Bookings" });
    expect(putRes.status).toBe(200);
    expect(putRes.body?.metadata?.category).toBe("Bookings");

    const getRes = await request(adminApp)
      .get(`/api/organizations/${orgId}/analytics/events/metadata`);
    expect(getRes.status).toBe(200);
    const found = (getRes.body?.metadata ?? []).find((m: any) => m.eventName === evtA);
    expect(found).toBeTruthy();
    expect(found.category).toBe("Bookings");
  });

  it("GET /events/names exposes categories list and per-event category", async () => {
    await request(adminApp)
      .put(`/api/organizations/${orgId}/analytics/events/metadata/${evtB}`)
      .send({ category: "Payments" });
    await request(adminApp)
      .put(`/api/organizations/${orgId}/analytics/events/metadata/${evtC}`)
      .send({ category: "Bookings" });

    const namesRes = await request(adminApp)
      .get(`/api/organizations/${orgId}/analytics/events/names`);
    expect(namesRes.status).toBe(200);

    expect(Array.isArray(namesRes.body?.categories)).toBe(true);
    const cats: string[] = namesRes.body.categories;
    expect(cats).toContain("Bookings");
    expect(cats).toContain("Payments");
    // Deduped:
    expect(new Set(cats).size).toBe(cats.length);

    const meta = namesRes.body?.metadata ?? {};
    expect(meta[evtA]?.category).toBe("Bookings");
    expect(meta[evtB]?.category).toBe("Payments");
    expect(meta[evtC]?.category).toBe("Bookings");
  });

  it("PUT silently truncates category at 64 chars (consistent with other text fields)", async () => {
    const tooLong = "x".repeat(80);
    const res = await request(adminApp)
      .put(`/api/organizations/${orgId}/analytics/events/metadata/${evtA}`)
      .send({ category: tooLong });
    expect(res.status).toBe(200);
    expect(res.body?.metadata?.category).toBe("x".repeat(64));
  });

  it("PUT with empty category clears the field", async () => {
    const res = await request(adminApp)
      .put(`/api/organizations/${orgId}/analytics/events/metadata/${evtA}`)
      .send({ displayName: "Event A", category: "" });
    expect(res.status).toBe(200);
    expect(res.body?.metadata?.category ?? null).toBeNull();

    const namesRes = await request(adminApp)
      .get(`/api/organizations/${orgId}/analytics/events/names`);
    const meta = namesRes.body?.metadata ?? {};
    expect(meta[evtA]?.category ?? null).toBeNull();
    // "Bookings" should still be present because evtC keeps it.
    expect(namesRes.body.categories).toContain("Bookings");
  });
});
