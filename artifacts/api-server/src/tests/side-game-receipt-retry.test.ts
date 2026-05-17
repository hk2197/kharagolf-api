/**
 * Unit tests: Side-game settlement receipt email/push retry helpers (Task #961)
 *
 * Mirrors `levy-receipt-retry.test.ts` (Tasks #207 / #247). Verifies the
 * bounded retry helpers `retrySideGameReceiptEmail` and
 * `retrySideGameReceiptPush` at the bottom of `sideGameSettlementPaidNotify.ts`:
 *   - Happy path: a previously `failed` email/push retries successfully and
 *     the attempts row is updated with the new status, attempt count,
 *     `lastEmail/PushRetryAt`, and `nextEmail/PushRetryAt` cleared.
 *   - Cap: once attempts reach the cap and the retry still fails,
 *     `emailRetryExhaustedAt` / `pushRetryExhaustedAt` is stamped and any
 *     subsequent retry returns `null`.
 *   - Backoff: a row whose `next*RetryAt` is still in the future is skipped
 *     (returns `null` without firing the provider).
 *   - Email provider-not-configured: status flips to terminal `skipped`,
 *     attempts NOT incremented, cron stops re-selecting it.
 *   - Ineligibility: rows whose status is no longer `failed` return `null`
 *     without firing any provider call.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendSideGameSettlementReceiptEmail: vi.fn(async () => undefined),
  };
});

vi.mock("../lib/push.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/push.js")>();
  return {
    ...actual,
    sendPushToUsers: vi.fn(async (userIds: number[]) => ({
      attempted: userIds.length,
      sent: userIds.length,
      failed: 0,
      invalid: 0,
    })),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  sideGameInstancesTable,
  sideGameSettlementsTable,
  sideGameSettlementReceiptAttemptsTable,
  tournamentsTable,
  playersTable,
  type SideGameSettlementReceiptAttempt,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  notifySettlementPaid,
  retrySideGameReceiptEmail,
  retrySideGameReceiptPush,
  SIDE_GAME_RECEIPT_MAX_EMAIL_ATTEMPTS,
  SIDE_GAME_RECEIPT_MAX_PUSH_ATTEMPTS,
  computeNextRetryAt,
} from "../lib/sideGameSettlementPaidNotify.js";
import { sendSideGameSettlementReceiptEmail } from "../lib/mailer.js";
import { sendPushToUsers } from "../lib/push.js";

const emailMock = vi.mocked(sendSideGameSettlementReceiptEmail);
const pushMock = vi.mocked(sendPushToUsers);

let testOrgId: number;
let testInstanceId: number;
const userIds: number[] = [];
const settlementIds: number[] = [];
const attemptIds: number[] = [];
const tournamentIds: number[] = [];
const playerIds: number[] = [];
let seq = 0;

async function makeUser(): Promise<number> {
  seq += 1;
  const tag = `${Date.now()}_${seq}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `sg-retry-${tag}`,
    username: `sg_retry_${tag}`,
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
  return u.id;
}

async function makeSettlement(): Promise<number> {
  const [s] = await db.insert(sideGameSettlementsTable).values({
    instanceId: testInstanceId,
    fromName: "Payer P",
    toName: "Recipient R",
    amount: "150.00",
    currency: "INR",
    status: "paid",
    paidAt: new Date(),
  }).returning({ id: sideGameSettlementsTable.id });
  settlementIds.push(s.id);
  return s.id;
}

async function makeAttempt(opts: {
  recipientUserId: number;
  settlementId: number;
  recipientEmail?: string | null;
  emailStatus?: string | null;
  emailAttempts?: number;
  nextEmailRetryAt?: Date | null;
  pushStatus?: string | null;
  pushAttempts?: number;
  nextPushRetryAt?: Date | null;
}): Promise<SideGameSettlementReceiptAttempt> {
  const [a] = await db.insert(sideGameSettlementReceiptAttemptsTable).values({
    organizationId: testOrgId,
    settlementId: opts.settlementId,
    recipientUserId: opts.recipientUserId,
    payerName: "Payer P",
    recipientName: "Recipient R",
    recipientEmail: opts.recipientEmail ?? "rec@example.test",
    gameLabel: "Skins",
    currency: "INR",
    amount: "150.00",
    paymentMethod: "wallet",
    paymentRef: "ref-1",
    paidAt: new Date(),
    emailStatus: opts.emailStatus ?? null,
    emailAttempts: opts.emailAttempts ?? 0,
    nextEmailRetryAt: opts.nextEmailRetryAt ?? null,
    pushStatus: opts.pushStatus ?? null,
    pushAttempts: opts.pushAttempts ?? 0,
    nextPushRetryAt: opts.nextPushRetryAt ?? null,
  }).returning();
  attemptIds.push(a.id);
  return a;
}

async function loadAttempt(id: number): Promise<SideGameSettlementReceiptAttempt> {
  const [row] = await db.select().from(sideGameSettlementReceiptAttemptsTable)
    .where(eq(sideGameSettlementReceiptAttemptsTable.id, id));
  return row;
}

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_SGReceiptRetry_${stamp}`,
    slug: `test-sg-receipt-retry-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [inst] = await db.insert(sideGameInstancesTable).values({
    organizationId: testOrgId,
    gameType: "skins",
    name: "Test Skins",
    status: "completed",
  }).returning({ id: sideGameInstancesTable.id });
  testInstanceId = inst.id;
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
  for (const id of playerIds) {
    await db.delete(playersTable).where(eq(playersTable.id, id));
  }
  for (const id of tournamentIds) {
    await db.delete(tournamentsTable).where(eq(tournamentsTable.id, id));
  }
  for (const id of userIds) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(() => {
  emailMock.mockReset();
  pushMock.mockReset();
  emailMock.mockResolvedValue(undefined);
  pushMock.mockImplementation(async (uids: number[]) => ({
    attempted: uids.length,
    sent: uids.length,
    failed: 0,
    invalid: 0,
  }));
});

// ─── computeNextRetryAt ───────────────────────────────────────────────────
describe("computeNextRetryAt — exponential backoff", () => {
  it("schedules 5/10/20/40/80 minutes for attempts 1..5", () => {
    const base = new Date("2026-01-01T00:00:00Z");
    expect(computeNextRetryAt(1, base).getTime() - base.getTime()).toBe(5 * 60 * 1000);
    expect(computeNextRetryAt(2, base).getTime() - base.getTime()).toBe(10 * 60 * 1000);
    expect(computeNextRetryAt(3, base).getTime() - base.getTime()).toBe(20 * 60 * 1000);
    expect(computeNextRetryAt(4, base).getTime() - base.getTime()).toBe(40 * 60 * 1000);
    expect(computeNextRetryAt(5, base).getTime() - base.getTime()).toBe(80 * 60 * 1000);
  });
});

// ─── retrySideGameReceiptEmail ────────────────────────────────────────────
describe("retrySideGameReceiptEmail — happy path", () => {
  it("retries a previously-failed email, flips status to sent, increments attempts, clears nextEmailRetryAt", async () => {
    const uid = await makeUser();
    const sId = await makeSettlement();
    const attempt = await makeAttempt({
      recipientUserId: uid,
      settlementId: sId,
      emailStatus: "failed",
      emailAttempts: 1,
      nextEmailRetryAt: new Date(Date.now() - 60_000),
    });

    const before = Date.now();
    const res = await retrySideGameReceiptEmail({ attempt });
    const after = Date.now();

    expect(res).not.toBeNull();
    expect(res!.channel).toBe("email");
    expect(res!.status).toBe("sent");
    expect(res!.attempts).toBe(2);
    expect(res!.exhausted).toBe(false);
    expect(emailMock).toHaveBeenCalledTimes(1);

    const row = await loadAttempt(attempt.id);
    expect(row.emailStatus).toBe("sent");
    expect(row.emailAttempts).toBe(2);
    expect(row.lastEmailError).toBeNull();
    expect(row.emailRetryExhaustedAt).toBeNull();
    expect(row.nextEmailRetryAt).toBeNull();
    expect(row.lastEmailRetryAt).toBeInstanceOf(Date);
    const ts = row.lastEmailRetryAt!.getTime();
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(after + 1000);
  });
});

describe("retrySideGameReceiptEmail — bounded cap", () => {
  it("when attempts reach the cap and email still fails, stamps emailRetryExhaustedAt", async () => {
    const uid = await makeUser();
    const sId = await makeSettlement();
    const attempt = await makeAttempt({
      recipientUserId: uid,
      settlementId: sId,
      emailStatus: "failed",
      emailAttempts: SIDE_GAME_RECEIPT_MAX_EMAIL_ATTEMPTS - 1,
      nextEmailRetryAt: new Date(Date.now() - 60_000),
    });
    emailMock.mockRejectedValueOnce(new Error("smtp down"));

    const res = await retrySideGameReceiptEmail({ attempt });
    expect(res).not.toBeNull();
    expect(res!.status).toBe("failed");
    expect(res!.attempts).toBe(SIDE_GAME_RECEIPT_MAX_EMAIL_ATTEMPTS);
    expect(res!.exhausted).toBe(true);

    const row = await loadAttempt(attempt.id);
    expect(row.emailStatus).toBe("failed");
    expect(row.emailAttempts).toBe(SIDE_GAME_RECEIPT_MAX_EMAIL_ATTEMPTS);
    expect(row.emailRetryExhaustedAt).toBeInstanceOf(Date);
    expect(row.nextEmailRetryAt).toBeNull();
    expect(row.lastEmailError).toBe("smtp down");

    // And the very next pass for the same row short-circuits to null.
    emailMock.mockClear();
    const next = await retrySideGameReceiptEmail({ attempt: row });
    expect(next).toBeNull();
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("subsequent retries return null once the cap has already been reached", async () => {
    const uid = await makeUser();
    const sId = await makeSettlement();
    const attempt = await makeAttempt({
      recipientUserId: uid,
      settlementId: sId,
      emailStatus: "failed",
      emailAttempts: SIDE_GAME_RECEIPT_MAX_EMAIL_ATTEMPTS,
    });
    const res = await retrySideGameReceiptEmail({ attempt });
    expect(res).toBeNull();
    expect(emailMock).not.toHaveBeenCalled();
  });
});

describe("retrySideGameReceiptEmail — backoff window", () => {
  it("returns null without firing email when nextEmailRetryAt is still in the future", async () => {
    const uid = await makeUser();
    const sId = await makeSettlement();
    const attempt = await makeAttempt({
      recipientUserId: uid,
      settlementId: sId,
      emailStatus: "failed",
      emailAttempts: 1,
      nextEmailRetryAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    const res = await retrySideGameReceiptEmail({ attempt });
    expect(res).toBeNull();
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("schedules an exponentially-larger backoff after each failed retry", async () => {
    const uid = await makeUser();
    const sId = await makeSettlement();
    const fakeNow = new Date("2026-04-01T12:00:00Z");
    const attempt = await makeAttempt({
      recipientUserId: uid,
      settlementId: sId,
      emailStatus: "failed",
      emailAttempts: 1,
      nextEmailRetryAt: new Date(fakeNow.getTime() - 60_000),
    });
    emailMock.mockRejectedValueOnce(new Error("smtp blip"));

    const res = await retrySideGameReceiptEmail({ attempt, now: fakeNow });
    expect(res!.status).toBe("failed");
    expect(res!.exhausted).toBe(false);

    const row = await loadAttempt(attempt.id);
    // attempts is now 2 -> backoff 10 minutes from fakeNow.
    expect(row.nextEmailRetryAt).toBeInstanceOf(Date);
    expect(row.nextEmailRetryAt!.getTime()).toBe(fakeNow.getTime() + 10 * 60 * 1000);
  });
});

describe("retrySideGameReceiptEmail — provider not configured", () => {
  it("flips status to terminal 'skipped', does NOT increment emailAttempts, and clears nextEmailRetryAt", async () => {
    const uid = await makeUser();
    const sId = await makeSettlement();
    const attempt = await makeAttempt({
      recipientUserId: uid,
      settlementId: sId,
      emailStatus: "failed",
      emailAttempts: 2,
      nextEmailRetryAt: new Date(Date.now() - 60_000),
    });
    emailMock.mockRejectedValueOnce(new Error("SMTP host not configured"));

    const res = await retrySideGameReceiptEmail({ attempt });
    expect(res).not.toBeNull();
    expect(res!.status).toBe("skipped");
    expect(res!.error).toBe("provider_not_configured");
    expect(res!.attempts).toBe(2);
    expect(res!.exhausted).toBe(false);

    const row = await loadAttempt(attempt.id);
    expect(row.emailStatus).toBe("skipped");
    expect(row.emailAttempts).toBe(2);
    expect(row.lastEmailError).toBe("provider_not_configured");
    expect(row.nextEmailRetryAt).toBeNull();
    expect(row.emailRetryExhaustedAt).toBeNull();

    // Reload — row no longer eligible (status is `skipped`).
    emailMock.mockClear();
    const next = await retrySideGameReceiptEmail({ attempt: row });
    expect(next).toBeNull();
    expect(emailMock).not.toHaveBeenCalled();
  });
});

describe("retrySideGameReceiptEmail — Task #1279 hard bounce shortcut", () => {
  it("hard SMTP 550 on a retry jumps straight to exhausted, even with budget remaining", async () => {
    const uid = await makeUser();
    const sId = await makeSettlement();
    // Row has only consumed 1 of 5 attempts — without the shortcut, a
    // failure here would just bump attempts to 2 and schedule another retry.
    const attempt = await makeAttempt({
      recipientUserId: uid,
      settlementId: sId,
      emailStatus: "failed",
      emailAttempts: 1,
      nextEmailRetryAt: new Date(Date.now() - 60_000),
    });
    emailMock.mockRejectedValueOnce(
      new Error("550 5.1.1 The email account that you tried to reach does not exist"),
    );

    const res = await retrySideGameReceiptEmail({ attempt });
    expect(res).not.toBeNull();
    expect(res!.status).toBe("failed");
    // Short-circuit: jumps straight to MAX even though only 2 attempts
    // would otherwise have been consumed.
    expect(res!.attempts).toBe(SIDE_GAME_RECEIPT_MAX_EMAIL_ATTEMPTS);
    expect(res!.exhausted).toBe(true);

    const row = await loadAttempt(attempt.id);
    expect(row.emailStatus).toBe("failed");
    expect(row.emailAttempts).toBe(SIDE_GAME_RECEIPT_MAX_EMAIL_ATTEMPTS);
    expect(row.emailRetryExhaustedAt).toBeInstanceOf(Date);
    expect(row.nextEmailRetryAt).toBeNull();

    // Subsequent cron pass for this row short-circuits to null — no more
    // provider calls.
    emailMock.mockClear();
    const next = await retrySideGameReceiptEmail({ attempt: row });
    expect(next).toBeNull();
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("transient SMTP error (timeout) does NOT trip the shortcut — uses normal retry path", async () => {
    const uid = await makeUser();
    const sId = await makeSettlement();
    const attempt = await makeAttempt({
      recipientUserId: uid,
      settlementId: sId,
      emailStatus: "failed",
      emailAttempts: 1,
      nextEmailRetryAt: new Date(Date.now() - 60_000),
    });
    emailMock.mockRejectedValueOnce(new Error("Connection refused (ECONNREFUSED)"));

    const res = await retrySideGameReceiptEmail({ attempt });
    expect(res!.status).toBe("failed");
    expect(res!.attempts).toBe(2); // NOT short-circuited
    expect(res!.exhausted).toBe(false);

    const row = await loadAttempt(attempt.id);
    expect(row.emailAttempts).toBe(2);
    expect(row.emailRetryExhaustedAt).toBeNull();
    expect(row.nextEmailRetryAt).toBeInstanceOf(Date);
  });
});

describe("notifySettlementPaid — Task #1279 hard bounce on initial send", () => {
  it("hard SMTP 550 on the first email attempt persists the receipt-attempts row as exhausted (emailAttempts === MAX, no retry scheduled)", async () => {
    // Wire a real recipient: app_user → players row → settlement.toPlayerId.
    // `resolveSideUserId` joins through `playersTable.userId`, so we need
    // a tournament + player in addition to the app user.
    const recipientUid = await makeUser();
    await db.update(appUsersTable)
      .set({ email: "hb-recipient@example.test" })
      .where(eq(appUsersTable.id, recipientUid));

    const [tournament] = await db.insert(tournamentsTable).values({
      organizationId: testOrgId,
      name: `HB Tournament ${Date.now()}`,
    }).returning({ id: tournamentsTable.id });
    tournamentIds.push(tournament.id);

    const [player] = await db.insert(playersTable).values({
      tournamentId: tournament.id,
      userId: recipientUid,
      firstName: "HB",
      lastName: "Recipient",
      email: "hb-recipient@example.test",
    }).returning({ id: playersTable.id });
    playerIds.push(player.id);

    const [settlement] = await db.insert(sideGameSettlementsTable).values({
      instanceId: testInstanceId,
      fromName: "Payer P",
      toName: "HB Recipient",
      toPlayerId: player.id,
      amount: "200.00",
      currency: "INR",
      status: "paid",
      paidAt: new Date(),
    }).returning({ id: sideGameSettlementsTable.id });
    settlementIds.push(settlement.id);

    // Provider rejects with a hard SMTP bounce on the very first send.
    emailMock.mockRejectedValueOnce(
      new Error("550 5.1.1 The email account that you tried to reach does not exist"),
    );

    await notifySettlementPaid(settlement.id);

    // The notify path should have inserted exactly one attempts row for
    // this settlement, stamped as exhausted on the very first attempt.
    const [row] = await db.select().from(sideGameSettlementReceiptAttemptsTable)
      .where(eq(sideGameSettlementReceiptAttemptsTable.settlementId, settlement.id));
    expect(row).toBeDefined();
    attemptIds.push(row.id);

    expect(row.emailStatus).toBe("failed");
    // Cap reached on the very first attempt — cron can never re-pick this row.
    expect(row.emailAttempts).toBe(SIDE_GAME_RECEIPT_MAX_EMAIL_ATTEMPTS);
    expect(row.emailRetryExhaustedAt).toBeInstanceOf(Date);
    expect(row.nextEmailRetryAt).toBeNull();
    // Only the initial-send call fired — no extra retries consumed.
    expect(emailMock).toHaveBeenCalledTimes(1);
  });
});

describe("retrySideGameReceiptEmail — ineligibility", () => {
  it("returns null without firing email when emailStatus is no longer 'failed'", async () => {
    const uid = await makeUser();
    const sId = await makeSettlement();
    const attempt = await makeAttempt({
      recipientUserId: uid,
      settlementId: sId,
      emailStatus: "sent",
      emailAttempts: 1,
    });

    const res = await retrySideGameReceiptEmail({ attempt });
    expect(res).toBeNull();
    expect(emailMock).not.toHaveBeenCalled();
  });
});

// ─── retrySideGameReceiptPush ─────────────────────────────────────────────
describe("retrySideGameReceiptPush — happy path", () => {
  it("retries a previously-failed push, flips status to sent, increments attempts, clears nextPushRetryAt", async () => {
    const uid = await makeUser();
    const sId = await makeSettlement();
    const attempt = await makeAttempt({
      recipientUserId: uid,
      settlementId: sId,
      pushStatus: "failed",
      pushAttempts: 1,
      nextPushRetryAt: new Date(Date.now() - 60_000),
    });

    const res = await retrySideGameReceiptPush({ attempt });
    expect(res).not.toBeNull();
    expect(res!.channel).toBe("push");
    expect(res!.status).toBe("sent");
    expect(res!.attempts).toBe(2);
    expect(res!.exhausted).toBe(false);
    expect(pushMock).toHaveBeenCalledTimes(1);

    const row = await loadAttempt(attempt.id);
    expect(row.pushStatus).toBe("sent");
    expect(row.pushAttempts).toBe(2);
    expect(row.nextPushRetryAt).toBeNull();
    expect(row.pushRetryExhaustedAt).toBeNull();
    expect(row.lastPushRetryAt).toBeInstanceOf(Date);
  });
});

describe("retrySideGameReceiptPush — bounded cap", () => {
  it("when attempts reach the cap and push still fails, stamps pushRetryExhaustedAt", async () => {
    const uid = await makeUser();
    const sId = await makeSettlement();
    const attempt = await makeAttempt({
      recipientUserId: uid,
      settlementId: sId,
      pushStatus: "failed",
      pushAttempts: SIDE_GAME_RECEIPT_MAX_PUSH_ATTEMPTS - 1,
      nextPushRetryAt: new Date(Date.now() - 60_000),
    });
    pushMock.mockRejectedValueOnce(new Error("expo down"));

    const res = await retrySideGameReceiptPush({ attempt });
    expect(res!.status).toBe("failed");
    expect(res!.attempts).toBe(SIDE_GAME_RECEIPT_MAX_PUSH_ATTEMPTS);
    expect(res!.exhausted).toBe(true);

    const row = await loadAttempt(attempt.id);
    expect(row.pushStatus).toBe("failed");
    expect(row.pushAttempts).toBe(SIDE_GAME_RECEIPT_MAX_PUSH_ATTEMPTS);
    expect(row.pushRetryExhaustedAt).toBeInstanceOf(Date);
    expect(row.nextPushRetryAt).toBeNull();
    expect(row.lastPushError).toBe("expo down");

    pushMock.mockClear();
    const next = await retrySideGameReceiptPush({ attempt: row });
    expect(next).toBeNull();
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe("retrySideGameReceiptPush — backoff window", () => {
  it("returns null without firing push when nextPushRetryAt is still in the future", async () => {
    const uid = await makeUser();
    const sId = await makeSettlement();
    const attempt = await makeAttempt({
      recipientUserId: uid,
      settlementId: sId,
      pushStatus: "failed",
      pushAttempts: 1,
      nextPushRetryAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    const res = await retrySideGameReceiptPush({ attempt });
    expect(res).toBeNull();
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe("retrySideGameReceiptPush — provider not configured", () => {
  it("flips status to terminal 'skipped', does NOT increment pushAttempts, and clears nextPushRetryAt", async () => {
    const uid = await makeUser();
    const sId = await makeSettlement();
    const attempt = await makeAttempt({
      recipientUserId: uid,
      settlementId: sId,
      pushStatus: "failed",
      pushAttempts: 2,
      nextPushRetryAt: new Date(Date.now() - 60_000),
    });
    pushMock.mockRejectedValueOnce(new Error("EXPO_ACCESS_TOKEN not configured"));

    const res = await retrySideGameReceiptPush({ attempt });
    expect(res).not.toBeNull();
    expect(res!.status).toBe("skipped");
    expect(res!.error).toBe("provider_not_configured");
    expect(res!.attempts).toBe(2);
    expect(res!.exhausted).toBe(false);

    const row = await loadAttempt(attempt.id);
    expect(row.pushStatus).toBe("skipped");
    expect(row.pushAttempts).toBe(2);
    expect(row.lastPushError).toBe("provider_not_configured");
    expect(row.nextPushRetryAt).toBeNull();
    expect(row.pushRetryExhaustedAt).toBeNull();
  });
});

describe("retrySideGameReceiptPush — ineligibility", () => {
  it("returns null without firing push when pushStatus is no longer 'failed'", async () => {
    const uid = await makeUser();
    const sId = await makeSettlement();
    const attempt = await makeAttempt({
      recipientUserId: uid,
      settlementId: sId,
      pushStatus: "sent",
      pushAttempts: 1,
    });

    const res = await retrySideGameReceiptPush({ attempt });
    expect(res).toBeNull();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
