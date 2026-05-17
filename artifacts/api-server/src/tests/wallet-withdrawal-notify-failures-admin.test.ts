/**
 * Integration test: Stuck wallet-withdrawal alert deliveries
 * (Task #1278).
 *
 * Covers:
 *   - GET /api/admin/wallet-withdrawal-notify-failures?organizationId=
 *   - GET /api/wallet/withdrawals — folds the per-channel notify state
 *     into the member-facing detail row (Sent / Retrying / Could not
 *     deliver) so the player can see whether their email/push
 *     confirmation actually went out.
 *
 * Admin endpoint mirrors the side-game receipt-failures widget: it
 * surfaces wallet-withdrawal notify rows whose email/push retries
 * have either run out (`*RetryExhaustedAt` stamped) or been
 * permanently skipped by the notify helper. This task is read-only —
 * resending is intentionally out of scope (a separate follow-up
 * covers safe one-shot resends).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
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
let memberApp: ReturnType<typeof createTestApp>;
let memberUserId: number;

const withdrawalIds: number[] = [];
const attemptIds: number[] = [];
const userIds: number[] = [];
let seq = 0;

async function makeUser(): Promise<number> {
  seq += 1;
  const tag = `${Date.now()}_${seq}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `wd-stuck-${tag}`,
    username: `wd_stuck_${tag}`,
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
  return u.id;
}

async function makeWithdrawal(userId: number, opts: {
  status?: string;
  amount?: string;
} = {}): Promise<number> {
  const [w] = await db.insert(clubWalletWithdrawalsTable).values({
    walletId: testWalletId,
    organizationId: testOrgId,
    userId,
    amount: opts.amount ?? "250.00",
    currency: "INR",
    method: "upi",
    status: opts.status ?? "processed",
  }).returning({ id: clubWalletWithdrawalsTable.id });
  withdrawalIds.push(w.id);
  return w.id;
}

async function makeAttempt(opts: {
  withdrawalId: number;
  userId: number;
  outcome?: string;
  emailStatus?: string | null;
  emailAttempts?: number;
  emailRetryExhaustedAt?: Date | null;
  nextEmailRetryAt?: Date | null;
  pushStatus?: string | null;
  pushAttempts?: number;
  pushRetryExhaustedAt?: Date | null;
  nextPushRetryAt?: Date | null;
}): Promise<number> {
  const [a] = await db.insert(walletWithdrawalNotifyAttemptsTable).values({
    withdrawalId: opts.withdrawalId,
    organizationId: testOrgId,
    userId: opts.userId,
    outcome: opts.outcome ?? "processed",
    amount: "250.00",
    currency: "INR",
    destination: "UPI ****1234",
    emailStatus: opts.emailStatus ?? "sent",
    emailAttempts: opts.emailAttempts ?? 1,
    emailRetryExhaustedAt: opts.emailRetryExhaustedAt ?? null,
    nextEmailRetryAt: opts.nextEmailRetryAt ?? null,
    pushStatus: opts.pushStatus ?? "sent",
    pushAttempts: opts.pushAttempts ?? 1,
    pushRetryExhaustedAt: opts.pushRetryExhaustedAt ?? null,
    nextPushRetryAt: opts.nextPushRetryAt ?? null,
  }).returning({ id: walletWithdrawalNotifyAttemptsTable.id });
  attemptIds.push(a.id);
  return a.id;
}

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_WdStuckNotify_${stamp}`,
    slug: `test-wd-stuck-notify-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const adminId = await makeUser();
  admin = {
    id: adminId,
    username: "admin",
    role: "org_admin",
    organizationId: testOrgId,
  };
  app = createTestApp(admin);

  const nonAdminId = await makeUser();
  nonAdmin = {
    id: nonAdminId,
    username: "member",
    role: "player",
    organizationId: testOrgId,
  };
  nonAdminApp = createTestApp(nonAdmin);

  memberUserId = await makeUser();
  memberApp = createTestApp({
    id: memberUserId,
    username: "wallet_owner",
    role: "player",
    organizationId: testOrgId,
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
  for (const id of userIds) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(async () => {
  // Wipe per-test seed rows so each test starts clean.
  for (const id of attemptIds.splice(0)) {
    await db.delete(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, id));
  }
  for (const id of withdrawalIds.splice(0)) {
    await db.delete(clubWalletWithdrawalsTable)
      .where(eq(clubWalletWithdrawalsTable.id, id));
  }
});

describe("GET /api/admin/wallet-withdrawal-notify-failures", () => {
  it("requires organizationId", async () => {
    const res = await request(app).get("/api/admin/wallet-withdrawal-notify-failures");
    expect(res.status).toBe(400);
  });

  it("rejects non-admins with 403", async () => {
    const res = await request(nonAdminApp)
      .get(`/api/admin/wallet-withdrawal-notify-failures?organizationId=${testOrgId}`);
    expect(res.status).toBe(403);
  });

  it("returns exhausted and skipped rows but not happy ones", async () => {
    const recipient = await makeUser();

    const happyWd = await makeWithdrawal(recipient);
    await makeAttempt({ withdrawalId: happyWd, userId: recipient });

    const exhaustedWd = await makeWithdrawal(recipient);
    const exhaustedId = await makeAttempt({
      withdrawalId: exhaustedWd,
      userId: recipient,
      emailStatus: "failed",
      emailAttempts: 5,
      emailRetryExhaustedAt: new Date(),
    });

    const skippedWd = await makeWithdrawal(recipient);
    const skippedId = await makeAttempt({
      withdrawalId: skippedWd,
      userId: recipient,
      pushStatus: "no_address",
    });

    const res = await request(app)
      .get(`/api/admin/wallet-withdrawal-notify-failures?organizationId=${testOrgId}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      items: Array<{ id: number; emailStuck: boolean; pushStuck: boolean }>;
      counts: { total: number; exhausted: number; skipped: number };
    };
    const ids = body.items.map(i => i.id).sort();
    expect(ids).toEqual([exhaustedId, skippedId].sort());
    expect(body.counts.total).toBe(2);
    expect(body.counts.exhausted).toBe(1);
    expect(body.counts.skipped).toBe(1);
    const exhaustedRow = body.items.find(i => i.id === exhaustedId)!;
    expect(exhaustedRow.emailStuck).toBe(true);
    const skippedRow = body.items.find(i => i.id === skippedId)!;
    expect(skippedRow.pushStuck).toBe(true);
  });

  describe("filters & pagination", () => {
    it("filters by channel=email (only email-stuck rows)", async () => {
      const recipient = await makeUser();
      const wdEmail = await makeWithdrawal(recipient);
      const emailId = await makeAttempt({
        withdrawalId: wdEmail,
        userId: recipient,
        emailStatus: "failed",
        emailAttempts: 5,
        emailRetryExhaustedAt: new Date(),
      });
      const wdPush = await makeWithdrawal(recipient);
      const pushId = await makeAttempt({
        withdrawalId: wdPush,
        userId: recipient,
        pushStatus: "no_address",
      });

      const emailRes = await request(app)
        .get(`/api/admin/wallet-withdrawal-notify-failures?organizationId=${testOrgId}&channel=email`);
      expect(emailRes.status).toBe(200);
      expect(emailRes.body.items.map((i: { id: number }) => i.id)).toEqual([emailId]);
      expect(emailRes.body.counts.total).toBe(1);

      const pushRes = await request(app)
        .get(`/api/admin/wallet-withdrawal-notify-failures?organizationId=${testOrgId}&channel=push`);
      expect(pushRes.status).toBe(200);
      expect(pushRes.body.items.map((i: { id: number }) => i.id)).toEqual([pushId]);
      expect(pushRes.body.counts.total).toBe(1);
    });

    it("filters by state=exhausted vs state=skipped", async () => {
      const recipient = await makeUser();
      const wdExhausted = await makeWithdrawal(recipient);
      const exhaustedId = await makeAttempt({
        withdrawalId: wdExhausted,
        userId: recipient,
        emailStatus: "failed",
        emailAttempts: 5,
        emailRetryExhaustedAt: new Date(),
      });
      const wdSkipped = await makeWithdrawal(recipient);
      const skippedId = await makeAttempt({
        withdrawalId: wdSkipped,
        userId: recipient,
        emailStatus: "no_address",
      });

      const exhaustedRes = await request(app)
        .get(`/api/admin/wallet-withdrawal-notify-failures?organizationId=${testOrgId}&state=exhausted`);
      expect(exhaustedRes.body.items.map((i: { id: number }) => i.id)).toEqual([exhaustedId]);
      expect(exhaustedRes.body.counts.total).toBe(1);
      expect(exhaustedRes.body.counts.exhausted).toBe(1);
      expect(exhaustedRes.body.counts.skipped).toBe(1);

      const skippedRes = await request(app)
        .get(`/api/admin/wallet-withdrawal-notify-failures?organizationId=${testOrgId}&state=skipped`);
      expect(skippedRes.body.items.map((i: { id: number }) => i.id)).toEqual([skippedId]);
      expect(skippedRes.body.counts.total).toBe(1);
    });

    it("recipient search matches the app-user's username (case-insensitive)", async () => {
      const seqTag = `${Date.now()}_search_${Math.floor(Math.random() * 1e6)}`;
      const [u] = await db.insert(appUsersTable).values({
        replitUserId: `wd-stuck-search-${seqTag}`,
        username: `searchable_alice_${seqTag}`,
        displayName: "Alice Searchable",
        email: `alice_${seqTag}@example.com`,
      }).returning({ id: appUsersTable.id });
      userIds.push(u.id);
      const aliceWd = await makeWithdrawal(u.id);
      const aliceId = await makeAttempt({
        withdrawalId: aliceWd,
        userId: u.id,
        emailStatus: "failed",
        emailAttempts: 5,
        emailRetryExhaustedAt: new Date(),
      });

      const otherUser = await makeUser();
      const otherWd = await makeWithdrawal(otherUser);
      await makeAttempt({
        withdrawalId: otherWd,
        userId: otherUser,
        pushStatus: "no_address",
      });

      const res = await request(app)
        .get(`/api/admin/wallet-withdrawal-notify-failures?organizationId=${testOrgId}&q=ALICE`);
      expect(res.status).toBe(200);
      expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([aliceId]);
      expect(res.body.counts.total).toBe(1);
    });

    it("paginates with limit + offset and returns the same total across pages", async () => {
      const recipient = await makeUser();
      const ids: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const wd = await makeWithdrawal(recipient);
        ids.push(await makeAttempt({
          withdrawalId: wd,
          userId: recipient,
          emailStatus: "no_address",
        }));
      }

      const page1 = await request(app)
        .get(`/api/admin/wallet-withdrawal-notify-failures?organizationId=${testOrgId}&limit=2&offset=0`);
      expect(page1.status).toBe(200);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.counts.total).toBe(5);
      expect(page1.body.page).toEqual({ limit: 2, offset: 0 });

      const page2 = await request(app)
        .get(`/api/admin/wallet-withdrawal-notify-failures?organizationId=${testOrgId}&limit=2&offset=2`);
      expect(page2.body.items).toHaveLength(2);
      expect(page2.body.counts.total).toBe(5);

      const page3 = await request(app)
        .get(`/api/admin/wallet-withdrawal-notify-failures?organizationId=${testOrgId}&limit=2&offset=4`);
      expect(page3.body.items).toHaveLength(1);

      const seenIds = new Set<number>([
        ...page1.body.items.map((i: { id: number }) => i.id),
        ...page2.body.items.map((i: { id: number }) => i.id),
        ...page3.body.items.map((i: { id: number }) => i.id),
      ]);
      expect(seenIds.size).toBe(5);
      for (const id of ids) expect(seenIds.has(id)).toBe(true);
    });
  });

  describe("acknowledged rows (Task #1843)", () => {
    it("hides rows whose adminFollowupAcknowledgedAt is set", async () => {
      const recipient = await makeUser();
      const visibleWd = await makeWithdrawal(recipient);
      const visibleId = await makeAttempt({
        withdrawalId: visibleWd,
        userId: recipient,
        emailStatus: "failed",
        emailAttempts: 5,
        emailRetryExhaustedAt: new Date(),
      });
      const dismissedWd = await makeWithdrawal(recipient);
      const dismissedId = await makeAttempt({
        withdrawalId: dismissedWd,
        userId: recipient,
        emailStatus: "failed",
        emailAttempts: 5,
        emailRetryExhaustedAt: new Date(),
      });
      // Stamp the dismissed row directly so we don't have to depend on
      // the bulk endpoint here (those have their own coverage below).
      await db.update(walletWithdrawalNotifyAttemptsTable)
        .set({ adminFollowupAcknowledgedAt: new Date(), adminFollowupAcknowledgedBy: admin.id })
        .where(eq(walletWithdrawalNotifyAttemptsTable.id, dismissedId));

      const res = await request(app)
        .get(`/api/admin/wallet-withdrawal-notify-failures?organizationId=${testOrgId}`);
      expect(res.status).toBe(200);
      const ids = res.body.items.map((i: { id: number }) => i.id);
      expect(ids).toContain(visibleId);
      expect(ids).not.toContain(dismissedId);
      // Counts (which power the dashboard widget badge) must drop too.
      expect(res.body.counts.total).toBe(1);
      expect(res.body.counts.exhausted).toBe(1);
    });
  });
});

describe("POST /api/admin/wallet-withdrawal-notify-failures/acknowledge (Task #1843)", () => {
  it("requires organizationId", async () => {
    const res = await request(app)
      .post("/api/admin/wallet-withdrawal-notify-failures/acknowledge")
      .send({ ids: [1] });
    expect(res.status).toBe(400);
  });

  it("rejects empty / invalid ids arrays", async () => {
    const res = await request(app)
      .post("/api/admin/wallet-withdrawal-notify-failures/acknowledge")
      .send({ organizationId: testOrgId, ids: [] });
    expect(res.status).toBe(400);
  });

  it("rejects non-admins with 403", async () => {
    const res = await request(nonAdminApp)
      .post("/api/admin/wallet-withdrawal-notify-failures/acknowledge")
      .send({ organizationId: testOrgId, ids: [1] });
    expect(res.status).toBe(403);
  });

  it("stamps adminFollowupAcknowledgedAt + adminFollowupAcknowledgedBy on selected rows and hides them from the worklist", async () => {
    const recipient = await makeUser();
    const wdA = await makeWithdrawal(recipient);
    const idA = await makeAttempt({
      withdrawalId: wdA,
      userId: recipient,
      emailStatus: "failed",
      emailAttempts: 5,
      emailRetryExhaustedAt: new Date(),
    });
    const wdB = await makeWithdrawal(recipient);
    const idB = await makeAttempt({
      withdrawalId: wdB,
      userId: recipient,
      pushStatus: "no_address",
    });

    const ackRes = await request(app)
      .post("/api/admin/wallet-withdrawal-notify-failures/acknowledge")
      .send({ organizationId: testOrgId, ids: [idA, idB] });
    expect(ackRes.status).toBe(200);
    expect(ackRes.body.acknowledged).toBe(2);
    expect(ackRes.body.alreadyAcknowledged).toBe(0);
    expect(ackRes.body.notFound).toBe(0);

    const [rowA] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, idA));
    expect(rowA.adminFollowupAcknowledgedAt).not.toBeNull();
    expect(rowA.adminFollowupAcknowledgedBy).toBe(admin.id);

    // Both rows now hidden from the failures list.
    const listRes = await request(app)
      .get(`/api/admin/wallet-withdrawal-notify-failures?organizationId=${testOrgId}`);
    expect(listRes.body.items.map((i: { id: number }) => i.id)).not.toContain(idA);
    expect(listRes.body.items.map((i: { id: number }) => i.id)).not.toContain(idB);
    expect(listRes.body.counts.total).toBe(0);
  });

  it("is idempotent — re-acknowledging an already-cleared row preserves the original audit stamps", async () => {
    const recipient = await makeUser();
    const wd = await makeWithdrawal(recipient);
    const id = await makeAttempt({
      withdrawalId: wd,
      userId: recipient,
      emailStatus: "failed",
      emailAttempts: 5,
      emailRetryExhaustedAt: new Date(),
    });

    const first = await request(app)
      .post("/api/admin/wallet-withdrawal-notify-failures/acknowledge")
      .send({ organizationId: testOrgId, ids: [id] });
    expect(first.body.acknowledged).toBe(1);

    const [stampedFirst] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, id));
    const firstStampMs = stampedFirst.adminFollowupAcknowledgedAt!.getTime();

    // Wait a beat so a second stamp would land at a different ms.
    await new Promise(r => setTimeout(r, 10));

    const second = await request(app)
      .post("/api/admin/wallet-withdrawal-notify-failures/acknowledge")
      .send({ organizationId: testOrgId, ids: [id] });
    expect(second.body.acknowledged).toBe(0);
    expect(second.body.alreadyAcknowledged).toBe(1);

    const [stampedAgain] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, id));
    expect(stampedAgain.adminFollowupAcknowledgedAt!.getTime()).toBe(firstStampMs);
  });

  it("refuses cross-org acknowledgement — ids from another org are reported as notFound", async () => {
    // Seed a row in `testOrgId` and verify an attempt to ack an
    // id-that-doesn't-belong-to-this-org is silently bucketed as
    // notFound rather than secretly clearing the foreign row.
    const recipient = await makeUser();
    const wd = await makeWithdrawal(recipient);
    const id = await makeAttempt({
      withdrawalId: wd,
      userId: recipient,
      emailStatus: "failed",
      emailAttempts: 5,
      emailRetryExhaustedAt: new Date(),
    });

    // A bogus id that isn't in our test org.
    const ghostId = id + 999_999;

    const res = await request(app)
      .post("/api/admin/wallet-withdrawal-notify-failures/acknowledge")
      .send({ organizationId: testOrgId, ids: [id, ghostId] });
    expect(res.status).toBe(200);
    expect(res.body.acknowledged).toBe(1);
    expect(res.body.notFound).toBe(1);
    expect(res.body.ids.notFound).toEqual([ghostId]);
  });
});

describe("POST /api/admin/wallet-withdrawal-notify-failures/retry (Task #1843)", () => {
  it("requires organizationId", async () => {
    const res = await request(app)
      .post("/api/admin/wallet-withdrawal-notify-failures/retry")
      .send({ ids: [1] });
    expect(res.status).toBe(400);
  });

  it("rejects non-admins with 403", async () => {
    const res = await request(nonAdminApp)
      .post("/api/admin/wallet-withdrawal-notify-failures/retry")
      .send({ organizationId: testOrgId, ids: [1] });
    expect(res.status).toBe(403);
  });

  it("re-queues exhausted email rows by clearing exhaustedAt + resetting attempts/status", async () => {
    const recipient = await makeUser();
    const wd = await makeWithdrawal(recipient);
    const id = await makeAttempt({
      withdrawalId: wd,
      userId: recipient,
      emailStatus: "failed",
      emailAttempts: 5,
      emailRetryExhaustedAt: new Date(),
    });

    const res = await request(app)
      .post("/api/admin/wallet-withdrawal-notify-failures/retry")
      .send({ organizationId: testOrgId, ids: [id] });
    expect(res.status).toBe(200);
    expect(res.body.requeued).toBe(1);
    expect(res.body.emailRequeued).toBe(1);
    expect(res.body.pushRequeued).toBe(0);

    const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, id));
    expect(row.emailRetryExhaustedAt).toBeNull();
    expect(row.emailStatus).toBe("failed");
    expect(row.emailAttempts).toBe(0);
    expect(row.nextEmailRetryAt).not.toBeNull();
    expect(row.lastEmailError).toBeNull();
  });

  it("re-queues skipped push (no_address) rows the same way", async () => {
    const recipient = await makeUser();
    const wd = await makeWithdrawal(recipient);
    const id = await makeAttempt({
      withdrawalId: wd,
      userId: recipient,
      pushStatus: "no_address",
      pushAttempts: 0,
    });

    const res = await request(app)
      .post("/api/admin/wallet-withdrawal-notify-failures/retry")
      .send({ organizationId: testOrgId, ids: [id] });
    expect(res.body.requeued).toBe(1);
    expect(res.body.pushRequeued).toBe(1);
    expect(res.body.emailRequeued).toBe(0);

    const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, id));
    expect(row.pushStatus).toBe("failed");
    expect(row.pushAttempts).toBe(0);
    expect(row.nextPushRetryAt).not.toBeNull();
  });

  it("leaves healthy channels alone and only resets stuck ones", async () => {
    const recipient = await makeUser();
    const wd = await makeWithdrawal(recipient);
    // Email exhausted, push delivered.
    const id = await makeAttempt({
      withdrawalId: wd,
      userId: recipient,
      emailStatus: "failed",
      emailAttempts: 5,
      emailRetryExhaustedAt: new Date(),
      pushStatus: "sent",
      pushAttempts: 1,
    });

    const res = await request(app)
      .post("/api/admin/wallet-withdrawal-notify-failures/retry")
      .send({ organizationId: testOrgId, ids: [id] });
    expect(res.body.requeued).toBe(1);
    expect(res.body.emailRequeued).toBe(1);
    expect(res.body.pushRequeued).toBe(0);

    const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, id));
    // Email reset.
    expect(row.emailRetryExhaustedAt).toBeNull();
    expect(row.emailStatus).toBe("failed");
    // Push untouched.
    expect(row.pushStatus).toBe("sent");
    expect(row.pushAttempts).toBe(1);
  });

  it("clears adminExhaustionNotifiedAt so a future re-exhaustion can re-fire the admin alert", async () => {
    const recipient = await makeUser();
    const wd = await makeWithdrawal(recipient);
    const exhaustedAt = new Date();
    const id = await makeAttempt({
      withdrawalId: wd,
      userId: recipient,
      emailStatus: "failed",
      emailAttempts: 5,
      emailRetryExhaustedAt: exhaustedAt,
    });
    await db.update(walletWithdrawalNotifyAttemptsTable)
      .set({ adminExhaustionNotifiedAt: exhaustedAt })
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, id));

    await request(app)
      .post("/api/admin/wallet-withdrawal-notify-failures/retry")
      .send({ organizationId: testOrgId, ids: [id] });

    const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, id));
    expect(row.adminExhaustionNotifiedAt).toBeNull();
  });

  it("reports alreadyHealthy when the selected row has no stuck channels", async () => {
    const recipient = await makeUser();
    const wd = await makeWithdrawal(recipient);
    const id = await makeAttempt({
      withdrawalId: wd,
      userId: recipient,
      emailStatus: "sent",
      pushStatus: "sent",
    });

    const res = await request(app)
      .post("/api/admin/wallet-withdrawal-notify-failures/retry")
      .send({ organizationId: testOrgId, ids: [id] });
    expect(res.body.requeued).toBe(0);
    expect(res.body.alreadyHealthy).toBe(1);
  });

  it("re-queues a batch of rows in one call", async () => {
    const recipient = await makeUser();
    const ids: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const wd = await makeWithdrawal(recipient);
      ids.push(await makeAttempt({
        withdrawalId: wd,
        userId: recipient,
        emailStatus: "failed",
        emailAttempts: 5,
        emailRetryExhaustedAt: new Date(),
      }));
    }

    const res = await request(app)
      .post("/api/admin/wallet-withdrawal-notify-failures/retry")
      .send({ organizationId: testOrgId, ids });
    expect(res.body.requeued).toBe(3);
    expect(res.body.emailRequeued).toBe(3);

    for (const id of ids) {
      const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
        .where(eq(walletWithdrawalNotifyAttemptsTable.id, id));
      expect(row.emailRetryExhaustedAt).toBeNull();
    }
  });
});

describe("GET /api/wallet/withdrawals — notify badge fold-in", () => {
  it("returns notify=null when no attempts have been recorded yet", async () => {
    await makeWithdrawal(memberUserId, { status: "pending" });

    const res = await request(memberApp)
      .get(`/api/wallet/withdrawals?organizationId=${testOrgId}`);
    expect(res.status).toBe(200);
    const body = res.body as { withdrawals: Array<{ id: number; notify: unknown }> };
    expect(body.withdrawals).toHaveLength(1);
    expect(body.withdrawals[0].notify).toBeNull();
  });

  it("derives 'sent' for delivered email + push", async () => {
    const wd = await makeWithdrawal(memberUserId);
    await makeAttempt({ withdrawalId: wd, userId: memberUserId });

    const res = await request(memberApp)
      .get(`/api/wallet/withdrawals?organizationId=${testOrgId}`);
    expect(res.status).toBe(200);
    const body = res.body as { withdrawals: Array<{ id: number; notify: { email: { status: string }; push: { status: string } } | null }> };
    const row = body.withdrawals.find(w => w.id === wd)!;
    expect(row.notify).not.toBeNull();
    expect(row.notify!.email.status).toBe("sent");
    expect(row.notify!.push.status).toBe("sent");
  });

  it("derives 'retrying' for failed-but-not-yet-exhausted channels", async () => {
    const wd = await makeWithdrawal(memberUserId, { status: "failed" });
    // Task #1499 — also seed nextEmailRetryAt so we can assert the
    // serializer surfaces it on the channel payload (the badge uses
    // this to render "Email retrying — next try in 2m 14s").
    const nextRetry = new Date(Date.now() + 134_000);
    await makeAttempt({
      withdrawalId: wd,
      userId: memberUserId,
      outcome: "failed",
      emailStatus: "failed",
      emailAttempts: 2,
      nextEmailRetryAt: nextRetry,
      pushStatus: "sent",
    });

    const res = await request(memberApp)
      .get(`/api/wallet/withdrawals?organizationId=${testOrgId}`);
    expect(res.status).toBe(200);
    const body = res.body as { withdrawals: Array<{ id: number; notify: { email: { status: string; attempts: number; nextRetryAt: string | null }; push: { status: string; nextRetryAt: string | null } } | null }> };
    const row = body.withdrawals.find(w => w.id === wd)!;
    expect(row.notify!.email.status).toBe("retrying");
    expect(row.notify!.email.attempts).toBe(2);
    expect(row.notify!.email.nextRetryAt).toBe(nextRetry.toISOString());
    expect(row.notify!.push.status).toBe("sent");
    // Push delivered fine — no retry pending.
    expect(row.notify!.push.nextRetryAt).toBeNull();
  });

  it("derives 'failed_permanent' once email retries are exhausted", async () => {
    const wd = await makeWithdrawal(memberUserId);
    const exhaustedAt = new Date(Date.now() - 5 * 60_000);
    await makeAttempt({
      withdrawalId: wd,
      userId: memberUserId,
      emailStatus: "failed",
      emailAttempts: 5,
      emailRetryExhaustedAt: exhaustedAt,
      // The cron clears nextRetryAt when it stamps exhaustedAt — make
      // sure the serializer agrees and reports null so the badge shows
      // "gave up X ago" instead of "next try in …".
      nextEmailRetryAt: null,
    });

    const res = await request(memberApp)
      .get(`/api/wallet/withdrawals?organizationId=${testOrgId}`);
    expect(res.status).toBe(200);
    const body = res.body as { withdrawals: Array<{ id: number; notify: { email: { status: string; exhaustedAt: string | null; nextRetryAt: string | null } } | null }> };
    const row = body.withdrawals.find(w => w.id === wd)!;
    expect(row.notify!.email.status).toBe("failed_permanent");
    expect(row.notify!.email.exhaustedAt).toBe(exhaustedAt.toISOString());
    expect(row.notify!.email.nextRetryAt).toBeNull();
  });

  it("hides skipped/no_address channels (status = null) so the UI shows nothing", async () => {
    const wd = await makeWithdrawal(memberUserId);
    await makeAttempt({
      withdrawalId: wd,
      userId: memberUserId,
      emailStatus: "no_address",
      pushStatus: "opted_out",
    });

    const res = await request(memberApp)
      .get(`/api/wallet/withdrawals?organizationId=${testOrgId}`);
    expect(res.status).toBe(200);
    const body = res.body as { withdrawals: Array<{ id: number; notify: { email: { status: string | null }; push: { status: string | null } } | null }> };
    const row = body.withdrawals.find(w => w.id === wd)!;
    expect(row.notify).not.toBeNull();
    expect(row.notify!.email.status).toBeNull();
    expect(row.notify!.push.status).toBeNull();
  });
});
