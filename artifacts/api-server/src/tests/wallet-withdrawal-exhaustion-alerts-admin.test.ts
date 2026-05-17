/**
 * Integration test: Admin worklist for retry-exhausted wallet
 * withdrawal alerts (Task #1501).
 *
 * Covers:
 *   - GET /api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=
 *   - POST /api/admin/wallet-withdrawal-exhaustion-alerts/:attemptId/acknowledge
 *
 * The list endpoint surfaces only rows the cron has already pushed an
 * admin alert about (i.e. `adminExhaustionNotifiedAt IS NOT NULL`) and
 * that an admin has not yet manually marked as followed up. Mark-
 * followed-up is idempotent and trail-stamped with the acting admin's
 * user id so we have a basic audit signal of who cleared the row.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  clubWalletsTable,
  clubWalletWithdrawalsTable,
  walletWithdrawalNotifyAttemptsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let testOrgId: number;
let testWalletId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;
let nonAdmin: TestUser;
let nonAdminApp: ReturnType<typeof createTestApp>;
let memberUserId: number;

const withdrawalIds: number[] = [];
const attemptIds: number[] = [];
const userIds: number[] = [];
const memberIds: number[] = [];
let seq = 0;

async function makeUser(opts: { displayName?: string; email?: string } = {}): Promise<number> {
  seq += 1;
  const tag = `${Date.now()}_${seq}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `wd-exh-${tag}`,
    username: `wd_exh_${tag}`,
    displayName: opts.displayName ?? null,
    email: opts.email ?? null,
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
  return u.id;
}

async function makeMember(userId: number, opts: {
  firstName?: string;
  lastName?: string;
  email?: string;
} = {}): Promise<void> {
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    userId,
    firstName: opts.firstName ?? "Test",
    lastName: opts.lastName ?? "Member",
    email: opts.email ?? null,
  }).returning({ id: clubMembersTable.id });
  memberIds.push(m.id);
}

async function makeWithdrawal(userId: number): Promise<number> {
  const [w] = await db.insert(clubWalletWithdrawalsTable).values({
    walletId: testWalletId,
    organizationId: testOrgId,
    userId,
    amount: "750.00",
    currency: "INR",
    method: "upi",
    status: "processed",
  }).returning({ id: clubWalletWithdrawalsTable.id });
  withdrawalIds.push(w.id);
  return w.id;
}

async function makeAttempt(opts: {
  withdrawalId: number;
  userId: number;
  outcome?: string;
  adminExhaustionNotifiedAt?: Date | null;
  adminFollowupAcknowledgedAt?: Date | null;
  emailRetryExhaustedAt?: Date | null;
  pushRetryExhaustedAt?: Date | null;
  lastEmailError?: string | null;
  lastPushError?: string | null;
  lastEmailAt?: Date | null;
  lastPushAt?: Date | null;
}): Promise<number> {
  const [a] = await db.insert(walletWithdrawalNotifyAttemptsTable).values({
    withdrawalId: opts.withdrawalId,
    organizationId: testOrgId,
    userId: opts.userId,
    outcome: opts.outcome ?? "processed",
    amount: "750.00",
    currency: "INR",
    destination: "UPI ****9999",
    emailStatus: opts.emailRetryExhaustedAt ? "failed" : "sent",
    emailAttempts: opts.emailRetryExhaustedAt ? 5 : 1,
    emailRetryExhaustedAt: opts.emailRetryExhaustedAt ?? null,
    lastEmailError: opts.lastEmailError ?? null,
    lastEmailAt: opts.lastEmailAt ?? null,
    pushStatus: opts.pushRetryExhaustedAt ? "failed" : "sent",
    pushAttempts: opts.pushRetryExhaustedAt ? 5 : 1,
    pushRetryExhaustedAt: opts.pushRetryExhaustedAt ?? null,
    lastPushError: opts.lastPushError ?? null,
    lastPushAt: opts.lastPushAt ?? null,
    adminExhaustionNotifiedAt: opts.adminExhaustionNotifiedAt ?? null,
    adminFollowupAcknowledgedAt: opts.adminFollowupAcknowledgedAt ?? null,
  }).returning({ id: walletWithdrawalNotifyAttemptsTable.id });
  attemptIds.push(a.id);
  return a.id;
}

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_WdExhAlerts_${stamp}`,
    slug: `test-wd-exh-alerts-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const adminId = await makeUser({ displayName: "Admin User" });
  admin = {
    id: adminId,
    username: "admin",
    role: "org_admin",
    organizationId: testOrgId,
  };
  app = createTestApp(admin);

  const nonAdminId = await makeUser({ displayName: "Member User" });
  nonAdmin = {
    id: nonAdminId,
    username: "member",
    role: "player",
    organizationId: testOrgId,
  };
  nonAdminApp = createTestApp(nonAdmin);

  memberUserId = await makeUser({ displayName: "Wallet Owner", email: "wallet@test.example" });
  await makeMember(memberUserId, {
    firstName: "Wallet",
    lastName: "Owner",
    email: "member@test.example",
  });

  const [wallet] = await db.insert(clubWalletsTable).values({
    organizationId: testOrgId,
    userId: memberUserId,
    currency: "INR",
    balance: "0.00",
  }).returning({ id: clubWalletsTable.id });
  testWalletId = wallet.id;
});

afterAll(async () => {
  for (const id of attemptIds) {
    await db.delete(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, id));
  }
  for (const id of withdrawalIds) {
    await db.delete(clubWalletWithdrawalsTable)
      .where(eq(clubWalletWithdrawalsTable.id, id));
  }
  await db.delete(clubWalletsTable).where(eq(clubWalletsTable.id, testWalletId));
  for (const id of memberIds) {
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, id));
  }
  for (const id of userIds) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(async () => {
  for (const id of attemptIds.splice(0)) {
    await db.delete(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, id));
  }
  for (const id of withdrawalIds.splice(0)) {
    await db.delete(clubWalletWithdrawalsTable)
      .where(eq(clubWalletWithdrawalsTable.id, id));
  }
});

describe("GET /api/admin/wallet-withdrawal-exhaustion-alerts", () => {
  it("requires organizationId", async () => {
    const res = await request(app)
      .get("/api/admin/wallet-withdrawal-exhaustion-alerts");
    expect(res.status).toBe(400);
  });

  it("rejects non-admins with 403", async () => {
    const res = await request(nonAdminApp)
      .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}`);
    expect(res.status).toBe(403);
  });

  it("returns only notified-but-not-acknowledged rows", async () => {
    const wdNotNotified = await makeWithdrawal(memberUserId);
    await makeAttempt({
      withdrawalId: wdNotNotified,
      userId: memberUserId,
      emailRetryExhaustedAt: new Date(),
      adminExhaustionNotifiedAt: null,
    });

    const wdAcknowledged = await makeWithdrawal(memberUserId);
    await makeAttempt({
      withdrawalId: wdAcknowledged,
      userId: memberUserId,
      emailRetryExhaustedAt: new Date(),
      adminExhaustionNotifiedAt: new Date(Date.now() - 60_000),
      adminFollowupAcknowledgedAt: new Date(Date.now() - 30_000),
    });

    const wdOpen = await makeWithdrawal(memberUserId);
    const openId = await makeAttempt({
      withdrawalId: wdOpen,
      userId: memberUserId,
      emailRetryExhaustedAt: new Date(),
      lastEmailError: "550 mailbox unavailable",
      lastEmailAt: new Date(),
      adminExhaustionNotifiedAt: new Date(),
    });

    const res = await request(app)
      .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      items: Array<{
        id: number;
        withdrawalId: number;
        recipientName: string | null;
        recipientEmail: string | null;
        adminExhaustionNotifiedAt: string;
        lastError: string | null;
      }>;
      count: number;
    };

    expect(body.count).toBe(1);
    expect(body.items).toHaveLength(1);
    const row = body.items[0];
    expect(row.id).toBe(openId);
    expect(row.withdrawalId).toBe(wdOpen);
    // Member contact info comes through (member email is preferred over user email).
    expect(row.recipientName).toBe("Wallet Owner");
    expect(row.recipientEmail).toBe("member@test.example");
    expect(row.lastError).toBe("550 mailbox unavailable");
    expect(row.adminExhaustionNotifiedAt).toBeTruthy();
  });

  // Task #1856 — acknowledged-slice tests. Surface the audit trail
  // (acknowledger name + timestamp) so the admin UI can render a
  // "Recently followed up" feed.
  it("status=acknowledged returns acked rows with acknowledger name + timestamp", async () => {
    const ackedAt = new Date(Date.now() - 60_000);

    const wdAcked = await makeWithdrawal(memberUserId);
    const ackedId = await makeAttempt({
      withdrawalId: wdAcked,
      userId: memberUserId,
      emailRetryExhaustedAt: new Date(Date.now() - 120_000),
      adminExhaustionNotifiedAt: new Date(Date.now() - 90_000),
    });
    // Stamp acknowledger fields directly so we can control the
    // timestamp + the acknowledging admin without relying on the POST
    // endpoint (which is exercised in its own block below).
    await db.update(walletWithdrawalNotifyAttemptsTable)
      .set({
        adminFollowupAcknowledgedAt: ackedAt,
        adminFollowupAcknowledgedBy: admin.id,
      })
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, ackedId));

    // Open row should NOT appear when status=acknowledged.
    const wdOpen = await makeWithdrawal(memberUserId);
    await makeAttempt({
      withdrawalId: wdOpen,
      userId: memberUserId,
      emailRetryExhaustedAt: new Date(),
      adminExhaustionNotifiedAt: new Date(),
    });

    const res = await request(app)
      .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}&status=acknowledged`);
    expect(res.status).toBe(200);
    const body = res.body as {
      items: Array<{
        id: number;
        adminFollowupAcknowledgedAt: string | null;
        adminFollowupAcknowledgedBy: number | null;
        acknowledgedByName: string | null;
      }>;
      count: number;
      status: string;
      days: number;
    };

    expect(body.status).toBe("acknowledged");
    expect(body.days).toBe(30);
    expect(body.count).toBe(1);
    expect(body.items).toHaveLength(1);

    const row = body.items[0];
    expect(row.id).toBe(ackedId);
    expect(row.adminFollowupAcknowledgedAt).toBe(ackedAt.toISOString());
    expect(row.adminFollowupAcknowledgedBy).toBe(admin.id);
    expect(row.acknowledgedByName).toBe("Admin User");
  });

  it("status=acknowledged honors the days bound", async () => {
    const longAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const recently = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    const wdOld = await makeWithdrawal(memberUserId);
    const oldId = await makeAttempt({
      withdrawalId: wdOld,
      userId: memberUserId,
      emailRetryExhaustedAt: longAgo,
      adminExhaustionNotifiedAt: longAgo,
    });
    await db.update(walletWithdrawalNotifyAttemptsTable)
      .set({ adminFollowupAcknowledgedAt: longAgo, adminFollowupAcknowledgedBy: admin.id })
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, oldId));

    const wdNew = await makeWithdrawal(memberUserId);
    const newId = await makeAttempt({
      withdrawalId: wdNew,
      userId: memberUserId,
      emailRetryExhaustedAt: recently,
      adminExhaustionNotifiedAt: recently,
    });
    await db.update(walletWithdrawalNotifyAttemptsTable)
      .set({ adminFollowupAcknowledgedAt: recently, adminFollowupAcknowledgedBy: admin.id })
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, newId));

    // Default 30-day window: only the recent ack appears.
    const def = await request(app)
      .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}&status=acknowledged`);
    expect(def.status).toBe(200);
    expect((def.body.items as Array<{ id: number }>).map(i => i.id)).toEqual([newId]);

    // Wider 90-day window: both rows appear, newest ack first.
    const wide = await request(app)
      .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}&status=acknowledged&days=90`);
    expect(wide.status).toBe(200);
    expect(wide.body.days).toBe(90);
    expect((wide.body.items as Array<{ id: number }>).map(i => i.id)).toEqual([newId, oldId]);

    // days bound is clamped at 90 server-side.
    const clamped = await request(app)
      .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}&status=acknowledged&days=9999`);
    expect(clamped.status).toBe(200);
    expect(clamped.body.days).toBe(90);
  });

  it("status=all returns both open and recently-acknowledged rows", async () => {
    const ackedAt = new Date(Date.now() - 60_000);

    const wdAcked = await makeWithdrawal(memberUserId);
    const ackedId = await makeAttempt({
      withdrawalId: wdAcked,
      userId: memberUserId,
      emailRetryExhaustedAt: new Date(Date.now() - 120_000),
      adminExhaustionNotifiedAt: new Date(Date.now() - 90_000),
    });
    await db.update(walletWithdrawalNotifyAttemptsTable)
      .set({ adminFollowupAcknowledgedAt: ackedAt, adminFollowupAcknowledgedBy: admin.id })
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, ackedId));

    const wdOpen = await makeWithdrawal(memberUserId);
    const openId = await makeAttempt({
      withdrawalId: wdOpen,
      userId: memberUserId,
      emailRetryExhaustedAt: new Date(),
      adminExhaustionNotifiedAt: new Date(),
    });

    const res = await request(app)
      .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}&status=all`);
    expect(res.status).toBe(200);
    const ids = (res.body.items as Array<{ id: number }>).map(i => i.id).sort((a, b) => a - b);
    expect(ids).toEqual([ackedId, openId].sort((a, b) => a - b));

    const acked = (res.body.items as Array<{
      id: number;
      acknowledgedByName: string | null;
      adminFollowupAcknowledgedAt: string | null;
    }>).find(i => i.id === ackedId)!;
    expect(acked.acknowledgedByName).toBe("Admin User");
    expect(acked.adminFollowupAcknowledgedAt).toBe(ackedAt.toISOString());

    const open = (res.body.items as Array<{
      id: number;
      acknowledgedByName: string | null;
      adminFollowupAcknowledgedAt: string | null;
      adminFollowupAcknowledgedBy: number | null;
    }>).find(i => i.id === openId)!;
    expect(open.acknowledgedByName).toBeNull();
    expect(open.adminFollowupAcknowledgedAt).toBeNull();
    expect(open.adminFollowupAcknowledgedBy).toBeNull();
  });

  it("default status=open omits acknowledger fields' values for un-acked rows", async () => {
    const wd = await makeWithdrawal(memberUserId);
    const id = await makeAttempt({
      withdrawalId: wd,
      userId: memberUserId,
      emailRetryExhaustedAt: new Date(),
      adminExhaustionNotifiedAt: new Date(),
    });

    const res = await request(app)
      .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      items: Array<{
        id: number;
        adminFollowupAcknowledgedAt: string | null;
        adminFollowupAcknowledgedBy: number | null;
        acknowledgedByName: string | null;
      }>;
      status: string;
    };
    expect(body.status).toBe("open");
    const row = body.items.find(i => i.id === id)!;
    expect(row.adminFollowupAcknowledgedAt).toBeNull();
    expect(row.adminFollowupAcknowledgedBy).toBeNull();
    expect(row.acknowledgedByName).toBeNull();
  });

  // Task #1858 — pagination tests. Older clients still see the same
  // shape (`items` + `count`); new clients use `nextCursor` + `total`
  // + `limit` to walk the full queue without the old 200-row cap.
  describe("pagination (Task #1858)", () => {
    it("returns total + nextCursor + limit alongside items", async () => {
      const wd = await makeWithdrawal(memberUserId);
      await makeAttempt({
        withdrawalId: wd,
        userId: memberUserId,
        emailRetryExhaustedAt: new Date(),
        adminExhaustionNotifiedAt: new Date(),
      });

      const res = await request(app)
        .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}`);
      expect(res.status).toBe(200);
      const body = res.body as {
        items: unknown[];
        count: number;
        total: number;
        limit: number;
        nextCursor: string | null;
      };
      expect(body.count).toBe(1);
      expect(body.total).toBe(1);
      // No second page when the page is not full.
      expect(body.nextCursor).toBeNull();
      // Default page size is 50 (well under the old 200 cap).
      expect(body.limit).toBe(50);
    });

    it("clamps limit between 1 and 200, defaulting to 50", async () => {
      const tooLow = await request(app)
        .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}&limit=0`);
      expect(tooLow.body.limit).toBe(50);

      const tooHigh = await request(app)
        .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}&limit=99999`);
      expect(tooHigh.body.limit).toBe(200);

      const explicit = await request(app)
        .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}&limit=10`);
      expect(explicit.body.limit).toBe(10);
    });

    it("walks every row across multiple pages with cursor", async () => {
      // Create 5 attempts with strictly-decreasing notified-at stamps
      // so the (timestamp, id) ordering is deterministic.
      const ids: number[] = [];
      const base = Date.now();
      for (let i = 0; i < 5; i++) {
        const wd = await makeWithdrawal(memberUserId);
        const attemptId = await makeAttempt({
          withdrawalId: wd,
          userId: memberUserId,
          emailRetryExhaustedAt: new Date(base - i * 1000),
          adminExhaustionNotifiedAt: new Date(base - i * 1000),
        });
        ids.push(attemptId);
      }
      // Newest-first ordering means index 0 (the newest) should land
      // first; the oldest (last inserted, smallest base offset) lands
      // last.
      const expectedOrder = [...ids]; // ids[0] newest, ids[4] oldest

      // First page: limit=2, no cursor.
      const first = await request(app)
        .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}&limit=2`);
      expect(first.status).toBe(200);
      expect(first.body.total).toBe(5);
      expect(first.body.count).toBe(2);
      expect(first.body.nextCursor).toBeTruthy();
      expect((first.body.items as Array<{ id: number }>).map(i => i.id))
        .toEqual([expectedOrder[0], expectedOrder[1]]);

      // Second page: feed the cursor back in.
      const second = await request(app)
        .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}&limit=2`)
        .query({ cursor: first.body.nextCursor });
      expect(second.status).toBe(200);
      expect(second.body.total).toBe(5);
      expect(second.body.count).toBe(2);
      expect(second.body.nextCursor).toBeTruthy();
      expect((second.body.items as Array<{ id: number }>).map(i => i.id))
        .toEqual([expectedOrder[2], expectedOrder[3]]);

      // Third (last) page: only 1 row left, so nextCursor is null.
      const third = await request(app)
        .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}&limit=2`)
        .query({ cursor: second.body.nextCursor });
      expect(third.status).toBe(200);
      expect(third.body.total).toBe(5);
      expect(third.body.count).toBe(1);
      expect(third.body.nextCursor).toBeNull();
      expect((third.body.items as Array<{ id: number }>).map(i => i.id))
        .toEqual([expectedOrder[4]]);
    });

    it("falls back to first page when cursor is malformed", async () => {
      const wd = await makeWithdrawal(memberUserId);
      await makeAttempt({
        withdrawalId: wd,
        userId: memberUserId,
        emailRetryExhaustedAt: new Date(),
        adminExhaustionNotifiedAt: new Date(),
      });

      const res = await request(app)
        .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}`)
        .query({ cursor: "this-is-not-a-cursor" });
      expect(res.status).toBe(200);
      // We get the full page rather than a 400 — the page can recover
      // by simply asking for the first page again.
      expect(res.body.count).toBe(1);
      expect(res.body.total).toBe(1);
    });

    it("paginates the acknowledged feed too", async () => {
      // Create 3 acknowledged rows so the audit feed needs a second
      // page at limit=2.
      const ids: number[] = [];
      for (let i = 0; i < 3; i++) {
        const wd = await makeWithdrawal(memberUserId);
        const attemptId = await makeAttempt({
          withdrawalId: wd,
          userId: memberUserId,
          emailRetryExhaustedAt: new Date(Date.now() - 60_000 - i * 1000),
          adminExhaustionNotifiedAt: new Date(Date.now() - 60_000 - i * 1000),
        });
        await db.update(walletWithdrawalNotifyAttemptsTable)
          .set({
            adminFollowupAcknowledgedAt: new Date(Date.now() - i * 1000),
            adminFollowupAcknowledgedBy: admin.id,
          })
          .where(eq(walletWithdrawalNotifyAttemptsTable.id, attemptId));
        ids.push(attemptId);
      }

      const first = await request(app)
        .get(
          `/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}`
          + `&status=acknowledged&limit=2`,
        );
      expect(first.status).toBe(200);
      expect(first.body.total).toBe(3);
      expect(first.body.count).toBe(2);
      expect(first.body.nextCursor).toBeTruthy();
      // Newest-acked first.
      expect((first.body.items as Array<{ id: number }>).map(i => i.id))
        .toEqual([ids[0], ids[1]]);

      const second = await request(app)
        .get(
          `/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}`
          + `&status=acknowledged&limit=2`,
        )
        .query({ cursor: first.body.nextCursor });
      expect(second.status).toBe(200);
      expect(second.body.count).toBe(1);
      expect(second.body.nextCursor).toBeNull();
      expect((second.body.items as Array<{ id: number }>).map(i => i.id))
        .toEqual([ids[2]]);
    });
  });

  it("orders newest-notified first", async () => {
    const wd1 = await makeWithdrawal(memberUserId);
    const id1 = await makeAttempt({
      withdrawalId: wd1,
      userId: memberUserId,
      emailRetryExhaustedAt: new Date(Date.now() - 120_000),
      adminExhaustionNotifiedAt: new Date(Date.now() - 120_000),
    });

    const wd2 = await makeWithdrawal(memberUserId);
    const id2 = await makeAttempt({
      withdrawalId: wd2,
      userId: memberUserId,
      pushRetryExhaustedAt: new Date(),
      adminExhaustionNotifiedAt: new Date(),
    });

    const res = await request(app)
      .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}`);
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<{ id: number }> };
    expect(body.items.map(i => i.id)).toEqual([id2, id1]);
  });
});

describe("POST /api/admin/wallet-withdrawal-exhaustion-alerts/:attemptId/acknowledge", () => {
  it("rejects non-admins with 403", async () => {
    const wd = await makeWithdrawal(memberUserId);
    const id = await makeAttempt({
      withdrawalId: wd,
      userId: memberUserId,
      emailRetryExhaustedAt: new Date(),
      adminExhaustionNotifiedAt: new Date(),
    });
    const res = await request(nonAdminApp)
      .post(`/api/admin/wallet-withdrawal-exhaustion-alerts/${id}/acknowledge`);
    expect(res.status).toBe(403);
  });

  it("404s for an unknown attempt", async () => {
    const res = await request(app)
      .post("/api/admin/wallet-withdrawal-exhaustion-alerts/999999999/acknowledge");
    expect(res.status).toBe(404);
  });

  it("409s if the row was never alerted to admins", async () => {
    const wd = await makeWithdrawal(memberUserId);
    const id = await makeAttempt({
      withdrawalId: wd,
      userId: memberUserId,
      adminExhaustionNotifiedAt: null,
    });
    const res = await request(app)
      .post(`/api/admin/wallet-withdrawal-exhaustion-alerts/${id}/acknowledge`);
    expect(res.status).toBe(409);
  });

  it("marks the row acknowledged and drops it off the list", async () => {
    const wd = await makeWithdrawal(memberUserId);
    const id = await makeAttempt({
      withdrawalId: wd,
      userId: memberUserId,
      emailRetryExhaustedAt: new Date(),
      adminExhaustionNotifiedAt: new Date(),
    });

    const before = await request(app)
      .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}`);
    expect(before.body.count).toBe(1);

    const ack = await request(app)
      .post(`/api/admin/wallet-withdrawal-exhaustion-alerts/${id}/acknowledge`);
    expect(ack.status).toBe(200);
    expect(ack.body.alreadyAcknowledged).toBe(false);
    expect(ack.body.acknowledgedAt).toBeTruthy();
    expect(ack.body.acknowledgedBy).toBe(admin.id);

    const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, id));
    expect(row.adminFollowupAcknowledgedAt).toBeTruthy();
    expect(row.adminFollowupAcknowledgedBy).toBe(admin.id);

    const after = await request(app)
      .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}`);
    expect(after.body.count).toBe(0);
    expect(after.body.items).toEqual([]);
  });

  it("is idempotent — re-acknowledging keeps the original stamps", async () => {
    const wd = await makeWithdrawal(memberUserId);
    const id = await makeAttempt({
      withdrawalId: wd,
      userId: memberUserId,
      emailRetryExhaustedAt: new Date(),
      adminExhaustionNotifiedAt: new Date(),
    });

    const first = await request(app)
      .post(`/api/admin/wallet-withdrawal-exhaustion-alerts/${id}/acknowledge`);
    expect(first.status).toBe(200);
    expect(first.body.alreadyAcknowledged).toBe(false);
    const firstAt = first.body.acknowledgedAt as string;

    const second = await request(app)
      .post(`/api/admin/wallet-withdrawal-exhaustion-alerts/${id}/acknowledge`);
    expect(second.status).toBe(200);
    expect(second.body.alreadyAcknowledged).toBe(true);
    expect(second.body.acknowledgedAt).toBe(firstAt);

    const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, id));
    expect(row.adminFollowupAcknowledgedAt?.toISOString()).toBe(firstAt);
    expect(row.adminFollowupAcknowledgedBy).toBe(admin.id);
  });
});
