/**
 * Integration tests: Running balance on the levy events timeline (Task 303).
 *
 * Covers GET /api/organizations/:orgId/members-360/levies/:id/charges/:memberId/events
 * and verifies that each row carries `runningPaid`, `runningRefunded` and
 * `runningBalance` after the event was applied. The final row must agree with
 * the per-charge totals the reverse endpoint converges to.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberLeviesTable,
  memberLevyChargesTable,
  memberLevyChargeEventsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let testOrgId: number;
let testUserId: number;
let testMemberId: number;
let testLevyId: number;
let testChargeId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;

const BASE = () => `/api/organizations/${testOrgId}/members-360`;
const CHARGE_URL = () => `${BASE()}/levies/${testLevyId}/charges/${testMemberId}`;

interface TimelineEvent {
  id: number;
  eventType: string;
  amount: string;
  reversesEventId: number | null;
  reversed: boolean;
  runningPaid: string;
  runningRefunded: string;
  runningBalance: string;
}

async function fetchTimeline() {
  const res = await request(app).get(`${CHARGE_URL()}/events`);
  expect(res.status, `events failed: ${res.text}`).toBe(200);
  return res.body as {
    chargeId: number;
    currency: string;
    chargeAmount: string;
    events: TimelineEvent[];
  };
}

async function recordPayment(amount: number) {
  const res = await request(app).post(`${CHARGE_URL()}/payment`).send({ amount });
  expect(res.status, `payment failed: ${res.text}`).toBe(200);
  return res.body;
}

async function recordRefund(amount: number, reason = "test refund") {
  const res = await request(app).post(`${CHARGE_URL()}/refund`).send({ amount, reason });
  expect(res.status, `refund failed: ${res.text}`).toBe(200);
  return res.body;
}

async function recordWaive(reason = "goodwill") {
  const res = await request(app).post(`${CHARGE_URL()}/waive`).send({ reason });
  expect(res.status, `waive failed: ${res.text}`).toBe(200);
  return res.body;
}

async function reverseEvent(eventId: number, reason: string) {
  const res = await request(app)
    .post(`${CHARGE_URL()}/events/${eventId}/reverse`)
    .send({ reason });
  expect(res.status, `reverse failed: ${res.text}`).toBe(200);
  return res.body;
}

async function resetCharge(amount = "200.00") {
  await db.delete(memberLevyChargeEventsTable)
    .where(eq(memberLevyChargeEventsTable.chargeId, testChargeId));
  await db.update(memberLevyChargesTable).set({
    amount,
    paid: false,
    paidAt: null,
    status: "unpaid",
    paidAmount: "0",
    refundedAmount: "0",
    waivedReason: null,
  }).where(eq(memberLevyChargesTable.id, testChargeId));
}

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_LevyRunningBal_${stamp}`,
    slug: `test-levy-running-bal-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `test-levy-running-bal-${stamp}`,
    username: `test_levy_runbal_${stamp}`,
    email: `runbal_${stamp}@example.com`,
    displayName: "Running Balance Admin",
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  testUserId = u.id;

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Running",
    lastName: "Tester",
    email: `runbal_member_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  testMemberId = member.id;

  const [levy] = await db.insert(memberLeviesTable).values({
    organizationId: testOrgId,
    name: `Running Balance Levy ${stamp}`,
    amount: "200.00",
    currency: "INR",
    status: "applied",
    appliedAt: new Date(),
  }).returning({ id: memberLeviesTable.id });
  testLevyId = levy.id;

  const [charge] = await db.insert(memberLevyChargesTable).values({
    levyId: testLevyId,
    clubMemberId: testMemberId,
    amount: "200.00",
    status: "unpaid",
  }).returning({ id: memberLevyChargesTable.id });
  testChargeId = charge.id;

  admin = {
    id: testUserId,
    username: `test_levy_runbal_${stamp}`,
    displayName: "Running Balance Admin",
    role: "org_admin",
    organizationId: testOrgId,
  };
  app = createTestApp(admin);
});

afterAll(async () => {
  if (testLevyId) await db.delete(memberLeviesTable).where(eq(memberLeviesTable.id, testLevyId));
  if (testMemberId) await db.delete(clubMembersTable).where(eq(clubMembersTable.id, testMemberId));
  if (testUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  if (testOrgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(async () => {
  await resetCharge();
});

describe("GET .../events — runningPaid / runningRefunded / runningBalance", () => {
  it("returns zero running totals on a charge with no events", async () => {
    const body = await fetchTimeline();
    expect(body.chargeAmount).toBe("200.00");
    expect(body.events).toEqual([]);
  });

  it("computes running totals row-by-row across payment + refund + reversal", async () => {
    // 1. partial payment 80 → balance 120
    // 2. partial payment 70 → balance 50
    // 3. refund 30 (of paid 150) → balance 20 (per existing convention: amt - paid - refunded)
    // 4. reverse the refund → balance 50 again
    // 5. payment 50 → balance 0
    await recordPayment(80);
    await recordPayment(70);
    await recordRefund(30, "duplicate");
    let body = await fetchTimeline();
    const refundEv = body.events.find(e => e.eventType === "refund")!;
    expect(refundEv).toBeDefined();
    await reverseEvent(refundEv.id, "refund issued by mistake");
    await recordPayment(50);

    body = await fetchTimeline();
    const rows = body.events;
    expect(rows.length).toBe(5);

    // Row 1: payment 80
    expect(rows[0].eventType).toBe("payment");
    expect(rows[0].runningPaid).toBe("80.00");
    expect(rows[0].runningRefunded).toBe("0.00");
    expect(rows[0].runningBalance).toBe("120.00");

    // Row 2: payment 70 → paid 150
    expect(rows[1].eventType).toBe("payment");
    expect(rows[1].runningPaid).toBe("150.00");
    expect(rows[1].runningRefunded).toBe("0.00");
    expect(rows[1].runningBalance).toBe("50.00");

    // Row 3: refund 30 → paid 150, refunded 30, balance = max(0, 200-150-30) = 20
    expect(rows[2].eventType).toBe("refund");
    expect(rows[2].runningPaid).toBe("150.00");
    expect(rows[2].runningRefunded).toBe("30.00");
    expect(rows[2].runningBalance).toBe("20.00");

    // Row 4: reversal of the refund → refunded back to 0, balance back to 50
    expect(rows[3].eventType).toBe("reversal");
    expect(rows[3].reversesEventId).toBe(refundEv.id);
    expect(rows[3].runningPaid).toBe("150.00");
    expect(rows[3].runningRefunded).toBe("0.00");
    expect(rows[3].runningBalance).toBe("50.00");

    // Row 5: payment 50 → fully paid, balance 0
    expect(rows[4].eventType).toBe("payment");
    expect(rows[4].runningPaid).toBe("200.00");
    expect(rows[4].runningRefunded).toBe("0.00");
    expect(rows[4].runningBalance).toBe("0.00");

    // The original refund row stays in the ledger but is flagged reversed.
    expect(rows[2].reversed).toBe(true);

    // Final running totals match the per-charge totals on the charge row.
    const [chargeRow] = await db.select().from(memberLevyChargesTable)
      .where(eq(memberLevyChargesTable.id, testChargeId));
    expect(parseFloat(chargeRow.paidAmount)).toBe(parseFloat(rows[4].runningPaid));
    expect(parseFloat(chargeRow.refundedAmount)).toBe(parseFloat(rows[4].runningRefunded));
  });

  it("treats an active waive as zero balance and restores it when the waive is reversed", async () => {
    // 1. payment 80 → balance 120
    // 2. waive → balance 0 (charge written off)
    // 3. reverse the waive → balance back to 120
    // 4. payment 120 → balance 0
    await recordPayment(80);
    await recordWaive("hardship goodwill write-off");
    let body = await fetchTimeline();
    const waiveEv = body.events.find(e => e.eventType === "waive")!;
    expect(waiveEv).toBeDefined();
    await reverseEvent(waiveEv.id, "approved on appeal");
    await recordPayment(120);

    body = await fetchTimeline();
    const rows = body.events;
    expect(rows.length).toBe(4);

    expect(rows[0].eventType).toBe("payment");
    expect(rows[0].runningBalance).toBe("120.00");

    expect(rows[1].eventType).toBe("waive");
    expect(rows[1].runningPaid).toBe("80.00");
    expect(rows[1].runningRefunded).toBe("0.00");
    expect(rows[1].runningBalance).toBe("0.00");

    expect(rows[2].eventType).toBe("reversal");
    expect(rows[2].reversesEventId).toBe(waiveEv.id);
    // Waive reversal doesn't move paid/refunded but restores the outstanding.
    expect(rows[2].runningPaid).toBe("80.00");
    expect(rows[2].runningRefunded).toBe("0.00");
    expect(rows[2].runningBalance).toBe("120.00");

    expect(rows[3].eventType).toBe("payment");
    expect(rows[3].runningPaid).toBe("200.00");
    expect(rows[3].runningBalance).toBe("0.00");

    // The waive row is now flagged as reversed and the charge is no longer waived.
    expect(rows[1].reversed).toBe(true);
    const [chargeRow] = await db.select().from(memberLevyChargesTable)
      .where(eq(memberLevyChargesTable.id, testChargeId));
    expect(chargeRow.status).toBe("paid");
    expect(chargeRow.waivedReason).toBeNull();
  });

  it("waiving an unpaid charge with no payments shows balance 0 immediately", async () => {
    await recordWaive("first-year goodwill");
    const body = await fetchTimeline();
    expect(body.events.length).toBe(1);
    const row = body.events[0];
    expect(row.eventType).toBe("waive");
    expect(row.runningPaid).toBe("0.00");
    expect(row.runningRefunded).toBe("0.00");
    expect(row.runningBalance).toBe("0.00");
  });

  it("never returns a negative running balance even when refunded > charge", async () => {
    // pay 200, refund 200 → amt - paid - refunded = -200; surface 0.00 instead.
    await recordPayment(200);
    await recordRefund(200, "fully refunded");
    const body = await fetchTimeline();
    const last = body.events[body.events.length - 1];
    expect(last.eventType).toBe("refund");
    expect(last.runningBalance).toBe("0.00");
  });
});
