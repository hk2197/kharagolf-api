/**
 * Test: GET /api/marketplace-discover/slots (Task #841).
 *
 * The cross-club marketplace search endpoint powers the player-facing
 * tee-time discovery list. Unlike the live count endpoint (covered by
 * marketplace-discover-slot-counts.test.ts) it returns full slot rows
 * and supports a wide filter / sort / pagination surface, so a
 * regression in any one of those would silently ship broken search
 * results.
 *
 * This spec exercises the endpoint with a mix of open / full / private
 * / closed / past-dated slots across multiple clubs and asserts only
 * matching slots come back. Each filter parameter (fromDate, toDate,
 * daysOfWeek, orgIds, courseIds, lat/lng/radiusKm, minSpots,
 * maxPricePaise, surge), all three sort modes (date, price, distance)
 * and pagination (limit/offset) are covered.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import {
  db,
  organizationsTable,
  marketplaceSlotsTable,
  coursesTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgAId: number;
let orgBId: number;
let orgCId: number;
let orgDisabledId: number;
let orgNoCoordsId: number;
let courseAId: number;
let courseBId: number;
const slotIds: number[] = [];
const app = createTestApp();

interface SlotRow {
  id: number;
  organizationId: number;
  courseId: number | null;
  slotDate: string;
  pricePaise: number;
  spotsLeft: number;
  surgeIndicator: string;
  distanceKm: number | null;
}

/**
 * Build a marketplace slot. `slotDate` may be supplied directly (for
 * day-of-week tests) or via `daysAhead` for the common case.
 */
async function makeSlot(
  orgId: number,
  opts: {
    daysAhead?: number;
    slotDate?: Date;
    isPublic?: boolean;
    status?: string;
    pricePaise?: number;
    maxPlayers?: number;
    bookedPlayers?: number;
    surgeIndicator?: "off_peak" | "normal" | "surge";
    courseId?: number | null;
  } = {},
): Promise<number> {
  const slotDate =
    opts.slotDate ?? new Date(Date.now() + (opts.daysAhead ?? 1) * 86_400_000);
  const [s] = await db.insert(marketplaceSlotsTable).values({
    organizationId: orgId,
    courseId: opts.courseId ?? null,
    slotDate,
    startingHole: 1,
    maxPlayers: opts.maxPlayers ?? 4,
    bookedPlayers: opts.bookedPlayers ?? 0,
    pricePaise: opts.pricePaise ?? 50_000,
    isPublic: opts.isPublic ?? true,
    status: opts.status ?? "open",
    surgeIndicator: opts.surgeIndicator ?? "normal",
  }).returning({ id: marketplaceSlotsTable.id });
  slotIds.push(s.id);
  return s.id;
}

