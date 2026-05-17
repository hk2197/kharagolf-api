/**
 * Integration tests: unified portal "Upcoming" list — Task #1424.
 *
 * GET /api/portal/my-upcoming reads from FIVE different tables (tee, lessons,
 * range, F&B, rentals — see `routes/wave3.ts`). Each reader filters by user
 * and (where applicable) status, and the route merges them into a single
 * capped list pinned with in-flight F&B orders followed by scheduled rows
 * sorted ascending by `startsAt`.
 *
 * Without coverage, an unrelated change to any of those tables (renaming a
 * status value, dropping a `userId` column, swapping enum defaults) could
 * silently break the home widget for every member. These tests pin the
 * behaviour:
 *
 *   - One row of each kind seeded for the caller is returned.
 *   - A `cancelled` lesson belonging to the caller is excluded (status filter).
 *   - Rows belonging to a different user are NOT leaked (user filter).
 *   - Items come back ascending by `startsAt`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  coursesTable,
  courseTeeSlotTable,
  teeBookingsTable,
  teachingProsTable,
  lessonTypesTable,
  lessonBookingsTable,
  rangeBayTable,
  rangeBookingTable,
  fbOrdersTable,
  rentalCategoriesTable,
  rentalAssetsTable,
  rentalBookingsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgId: number;
let courseId: number;
let proId: number;
let lessonTypeId: number;
let bayId: number;
let rentalCategoryId: number;
let rentalAssetId: number;

let userId: number;
let otherUserId: number;
let actor: TestUser;
let app: ReturnType<typeof createTestApp>;

// Per-row ids we insert, tracked for tidy teardown.
const teeBookingIds: number[] = [];
const teeSlotIds: number[] = [];
const lessonBookingIds: number[] = [];
const rangeBookingIds: number[] = [];
const fbOrderIds: number[] = [];
const rentalBookingIds: number[] = [];

// Future timestamps spaced one day apart so we can assert ordering.
const day = 24 * 60 * 60 * 1000;
const teeAt = new Date(Date.now() + 1 * day);
const lessonAt = new Date(Date.now() + 2 * day);
const rangeAt = new Date(Date.now() + 3 * day);
const rentalAt = new Date(Date.now() + 4 * day);
// Excluded cancelled lesson — sits between tee and lesson on the timeline so
// if the status filter was dropped we'd see it appear in the results in
// position #2 (right after the fb pin) and the assertion would fail.
const cancelledLessonAt = new Date(Date.now() + 1.5 * day);
// Excluded cancelled tee — sits between tee and lesson on the timeline so
// if the tee reader's status filter (Task #1713) was dropped we'd see it
// appear in the results and the assertion would fail.
const cancelledTeeAt = new Date(Date.now() + 1.25 * day);

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `MyUpcomingTest_${stamp}`,
    slug: `my-upcoming-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `my-upcoming-${stamp}`,
    username: `my_upcoming_${stamp}`,
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = user.id;

  const [other] = await db.insert(appUsersTable).values({
    replitUserId: `my-upcoming-other-${stamp}`,
    username: `my_upcoming_other_${stamp}`,
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  otherUserId = other.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "Upcoming Test Course",
    slug: `upcoming-course-${stamp}`,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [pro] = await db.insert(teachingProsTable).values({
    organizationId: orgId,
    displayName: "Upcoming Test Pro",
  }).returning({ id: teachingProsTable.id });
  proId = pro.id;

  const [lessonType] = await db.insert(lessonTypesTable).values({
    organizationId: orgId,
    proId,
    name: "Upcoming 30min",
    durationMinutes: 30,
  }).returning({ id: lessonTypesTable.id });
  lessonTypeId = lessonType.id;

  const [bay] = await db.insert(rangeBayTable).values({
    organizationId: orgId,
    bayNumber: 1,
  }).returning({ id: rangeBayTable.id });
  bayId = bay.id;

  const [rentalCategory] = await db.insert(rentalCategoriesTable).values({
    organizationId: orgId,
    name: "Test Trolleys",
  }).returning({ id: rentalCategoriesTable.id });
  rentalCategoryId = rentalCategory.id;

  const [rentalAsset] = await db.insert(rentalAssetsTable).values({
    organizationId: orgId,
    categoryId: rentalCategoryId,
    assetCode: `TROLLEY_${stamp}`,
  }).returning({ id: rentalAssetsTable.id });
  rentalAssetId = rentalAsset.id;

  // ─── Caller's bookings (the rows we expect to see) ────────────────────
  // 1) Tee booking at +1 day.
  const [teeSlot] = await db.insert(courseTeeSlotTable).values({
    courseId, organizationId: orgId,
    slotDate: teeAt, slotTime: "08:00", capacity: 4,
  }).returning({ id: courseTeeSlotTable.id });
  teeSlotIds.push(teeSlot.id);
  const [teeBooking] = await db.insert(teeBookingsTable).values({
    slotId: teeSlot.id,
    organizationId: orgId,
    leadUserId: userId,
    partySize: 1,
    status: "confirmed",
  }).returning({ id: teeBookingsTable.id });
  teeBookingIds.push(teeBooking.id);

  // 2) Lesson booking at +2 day, status confirmed.
  const [lessonBooking] = await db.insert(lessonBookingsTable).values({
    organizationId: orgId,
    proId, lessonTypeId,
    userId,
    memberName: "Upcoming Test Member",
    scheduledAt: lessonAt,
    durationMinutes: 30,
    status: "confirmed",
  }).returning({ id: lessonBookingsTable.id });
  lessonBookingIds.push(lessonBooking.id);

  // 3) Range booking at +3 day, status confirmed.
  const [rangeBooking] = await db.insert(rangeBookingTable).values({
    organizationId: orgId,
    bayId,
    userId,
    slotDate: rangeAt,
    slotTime: "10:00",
    durationMinutes: 30,
    status: "confirmed",
  }).returning({ id: rangeBookingTable.id });
  rangeBookingIds.push(rangeBooking.id);

  // 4) Rental booking at +4 day, status reserved.
  const [rentalBooking] = await db.insert(rentalBookingsTable).values({
    organizationId: orgId,
    assetId: rentalAssetId,
    bookedByUserId: userId,
    rentalDate: rentalAt,
    status: "reserved",
  }).returning({ id: rentalBookingsTable.id });
  rentalBookingIds.push(rentalBooking.id);

  // 5) F&B order, status received (in-flight, no future startsAt).
  const [fbOrder] = await db.insert(fbOrdersTable).values({
    organizationId: orgId,
    userId,
    totalAmount: "12.50",
    status: "received",
  }).returning({ id: fbOrdersTable.id });
  fbOrderIds.push(fbOrder.id);

  // ─── Excluded rows ────────────────────────────────────────────────────
  // (a) Caller's CANCELLED lesson at +1.5 day. The route filters
  //     `status IN ('pending', 'confirmed')` so this must NOT be returned.
  const [cancelledLesson] = await db.insert(lessonBookingsTable).values({
    organizationId: orgId,
    proId, lessonTypeId,
    userId,
    memberName: "Upcoming Test Member",
    scheduledAt: cancelledLessonAt,
    durationMinutes: 30,
    status: "cancelled",
  }).returning({ id: lessonBookingsTable.id });
  lessonBookingIds.push(cancelledLesson.id);

  // (a2) Caller's CANCELLED tee booking at +1.25 day. Task #1713 made the
  //      tee reader filter `status IN ('pending', 'confirmed')` to match
  //      the lesson/range/rental pattern, so this must NOT be returned.
  const [cancelledTeeSlot] = await db.insert(courseTeeSlotTable).values({
    courseId, organizationId: orgId,
    slotDate: cancelledTeeAt, slotTime: "07:30", capacity: 4,
  }).returning({ id: courseTeeSlotTable.id });
  teeSlotIds.push(cancelledTeeSlot.id);
  const [cancelledTee] = await db.insert(teeBookingsTable).values({
    slotId: cancelledTeeSlot.id,
    organizationId: orgId,
    leadUserId: userId,
    partySize: 1,
    status: "cancelled",
  }).returning({ id: teeBookingsTable.id });
  teeBookingIds.push(cancelledTee.id);

  // (b) OTHER user's bookings (one of each kind). None should leak into
  //     our caller's response — the readers all filter by user id.
  const [otherTeeSlot] = await db.insert(courseTeeSlotTable).values({
    courseId, organizationId: orgId,
    slotDate: teeAt, slotTime: "09:00", capacity: 4,
  }).returning({ id: courseTeeSlotTable.id });
  teeSlotIds.push(otherTeeSlot.id);
  const [otherTee] = await db.insert(teeBookingsTable).values({
    slotId: otherTeeSlot.id, organizationId: orgId,
    leadUserId: otherUserId, partySize: 1, status: "confirmed",
  }).returning({ id: teeBookingsTable.id });
  teeBookingIds.push(otherTee.id);

  const [otherLesson] = await db.insert(lessonBookingsTable).values({
    organizationId: orgId, proId, lessonTypeId,
    userId: otherUserId, memberName: "Other Member",
    scheduledAt: lessonAt, durationMinutes: 30, status: "confirmed",
  }).returning({ id: lessonBookingsTable.id });
  lessonBookingIds.push(otherLesson.id);

  const [otherRange] = await db.insert(rangeBookingTable).values({
    organizationId: orgId, bayId,
    userId: otherUserId,
    slotDate: rangeAt, slotTime: "11:00",
    durationMinutes: 30, status: "confirmed",
  }).returning({ id: rangeBookingTable.id });
  rangeBookingIds.push(otherRange.id);

  const [otherFb] = await db.insert(fbOrdersTable).values({
    organizationId: orgId, userId: otherUserId,
    totalAmount: "5.00", status: "received",
  }).returning({ id: fbOrdersTable.id });
  fbOrderIds.push(otherFb.id);

  // The active-asset unique index forbids two simultaneous reservations on
  // the same asset, so the other user's rental needs a separate asset row.
  const [otherAsset] = await db.insert(rentalAssetsTable).values({
    organizationId: orgId, categoryId: rentalCategoryId,
    assetCode: `TROLLEY_OTHER_${stamp}`,
  }).returning({ id: rentalAssetsTable.id });
  const [otherRental] = await db.insert(rentalBookingsTable).values({
    organizationId: orgId, assetId: otherAsset.id,
    bookedByUserId: otherUserId,
    rentalDate: rentalAt, status: "reserved",
  }).returning({ id: rentalBookingsTable.id });
  rentalBookingIds.push(otherRental.id);
  // Track for cleanup (asset removal happens via the categoriesTable → assets
  // cascade, but we delete bookings first to free the FK).

  actor = { id: userId, username: `my_upcoming_${stamp}`, role: "player", organizationId: orgId };
  app = createTestApp(actor);
});

afterAll(async () => {
  if (rentalBookingIds.length) {
    await db.delete(rentalBookingsTable).where(inArray(rentalBookingsTable.id, rentalBookingIds));
  }
  if (fbOrderIds.length) {
    await db.delete(fbOrdersTable).where(inArray(fbOrdersTable.id, fbOrderIds));
  }
  if (rangeBookingIds.length) {
    await db.delete(rangeBookingTable).where(inArray(rangeBookingTable.id, rangeBookingIds));
  }
  if (lessonBookingIds.length) {
    await db.delete(lessonBookingsTable).where(inArray(lessonBookingsTable.id, lessonBookingIds));
  }
  if (teeBookingIds.length) {
    await db.delete(teeBookingsTable).where(inArray(teeBookingsTable.id, teeBookingIds));
  }
  if (teeSlotIds.length) {
    await db.delete(courseTeeSlotTable).where(inArray(courseTeeSlotTable.id, teeSlotIds));
  }
  // Org cascade tears the rest down (rental assets/categories, range bay,
  // lesson types, teaching pros, courses, users).
  if (orgId) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, [userId, otherUserId].filter(Boolean) as number[]));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  }
});

describe("portal /my-upcoming", () => {
  it("returns one row per booking type, excludes cancelled + other-user rows, and orders by startsAt", async () => {
    const res = await request(app).get("/api/portal/my-upcoming");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);

    const items: Array<{ kind: string; id: number; organizationId: number; startsAt: string }> = res.body.items;

    // --- Merge: every kind we seeded for the caller is present.
    const byKind = new Map(items.map((i) => [i.kind, i]));
    expect(byKind.has("tee")).toBe(true);
    expect(byKind.has("lesson")).toBe(true);
    expect(byKind.has("range")).toBe(true);
    expect(byKind.has("rental")).toBe(true);
    expect(byKind.has("fb")).toBe(true);

    // The exact ids should match what we inserted for the caller.
    expect(byKind.get("tee")!.id).toBe(teeBookingIds[0]);
    expect(byKind.get("lesson")!.id).toBe(lessonBookingIds[0]);
    expect(byKind.get("range")!.id).toBe(rangeBookingIds[0]);
    expect(byKind.get("rental")!.id).toBe(rentalBookingIds[0]);
    expect(byKind.get("fb")!.id).toBe(fbOrderIds[0]);

    // --- Exclusion: the cancelled lesson + cancelled tee are not present,
    // and none of the other user's rows leaked through.
    const cancelledLessonId = lessonBookingIds[1];
    const cancelledTeeId = teeBookingIds[1];
    const otherTeeId = teeBookingIds[2];
    const otherLessonId = lessonBookingIds[2];
    const otherRangeId = rangeBookingIds[1];
    const otherFbId = fbOrderIds[1];
    const otherRentalId = rentalBookingIds[1];

    const presentLessonIds = items.filter((i) => i.kind === "lesson").map((i) => i.id);
    expect(presentLessonIds).not.toContain(cancelledLessonId);
    expect(presentLessonIds).not.toContain(otherLessonId);
    const presentTeeIds = items.filter((i) => i.kind === "tee").map((i) => i.id);
    expect(presentTeeIds).not.toContain(cancelledTeeId);
    expect(presentTeeIds).not.toContain(otherTeeId);
    expect(items.find((i) => i.kind === "range" && i.id === otherRangeId)).toBeUndefined();
    expect(items.find((i) => i.kind === "fb" && i.id === otherFbId)).toBeUndefined();
    expect(items.find((i) => i.kind === "rental" && i.id === otherRentalId)).toBeUndefined();

    // Exactly the five caller rows — no more, no less.
    expect(items.length).toBe(5);

    // --- Ordering: ascending by `startsAt`. F&B uses `createdAt` as its
    // startsAt (in the past) so it naturally lands first; the other four
    // are spaced one day apart in the future.
    const times = items.map((i) => new Date(i.startsAt).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    }

    // Concretely: fb (now-ish) → tee (+1d) → lesson (+2d) → range (+3d) → rental (+4d).
    expect(items.map((i) => i.kind)).toEqual(["fb", "tee", "lesson", "range", "rental"]);
  });

  it("caps the merged response at 20 items, with pinned F&B counted in the cap", async () => {
    // Seed enough additional in-flight F&B orders + future lessons for the
    // caller that the merged list would exceed 20 without the slice. F&B is
    // pinned ahead of scheduled rows, so the cap must apply to the combined
    // list (not to each category independently).
    const extraFbIds: number[] = [];
    const extraLessonIds: number[] = [];
    try {
      // 4 more F&B in-flight orders → 5 fb total (the original + these).
      for (let i = 0; i < 4; i++) {
        const [row] = await db.insert(fbOrdersTable).values({
          organizationId: orgId, userId,
          totalAmount: "1.00",
          status: i % 2 === 0 ? "preparing" : "ready",
        }).returning({ id: fbOrdersTable.id });
        extraFbIds.push(row.id);
      }
      // 20 more confirmed future lessons. With the original 5 caller rows
      // (1 of each kind) that's 1+1+1+1 scheduled + 5 fb + 20 = 25 candidate
      // rows pre-cap → response must be truncated to 20.
      for (let i = 0; i < 20; i++) {
        const [row] = await db.insert(lessonBookingsTable).values({
          organizationId: orgId, proId, lessonTypeId,
          userId,
          memberName: "Cap Test Member",
          // Scatter scheduledAt across +5..+25 days so they sort after the
          // original 5 caller rows.
          scheduledAt: new Date(Date.now() + (5 + i) * day),
          durationMinutes: 30,
          status: "confirmed",
        }).returning({ id: lessonBookingsTable.id });
        extraLessonIds.push(row.id);
      }

      const res = await request(app).get("/api/portal/my-upcoming");
      expect(res.status).toBe(200);
      const items: Array<{ kind: string }> = res.body.items;
      expect(items.length).toBe(20);
      // All 5 fb rows pin to the front (route puts fb first, before the
      // ascending-by-startsAt scheduled list).
      expect(items.slice(0, 5).every((i) => i.kind === "fb")).toBe(true);
    } finally {
      if (extraLessonIds.length) {
        await db.delete(lessonBookingsTable).where(inArray(lessonBookingsTable.id, extraLessonIds));
      }
      if (extraFbIds.length) {
        await db.delete(fbOrdersTable).where(inArray(fbOrdersTable.id, extraFbIds));
      }
    }
  });
});
