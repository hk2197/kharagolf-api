/**
 * Integration test: Stuck side-game receipt deliveries admin endpoints
 * (Task #1117).
 *
 * Covers:
 *   - GET  /api/admin/side-game-receipt-failures?organizationId=
 *   - POST /api/admin/side-game-receipt-failures/:attemptId/resend
 *
 * The dashboard widget surfaces side-game payment receipts whose
 * email/push delivery has either run out of retries
 * (`*RetryExhaustedAt` stamped) or been permanently skipped by the
 * notify helper. The resend endpoint clears that stuck state and re-
 * queues the delivery so the retry cron picks it up on the next tick.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  sideGameInstancesTable,
  sideGameSettlementsTable,
  sideGameSettlementReceiptAttemptsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let testOrgId: number;
let testInstanceId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;
let nonAdmin: TestUser;
let nonAdminApp: ReturnType<typeof createTestApp>;

const settlementIds: number[] = [];
const attemptIds: number[] = [];
const userIds: number[] = [];
let seq = 0;

async function makeUser(): Promise<number> {
  seq += 1;
  const tag = `${Date.now()}_${seq}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `sg-stuck-${tag}`,
    username: `sg_stuck_${tag}`,
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
  return u.id;
}

const clubMemberIds: number[] = [];
async function makeClubMember(userId: number): Promise<number> {
  seq += 1;
  const tag = `${Date.now()}_${seq}`;
  const [cm] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    userId,
    firstName: "Stuck",
    lastName: `Recipient_${tag}`,
    email: `stuck_${tag}@example.test`,
  }).returning({ id: clubMembersTable.id });
  clubMemberIds.push(cm.id);
  return cm.id;
}

async function makeSettlement(): Promise<number> {
  const [s] = await db.insert(sideGameSettlementsTable).values({
    instanceId: testInstanceId,
    fromName: "Payer",
    toName: "Recipient",
    amount: "150.00",
    currency: "INR",
    status: "paid",
    paidAt: new Date(),
  }).returning({ id: sideGameSettlementsTable.id });
  settlementIds.push(s.id);
  return s.id;
}

async function makeAttempt(opts: {
  settlementId: number;
  recipientUserId: number;
  emailStatus?: string | null;
  emailAttempts?: number;
  emailRetryExhaustedAt?: Date | null;
  pushStatus?: string | null;
  pushAttempts?: number;
  pushRetryExhaustedAt?: Date | null;
}): Promise<number> {
  const [a] = await db.insert(sideGameSettlementReceiptAttemptsTable).values({
    organizationId: testOrgId,
    settlementId: opts.settlementId,
    recipientUserId: opts.recipientUserId,
    payerName: "Payer",
    recipientName: "Recipient",
    recipientEmail: "rec@example.test",
    gameLabel: "Skins",
    currency: "INR",
    amount: "150.00",
    paymentMethod: "wallet",
    paymentRef: "ref-1",
    paidAt: new Date(),
    emailStatus: opts.emailStatus ?? "sent",
    emailAttempts: opts.emailAttempts ?? 1,
    emailRetryExhaustedAt: opts.emailRetryExhaustedAt ?? null,
    pushStatus: opts.pushStatus ?? "sent",
    pushAttempts: opts.pushAttempts ?? 1,
    pushRetryExhaustedAt: opts.pushRetryExhaustedAt ?? null,
  }).returning({ id: sideGameSettlementReceiptAttemptsTable.id });
  attemptIds.push(a.id);
  return a.id;
}

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_SGStuckReceipts_${stamp}`,
    slug: `test-sg-stuck-receipts-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [inst] = await db.insert(sideGameInstancesTable).values({
    organizationId: testOrgId,
    gameType: "skins",
    name: "Stuck Receipts Test",
    status: "completed",
  }).returning({ id: sideGameInstancesTable.id });
  testInstanceId = inst.id;

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
});

afterAll(async () => {
  for (const id of attemptIds) {
    await db.delete(sideGameSettlementReceiptAttemptsTable)
      .where(eq(sideGameSettlementReceiptAttemptsTable.id, id));
  }
  for (const id of settlementIds) {
    await db.delete(sideGameSettlementsTable).where(eq(sideGameSettlementsTable.id, id));
  }
  await db.delete(sideGameInstancesTable).where(eq(sideGameInstancesTable.id, testInstanceId));
  for (const id of clubMemberIds.splice(0)) {
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, id));
  }
  for (const id of userIds) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(async () => {
  // Wipe the per-test seed rows so each test starts from a clean slate.
  for (const id of attemptIds.splice(0)) {
    await db.delete(sideGameSettlementReceiptAttemptsTable)
      .where(eq(sideGameSettlementReceiptAttemptsTable.id, id));
  }
  for (const id of settlementIds.splice(0)) {
    await db.delete(sideGameSettlementsTable)
      .where(eq(sideGameSettlementsTable.id, id));
  }
});

describe("GET /api/admin/side-game-receipt-failures", () => {
  it("requires organizationId", async () => {
    const res = await request(app).get("/api/admin/side-game-receipt-failures");
    expect(res.status).toBe(400);
  });

  it("rejects non-admins with 403", async () => {
    const res = await request(nonAdminApp)
      .get(`/api/admin/side-game-receipt-failures?organizationId=${testOrgId}`);
    expect(res.status).toBe(403);
  });

  it("returns exhausted and skipped rows but not happy ones", async () => {
    const recipient = await makeUser();
    const sentSettlement = await makeSettlement();
    await makeAttempt({ settlementId: sentSettlement, recipientUserId: recipient }); // happy path — excluded

    const exhaustedSettlement = await makeSettlement();
    const exhaustedId = await makeAttempt({
      settlementId: exhaustedSettlement,
      recipientUserId: recipient,
      emailStatus: "failed",
      emailAttempts: 5,
      emailRetryExhaustedAt: new Date(),
    });

    const skippedSettlement = await makeSettlement();
    const skippedId = await makeAttempt({
      settlementId: skippedSettlement,
      recipientUserId: recipient,
      pushStatus: "skipped",
    });

    const res = await request(app)
      .get(`/api/admin/side-game-receipt-failures?organizationId=${testOrgId}`);
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

  // Task #1291 — the dashboard widget needs the recipient's clubMembers.id
  // to deep-link the row to Member 360. The endpoint resolves it via a
  // left-join so rows without a club_members row in this org still
  // surface (with a null clubMemberId so the UI falls back to a plain
  // non-link name).
  it("includes recipientClubMemberId when the recipient has a club_members row, null otherwise", async () => {
    const recipientWithMember = await makeUser();
    const memberId = await makeClubMember(recipientWithMember);
    const settlementWithMember = await makeSettlement();
    const linkedAttemptId = await makeAttempt({
      settlementId: settlementWithMember,
      recipientUserId: recipientWithMember,
      emailStatus: "failed",
      emailAttempts: 5,
      emailRetryExhaustedAt: new Date(),
    });

    const recipientNoMember = await makeUser();
    const settlementNoMember = await makeSettlement();
    const orphanAttemptId = await makeAttempt({
      settlementId: settlementNoMember,
      recipientUserId: recipientNoMember,
      pushStatus: "skipped",
    });

    const res = await request(app)
      .get(`/api/admin/side-game-receipt-failures?organizationId=${testOrgId}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      items: Array<{ id: number; recipientClubMemberId: number | null }>;
    };
    const linked = body.items.find(i => i.id === linkedAttemptId)!;
    expect(linked.recipientClubMemberId).toBe(memberId);
    const orphan = body.items.find(i => i.id === orphanAttemptId)!;
    expect(orphan.recipientClubMemberId).toBeNull();
  });
});

describe("POST /api/admin/side-game-receipt-failures/:attemptId/resend", () => {
  it("rejects non-admins with 403", async () => {
    const recipient = await makeUser();
    const settlement = await makeSettlement();
    const attemptId = await makeAttempt({
      settlementId: settlement,
      recipientUserId: recipient,
      emailStatus: "failed",
      emailAttempts: 5,
      emailRetryExhaustedAt: new Date(),
    });
    const res = await request(nonAdminApp)
      .post(`/api/admin/side-game-receipt-failures/${attemptId}/resend`);
    expect(res.status).toBe(403);
  });

  it("404s for an unknown attempt", async () => {
    const res = await request(app)
      .post("/api/admin/side-game-receipt-failures/9999999/resend");
    expect(res.status).toBe(404);
  });

  it("409s when neither channel is stuck", async () => {
    const recipient = await makeUser();
    const settlement = await makeSettlement();
    const attemptId = await makeAttempt({
      settlementId: settlement,
      recipientUserId: recipient,
    });
    const res = await request(app)
      .post(`/api/admin/side-game-receipt-failures/${attemptId}/resend`);
    expect(res.status).toBe(409);
  });

  it("clears exhausted email state and re-queues the delivery", async () => {
    const recipient = await makeUser();
    const settlement = await makeSettlement();
    const attemptId = await makeAttempt({
      settlementId: settlement,
      recipientUserId: recipient,
      emailStatus: "failed",
      emailAttempts: 5,
      emailRetryExhaustedAt: new Date(),
    });
    const res = await request(app)
      .post(`/api/admin/side-game-receipt-failures/${attemptId}/resend`);
    expect(res.status).toBe(200);
    expect(res.body.requeued).toEqual({ email: true, push: false });

    const [row] = await db.select().from(sideGameSettlementReceiptAttemptsTable)
      .where(eq(sideGameSettlementReceiptAttemptsTable.id, attemptId));
    expect(row.emailStatus).toBe("failed");
    expect(row.emailAttempts).toBe(0);
    expect(row.emailRetryExhaustedAt).toBeNull();
    expect(row.nextEmailRetryAt).toBeNull();
    // Push side wasn't stuck so it must be left untouched.
    expect(row.pushStatus).toBe("sent");
    expect(row.pushAttempts).toBe(1);
  });

  it("re-queues skipped push deliveries too", async () => {
    const recipient = await makeUser();
    const settlement = await makeSettlement();
    const attemptId = await makeAttempt({
      settlementId: settlement,
      recipientUserId: recipient,
      pushStatus: "skipped",
    });
    const res = await request(app)
      .post(`/api/admin/side-game-receipt-failures/${attemptId}/resend`);
    expect(res.status).toBe(200);
    expect(res.body.requeued).toEqual({ email: false, push: true });

    const [row] = await db.select().from(sideGameSettlementReceiptAttemptsTable)
      .where(eq(sideGameSettlementReceiptAttemptsTable.id, attemptId));
    expect(row.pushStatus).toBe("failed");
    expect(row.pushAttempts).toBe(0);
    expect(row.pushRetryExhaustedAt).toBeNull();
    expect(row.nextPushRetryAt).toBeNull();
  });
});
