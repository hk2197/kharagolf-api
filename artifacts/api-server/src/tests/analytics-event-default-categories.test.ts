/**
 * Task #1958 — Default categories for built-in event types.
 *
 * Pins the contract for `GET /events/names`:
 *   • Built-in event names (player_login, tee_booking_created, ...) ship with
 *     a default category that surfaces on a fresh org with no
 *     `analytics_event_metadata` rows at all.
 *   • Admin overrides on `analytics_event_metadata.category` win — both
 *     when the row sets a non-empty value AND, importantly, when the
 *     row exists but `category` is NULL the default still fills in
 *     (a NULL row is "no category override yet", not "explicitly
 *     uncategorized"). This matches how the Customize tab editor works:
 *     setting a category writes the row; clearing it doesn't pin
 *     "Uncategorized" forever.
 *   • Unknown event names (admin-customized strings, ad-hoc names) get
 *     no default — they remain Uncategorized until an admin assigns one.
 *   • The top-level `categories` list includes default-derived categories
 *     so the trends-page filter dropdown isn't empty on a fresh install.
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
import { and, eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgId: number;
let adminUserId: number;
let adminApp: ReturnType<typeof createTestApp>;

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const customEvent = `task1958_custom_${stamp}`;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_T1958_${stamp}`,
    slug: `test-t1958-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-t1958-admin-${stamp}`,
    username: `t1958_admin_${stamp}`,
    email: `t1958_admin_${stamp}@example.com`,
    displayName: "T1958 Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  const adminUser: TestUser = {
    id: adminUserId,
    username: `t1958_admin_${stamp}`,
    role: "org_admin",
    organizationId: orgId,
  };
  adminApp = createTestApp(adminUser);

  // Seed a couple of built-in events plus one custom name so /events/names
  // returns them. INSTRUMENTED_EVENTS would surface the built-ins anyway,
  // but firing them keeps the test honest about real-world behavior.
  await db.insert(analyticsEventsTable).values([
    { organizationId: orgId, eventName: "tee_booking_created", payload: {}, occurredAt: new Date() },
    { organizationId: orgId, eventName: "shop_checkout_completed", payload: {}, occurredAt: new Date() },
    { organizationId: orgId, eventName: customEvent, payload: {}, occurredAt: new Date() },
  ]);
});

afterAll(async () => {
  await db.delete(analyticsEventMetadataTable).where(eq(analyticsEventMetadataTable.organizationId, orgId));
  await db.delete(analyticsEventsTable).where(eq(analyticsEventsTable.organizationId, orgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("Task #1958 — default categories for built-in event types", () => {
  it("ships built-in events with a default category on a fresh org", async () => {
    const res = await request(adminApp)
      .get(`/api/organizations/${orgId}/analytics/events/names`);
    expect(res.status).toBe(200);

    const meta = res.body?.metadata ?? {};
    // Bookings bucket
    expect(meta["tee_booking_created"]?.category).toBe("Bookings");
    expect(meta["lesson_booked"]?.category).toBe("Bookings");
    // Tournaments
    expect(meta["tournament_registration"]?.category).toBe("Tournaments");
    expect(meta["scorecard_submitted"]?.category).toBe("Tournaments");
    // Commerce
    expect(meta["shop_checkout_completed"]?.category).toBe("Commerce");
    expect(meta["payment_settled"]?.category).toBe("Commerce");
    expect(meta["fb_order_placed"]?.category).toBe("Commerce");
    // Engagement
    expect(meta["notification_opened"]?.category).toBe("Engagement");
    // Authentication
    expect(meta["player_login"]?.category).toBe("Authentication");

    // The synthesized stub for default-only events should leave editor
    // attribution null so the Customize tab doesn't claim an admin
    // touched it.
    expect(meta["tee_booking_created"]?.updatedAt ?? null).toBeNull();
    expect(meta["tee_booking_created"]?.updatedByUserId ?? null).toBeNull();
    expect(meta["tee_booking_created"]?.updatedByName ?? null).toBeNull();
  });

  it("includes the default-derived categories in the top-level categories list", async () => {
    const res = await request(adminApp)
      .get(`/api/organizations/${orgId}/analytics/events/names`);
    const cats: string[] = res.body?.categories ?? [];
    expect(cats).toContain("Bookings");
    expect(cats).toContain("Tournaments");
    expect(cats).toContain("Commerce");
    expect(cats).toContain("Engagement");
    expect(cats).toContain("Authentication");
    // Deduped + sorted.
    expect(new Set(cats).size).toBe(cats.length);
    expect([...cats]).toEqual([...cats].sort((a, b) => a.localeCompare(b)));
  });

  it("does NOT assign a default to ad-hoc / custom event names", async () => {
    const res = await request(adminApp)
      .get(`/api/organizations/${orgId}/analytics/events/names`);
    const meta = res.body?.metadata ?? {};
    // Custom name has no metadata stub at all (no admin row, no
    // default), so the dashboard treats it as Uncategorized via the
    // missing-key fallback in `categoryFor()`.
    expect(meta[customEvent] ?? null).toBeNull();
  });

  it("admin-set category overrides the default", async () => {
    // Override the default Bookings → "Tee Sheet" for tee_booking_created.
    await request(adminApp)
      .put(`/api/organizations/${orgId}/analytics/events/metadata/tee_booking_created`)
      .send({ category: "Tee Sheet" })
      .expect(200);

    const res = await request(adminApp)
      .get(`/api/organizations/${orgId}/analytics/events/names`);
    const meta = res.body?.metadata ?? {};
    expect(meta["tee_booking_created"]?.category).toBe("Tee Sheet");

    // The other built-ins keep their defaults.
    expect(meta["shop_checkout_completed"]?.category).toBe("Commerce");

    const cats: string[] = res.body?.categories ?? [];
    expect(cats).toContain("Tee Sheet");
  });

  it("falls back to the default when an admin row exists but its category is NULL", async () => {
    // Save an override that touches displayName/color but leaves
    // category empty. The `normalizeMetadataInput()` helper persists
    // category as NULL in this case.
    await request(adminApp)
      .put(`/api/organizations/${orgId}/analytics/events/metadata/payment_settled`)
      .send({ displayName: "Payment Settled", color: "#22c55e", category: "" })
      .expect(200);

    // Confirm the row in the DB really has NULL category. Scope by
    // (orgId, eventName) so the assertion stays deterministic when
    // other tests in the same DB also write to "payment_settled".
    const [row] = await db.select().from(analyticsEventMetadataTable)
      .where(and(
        eq(analyticsEventMetadataTable.organizationId, orgId),
        eq(analyticsEventMetadataTable.eventName, "payment_settled"),
      ));
    expect(row).toBeTruthy();
    expect(row.category ?? null).toBeNull();

    // The endpoint should still expose the default category for that event.
    const res = await request(adminApp)
      .get(`/api/organizations/${orgId}/analytics/events/names`);
    const meta = res.body?.metadata ?? {};
    expect(meta["payment_settled"]?.category).toBe("Commerce");
    // …while preserving the admin-set displayName / color on the same row.
    expect(meta["payment_settled"]?.displayName).toBe("Payment Settled");
    expect(meta["payment_settled"]?.color).toBe("#22c55e");
  });
});
