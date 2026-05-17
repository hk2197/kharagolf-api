/**
 * Unit tests: coach payout mark-paid push + SMS fan-out (Task #774)
 *
 * Extends the Task #610 email/in-app coverage with the push and SMS
 * channels. Verifies that POST /api/swing-reviews/admin/payouts/:id/mark-paid:
 *   - Sends a push to the coach's app user (with deep-link payload)
 *   - Sends an SMS when the coach has a phone on file
 *   - Honours per-channel `billing` comm prefs (email/push/sms), defaulting
 *     to ON when no member_comm_prefs row exists for the coach
 *   - A failure on one channel never blocks the others
 *   - Idempotency via paid_notified_at continues to be enforced (no
 *     duplicate push/SMS on a retried mark-paid call)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => ({
  sendCoachPayoutPaidEmail: vi.fn(async () => undefined),
}));

vi.mock("../lib/comms.js", async () => ({
  sendTransactionalPush: vi.fn(async (_userIds: number[]) => ({
    attempted: 1, sent: 1, failed: 0, invalid: 0,
  })),
  sendTransactionalSms: vi.fn(async () => undefined),
  sendTransactionalWhatsapp: vi.fn(async () => "wa-msg-id"),
}));

import express from "express";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  teachingProsTable,
  coachPayoutsTable,
  coachPayoutNotificationsTable,
  clubMembersTable,
  memberCommPrefsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import swingReviewsRouter from "../routes/swing-reviews.js";
import { sendCoachPayoutPaidEmail } from "../lib/mailer.js";
import { sendTransactionalPush, sendTransactionalSms, sendTransactionalWhatsapp } from "../lib/comms.js";

const emailMock = vi.mocked(sendCoachPayoutPaidEmail);
const pushMock = vi.mocked(sendTransactionalPush);
const smsMock = vi.mocked(sendTransactionalSms);
const waMock = vi.mocked(sendTransactionalWhatsapp);

let testOrgId = 0;
let testUserId = 0;
let testProId = 0;
let testClubMemberId = 0;
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
    name: "Test Coach Payout PushSMS Org",
    slug: `coach-payout-pushsms-${Date.now()}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `coach-payout-pushsms-${Date.now()}`,
    username: `coach_payout_pushsms_${Date.now()}`,
    email: "coach-pushsms@example.com",
    displayName: "Coach Charlie",
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  testUserId = u.id;

  const [pro] = await db.insert(teachingProsTable).values({
    organizationId: testOrgId,
    userId: testUserId,
    displayName: "Coach Charlie",
    email: "charlie@coach.com",
    phone: "+919876543210",
  }).returning({ id: teachingProsTable.id });
  testProId = pro.id;

  // Coach also has a club_members row in the org so we can attach
  // member_comm_prefs to control opt-in/out per channel.
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    userId: testUserId,
    firstName: "Coach",
    lastName: "Charlie",
    email: "coach-pushsms@example.com",
    phone: "+919876543210",
  }).returning({ id: clubMembersTable.id });
  testClubMemberId = m.id;

  app = makeApp(testUserId, "org_admin", testOrgId);
});

afterAll(async () => {
  if (testPayoutId) {
    await db.delete(coachPayoutNotificationsTable).where(eq(coachPayoutNotificationsTable.payoutId, testPayoutId));
    await db.delete(coachPayoutsTable).where(eq(coachPayoutsTable.id, testPayoutId));
  }
  await db.delete(memberCommPrefsTable).where(eq(memberCommPrefsTable.clubMemberId, testClubMemberId));
  if (testClubMemberId) await db.delete(clubMembersTable).where(eq(clubMembersTable.id, testClubMemberId));
  if (testProId) await db.delete(teachingProsTable).where(eq(teachingProsTable.id, testProId));
  if (testUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  if (testOrgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(async () => {
  emailMock.mockClear();
  pushMock.mockClear();
  smsMock.mockClear();
  waMock.mockClear();
  // Reset all mocks to default success implementations between tests.
  pushMock.mockImplementation(async () => ({ attempted: 1, sent: 1, failed: 0, invalid: 0 }));
  smsMock.mockImplementation(async () => undefined);
  emailMock.mockImplementation(async () => undefined);
  waMock.mockImplementation(async () => "wa-msg-id");

  await db.delete(memberCommPrefsTable).where(eq(memberCommPrefsTable.clubMemberId, testClubMemberId));
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

describe("POST /admin/payouts/:id/mark-paid (push + SMS fan-out)", () => {
  it("sends email, push and SMS to the coach when no comm-prefs row exists (defaults ON, WhatsApp OFF)", async () => {
    const res = await request(app)
      .post(`/api/swing-reviews/admin/payouts/${testPayoutId}/mark-paid`)
      .send({ reference: "UTR-PUSHSMS-1" });
    expect(res.status).toBe(200);

    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(smsMock).toHaveBeenCalledTimes(1);
    // WhatsApp default is OFF (matches schema default) — must NOT fire
    // unless the coach has explicitly opted in.
    expect(waMock).not.toHaveBeenCalled();

    const [users, title, body, data] = pushMock.mock.calls[0];
    expect(users).toEqual([testUserId]);
    expect(title).toMatch(/Payout sent/);
    expect(body).toMatch(/UTR-PUSHSMS-1/);
    expect(data).toMatchObject({
      type: "coach_payout_paid",
      payoutId: testPayoutId,
      reference: "UTR-PUSHSMS-1",
      deepLink: "/coach/earnings",
    });

    const [phone, smsBody] = smsMock.mock.calls[0];
    expect(phone).toBe("+919876543210");
    expect(smsBody).toMatch(/Payout sent/);
    expect(smsBody).toMatch(/UTR-PUSHSMS-1/);
  });

  it("respects per-channel opt-outs in member_comm_prefs (billing category)", async () => {
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: testClubMemberId,
      organizationId: testOrgId,
      category: "billing",
      emailEnabled: true,
      pushEnabled: false,
      smsEnabled: false,
      whatsappEnabled: false,
    });

    const res = await request(app)
      .post(`/api/swing-reviews/admin/payouts/${testPayoutId}/mark-paid`)
      .send({ reference: "UTR-OPTOUT" });
    expect(res.status).toBe(200);

    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).not.toHaveBeenCalled();
    expect(smsMock).not.toHaveBeenCalled();
    expect(waMock).not.toHaveBeenCalled();
  });

  it("sends a WhatsApp message when the coach has opted in to billing WhatsApp", async () => {
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: testClubMemberId,
      organizationId: testOrgId,
      category: "billing",
      emailEnabled: true,
      pushEnabled: true,
      smsEnabled: true,
      whatsappEnabled: true,
    });

    const res = await request(app)
      .post(`/api/swing-reviews/admin/payouts/${testPayoutId}/mark-paid`)
      .send({ reference: "UTR-WA-OPTIN" });
    expect(res.status).toBe(200);

    expect(waMock).toHaveBeenCalledTimes(1);
    const [phone, body] = waMock.mock.calls[0];
    expect(phone).toBe("+919876543210");
    expect(body).toMatch(/Payout sent/);
    expect(body).toMatch(/UTR-WA-OPTIN/);

    // Other opted-in channels still fire alongside.
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(smsMock).toHaveBeenCalledTimes(1);
  });

  it("WhatsApp opted in but provider not configured: degrades gracefully (logged + skipped, not failed)", async () => {
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: testClubMemberId,
      organizationId: testOrgId,
      category: "billing",
      emailEnabled: true,
      pushEnabled: true,
      smsEnabled: true,
      whatsappEnabled: true,
    });
    waMock.mockImplementationOnce(async () => {
      throw new Error("WHATSAPP_PROVIDER not configured");
    });

    const res = await request(app)
      .post(`/api/swing-reviews/admin/payouts/${testPayoutId}/mark-paid`)
      .send({ reference: "UTR-WA-NOPROV" });
    expect(res.status).toBe(200);

    expect(waMock).toHaveBeenCalledTimes(1);
    // Other channels unaffected.
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(smsMock).toHaveBeenCalledTimes(1);

    // Idempotency stamp still applied so a retry does not re-fan-out.
    const [payout] = await db.select().from(coachPayoutsTable).where(eq(coachPayoutsTable.id, testPayoutId));
    expect(payout.paidNotifiedAt).not.toBeNull();
  });

  it("a failing WhatsApp does not block the email/push/SMS from being attempted", async () => {
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: testClubMemberId,
      organizationId: testOrgId,
      category: "billing",
      emailEnabled: true,
      pushEnabled: true,
      smsEnabled: true,
      whatsappEnabled: true,
    });
    waMock.mockImplementationOnce(async () => { throw new Error("whatsapp provider down"); });

    const res = await request(app)
      .post(`/api/swing-reviews/admin/payouts/${testPayoutId}/mark-paid`)
      .send({ reference: "UTR-WA-FAIL" });
    expect(res.status).toBe(200);

    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(smsMock).toHaveBeenCalledTimes(1);
    expect(waMock).toHaveBeenCalledTimes(1);

    const [payout] = await db.select().from(coachPayoutsTable).where(eq(coachPayoutsTable.id, testPayoutId));
    expect(payout.paidNotifiedAt).not.toBeNull();
  });

  it("a failing push does not block the SMS or email from being attempted", async () => {
    pushMock.mockImplementationOnce(async () => { throw new Error("push provider down"); });

    const res = await request(app)
      .post(`/api/swing-reviews/admin/payouts/${testPayoutId}/mark-paid`)
      .send({ reference: "UTR-FAIL-PUSH" });
    expect(res.status).toBe(200);

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(smsMock).toHaveBeenCalledTimes(1);

    const [payout] = await db.select().from(coachPayoutsTable).where(eq(coachPayoutsTable.id, testPayoutId));
    expect(payout.paidNotifiedAt).not.toBeNull();
  });

  it("a failing SMS does not block the push or email from being attempted", async () => {
    smsMock.mockImplementationOnce(async () => { throw new Error("sms provider down"); });

    const res = await request(app)
      .post(`/api/swing-reviews/admin/payouts/${testPayoutId}/mark-paid`)
      .send({ reference: "UTR-FAIL-SMS" });
    expect(res.status).toBe(200);

    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(smsMock).toHaveBeenCalledTimes(1);
  });

  it("idempotency: a retried mark-paid does not re-fire push or SMS", async () => {
    const first = await request(app)
      .post(`/api/swing-reviews/admin/payouts/${testPayoutId}/mark-paid`)
      .send({ reference: "UTR-IDEM" });
    expect(first.status).toBe(200);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(smsMock).toHaveBeenCalledTimes(1);

    const second = await request(app)
      .post(`/api/swing-reviews/admin/payouts/${testPayoutId}/mark-paid`)
      .send({ reference: "UTR-IDEM" });
    expect(second.status).toBe(200);
    expect(second.body.alreadyNotified).toBe(true);

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(smsMock).toHaveBeenCalledTimes(1);
    expect(emailMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the coach's club_members phone for SMS when the pro record has no phone", async () => {
    await db.update(teachingProsTable).set({ phone: null })
      .where(eq(teachingProsTable.id, testProId));

    const res = await request(app)
      .post(`/api/swing-reviews/admin/payouts/${testPayoutId}/mark-paid`)
      .send({ reference: "UTR-MEMBER-PHONE" });
    expect(res.status).toBe(200);

    expect(smsMock).toHaveBeenCalledTimes(1);
    const [phone] = smsMock.mock.calls[0];
    // Falls back to the club_members.phone seeded in beforeAll.
    expect(phone).toBe("+919876543210");

    await db.update(teachingProsTable).set({ phone: "+919876543210" })
      .where(eq(teachingProsTable.id, testProId));
  });

  it("skips SMS silently when the coach has no phone on file (pro or member)", async () => {
    await db.update(teachingProsTable).set({ phone: null })
      .where(eq(teachingProsTable.id, testProId));
    await db.update(clubMembersTable).set({ phone: null })
      .where(eq(clubMembersTable.id, testClubMemberId));

    const res = await request(app)
      .post(`/api/swing-reviews/admin/payouts/${testPayoutId}/mark-paid`)
      .send({ reference: "UTR-NOPHONE" });
    expect(res.status).toBe(200);

    expect(smsMock).not.toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(emailMock).toHaveBeenCalledTimes(1);

    // Restore phone for subsequent tests
    await db.update(teachingProsTable).set({ phone: "+919876543210" })
      .where(eq(teachingProsTable.id, testProId));
    await db.update(clubMembersTable).set({ phone: "+919876543210" })
      .where(eq(clubMembersTable.id, testClubMemberId));
  });
});
