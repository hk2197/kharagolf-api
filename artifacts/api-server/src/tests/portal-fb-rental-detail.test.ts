/**
 * Integration tests: member-facing F&B order + rental booking detail
 * endpoints introduced in Task #1728 to back the new web detail pages
 * (`/fb-orders/:orderId` and `/rentals/bookings/:bookingId`).
 *
 *   GET /api/organizations/:orgId/fb/orders/:orderId/mine
 *   GET /api/organizations/:orgId/rentals/bookings/:bookingId/mine
 *
 * Both routes scope strictly to the caller's own record (userId for F&B,
 * bookedByUserId for rentals) and 404 otherwise so we don't leak the
 * existence of another member's records. Without coverage, a future
 * refactor could relax the user filter and accidentally expose other
 * members' orders/bookings to anyone who guesses the id.
 *
 * The F&B endpoint also returns line items inline; the rentals endpoint
 * joins through the asset and category so the page can render the item
 * name without a second round-trip. We pin both shapes here.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  fbOrdersTable,
  fbOrderItemsTable,
  rentalCategoriesTable,
  rentalAssetsTable,
  rentalBookingsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgId: number;
let userId: number;
let otherUserId: number;
let actor: TestUser;
let app: ReturnType<typeof createTestApp>;

let ownFbOrderId: number;
let otherFbOrderId: number;
const fbItemIds: number[] = [];

let categoryId: number;
let assetId: number;
let otherAssetId: number;
let ownRentalId: number;
let otherRentalId: number;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `FbRentalDetailTest_${stamp}`,
    slug: `fb-rental-detail-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `fb-rental-detail-${stamp}`,
    username: `fb_rental_detail_${stamp}`,
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = user.id;

  const [other] = await db.insert(appUsersTable).values({
    replitUserId: `fb-rental-detail-other-${stamp}`,
    username: `fb_rental_detail_other_${stamp}`,
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  otherUserId = other.id;

  // ─── F&B order seed data ──────────────────────────────────────────────
  const [ownOrder] = await db.insert(fbOrdersTable).values({
    organizationId: orgId,
    userId,
    totalAmount: "23.50",
    currency: "INR",
    status: "ready",
    holeNumber: 7,
    notes: "No onions",
  }).returning({ id: fbOrdersTable.id });
  ownFbOrderId = ownOrder.id;

  const [item1] = await db.insert(fbOrderItemsTable).values({
    orderId: ownFbOrderId,
    name: "Club Sandwich",
    price: "12.00",
    quantity: 1,
    modifierTotal: "1.50",
  }).returning({ id: fbOrderItemsTable.id });
  fbItemIds.push(item1.id);
  const [item2] = await db.insert(fbOrderItemsTable).values({
    orderId: ownFbOrderId,
    name: "Iced Tea",
    price: "5.00",
    quantity: 2,
    modifierTotal: "0",
  }).returning({ id: fbOrderItemsTable.id });
  fbItemIds.push(item2.id);

  const [otherOrder] = await db.insert(fbOrdersTable).values({
    organizationId: orgId,
    userId: otherUserId,
    totalAmount: "9.00",
    status: "received",
  }).returning({ id: fbOrdersTable.id });
  otherFbOrderId = otherOrder.id;

  // ─── Rental booking seed data ─────────────────────────────────────────
  const [category] = await db.insert(rentalCategoriesTable).values({
    organizationId: orgId,
    name: "Pull Trolleys",
    icon: "package",
  }).returning({ id: rentalCategoriesTable.id });
  categoryId = category.id;

  const [asset] = await db.insert(rentalAssetsTable).values({
    organizationId: orgId,
    categoryId,
    assetCode: `TROLLEY_OWN_${stamp}`,
    description: "Carbon trolley #1",
  }).returning({ id: rentalAssetsTable.id });
  assetId = asset.id;

  // Active-asset uniqueness forbids two reservations on the same asset,
  // so the other user's booking needs a different asset row.
  const [otherAsset] = await db.insert(rentalAssetsTable).values({
    organizationId: orgId,
    categoryId,
    assetCode: `TROLLEY_OTHER_${stamp}`,
  }).returning({ id: rentalAssetsTable.id });
  otherAssetId = otherAsset.id;

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const [ownRental] = await db.insert(rentalBookingsTable).values({
    organizationId: orgId,
    assetId,
    bookedByUserId: userId,
    rentalDate: tomorrow,
    expectedReturnAt: new Date(tomorrow.getTime() + 4 * 60 * 60 * 1000),
    rateCharged: "15.00",
    currency: "INR",
    status: "reserved",
    notes: "Pickup at clubhouse",
  }).returning({ id: rentalBookingsTable.id });
  ownRentalId = ownRental.id;

  const [otherRental] = await db.insert(rentalBookingsTable).values({
    organizationId: orgId,
    assetId: otherAssetId,
    bookedByUserId: otherUserId,
    rentalDate: tomorrow,
    status: "reserved",
  }).returning({ id: rentalBookingsTable.id });
  otherRentalId = otherRental.id;

  actor = {
    id: userId,
    username: `fb_rental_detail_${stamp}`,
    role: "player",
    organizationId: orgId,
  };
  app = createTestApp(actor);
});

afterAll(async () => {
  if (ownRentalId || otherRentalId) {
    await db.delete(rentalBookingsTable).where(
      inArray(rentalBookingsTable.id, [ownRentalId, otherRentalId].filter(Boolean) as number[]),
    );
  }
  if (assetId || otherAssetId) {
    await db.delete(rentalAssetsTable).where(
      inArray(rentalAssetsTable.id, [assetId, otherAssetId].filter(Boolean) as number[]),
    );
  }
  if (categoryId) {
    await db.delete(rentalCategoriesTable).where(eq(rentalCategoriesTable.id, categoryId));
  }
  if (fbItemIds.length) {
    await db.delete(fbOrderItemsTable).where(inArray(fbOrderItemsTable.id, fbItemIds));
  }
  if (ownFbOrderId || otherFbOrderId) {
    await db.delete(fbOrdersTable).where(
      inArray(fbOrdersTable.id, [ownFbOrderId, otherFbOrderId].filter(Boolean) as number[]),
    );
  }
  if (userId || otherUserId) {
    await db.delete(appUsersTable).where(
      inArray(appUsersTable.id, [userId, otherUserId].filter(Boolean) as number[]),
    );
  }
  if (orgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  }
});

describe("GET /organizations/:orgId/fb/orders/:orderId/mine (Task #1728)", () => {
  it("returns the caller's order with line items inlined", async () => {
    const res = await request(app).get(`/api/organizations/${orgId}/fb/orders/${ownFbOrderId}/mine`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ownFbOrderId);
    expect(res.body.userId).toBe(userId);
    expect(res.body.totalAmount).toBe("23.50");
    expect(res.body.holeNumber).toBe(7);
    expect(res.body.notes).toBe("No onions");
    // The handler inlines the line items so the page can render the
    // receipt without a second round-trip.
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBe(2);
    const names = res.body.items.map((it: { name: string }) => it.name).sort();
    expect(names).toEqual(["Club Sandwich", "Iced Tea"]);
  });

  it("404s when the order belongs to another member (no leak of existence)", async () => {
    // Another member's order id is real and exists in the same org, so
    // anything other than 404 here would let a guesser confirm they
    // exist. Pin the privacy contract.
    const res = await request(app).get(`/api/organizations/${orgId}/fb/orders/${otherFbOrderId}/mine`);
    expect(res.status).toBe(404);
  });

  it("404s when the order id doesn't exist", async () => {
    const res = await request(app).get(`/api/organizations/${orgId}/fb/orders/9999999/mine`);
    expect(res.status).toBe(404);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const anon = createTestApp();
    const res = await request(anon).get(`/api/organizations/${orgId}/fb/orders/${ownFbOrderId}/mine`);
    expect(res.status).toBe(401);
  });
});

describe("GET /organizations/:orgId/rentals/bookings/:bookingId/mine (Task #1728)", () => {
  it("returns the caller's booking with asset + category fields joined in", async () => {
    const res = await request(app).get(`/api/organizations/${orgId}/rentals/bookings/${ownRentalId}/mine`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ownRentalId);
    expect(res.body.bookedByUserId).toBe(userId);
    expect(res.body.status).toBe("reserved");
    expect(res.body.rateCharged).toBe("15.00");
    expect(res.body.currency).toBe("INR");
    // Asset + category names come back inline so the detail page can
    // render "Pull Trolleys · TROLLEY_OWN_xxx" without extra fetches.
    expect(res.body.assetCode).toBe(`TROLLEY_OWN_${stamp}`);
    expect(res.body.assetDescription).toBe("Carbon trolley #1");
    expect(res.body.categoryName).toBe("Pull Trolleys");
    expect(res.body.categoryIcon).toBe("package");
  });

  it("404s when the booking belongs to another member (no leak of existence)", async () => {
    const res = await request(app).get(`/api/organizations/${orgId}/rentals/bookings/${otherRentalId}/mine`);
    expect(res.status).toBe(404);
  });

  it("404s when the booking id doesn't exist", async () => {
    const res = await request(app).get(`/api/organizations/${orgId}/rentals/bookings/9999999/mine`);
    expect(res.status).toBe(404);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const anon = createTestApp();
    const res = await request(anon).get(`/api/organizations/${orgId}/rentals/bookings/${ownRentalId}/mine`);
    expect(res.status).toBe(401);
  });
});

// ─── Task #2146 — self-service cancel ─────────────────────────────────
//
// Companion to GET /mine: lets the booker flip a `reserved` rental to
// `cancelled` from the web detail page without involving the pro shop.
// The same access shape applies (404 when the booking belongs to someone
// else, 401 when unauthenticated) and the response mirrors the /mine
// shape so the page can replace its local state in one round-trip.
describe("POST /organizations/:orgId/rentals/bookings/:bookingId/cancel/mine (Task #2146)", () => {
  // Use a dedicated booking so the rest of the suite keeps a `reserved`
  // row to test against. Each cancel test inserts and tears down its own
  // record to avoid bleeding state across cases.
  async function seedReservation(forUserId: number) {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    // Same uniqueness constraint as the seed above — give every cancel
    // case its own asset row so concurrent reservations are valid.
    const [a] = await db.insert(rentalAssetsTable).values({
      organizationId: orgId,
      categoryId,
      assetCode: `CANCEL_${stamp}_${Math.random().toString(36).slice(2, 7)}`,
    }).returning({ id: rentalAssetsTable.id });
    const [b] = await db.insert(rentalBookingsTable).values({
      organizationId: orgId,
      assetId: a.id,
      bookedByUserId: forUserId,
      rentalDate: tomorrow,
      status: "reserved",
    }).returning({ id: rentalBookingsTable.id });
    return { assetId: a.id, bookingId: b.id };
  }

  async function cleanup(ids: { assetId: number; bookingId: number }) {
    await db.delete(rentalBookingsTable).where(eq(rentalBookingsTable.id, ids.bookingId));
    await db.delete(rentalAssetsTable).where(eq(rentalAssetsTable.id, ids.assetId));
  }

  it("cancels a reserved booking and returns the updated row in /mine shape", async () => {
    const seed = await seedReservation(userId);
    try {
      const res = await request(app)
        .post(`/api/organizations/${orgId}/rentals/bookings/${seed.bookingId}/cancel/mine`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(seed.bookingId);
      expect(res.body.status).toBe("cancelled");
      // The handler re-joins assets + categories so the page can render
      // the cancelled state without another round-trip.
      expect(res.body.assetCode).toMatch(/^CANCEL_/);
      expect(res.body.categoryName).toBe("Pull Trolleys");

      // Persisted in the database too.
      const [row] = await db
        .select({ status: rentalBookingsTable.status })
        .from(rentalBookingsTable)
        .where(eq(rentalBookingsTable.id, seed.bookingId));
      expect(row.status).toBe("cancelled");
    } finally {
      await cleanup(seed);
    }
  });

  it("404s when the booking belongs to another member", async () => {
    const seed = await seedReservation(otherUserId);
    try {
      const res = await request(app)
        .post(`/api/organizations/${orgId}/rentals/bookings/${seed.bookingId}/cancel/mine`);
      expect(res.status).toBe(404);
      // And the row was not mutated.
      const [row] = await db
        .select({ status: rentalBookingsTable.status })
        .from(rentalBookingsTable)
        .where(eq(rentalBookingsTable.id, seed.bookingId));
      expect(row.status).toBe("reserved");
    } finally {
      await cleanup(seed);
    }
  });

  it("404s when the booking id doesn't exist", async () => {
    const res = await request(app)
      .post(`/api/organizations/${orgId}/rentals/bookings/9999999/cancel/mine`);
    expect(res.status).toBe(404);
  });

  it.each(["checked_out", "returned", "cancelled"] as const)(
    "409s when the booking is already %s (no-op state)",
    async status => {
      const seed = await seedReservation(userId);
      try {
        await db.update(rentalBookingsTable)
          .set({ status })
          .where(eq(rentalBookingsTable.id, seed.bookingId));

        const res = await request(app)
          .post(`/api/organizations/${orgId}/rentals/bookings/${seed.bookingId}/cancel/mine`);
        expect(res.status).toBe(409);
        // Status stays put — the conflict response must not mutate the row.
        const [row] = await db
          .select({ status: rentalBookingsTable.status })
          .from(rentalBookingsTable)
          .where(eq(rentalBookingsTable.id, seed.bookingId));
        expect(row.status).toBe(status);
      } finally {
        await cleanup(seed);
      }
    },
  );

  it("rejects unauthenticated callers with 401", async () => {
    const seed = await seedReservation(userId);
    try {
      const anon = createTestApp();
      const res = await request(anon)
        .post(`/api/organizations/${orgId}/rentals/bookings/${seed.bookingId}/cancel/mine`);
      expect(res.status).toBe(401);
    } finally {
      await cleanup(seed);
    }
  });
});