beforeAll(async () => {
  // Three participating orgs at different lat/lng so distance / radius
  // filters and the distance sort can be exercised. Coordinates are
  // chosen so haversine distances are unambiguous (>~100 km apart).
  const [orgA] = await db.insert(organizationsTable).values({
    name: `MktSlotsA_${stamp}`,
    slug: `mkt-slots-a-${stamp}`,
    marketplaceEnabled: true,
    latitude: "12.9716",   // Bengaluru
    longitude: "77.5946",
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `MktSlotsB_${stamp}`,
    slug: `mkt-slots-b-${stamp}`,
    marketplaceEnabled: true,
    latitude: "13.0827",   // Chennai (~290 km from Bengaluru)
    longitude: "80.2707",
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [orgC] = await db.insert(organizationsTable).values({
    name: `MktSlotsC_${stamp}`,
    slug: `mkt-slots-c-${stamp}`,
    marketplaceEnabled: true,
    latitude: "19.0760",   // Mumbai (~840 km from Bengaluru)
    longitude: "72.8777",
  }).returning({ id: organizationsTable.id });
  orgCId = orgC.id;

  // A club whose marketplace is disabled — its slots must never appear.
  const [orgDisabled] = await db.insert(organizationsTable).values({
    name: `MktSlotsDisabled_${stamp}`,
    slug: `mkt-slots-disabled-${stamp}`,
    marketplaceEnabled: false,
  }).returning({ id: organizationsTable.id });
  orgDisabledId = orgDisabled.id;

  // A participating club with no lat/lng so we can exercise the
  // NULLS-LAST behaviour of the distance sort.
  const [orgNoCoords] = await db.insert(organizationsTable).values({
    name: `MktSlotsNoCoords_${stamp}`,
    slug: `mkt-slots-no-coords-${stamp}`,
    marketplaceEnabled: true,
  }).returning({ id: organizationsTable.id });
  orgNoCoordsId = orgNoCoords.id;

  // Two courses on org A so the courseIds filter has something to bite.
  const [courseA] = await db.insert(coursesTable).values({
    organizationId: orgAId,
    name: `CourseA_${stamp}`,
    slug: `course-a-${stamp}`,
  }).returning({ id: coursesTable.id });
  courseAId = courseA.id;

  const [courseB] = await db.insert(coursesTable).values({
    organizationId: orgAId,
    name: `CourseB_${stamp}`,
    slug: `course-b-${stamp}`,
  }).returning({ id: coursesTable.id });
  courseBId = courseB.id;
});

beforeEach(async () => {
  if (slotIds.length > 0) {
    await db.delete(marketplaceSlotsTable).where(inArray(marketplaceSlotsTable.id, slotIds));
    slotIds.length = 0;
  }
});

afterAll(async () => {
  if (slotIds.length > 0) {
    await db.delete(marketplaceSlotsTable).where(inArray(marketplaceSlotsTable.id, slotIds));
  }
  await db.delete(coursesTable).where(inArray(coursesTable.id, [courseAId, courseBId].filter(Boolean) as number[]));
  await db.delete(organizationsTable).where(
    inArray(organizationsTable.id, [orgAId, orgBId, orgCId, orgDisabledId, orgNoCoordsId].filter(Boolean) as number[]),
  );
});

/**
 * Pull only slot ids from a /slots response — useful for set-equality
 * assertions when the order doesn't matter.
 */
function ids(rows: SlotRow[]): number[] {
  return rows.map((r) => r.id);
}

describe("GET /api/marketplace-discover/slots", () => {
  it("returns only open public future slots from marketplace-enabled orgs", async () => {
    const a1 = await makeSlot(orgAId, { daysAhead: 1, courseId: courseAId });
    const a2 = await makeSlot(orgAId, { daysAhead: 2, courseId: courseAId });
    const b1 = await makeSlot(orgBId, { daysAhead: 3 });

    // Four ineligible slots that must NOT come back:
    const fullSlot = await makeSlot(orgAId, { daysAhead: 1, maxPlayers: 4, bookedPlayers: 4 });
    const privateSlot = await makeSlot(orgAId, { daysAhead: 1, isPublic: false });
    const closedSlot = await makeSlot(orgAId, { daysAhead: 1, status: "closed" });
    const pastSlot = await makeSlot(orgAId, { daysAhead: -2 });
    const disabledOrgSlot = await makeSlot(orgDisabledId, { daysAhead: 1 });

    const res = await request(app)
      .get("/api/marketplace-discover/slots")
      .query({ orgIds: [orgAId, orgBId, orgDisabledId].join(",") });
    expect(res.status).toBe(200);
    const slots: SlotRow[] = res.body.slots;
    const returnedIds = ids(slots);

    expect(returnedIds).toEqual(expect.arrayContaining([a1, a2, b1]));
    expect(returnedIds).not.toContain(fullSlot);
    expect(returnedIds).not.toContain(privateSlot);
    expect(returnedIds).not.toContain(closedSlot);
    expect(returnedIds).not.toContain(pastSlot);
    expect(returnedIds).not.toContain(disabledOrgSlot);
    expect(res.body.total).toBe(3);
  });

  it("respects fromDate and toDate", async () => {
    const early = await makeSlot(orgAId, { daysAhead: 1 });
    const middle = await makeSlot(orgAId, { daysAhead: 7 });
    const late = await makeSlot(orgAId, { daysAhead: 20 });

    const fromDate = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const toDate = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const res = await request(app)
      .get("/api/marketplace-discover/slots")
      .query({ orgIds: String(orgAId), fromDate, toDate });
    expect(res.status).toBe(200);

    const returnedIds = ids(res.body.slots);
    expect(returnedIds).toContain(middle);
    expect(returnedIds).not.toContain(early);
    expect(returnedIds).not.toContain(late);
  });

  it("respects daysOfWeek (filters out non-matching weekdays)", async () => {
    // Find the next Monday and the next Tuesday so our assertion is
    // deterministic regardless of when the test runs.
    const now = new Date();
    function nextDow(target: number): Date {
      const d = new Date(now);
      d.setUTCHours(12, 0, 0, 0); // mid-day so TZ rounding doesn't bite
      const delta = (target - d.getUTCDay() + 7) % 7 || 7;
      d.setUTCDate(d.getUTCDate() + delta);
      return d;
    }
    const monday = nextDow(1);
    const tuesday = nextDow(2);

    const monSlot = await makeSlot(orgAId, { slotDate: monday });
    const tueSlot = await makeSlot(orgAId, { slotDate: tuesday });

    const res = await request(app)
      .get("/api/marketplace-discover/slots")
      .query({ orgIds: String(orgAId), daysOfWeek: "1" }); // Mondays only
    expect(res.status).toBe(200);
    const returnedIds = ids(res.body.slots);
    expect(returnedIds).toContain(monSlot);
    expect(returnedIds).not.toContain(tueSlot);
  });

  it("respects orgIds — limits to the requested clubs", async () => {
    const a = await makeSlot(orgAId, { daysAhead: 1 });
    const b = await makeSlot(orgBId, { daysAhead: 1 });
    const c = await makeSlot(orgCId, { daysAhead: 1 });

    const res = await request(app)
      .get("/api/marketplace-discover/slots")
      .query({ orgIds: `${orgAId},${orgCId}` });
    expect(res.status).toBe(200);
    const returnedIds = ids(res.body.slots);
    expect(returnedIds).toEqual(expect.arrayContaining([a, c]));
    expect(returnedIds).not.toContain(b);
  });

  it("respects courseIds — limits to the requested courses", async () => {
    const onA = await makeSlot(orgAId, { daysAhead: 1, courseId: courseAId });
    const onB = await makeSlot(orgAId, { daysAhead: 1, courseId: courseBId });

    const res = await request(app)
      .get("/api/marketplace-discover/slots")
      .query({ orgIds: String(orgAId), courseIds: String(courseAId) });
    expect(res.status).toBe(200);
    const returnedIds = ids(res.body.slots);
    expect(returnedIds).toContain(onA);
    expect(returnedIds).not.toContain(onB);
  });

  it("respects lat/lng/radiusKm — clubs outside the radius drop out and distanceKm is populated", async () => {
    const aSlot = await makeSlot(orgAId, { daysAhead: 1 }); // Bengaluru
    const bSlot = await makeSlot(orgBId, { daysAhead: 1 }); // Chennai (~290 km)
    const cSlot = await makeSlot(orgCId, { daysAhead: 1 }); // Mumbai (~840 km)

    // Centre on Bengaluru with a 400 km radius — should keep A and B,
    // drop C.
    const res = await request(app)
      .get("/api/marketplace-discover/slots")
      .query({
        orgIds: [orgAId, orgBId, orgCId].join(","),
        lat: "12.9716",
        lng: "77.5946",
        radiusKm: "400",
      });
    expect(res.status).toBe(200);
    const slots: SlotRow[] = res.body.slots;
    const returnedIds = ids(slots);
    expect(returnedIds).toEqual(expect.arrayContaining([aSlot, bSlot]));
    expect(returnedIds).not.toContain(cSlot);

    // Distance is included on every returned row.
    for (const s of slots) {
      expect(typeof s.distanceKm).toBe("number");
    }
    // Org A must have ~0 km distance to itself.
    const aRow = slots.find((s) => s.id === aSlot)!;
    expect(aRow.distanceKm).toBeLessThan(1);
  });

  it("respects minSpots — slots with fewer remaining spots are excluded", async () => {
    const oneLeft = await makeSlot(orgAId, { daysAhead: 1, maxPlayers: 4, bookedPlayers: 3 });
    const fourLeft = await makeSlot(orgAId, { daysAhead: 2, maxPlayers: 4, bookedPlayers: 0 });

    const res = await request(app)
      .get("/api/marketplace-discover/slots")
      .query({ orgIds: String(orgAId), minSpots: "3" });
    expect(res.status).toBe(200);
    const returnedIds = ids(res.body.slots);
    expect(returnedIds).toContain(fourLeft);
    expect(returnedIds).not.toContain(oneLeft);
  });

  it("respects maxPricePaise — pricier slots are excluded", async () => {
    const cheap = await makeSlot(orgAId, { daysAhead: 1, pricePaise: 10_000 });
    const dear = await makeSlot(orgAId, { daysAhead: 2, pricePaise: 100_000 });

    const res = await request(app)
      .get("/api/marketplace-discover/slots")
      .query({ orgIds: String(orgAId), maxPricePaise: "20000" });
    expect(res.status).toBe(200);
    const returnedIds = ids(res.body.slots);
    expect(returnedIds).toContain(cheap);
    expect(returnedIds).not.toContain(dear);
  });

  it("respects the surge filter — only matching tiers come back", async () => {
    const offPeak = await makeSlot(orgAId, { daysAhead: 1, surgeIndicator: "off_peak" });
    const normal  = await makeSlot(orgAId, { daysAhead: 2, surgeIndicator: "normal" });
    const surge   = await makeSlot(orgAId, { daysAhead: 3, surgeIndicator: "surge" });

    const res = await request(app)
      .get("/api/marketplace-discover/slots")
      .query({ orgIds: String(orgAId), surge: "off_peak,surge" });
    expect(res.status).toBe(200);
    const returnedIds = ids(res.body.slots);
    expect(returnedIds).toEqual(expect.arrayContaining([offPeak, surge]));
    expect(returnedIds).not.toContain(normal);
  });

  it("sorts by date ascending by default", async () => {
    const later = await makeSlot(orgAId, { daysAhead: 5, pricePaise: 10_000 });
    const sooner = await makeSlot(orgAId, { daysAhead: 1, pricePaise: 90_000 });

    const res = await request(app)
      .get("/api/marketplace-discover/slots")
      .query({ orgIds: String(orgAId) });
    expect(res.status).toBe(200);
    const returnedIds = ids(res.body.slots);
    expect(returnedIds).toEqual([sooner, later]);
  });

  it("sorts by price when sort=price", async () => {
    const expensive = await makeSlot(orgAId, { daysAhead: 1, pricePaise: 90_000 });
    const cheap     = await makeSlot(orgAId, { daysAhead: 2, pricePaise: 10_000 });
    const middle    = await makeSlot(orgAId, { daysAhead: 3, pricePaise: 50_000 });

    const res = await request(app)
      .get("/api/marketplace-discover/slots")
      .query({ orgIds: String(orgAId), sort: "price" });
    expect(res.status).toBe(200);
    const returnedIds = ids(res.body.slots);
    expect(returnedIds).toEqual([cheap, middle, expensive]);
  });

  it("sorts by distance when sort=distance", async () => {
    const aSlot = await makeSlot(orgAId, { daysAhead: 1 }); // Bengaluru — 0 km
    const bSlot = await makeSlot(orgBId, { daysAhead: 1 }); // Chennai   — ~290 km
    const cSlot = await makeSlot(orgCId, { daysAhead: 1 }); // Mumbai    — ~840 km

    const res = await request(app)
      .get("/api/marketplace-discover/slots")
      .query({
        orgIds: [orgAId, orgBId, orgCId].join(","),
        lat: "12.9716",
        lng: "77.5946",
        sort: "distance",
      });
    expect(res.status).toBe(200);
    const returnedIds = ids(res.body.slots);
    expect(returnedIds).toEqual([aSlot, bSlot, cSlot]);
  });

  it("sorts clubs missing coordinates last when sort=distance", async () => {
    const nearSlot = await makeSlot(orgAId, { daysAhead: 1 });   // Bengaluru — 0 km
    const farSlot  = await makeSlot(orgCId, { daysAhead: 1 });   // Mumbai    — ~840 km
    const noCoordsSlot = await makeSlot(orgNoCoordsId, { daysAhead: 1 }); // unknown distance

    const res = await request(app)
      .get("/api/marketplace-discover/slots")
      .query({
        orgIds: [orgAId, orgCId, orgNoCoordsId].join(","),
        lat: "12.9716",
        lng: "77.5946",
        sort: "distance",
      });
    expect(res.status).toBe(200);
    const returnedIds = ids(res.body.slots);
    // Real coordinates first (closest → farthest), unknown coords last.
    expect(returnedIds).toEqual([nearSlot, farSlot, noCoordsSlot]);
  });

  it("paginates with limit and offset (date-sorted)", async () => {
    const s1 = await makeSlot(orgAId, { daysAhead: 1 });
    const s2 = await makeSlot(orgAId, { daysAhead: 2 });
    const s3 = await makeSlot(orgAId, { daysAhead: 3 });
    const s4 = await makeSlot(orgAId, { daysAhead: 4 });

    const page1 = await request(app)
      .get("/api/marketplace-discover/slots")
      .query({ orgIds: String(orgAId), limit: "2", offset: "0" });
    expect(page1.status).toBe(200);
    expect(ids(page1.body.slots)).toEqual([s1, s2]);
    // `total` must reflect every matching slot, not just this page.
    expect(page1.body.total).toBe(4);

    const page2 = await request(app)
      .get("/api/marketplace-discover/slots")
      .query({ orgIds: String(orgAId), limit: "2", offset: "2" });
    expect(page2.status).toBe(200);
    expect(ids(page2.body.slots)).toEqual([s3, s4]);
    // Same authoritative total on the second page.
    expect(page2.body.total).toBe(4);

    // A wide enough window returns every slot in date order.
    const allRes = await request(app)
      .get("/api/marketplace-discover/slots")
      .query({ orgIds: String(orgAId), limit: "100", offset: "0" });
    expect(allRes.status).toBe(200);
    expect(ids(allRes.body.slots)).toEqual([s1, s2, s3, s4]);
    expect(allRes.body.total).toBe(4);
  });
});
