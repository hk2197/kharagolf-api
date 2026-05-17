/**
 * Tests for the coach-scoped notification dispatch trail endpoint — Task #1701.
 *
 *   GET /api/coach-marketplace/me/payout-account/notification-history
 *
 * Returns the per-channel `notification_audit_log` rows that
 * `notifyCoachPayoutAccountChanged` writes (Task #1406) for the
 * authenticated coach, filtered by the
 * `coach.payout.account.changed.coach` key.
 *
 * Coverage:
 *   - 401 when unauthenticated.
 *   - 200 with `{ entries: [] }` when the caller is authenticated but
 *     not yet a registered coach (so the workspace UI never has to
 *     special-case 404).
 *   - The endpoint returns the coach's own audit rows newest-first,
 *     surfacing channel + status + reason + historyId.
 *   - A coach can only see their own rows — never another coach's.
 *   - Rows under any other notification key (e.g. the admin-side fanout
 *     `coach.payout.account.changed.admin`) are filtered out, so a
 *     coach who happens to also be an org admin can't accidentally see
 *     the admin trail through this endpoint.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  teachingProsTable,
  notificationAuditLogTable,
} from "@workspace/db";
import { eq, inArray, and } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgAId: number;
let orgBId: number;
let coachAUserId: number;
let coachBUserId: number;
let nonCoachUserId: number;
let proAId: number;
let proBId: number;

let coachA: TestUser;
let coachB: TestUser;
let nonCoach: TestUser;

let appAsCoachA: ReturnType<typeof createTestApp>;
let appAsCoachB: ReturnType<typeof createTestApp>;
let appAsNonCoach: ReturnType<typeof createTestApp>;
let appAnonymous: ReturnType<typeof createTestApp>;

const URL = "/api/coach-marketplace/me/payout-account/notification-history";
const COACH_KEY = "coach.payout.account.changed.coach";
const ADMIN_KEY = "coach.payout.account.changed.admin";

beforeAll(async () => {
  const [orgA] = await db.insert(organizationsTable).values({
    name: `PayoutNotifA_${stamp}`,
    slug: `payout-notif-a-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;
  const [orgB] = await db.insert(organizationsTable).values({
    name: `PayoutNotifB_${stamp}`,
    slug: `payout-notif-b-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [cA] = await db.insert(appUsersTable).values({
    replitUserId: `payout-notif-coachA-${stamp}`,
    username: `payout_notif_coachA_${stamp}`,
    email: `payout_notif_coachA_${stamp}@example.com`,
    displayName: "Coach A",
    role: "player",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  coachAUserId = cA.id;

  const [cB] = await db.insert(appUsersTable).values({
    replitUserId: `payout-notif-coachB-${stamp}`,
    username: `payout_notif_coachB_${stamp}`,
    email: `payout_notif_coachB_${stamp}@example.com`,
    displayName: "Coach B",
    role: "player",
    organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  coachBUserId = cB.id;

  const [nc] = await db.insert(appUsersTable).values({
    replitUserId: `payout-notif-noncoach-${stamp}`,
    username: `payout_notif_noncoach_${stamp}`,
    email: `payout_notif_noncoach_${stamp}@example.com`,
    displayName: "Not A Coach",
    role: "player",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  nonCoachUserId = nc.id;

  const [pA] = await db.insert(teachingProsTable).values({
    organizationId: orgAId, userId: coachAUserId, displayName: "Coach A",
  }).returning({ id: teachingProsTable.id });
  proAId = pA.id;
  const [pB] = await db.insert(teachingProsTable).values({
    organizationId: orgBId, userId: coachBUserId, displayName: "Coach B",
  }).returning({ id: teachingProsTable.id });
  proBId = pB.id;

  coachA = {
    id: coachAUserId, username: `payout_notif_coachA_${stamp}`,
    displayName: "Coach A", role: "player", organizationId: orgAId,
  };
  coachB = {
    id: coachBUserId, username: `payout_notif_coachB_${stamp}`,
    displayName: "Coach B", role: "player", organizationId: orgBId,
  };
  nonCoach = {
    id: nonCoachUserId, username: `payout_notif_noncoach_${stamp}`,
    displayName: "Not A Coach", role: "player", organizationId: orgAId,
  };

  appAsCoachA = createTestApp(coachA);
  appAsCoachB = createTestApp(coachB);
  appAsNonCoach = createTestApp(nonCoach);
  appAnonymous = createTestApp();
});

afterAll(async () => {
  const userIds = [coachAUserId, coachBUserId, nonCoachUserId].filter(Boolean);
  if (userIds.length) {
    await db.delete(notificationAuditLogTable)
      .where(inArray(notificationAuditLogTable.userId, userIds));
  }
  for (const id of [proAId, proBId]) {
    if (!id) continue;
    await db.delete(teachingProsTable).where(eq(teachingProsTable.id, id));
  }
  if (userIds.length) await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  const orgIds = [orgAId, orgBId].filter(Boolean);
  if (orgIds.length) await db.delete(organizationsTable).where(inArray(organizationsTable.id, orgIds));
});

beforeEach(async () => {
  // Each test seeds its own audit rows — start clean.
  const userIds = [coachAUserId, coachBUserId, nonCoachUserId].filter(Boolean);
  if (userIds.length) {
    await db.delete(notificationAuditLogTable)
      .where(inArray(notificationAuditLogTable.userId, userIds));
  }
});

async function seedAuditRow(opts: {
  userId: number;
  notificationKey?: string;
  channel: "email" | "in_app" | "push";
  status: string;
  reason?: string | null;
  historyId?: number;
}) {
  await db.insert(notificationAuditLogTable).values({
    notificationKey: opts.notificationKey ?? COACH_KEY,
    userId: opts.userId,
    channel: opts.channel,
    status: opts.status,
    reason: opts.reason ?? null,
    payload: { historyId: opts.historyId ?? 1, proId: 1, organizationId: 1 },
  });
}

describe("GET /coach-marketplace/me/payout-account/notification-history", () => {
  it("requires authentication", async () => {
    const res = await request(appAnonymous).get(URL);
    expect(res.status).toBe(401);
  });

  it("returns { entries: [] } for an authenticated user who is not a registered coach", async () => {
    const res = await request(appAsNonCoach).get(URL);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({ entries: [] });
  });

  it("returns the coach's own per-channel audit rows newest-first with channel/status/reason/historyId", async () => {
    // Two account-change events, each with all three legs (some skipped /
    // opted_out so we exercise the reason field too).
    await seedAuditRow({ userId: coachAUserId, channel: "email", status: "sent", historyId: 100 });
    await seedAuditRow({ userId: coachAUserId, channel: "in_app", status: "sent", historyId: 100 });
    await seedAuditRow({
      userId: coachAUserId, channel: "push",
      status: "opted_out", reason: "push_opted_out", historyId: 100,
    });
    // Older event for the same coach — must come second in the result list.
    await db.update(notificationAuditLogTable)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(and(
        eq(notificationAuditLogTable.userId, coachAUserId),
        eq(notificationAuditLogTable.notificationKey, COACH_KEY),
      ));
    await seedAuditRow({
      userId: coachAUserId, channel: "email",
      status: "no_address", reason: "no_email_on_file", historyId: 200,
    });
    await seedAuditRow({ userId: coachAUserId, channel: "in_app", status: "sent", historyId: 200 });
    await seedAuditRow({ userId: coachAUserId, channel: "push", status: "sent", historyId: 200 });

    const res = await request(appAsCoachA).get(URL);
    expect(res.status, res.text).toBe(200);
    const entries = res.body.entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(6);

    // Newest-first: the historyId=200 batch should come before historyId=100.
    expect(entries[0].historyId).toBe(200);
    expect(entries[entries.length - 1].historyId).toBe(100);

    // Each entry surfaces the four contract fields.
    for (const e of entries) {
      expect(typeof e.id).toBe("number");
      expect(typeof e.channel).toBe("string");
      expect(typeof e.status).toBe("string");
      expect(typeof e.createdAt).toBe("string");
    }

    // Reason is preserved verbatim (push opt-out + no_email_on_file).
    const pushOptOut = entries.find(e => e.historyId === 100 && e.channel === "push")!;
    expect(pushOptOut.status).toBe("opted_out");
    expect(pushOptOut.reason).toBe("push_opted_out");

    const emailNoAddr = entries.find(e => e.historyId === 200 && e.channel === "email")!;
    expect(emailNoAddr.status).toBe("no_address");
    expect(emailNoAddr.reason).toBe("no_email_on_file");
  });

  it("never includes another coach's rows (no cross-coach leakage)", async () => {
    await seedAuditRow({ userId: coachAUserId, channel: "email", status: "sent", historyId: 1 });
    await seedAuditRow({ userId: coachBUserId, channel: "email", status: "sent", historyId: 2 });

    const resA = await request(appAsCoachA).get(URL);
    expect(resA.status).toBe(200);
    expect(resA.body.entries).toHaveLength(1);
    expect((resA.body.entries[0] as Record<string, unknown>).historyId).toBe(1);

    const resB = await request(appAsCoachB).get(URL);
    expect(resB.status).toBe(200);
    expect(resB.body.entries).toHaveLength(1);
    expect((resB.body.entries[0] as Record<string, unknown>).historyId).toBe(2);
  });

  it("filters out audit rows under other notification keys (e.g. the admin-side fanout)", async () => {
    // Coach A is *also* the recipient of an admin-key audit row (e.g.
    // because they're listed as an org admin elsewhere). The coach-scoped
    // endpoint must only show the coach-key rows so the admin trail is
    // never accidentally exposed through this endpoint.
    await seedAuditRow({
      userId: coachAUserId, notificationKey: COACH_KEY,
      channel: "email", status: "sent", historyId: 10,
    });
    await seedAuditRow({
      userId: coachAUserId, notificationKey: ADMIN_KEY,
      channel: "email", status: "sent", historyId: 999,
    });

    const res = await request(appAsCoachA).get(URL);
    expect(res.status).toBe(200);
    const entries = res.body.entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0].historyId).toBe(10);
  });
});
