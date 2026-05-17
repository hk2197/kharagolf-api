/**
 * Integration tests: Reversing levy ledger entries (Task 219).
 *
 * Covers POST /api/organizations/:orgId/members-360/levies/:id/charges/:memberId/events/:eventId/reverse.
 *
 *   - reversing a payment drops paidAmount and flips status back to 'unpaid'
 *   - reversing one of several payments leaves the charge in 'partial'
 *   - reversing a refund restores paidAmount accounting and flips back to 'paid'
 *   - reversing a waive clears waivedReason and recomputes status
 *   - double-reverse on the same event is blocked
 *   - reversal rows themselves cannot be reversed
 *   - reason is required (empty/whitespace rejected)
 *
 * Uses the real PostgreSQL database (DATABASE_URL). Test data is created in
 * beforeAll and cleaned in afterAll.
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
import { and, eq } from "drizzle-orm";
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

async function resetCharge(amount = "100.00") {
  // Wipe the ledger and reset the charge between tests so each scenario
  // starts from the same baseline (unpaid, no events).
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

async function recordPayment(amount: number) {
  const res = await request(app)
    .post(`${CHARGE_URL()}/payment`)
    .send({ amount });
  expect(res.status, `payment failed: ${res.text}`).toBe(200);
  return res.body;
}

async function recordRefund(amount: number, reason = "duplicate charge") {
  const res = await request(app)
    .post(`${CHARGE_URL()}/refund`)
    .send({ amount, reason });
  expect(res.status, `refund failed: ${res.text}`).toBe(200);
  return res.body;
}

async function recordWaive(reason = "goodwill") {
  const res = await request(app)
    .post(`${CHARGE_URL()}/waive`)
    .send({ reason });
  expect(res.status, `waive failed: ${res.text}`).toBe(200);
  return res.body;
}

async function fetchEvents() {
  const res = await request(app).get(`${CHARGE_URL()}/events`);
  expect(res.status, `events failed: ${res.text}`).toBe(200);
  return res.body.events as Array<{
    id: number; eventType: string; amount: string;
    reason: string | null; reversesEventId: number | null; reversed: boolean;
  }>;
}

async function fetchCharge() {
  const [row] = await db.select().from(memberLevyChargesTable)
    .where(eq(memberLevyChargesTable.id, testChargeId));
  return row;
}

async function reverseEvent(eventId: number, reason: string | undefined) {
  const body: Record<string, unknown> = {};
  if (reason !== undefined) body.reason = reason;
  return request(app)
    .post(`${CHARGE_URL()}/events/${eventId}/reverse`)
    .send(body);
}

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_LevyReverse_${stamp}`,
    slug: `test-levy-reverse-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `test-levy-reverse-${stamp}`,
    username: `test_levy_admin_${stamp}`,
    email: `levy_admin_${stamp}@example.com`,
    displayName: "Levy Test Admin",
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  testUserId = u.id;

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Reverse",
    lastName: "Tester",
    email: `member_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  testMemberId = member.id;

  const [levy] = await db.insert(memberLeviesTable).values({
    organizationId: testOrgId,
    name: `Reversal Test Levy ${stamp}`,
    amount: "100.00",
    currency: "INR",
    status: "applied",
    appliedAt: new Date(),
  }).returning({ id: memberLeviesTable.id });
  testLevyId = levy.id;

  const [charge] = await db.insert(memberLevyChargesTable).values({
    levyId: testLevyId,
    clubMemberId: testMemberId,
    amount: "100.00",
    status: "unpaid",
  }).returning({ id: memberLevyChargesTable.id });
  testChargeId = charge.id;

  admin = {
    id: testUserId,
    username: `test_levy_admin_${stamp}`,
    displayName: "Levy Test Admin",
    role: "org_admin",
    organizationId: testOrgId,
  };
  app = createTestApp(admin);
});

afterAll(async () => {
  // Cascades take care of charges + events when the levy/org go.
  if (testLevyId) {
    await db.delete(memberLeviesTable).where(eq(memberLeviesTable.id, testLevyId));
  }
  if (testMemberId) {
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, testMemberId));
  }
  if (testUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
});

beforeEach(async () => {
  await resetCharge();
});

describe("POST .../events/:eventId/reverse — payments", () => {
  it("reversing a full payment drops paidAmount to 0 and flips status to unpaid", async () => {
    await recordPayment(100);
    let events = await fetchEvents();
    const payEvent = events.find(e => e.eventType === "payment")!;
    expect(payEvent).toBeDefined();

    const before = await fetchCharge();
    expect(before.status).toBe("paid");
    expect(parseFloat(before.paidAmount)).toBe(100);
    expect(before.paid).toBe(true);

    const res = await reverseEvent(payEvent.id, "entered against wrong member");
    expect(res.status).toBe(200);
    expect(res.body.reversal.eventType).toBe("reversal");
    expect(res.body.reversal.reversesEventId).toBe(payEvent.id);
    expect(res.body.charge.status).toBe("unpaid");
    expect(parseFloat(res.body.charge.paidAmount)).toBe(0);
    expect(res.body.charge.paid).toBe(false);
    expect(res.body.charge.paidAt).toBeNull();

    events = await fetchEvents();
    const original = events.find(e => e.id === payEvent.id)!;
    expect(original.reversed).toBe(true);
  });

  it("reversing one of two partial payments leaves the charge in 'partial'", async () => {
    const first = await recordPayment(40);
    expect(first.status).toBe("partial");
    await recordPayment(60);
    const settled = await fetchCharge();
    expect(settled.status).toBe("paid");

    const events = await fetchEvents();
    const firstPay = events.find(e => e.eventType === "payment" && parseFloat(e.amount) === 40)!;

    const res = await reverseEvent(firstPay.id, "double-counted cash receipt");
    expect(res.status).toBe(200);
    expect(res.body.charge.status).toBe("partial");
    expect(parseFloat(res.body.charge.paidAmount)).toBe(60);
  });
});

describe("POST .../events/:eventId/reverse — refunds", () => {
  it("reversing a refund restores paidAmount accounting and returns to 'paid'", async () => {
    await recordPayment(100);
    await recordRefund(100, "refund issued in error");
    const refunded = await fetchCharge();
    expect(refunded.status).toBe("refunded");
    expect(parseFloat(refunded.refundedAmount)).toBe(100);

    const events = await fetchEvents();
    const refundEvent = events.find(e => e.eventType === "refund")!;

    const res = await reverseEvent(refundEvent.id, "refund was issued in error");
    expect(res.status).toBe(200);
    expect(res.body.charge.status).toBe("paid");
    expect(parseFloat(res.body.charge.refundedAmount)).toBe(0);
    expect(parseFloat(res.body.charge.paidAmount)).toBe(100);
    expect(res.body.charge.paid).toBe(true);
  });
});

describe("POST .../events/:eventId/reverse — waives", () => {
  it("reversing a waive clears waivedReason and recomputes status to unpaid", async () => {
    await recordWaive("hardship goodwill write-off");
    const waived = await fetchCharge();
    expect(waived.status).toBe("waived");
    expect(waived.waivedReason).toBe("hardship goodwill write-off");

    const events = await fetchEvents();
    const waiveEvent = events.find(e => e.eventType === "waive")!;

    const res = await reverseEvent(waiveEvent.id, "approved on appeal — un-write-off");
    expect(res.status).toBe(200);
    expect(res.body.charge.status).toBe("unpaid");
    expect(res.body.charge.waivedReason).toBeNull();
  });
});

describe("POST .../events/:eventId/reverse — guards", () => {
  it("rejects a second reverse on the same original event with 400", async () => {
    await recordPayment(100);
    const events = await fetchEvents();
    const payEvent = events.find(e => e.eventType === "payment")!;

    const first = await reverseEvent(payEvent.id, "duplicate entry");
    expect(first.status).toBe(200);

    const second = await reverseEvent(payEvent.id, "trying again");
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/already been reversed/i);
  });

  it("rejects reversing a reversal row itself with 400", async () => {
    await recordPayment(100);
    const events = await fetchEvents();
    const payEvent = events.find(e => e.eventType === "payment")!;

    const first = await reverseEvent(payEvent.id, "wrong member");
    expect(first.status).toBe(200);
    const reversalId: number = first.body.reversal.id;

    const reReverse = await reverseEvent(reversalId, "redo");
    expect(reReverse.status).toBe(400);
    expect(reReverse.body.error).toMatch(/reversal entries cannot/i);
  });

  it("requires a non-empty reason (empty body → 400)", async () => {
    await recordPayment(100);
    const events = await fetchEvents();
    const payEvent = events.find(e => e.eventType === "payment")!;

    const noBody = await reverseEvent(payEvent.id, undefined);
    expect(noBody.status).toBe(400);
    expect(noBody.body.error).toMatch(/reason is required/i);

    const blank = await reverseEvent(payEvent.id, "   ");
    expect(blank.status).toBe(400);
    expect(blank.body.error).toMatch(/reason is required/i);
  });

  it("returns 404 for an unknown eventId on this charge", async () => {
    const res = await reverseEvent(99_999_999, "bogus");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("persists a single reversal ledger row per original event", async () => {
    await recordPayment(100);
    const events = await fetchEvents();
    const payEvent = events.find(e => e.eventType === "payment")!;
    const res = await reverseEvent(payEvent.id, "test single insert");
    expect(res.status).toBe(200);

    const reversals = await db.select().from(memberLevyChargeEventsTable)
      .where(and(
        eq(memberLevyChargeEventsTable.chargeId, testChargeId),
        eq(memberLevyChargeEventsTable.reversesEventId, payEvent.id),
      ));
    expect(reversals.length).toBe(1);
    expect(reversals[0].eventType).toBe("reversal");
    expect(reversals[0].reason).toBe("test single insert");
  });
});
