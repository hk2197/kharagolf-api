/**
 * Task #455 — settle-up payment flow tests.
 *
 * Covers the in-app side-game settle-up endpoints:
 *   - POST /api/side-game-settlements/:id/pay-wallet
 *     (debits payer wallet, credits recipient wallet, marks paid)
 *   - GET  /api/wallet?organizationId=
 *     (auto-creates wallet, returns balance + recent txns)
 *
 * The Razorpay-funded path is exercised through markSettlementPaid()
 * directly, which is the same code path the verify endpoint and webhook
 * handler invoke. We don't hit the Razorpay API in tests — the order /
 * verify endpoints would require live keys.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  playersTable,
  tournamentsTable,
  sideGameInstancesTable,
  sideGameSettlementsTable,
  clubWalletsTable,
  clubWalletTxnsTable,
  coursesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp } from "./helpers.js";
import { markSettlementPaid } from "../routes/side-games-v2.js";

let orgId: number;
let payerUserId: number;
let recipientUserId: number;
let payerPlayerId: number;
let recipientPlayerId: number;
let courseId: number;
let tournamentId: number;
let instanceId: number;
let settlementId: number;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `T455-${Date.now()}`,
    slug: `t455-${Date.now()}`,
    contactEmail: `t455-${Date.now()}@example.test`,
  }).returning();
  orgId = org.id;

  const [payer] = await db.insert(appUsersTable).values({
    replitUserId: `ep_t455_payer_${Date.now()}`,
    username: `t455_payer_${Date.now()}`,
    email: `payer_${Date.now()}@example.test`,
    displayName: "Payer",
    role: "player",
    organizationId: orgId,
  }).returning();
  payerUserId = payer.id;

  const [rec] = await db.insert(appUsersTable).values({
    replitUserId: `ep_t455_rec_${Date.now()}`,
    username: `t455_rec_${Date.now()}`,
    email: `rec_${Date.now()}@example.test`,
    displayName: "Recipient",
    role: "player",
    organizationId: orgId,
  }).returning();
  recipientUserId = rec.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId, name: "T455 Course", slug: `t455-course-${Date.now()}`,
  }).returning();
  courseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: "T455 Test Tournament",
    startDate: new Date(),
    rounds: 1,
    status: "completed",
  }).returning();
  tournamentId = tournament.id;

  const [pPlayer] = await db.insert(playersTable).values({
    tournamentId, userId: payerUserId, firstName: "Payer", lastName: "P",
  }).returning();
  payerPlayerId = pPlayer.id;

  const [rPlayer] = await db.insert(playersTable).values({
    tournamentId, userId: recipientUserId, firstName: "Recipient", lastName: "P",
  }).returning();
  recipientPlayerId = rPlayer.id;

  const [instance] = await db.insert(sideGameInstancesTable).values({
    organizationId: orgId,
    tournamentId,
    round: 1,
    gameType: "skins",
    name: "T455 Skins",
    rules: {},
    events: {},
    status: "completed",
    participantPlayerIds: [payerPlayerId, recipientPlayerId],
    participantUserIds: [payerUserId, recipientUserId],
    participantNames: { [payerPlayerId]: "Payer P", [recipientPlayerId]: "Recipient P" },
    createdByUserId: payerUserId,
  }).returning();
  instanceId = instance.id;

  const [settlement] = await db.insert(sideGameSettlementsTable).values({
    instanceId,
    fromPlayerId: payerPlayerId,
    fromName: "Payer P",
    toPlayerId: recipientPlayerId,
    toName: "Recipient P",
    amount: "12.50",
    currency: "INR",
    status: "pending",
  }).returning();
  settlementId = settlement.id;
});

afterAll(async () => {
  await db.delete(sideGameSettlementsTable).where(eq(sideGameSettlementsTable.instanceId, instanceId));
  await db.delete(sideGameInstancesTable).where(eq(sideGameInstancesTable.id, instanceId));
  await db.delete(playersTable).where(inArray(playersTable.id, [payerPlayerId, recipientPlayerId]));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(clubWalletTxnsTable).where(inArray(clubWalletTxnsTable.walletId,
    (await db.select({ id: clubWalletsTable.id }).from(clubWalletsTable).where(eq(clubWalletsTable.organizationId, orgId))).map(r => r.id),
  ));
  await db.delete(clubWalletsTable).where(eq(clubWalletsTable.organizationId, orgId));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [payerUserId, recipientUserId]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("Task #455 — settle-up wallet flow", () => {
  it("auto-creates an empty wallet on first GET /wallet", async () => {
    const app = createTestApp({
      id: payerUserId, username: "payer", role: "player", organizationId: orgId,
    });
    const r = await request(app).get(`/api/wallet?organizationId=${orgId}`);
    expect(r.status).toBe(200);
    expect(r.body.wallet.balance).toBe(0);
    expect(r.body.wallet.userId).toBe(payerUserId);
    expect(Array.isArray(r.body.transactions)).toBe(true);
  });

  it("rejects /pay-wallet when payer has insufficient balance", async () => {
    const app = createTestApp({
      id: payerUserId, username: "payer", role: "player", organizationId: orgId,
    });
    const r = await request(app).post(`/api/side-game-settlements/${settlementId}/pay-wallet`).send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("INSUFFICIENT_FUNDS");
  });

  it("settles via wallet when payer has enough credit", async () => {
    // Seed payer's wallet with 50.00 (wallet may have been auto-created by an earlier test).
    const [wallet] = await db.insert(clubWalletsTable).values({
      organizationId: orgId, userId: payerUserId, currency: "INR", balance: "50.00",
    }).onConflictDoUpdate({
      target: [clubWalletsTable.organizationId, clubWalletsTable.userId, clubWalletsTable.currency],
      set: { balance: "50.00" },
    }).returning();
    await db.insert(clubWalletTxnsTable).values({
      walletId: wallet.id, kind: "credit", amount: "50.00", currency: "INR",
      sourceType: "test_seed", balanceAfter: "50.00",
    });

    const app = createTestApp({
      id: payerUserId, username: "payer", role: "player", organizationId: orgId,
    });
    const r = await request(app).post(`/api/side-game-settlements/${settlementId}/pay-wallet`).send({});
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.settlement.status).toBe("paid");
    expect(r.body.settlement.paymentMethod).toBe("wallet");

    // Payer wallet debited.
    const [payerWallet] = await db.select().from(clubWalletsTable)
      .where(eq(clubWalletsTable.id, wallet.id));
    expect(Number(payerWallet.balance)).toBeCloseTo(50 - 12.5, 2);

    // Recipient wallet credited.
    const [recWallet] = await db.select().from(clubWalletsTable).where(eq(clubWalletsTable.userId, recipientUserId));
    expect(Number(recWallet.balance)).toBeCloseTo(12.5, 2);
  });

  it("rejects pay-wallet for an already-paid settlement (idempotency guard)", async () => {
    const app = createTestApp({
      id: payerUserId, username: "payer", role: "player", organizationId: orgId,
    });
    const r = await request(app).post(`/api/side-game-settlements/${settlementId}/pay-wallet`).send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/paid/);
  });

  it("markSettlementPaid is a no-op when called twice (webhook idempotency)", async () => {
    // Create a fresh pending settlement and use markSettlementPaid (simulating the webhook).
    const [s2] = await db.insert(sideGameSettlementsTable).values({
      instanceId, fromPlayerId: payerPlayerId, fromName: "Payer P",
      toPlayerId: recipientPlayerId, toName: "Recipient P",
      amount: "5.00", currency: "INR", status: "pending",
    }).returning();
    const first = await markSettlementPaid({
      settlementId: s2.id, paymentMethod: "razorpay",
      paymentRef: "pay_test_first", source: "webhook",
    });
    expect(first?.status).toBe("paid");
    expect(first?.paymentRef).toBe("pay_test_first");
    const second = await markSettlementPaid({
      settlementId: s2.id, paymentMethod: "razorpay",
      paymentRef: "pay_test_second", source: "webhook",
    });
    // Second call should return the existing paid settlement, NOT overwrite the ref.
    expect(second?.status).toBe("paid");
    expect(second?.paymentRef).toBe("pay_test_first");
  });

  it("GET /wallet?includeTxnIds= surfaces older txns beyond the recent-50 window (Task #1104)", async () => {
    // Seed >50 fresh credits so the oldest one falls outside the default window,
    // then verify it can be re-surfaced via includeTxnIds.
    const [seedWallet] = await db.insert(clubWalletsTable).values({
      organizationId: orgId, userId: payerUserId, currency: "INR", balance: "0.00",
    }).onConflictDoUpdate({
      target: [clubWalletsTable.organizationId, clubWalletsTable.userId, clubWalletsTable.currency],
      set: { balance: "0.00" },
    }).returning();
    // Insert 55 txns one second apart so ordering is deterministic.
    const base = Date.now() - 60_000;
    const inserted = await db.insert(clubWalletTxnsTable).values(
      Array.from({ length: 55 }, (_, i) => ({
        walletId: seedWallet.id,
        kind: "credit" as const,
        amount: "0.01",
        currency: "INR",
        sourceType: "test_pad",
        balanceAfter: "0.00",
        createdAt: new Date(base + i * 1000),
      })),
    ).returning();
    const oldestId = inserted[0].id;
    const app = createTestApp({
      id: payerUserId, username: "payer", role: "player", organizationId: orgId,
    });
    // Default fetch should NOT include the oldest one.
    const r1 = await request(app).get(`/api/wallet?organizationId=${orgId}`);
    expect(r1.status).toBe(200);
    expect((r1.body.transactions as { id: number }[]).some(t => t.id === oldestId)).toBe(false);
    // With includeTxnIds it should be present.
    const r2 = await request(app).get(`/api/wallet?organizationId=${orgId}&includeTxnIds=${oldestId}`);
    expect(r2.status).toBe(200);
    expect((r2.body.transactions as { id: number }[]).some(t => t.id === oldestId)).toBe(true);
    // A txn id from another wallet must NOT leak in even when requested.
    const [otherUser] = await db.insert(appUsersTable).values({
      replitUserId: `ep_t1104_other_${Date.now()}`,
      username: `t1104_other_${Date.now()}`,
      email: `t1104_other_${Date.now()}@example.test`,
      displayName: "Other", role: "player", organizationId: orgId,
    }).returning();
    const [otherWallet] = await db.insert(clubWalletsTable).values({
      organizationId: orgId, userId: otherUser.id, currency: "INR", balance: "0.00",
    }).returning();
    const [otherTxn] = await db.insert(clubWalletTxnsTable).values({
      walletId: otherWallet.id, kind: "credit", amount: "1.00", currency: "INR",
      sourceType: "test_other", balanceAfter: "1.00",
    }).returning();
    const r3 = await request(app).get(`/api/wallet?organizationId=${orgId}&includeTxnIds=${otherTxn.id}`);
    expect(r3.status).toBe(200);
    expect((r3.body.transactions as { id: number }[]).some(t => t.id === otherTxn.id)).toBe(false);
    // Cleanup the foreign user we just created (the rest is handled in afterAll).
    await db.delete(clubWalletTxnsTable).where(eq(clubWalletTxnsTable.id, otherTxn.id));
    await db.delete(clubWalletsTable).where(eq(clubWalletsTable.id, otherWallet.id));
    await db.delete(appUsersTable).where(eq(appUsersTable.id, otherUser.id));
  });

  it("rejects /pay-wallet from a user who isn't the debtor", async () => {
    // Recipient tries to pay payer's debt — not allowed.
    const app = createTestApp({
      id: recipientUserId, username: "rec", role: "player", organizationId: orgId,
    });
    // Need a fresh pending settlement.
    const [s3] = await db.insert(sideGameSettlementsTable).values({
      instanceId, fromPlayerId: payerPlayerId, fromName: "Payer P",
      toPlayerId: recipientPlayerId, toName: "Recipient P",
      amount: "1.00", currency: "INR", status: "pending",
    }).returning();
    const r = await request(app).post(`/api/side-game-settlements/${s3.id}/pay-wallet`).send({});
    expect(r.status).toBe(403);
  });
});
