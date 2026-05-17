/**
 * Unit tests: coach payout mark-paid notification (Task #610)
 *
 * Verifies that POST /api/swing-reviews/admin/payouts/:id/mark-paid:
 *   - Sends an email to the coach with amount/reference/notes
 *   - Inserts an in-app notification row visible in the coach workspace
 *   - Stamps `paidNotifiedAt` so a retried mark-paid call is a no-op
 *     (no duplicate email, no duplicate in-app row)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => {
  return {
    sendCoachPayoutPaidEmail: vi.fn(async () => undefined),
  };
});

import express from "express";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  teachingProsTable,
  coachPayoutsTable,
  coachPayoutNotificationsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import swingReviewsRouter from "../routes/swing-reviews.js";
import { sendCoachPayoutPaidEmail } from "../lib/mailer.js";

const emailMock = vi.mocked(sendCoachPayoutPaidEmail);

let testOrgId = 0;
let testUserId = 0;
let testProId = 0;
let testPayoutId = 0;
let app: express.Express;

function makeApp(userId: number, role: string, organizationId: number) {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => {
    req.user = { id: userId, role, organizationId };
    req.isAuthenticated = () => true;
    next();
  });
  a.use("/api/swing-reviews", swingReviewsRouter);
  return a;
}

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: "Test Coach Payout Org",
    slug: `coach-payout-test-${Date.now()}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `coach-payout-test-${Date.now()}`,
    username: `coach_payout_${Date.now()}`,
    email: "coach@example.com",
    displayName: "Coach Carlos",
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  testUserId = u.id;

  const [pro] = await db.insert(teachingProsTable).values({
    organizationId: testOrgId,
    userId: testUserId,
    displayName: "Coach Carlos",
    email: "carlos@coach.com",
  }).returning({ id: teachingProsTable.id });
  testProId = pro.id;

  app = makeApp(testUserId, "org_admin", testOrgId);
});

afterAll(async () => {
  if (testPayoutId) {
    await db.delete(coachPayoutNotificationsTable).where(eq(coachPayoutNotificationsTable.payoutId, testPayoutId));
    await db.delete(coachPayoutsTable).where(eq(coachPayoutsTable.id, testPayoutId));
  }
  if (testProId) await db.delete(teachingProsTable).where(eq(teachingProsTable.id, testProId));
  if (testUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  if (testOrgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(async () => {
  emailMock.mockClear();
  if (testPayoutId) {
    await db.delete(coachPayoutNotificationsTable).where(eq(coachPayoutNotificationsTable.payoutId, testPayoutId));
    await db.delete(coachPayoutsTable).where(eq(coachPayoutsTable.id, testPayoutId));
    testPayoutId = 0;
  }
  const [p] = await db.insert(coachPayoutsTable).values({
    proId: testProId,
    organizationId: testOrgId,
    periodStart: new Date(Date.now() - 30 * 86_400_000),
    periodEnd: new Date(),
    grossPaise: 200_00,
    netPayoutPaise: 140_00,
    platformFeePaise: 60_00,
    status: "processing",
  }).returning({ id: coachPayoutsTable.id });
  testPayoutId = p.id;
});

describe("POST /admin/payouts/:id/mark-paid", () => {
  it("emails the coach and inserts an in-app notification on first call", async () => {
    const res = await request(app)
      .post(`/api/swing-reviews/admin/payouts/${testPayoutId}/mark-paid`)
      .send({ reference: "UTR1234567", notes: "Bank transfer" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    expect(emailMock).toHaveBeenCalledTimes(1);
    const call = emailMock.mock.calls[0][0];
    // Prefer the linked app-user email over the pro contact email
    expect(call.to).toBe("coach@example.com");
    expect(call.amountPaise).toBe(140_00);
    expect(call.reference).toBe("UTR1234567");
    expect(call.notes).toBe("Bank transfer");
    expect(call.coachName).toBe("Coach Carlos");

    const notifs = await db.select().from(coachPayoutNotificationsTable)
      .where(eq(coachPayoutNotificationsTable.payoutId, testPayoutId));
    expect(notifs).toHaveLength(1);
    expect(notifs[0].coachUserId).toBe(testUserId);
    expect(notifs[0].amountPaise).toBe(140_00);
    expect(notifs[0].reference).toBe("UTR1234567");

    const [payout] = await db.select().from(coachPayoutsTable).where(eq(coachPayoutsTable.id, testPayoutId));
    expect(payout.status).toBe("paid");
    expect(payout.paidNotifiedAt).not.toBeNull();
  });

  it("does not duplicate the email or in-app notification on a retried mark-paid call", async () => {
    const first = await request(app)
      .post(`/api/swing-reviews/admin/payouts/${testPayoutId}/mark-paid`)
      .send({ reference: "UTR1234567" });
    expect(first.status).toBe(200);
    expect(emailMock).toHaveBeenCalledTimes(1);

    const second = await request(app)
      .post(`/api/swing-reviews/admin/payouts/${testPayoutId}/mark-paid`)
      .send({ reference: "UTR1234567" });
    expect(second.status).toBe(200);
    expect(second.body.alreadyNotified).toBe(true);

    expect(emailMock).toHaveBeenCalledTimes(1);

    const notifs = await db.select().from(coachPayoutNotificationsTable)
      .where(eq(coachPayoutNotificationsTable.payoutId, testPayoutId));
    expect(notifs).toHaveLength(1);
  });

  it("rejects mark-paid without a reference", async () => {
    const res = await request(app)
      .post(`/api/swing-reviews/admin/payouts/${testPayoutId}/mark-paid`)
      .send({});
    expect(res.status).toBe(400);
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("exposes the notification via GET /coach/notifications and supports marking it read", async () => {
    await request(app)
      .post(`/api/swing-reviews/admin/payouts/${testPayoutId}/mark-paid`)
      .send({ reference: "UTR9" });

    const list = await request(app).get("/api/swing-reviews/coach/notifications");
    expect(list.status).toBe(200);
    const notif = list.body.notifications.find((n: any) => n.payoutId === testPayoutId);
    expect(notif).toBeDefined();
    expect(notif.readAt).toBeNull();

    const read = await request(app).post(`/api/swing-reviews/coach/notifications/${notif.id}/read`);
    expect(read.status).toBe(200);

    const [row] = await db.select().from(coachPayoutNotificationsTable)
      .where(eq(coachPayoutNotificationsTable.id, notif.id));
    expect(row.readAt).not.toBeNull();
  });
});
