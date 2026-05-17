/**
 * Integration tests: Marketplace commission/markup revenue dashboard (Task #534).
 *
 * Task #409 added per-club commission, markup, and gross-revenue rollups plus
 * a CSV export to the Bookings Dashboard. These are the finance numbers that
 * club admins reconcile against, so a silent regression in the maths or the
 * CSV format would ship straight to whoever pulls the spreadsheet.
 *
 * Covers:
 *   - GET /dashboard JSON across confirmed / cancelled / pending bookings,
 *     free + paid slots, and slots with and without `basePricePaise`.
 *   - KPI totals (gross revenue, markup retained, commission accrued) and
 *     per-booking commission/markup values.
 *   - GET /dashboard/export.csv: header row, escaping of comma + quote
 *     values (player name and course name), and the trailing TOTALS row.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  coursesTable,
  marketplaceSlotsTable,
  marketplaceBookingsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgId: number;
let userId: number;
let courseAId: number;
let courseBId: number;
let slotPaidWithBaseId: number;
let slotPaidNoBaseId: number;
let slotFreeId: number;
let slotEscapeId: number;
let bookingConfirmedPaidId: number;
let bookingCancelledId: number = 0;
let bookingPendingId: number = 0;
let bookingFreeConfirmedId: number = 0;
let bookingEscapeId: number;
let app: ReturnType<typeof createTestApp>;

// Pick a slot date inside the dashboard's default window
// (default: now-30d ... now+365d). Use noon UTC tomorrow so it's deterministic.
function tomorrowNoonUtc(extraDays = 0): Date {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1 + extraDays);
  return d;
}

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `MktFinanceTest_${stamp}`,
    slug: `mkt-finance-test-${stamp}`,
    subscriptionTier: "starter",
    marketplaceEnabled: true,
    marketplaceCommissionPct: "10.00",
    marketplaceMarkupPct: "20.00",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `mkt-finance-${stamp}`,
    username: `mkt_finance_${stamp}`,
    email: `mkt_finance_${stamp}@example.com`,
    displayName: "Marketplace Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = user.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId,
    role: "org_admin",
  });

  // Two courses: one plain, one whose name needs CSV escaping.
  const [courseA] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "Plain Course",
    slug: `plain-${stamp}`,
  }).returning({ id: coursesTable.id });
  courseAId = courseA.id;

  const [courseB] = await db.insert(coursesTable).values({
    organizationId: orgId,
    // Comma in the name forces the CSV writer to wrap the field in quotes.
    name: "St. Andrews, OH",
    slug: `escape-${stamp}`,
  }).returning({ id: coursesTable.id });
  courseBId = courseB.id;

  // Slot A: paid, basePricePaise=10000, listed pricePaise=12000
  //   → markup per player = 2000 paise
  const [slotA] = await db.insert(marketplaceSlotsTable).values({
    organizationId: orgId,
    courseId: courseAId,
    slotDate: tomorrowNoonUtc(0),
    pricePaise: 12000,
    basePricePaise: 10000,
    maxPlayers: 4,
  }).returning({ id: marketplaceSlotsTable.id });
  slotPaidWithBaseId = slotA.id;

  // Slot B: paid, basePricePaise=null → should be treated as no markup.
  const [slotB] = await db.insert(marketplaceSlotsTable).values({
    organizationId: orgId,
    courseId: courseAId,
    slotDate: tomorrowNoonUtc(1),
    pricePaise: 8000,
    basePricePaise: null,
    maxPlayers: 4,
  }).returning({ id: marketplaceSlotsTable.id });
  slotPaidNoBaseId = slotB.id;

  // Slot C: free slot (price=0, base=0).
  const [slotC] = await db.insert(marketplaceSlotsTable).values({
    organizationId: orgId,
    courseId: courseAId,
    slotDate: tomorrowNoonUtc(2),
    pricePaise: 0,
    basePricePaise: 0,
    maxPlayers: 4,
  }).returning({ id: marketplaceSlotsTable.id });
  slotFreeId = slotC.id;

  // Slot D: paid, attached to the comma-named course; used for CSV escape test.
  // basePricePaise=12000, pricePaise=15000 → markup per player = 3000 paise
  const [slotD] = await db.insert(marketplaceSlotsTable).values({
    organizationId: orgId,
    courseId: courseBId,
    slotDate: tomorrowNoonUtc(3),
    pricePaise: 15000,
    basePricePaise: 12000,
    maxPlayers: 4,
  }).returning({ id: marketplaceSlotsTable.id });
  slotEscapeId = slotD.id;

  // Bookings ─────────────────────────────────────────────────────────────
  // B1: confirmed, paid, 2 players, amount 24000 → markup 4000, commission 2400
  const [b1] = await db.insert(marketplaceBookingsTable).values({
    slotId: slotPaidWithBaseId,
    organizationId: orgId,
    userId,
    playerName: "Alice Confirmed",
    players: 2,
    amountPaise: 24000,
    paymentStatus: "confirmed",
  }).returning({ id: marketplaceBookingsTable.id });
  bookingConfirmedPaidId = b1.id;

  // B2: cancelled, 1 player, amount 12000.
  // markup is computed regardless of status; commission only when confirmed.
  const [b2] = await db.insert(marketplaceBookingsTable).values({
    slotId: slotPaidWithBaseId,
    organizationId: orgId,
    userId,
    playerName: "Bob Cancelled",
    players: 1,
    amountPaise: 12000,
    paymentStatus: "cancelled",
  }).returning({ id: marketplaceBookingsTable.id });
  bookingCancelledId = b2.id;

  // B3: pending, 3 players on no-base slot → markup must be 0.
  const [b3] = await db.insert(marketplaceBookingsTable).values({
    slotId: slotPaidNoBaseId,
    organizationId: orgId,
    userId,
    playerName: "Carol Pending",
    players: 3,
    amountPaise: 24000,
    paymentStatus: "pending",
  }).returning({ id: marketplaceBookingsTable.id });
  bookingPendingId = b3.id;

  // B4: free slot, confirmed, 4 players, amount 0 → contributes players only.
  const [b4] = await db.insert(marketplaceBookingsTable).values({
    slotId: slotFreeId,
    organizationId: orgId,
    userId,
    playerName: "Dave Free",
    players: 4,
    amountPaise: 0,
    paymentStatus: "confirmed",
  }).returning({ id: marketplaceBookingsTable.id });
  bookingFreeConfirmedId = b4.id;

  // B5: confirmed paid, on the comma-named course; player name contains a
  // comma AND a double-quote so we can verify CSV quoting + escaping.
  // 1 player, amount 15000 → markup 3000, commission 1500.
  const [b5] = await db.insert(marketplaceBookingsTable).values({
    slotId: slotEscapeId,
    organizationId: orgId,
    userId,
    playerName: 'Smith, "Jr."',
    players: 1,
    amountPaise: 15000,
    paymentStatus: "confirmed",
  }).returning({ id: marketplaceBookingsTable.id });
  bookingEscapeId = b5.id;

  const admin: TestUser = {
    id: userId,
    username: `mkt_finance_${stamp}`,
    displayName: "Marketplace Admin",
    role: "org_admin",
    organizationId: orgId,
  };
  app = createTestApp(admin);
});

afterAll(async () => {
  // Org cascades to courses → slots → bookings, but be explicit anyway so
  // any partial failure during setup doesn't leave dangling rows.
  await db.delete(marketplaceBookingsTable).where(eq(marketplaceBookingsTable.organizationId, orgId));
  await db.delete(marketplaceSlotsTable).where(eq(marketplaceSlotsTable.organizationId, orgId));
  await db.delete(coursesTable).where(eq(coursesTable.organizationId, orgId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

// Avoid lint warnings for the IDs we capture for cleanup/assertions.
void bookingCancelledId;
void bookingPendingId;
void bookingFreeConfirmedId;

describe("GET /organizations/:orgId/marketplace/dashboard", () => {
  it("returns KPI totals across confirmed / cancelled / pending and per-booking commission+markup", async () => {
    const res = await request(app)
      .get(`/api/organizations/${orgId}/marketplace/dashboard`);
    expect(res.status, res.text).toBe(200);

    expect(res.body.commissionPct).toBe(10);

    const k = res.body.kpis;
    expect(k.totalBookings).toBe(5);
    expect(k.confirmedBookings).toBe(3);
    expect(k.cancelledBookings).toBe(1);
    // Confirmed only: 24000 (B1) + 0 (B4) + 15000 (B5) = 39000
    expect(k.totalRevenuePaise).toBe(39000);
    // Confirmed only: 2 + 4 + 1 = 7
    expect(k.totalPlayers).toBe(7);
    // Confirmed markup: B1 (2 × 2000) + B4 (0) + B5 (1 × 3000) = 7000
    expect(k.totalMarkupRetainedPaise).toBe(7000);
    // Confirmed commission: round(24000*10%) + 0 + round(15000*10%) = 3900
    expect(k.totalCommissionAccruedPaise).toBe(3900);

    const byId = new Map<number, {
      paymentStatus: string;
      players: number;
      amountPaise: number;
      basePricePaise: number;
      listedPricePaise: number;
      markupPaise: number;
      commissionPaise: number;
    }>();
    for (const row of res.body.bookings) byId.set(row.id, row);

    const b1 = byId.get(bookingConfirmedPaidId)!;
    expect(b1).toBeDefined();
    expect(b1.paymentStatus).toBe("confirmed");
    expect(b1.basePricePaise).toBe(10000);
    expect(b1.listedPricePaise).toBe(12000);
    expect(b1.markupPaise).toBe(4000);
    expect(b1.commissionPaise).toBe(2400);

    // Cancelled: markup still derived from prices, but commission = 0.
    const b2 = byId.get(bookingCancelledId)!;
    expect(b2).toBeDefined();
    expect(b2.paymentStatus).toBe("cancelled");
    expect(b2.markupPaise).toBe(2000);
    expect(b2.commissionPaise).toBe(0);

    // Pending on no-base slot: basePerPlayer falls back to listed → markup 0.
    const b3 = byId.get(bookingPendingId)!;
    expect(b3).toBeDefined();
    expect(b3.paymentStatus).toBe("pending");
    expect(b3.basePricePaise).toBe(8000);
    expect(b3.listedPricePaise).toBe(8000);
    expect(b3.markupPaise).toBe(0);
    expect(b3.commissionPaise).toBe(0);

    // Free + confirmed: contributes to players, not revenue/markup/commission.
    const b4 = byId.get(bookingFreeConfirmedId)!;
    expect(b4).toBeDefined();
    expect(b4.paymentStatus).toBe("confirmed");
    expect(b4.amountPaise).toBe(0);
    expect(b4.markupPaise).toBe(0);
    expect(b4.commissionPaise).toBe(0);

    // Confirmed paid on the comma-named course.
    const b5 = byId.get(bookingEscapeId)!;
    expect(b5).toBeDefined();
    expect(b5.paymentStatus).toBe("confirmed");
    expect(b5.basePricePaise).toBe(12000);
    expect(b5.listedPricePaise).toBe(15000);
    expect(b5.markupPaise).toBe(3000);
    expect(b5.commissionPaise).toBe(1500);
  });
});

describe("GET /organizations/:orgId/marketplace/dashboard/export.csv", () => {
  it("emits the documented header, escapes comma/quote values, and ends with the TOTALS row", async () => {
    const res = await request(app)
      .get(`/api/organizations/${orgId}/marketplace/dashboard/export.csv`);
    expect(res.status, res.text).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename=".*\.csv"/);

    const lines = res.text.split("\n");

    // Header row — exact column order per loadDashboardData/exportCsv.
    expect(lines[0]).toBe([
      "booking_id", "slot_date", "course", "player", "players",
      "payment_status", "base_price_per_player_inr", "listed_price_per_player_inr",
      "gross_revenue_inr", "markup_retained_inr",
      "commission_pct", "commission_accrued_inr", "booked_at",
    ].join(","));

    // Locate the row for B5 — the one with the escaped player name.
    const escapeRow = lines.find(l => l.startsWith(`${bookingEscapeId},`));
    expect(escapeRow, "expected a CSV row for the escape booking").toBeTruthy();

    // Course name "St. Andrews, OH" is wrapped in quotes (contains a comma).
    expect(escapeRow!).toContain('"St. Andrews, OH"');
    // Player name 'Smith, "Jr."' must be wrapped in quotes with internal
    // double-quotes doubled per RFC 4180.
    expect(escapeRow!).toContain('"Smith, ""Jr."""');

    // Spot-check the per-booking commission/markup columns are rupees.
    const cols = parseCsvLine(escapeRow!);
    expect(cols[0]).toBe(String(bookingEscapeId));
    expect(cols[2]).toBe("St. Andrews, OH");
    expect(cols[3]).toBe('Smith, "Jr."');
    expect(cols[4]).toBe("1");                    // players
    expect(cols[5]).toBe("confirmed");
    expect(cols[6]).toBe("120.00");               // base/player ₹
    expect(cols[7]).toBe("150.00");               // listed/player ₹
    expect(cols[8]).toBe("150.00");               // gross revenue ₹
    expect(cols[9]).toBe("30.00");                // markup retained ₹
    expect(cols[10]).toBe("10.00");               // commission %
    expect(cols[11]).toBe("15.00");               // commission accrued ₹

    // Cancelled row: commission column must be 0.00 even though markup > 0.
    const cancelledRow = lines.find(l => l.startsWith(`${bookingCancelledId},`));
    expect(cancelledRow, "expected a CSV row for the cancelled booking").toBeTruthy();
    const cancelledCols = parseCsvLine(cancelledRow!);
    expect(cancelledCols[5]).toBe("cancelled");
    expect(cancelledCols[9]).toBe("20.00");       // markup retained ₹ (1 × 2000 paise)
    expect(cancelledCols[11]).toBe("0.00");       // commission accrued ₹

    // The export ends with a blank line then the TOTALS (confirmed) line.
    const totalsLine = lines[lines.length - 1];
    expect(lines[lines.length - 2]).toBe("");
    const totals = parseCsvLine(totalsLine);
    expect(totals[0]).toBe("TOTALS (confirmed)");
    expect(totals[4]).toBe("7");                  // total players (confirmed)
    expect(totals[5]).toBe("confirmed");
    expect(totals[8]).toBe("390.00");             // gross revenue ₹
    expect(totals[9]).toBe("70.00");              // markup retained ₹
    expect(totals[10]).toBe("10.00");             // commission %
    expect(totals[11]).toBe("39.00");             // commission accrued ₹
  });
});

/**
 * Minimal RFC-4180-style CSV line parser sufficient for our fields:
 * supports quoted fields and escaped doubled quotes inside them.
 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === ',') { out.push(cur); cur = ""; }
      else if (ch === '"') { inQuotes = true; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out;
}
