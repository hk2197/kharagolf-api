/**
 * Test: GET /api/marketplace-discover/clubs/slot-counts (Task #683).
 *
 * The slot-counts endpoint powers the live map pins. A regression in its
 * filter handling would silently make the map go stale, so this spec
 * exercises it with a mix of open / full / private / closed / past-dated
 * slots across two organizations and asserts only matching open slots are
 * counted, per organization. Filter parameters (fromDate, toDate, minSpots,
 * maxPricePaise) are also covered.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  marketplaceSlotsTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgAId: number;
let orgBId: number;
let orgDisabledId: number;
const slotIds: number[] = [];
const app = createTestApp();

interface CountRow {
  organizationId: number;
  openSlots: number;
  spotsLeft: number;
}

function findCount(rows: CountRow[], orgId: number): CountRow | undefined {
  return rows.find((r) => r.organizationId === orgId);
}

async function makeSlot(
  orgId: number,
  opts: {
    daysAhead?: number;
    isPublic?: boolean;
    status?: string;
    pricePaise?: number;
    maxPlayers?: number;
    bookedPlayers?: number;
  } = {},
): Promise<number> {
  const daysAhead = opts.daysAhead ?? 1;
  const [s] = await db.insert(marketplaceSlotsTable).values({
    organizationId: orgId,
    slotDate: new Date(Date.now() + daysAhead * 86_400_000),
    startingHole: 1,
    maxPlayers: opts.maxPlayers ?? 4,
    bookedPlayers: opts.bookedPlayers ?? 0,
    pricePaise: opts.pricePaise ?? 50000,
    isPublic: opts.isPublic ?? true,
    status: opts.status ?? "open",
  }).returning({ id: marketplaceSlotsTable.id });
  slotIds.push(s.id);
  return s.id;
}

beforeAll(async () => {
  const [orgA] = await db.insert(organizationsTable).values({
    name: `MktCountsA_${stamp}`,
    slug: `mkt-counts-a-${stamp}`,
    marketplaceEnabled: true,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `MktCountsB_${stamp}`,
    slug: `mkt-counts-b-${stamp}`,
    marketplaceEnabled: true,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  // A club whose marketplace is disabled — its slots must never appear.
  const [orgDisabled] = await db.insert(organizationsTable).values({
    name: `MktCountsDisabled_${stamp}`,
    slug: `mkt-counts-disabled-${stamp}`,
    marketplaceEnabled: false,
  }).returning({ id: organizationsTable.id });
  orgDisabledId = orgDisabled.id;
});

beforeEach(async () => {
  // Each scenario asserts on org-level counts, so wipe slots between tests
  // to avoid bleed-over from earlier scenarios.
  if (slotIds.length > 0) {
    await db.delete(marketplaceSlotsTable).where(inArray(marketplaceSlotsTable.id, slotIds));
    slotIds.length = 0;
  }
});

afterAll(async () => {
  if (slotIds.length > 0) {
    await db.delete(marketplaceSlotsTable).where(inArray(marketplaceSlotsTable.id, slotIds));
  }
  await db.delete(organizationsTable).where(
    inArray(organizationsTable.id, [orgAId, orgBId, orgDisabledId].filter(Boolean) as number[]),
  );
});

describe("GET /api/marketplace-discover/clubs/slot-counts", () => {
  it("counts only open public future slots, per organization, ignoring full/private/closed/past/disabled-org slots", async () => {
    // Org A: 2 valid open slots (with 3 + 2 spots left), plus 4 ignored ones.
    const aOpen1 = await makeSlot(orgAId, { daysAhead: 1, maxPlayers: 4, bookedPlayers: 1 }); // 3 left
    const aOpen2 = await makeSlot(orgAId, { daysAhead: 2, maxPlayers: 4, bookedPlayers: 2 }); // 2 left
    await makeSlot(orgAId, { daysAhead: 3, maxPlayers: 4, bookedPlayers: 4 });                // full → spotsLeft=0, excluded
    await makeSlot(orgAId, { daysAhead: 4, isPublic: false });                                 // private → excluded
    await makeSlot(orgAId, { daysAhead: 5, status: "closed" });                                // not open → excluded
    await makeSlot(orgAId, { daysAhead: -2 });                                                  // past/expired → excluded by default fromDate=now

    // Org B: 1 valid open slot.
    const bOpen1 = await makeSlot(orgBId, { daysAhead: 3, maxPlayers: 4, bookedPlayers: 0 }); // 4 left

    // Disabled org: open public future slot — must still be excluded.
    await makeSlot(orgDisabledId, { daysAhead: 1 });

    expect([aOpen1, aOpen2, bOpen1]).toHaveLength(3); // sanity

    const res = await request(app).get("/api/marketplace-discover/clubs/slot-counts");
    expect(res.status).toBe(200);
    expect(typeof res.body.asOf).toBe("string");
    const counts: CountRow[] = res.body.counts;

    const a = findCount(counts, orgAId);
    expect(a).toBeDefined();
    expect(a!.openSlots).toBe(2);
    expect(a!.spotsLeft).toBe(5); // 3 + 2

    const b = findCount(counts, orgBId);
    expect(b).toBeDefined();
    expect(b!.openSlots).toBe(1);
    expect(b!.spotsLeft).toBe(4);

    expect(findCount(counts, orgDisabledId)).toBeUndefined();
  });

  it("respects the fromDate filter — earlier-than-fromDate slots are excluded", async () => {
    // Slot 2 days out vs slot 10 days out. With fromDate=now+5d only the
    // 10-day slot should count for orgA.
    await makeSlot(orgAId, { daysAhead: 2 });
    await makeSlot(orgAId, { daysAhead: 10 });

    const fromDate = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const res = await request(app)
      .get("/api/marketplace-discover/clubs/slot-counts")
      .query({ fromDate });
    expect(res.status).toBe(200);
    const a = findCount(res.body.counts as CountRow[], orgAId);
    expect(a).toBeDefined();
    expect(a!.openSlots).toBe(1);
  });

  it("respects the toDate filter — later-than-toDate slots are excluded", async () => {
    await makeSlot(orgBId, { daysAhead: 1 });
    await makeSlot(orgBId, { daysAhead: 10 });

    const toDate = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const res = await request(app)
      .get("/api/marketplace-discover/clubs/slot-counts")
      .query({ toDate });
    expect(res.status).toBe(200);
    const b = findCount(res.body.counts as CountRow[], orgBId);
    expect(b).toBeDefined();
    expect(b!.openSlots).toBe(1);
  });

  it("respects the minSpots filter — slots with fewer remaining spots are excluded", async () => {
    // 1 spot left and 4 spots left — minSpots=3 keeps only the 4-spot slot.
    await makeSlot(orgAId, { daysAhead: 1, maxPlayers: 4, bookedPlayers: 3 }); // 1 left
    await makeSlot(orgAId, { daysAhead: 2, maxPlayers: 4, bookedPlayers: 0 }); // 4 left

    const res = await request(app)
      .get("/api/marketplace-discover/clubs/slot-counts")
      .query({ minSpots: "3" });
    expect(res.status).toBe(200);
    const a = findCount(res.body.counts as CountRow[], orgAId);
    expect(a).toBeDefined();
    expect(a!.openSlots).toBe(1);
    expect(a!.spotsLeft).toBe(4);
  });

  it("respects the maxPricePaise filter — pricier slots are excluded", async () => {
    await makeSlot(orgBId, { daysAhead: 1, pricePaise: 100_00 }); // ₹100
    await makeSlot(orgBId, { daysAhead: 2, pricePaise: 500_00 }); // ₹500

    const res = await request(app)
      .get("/api/marketplace-discover/clubs/slot-counts")
      .query({ maxPricePaise: "20000" }); // ₹200 ceiling
    expect(res.status).toBe(200);
    const b = findCount(res.body.counts as CountRow[], orgBId);
    expect(b).toBeDefined();
    expect(b!.openSlots).toBe(1);
  });
});
