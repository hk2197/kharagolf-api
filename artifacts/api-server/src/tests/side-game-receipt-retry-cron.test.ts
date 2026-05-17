/**
 * Integration tests: Task #1118 — end-to-end behavior of the side-game
 * settlement receipt retry cron entrypoint
 * `retryFailedSideGameReceiptEmailPush` (runs every 5 minutes).
 *
 * The bottom-half retry helpers `retrySideGameReceiptEmail` and
 * `retrySideGameReceiptPush` are already covered per-row by
 * `side-game-receipt-retry.test.ts`. This file pins down the cron
 * entrypoint itself, which is otherwise un-tested:
 *
 *   1. Candidate-selection query — only rows that are actually due for a
 *      retry are processed. Sent / skipped / not-yet-due / exhausted rows
 *      are left untouched.
 *   2. Per-row error isolation — if the retry helper throws for one row,
 *      the cron still processes the remaining rows in the batch.
 *   3. Batch limit — the cron processes at most 50 rows per pass; any
 *      excess due rows remain `failed` and are picked up by a later pass.
 *
 * ─── Test isolation (Task #1808 / #2266) ──────────────────────────────
 * `retryFailedSideGameReceiptEmailPush` sweeps
 * `side_game_settlement_receipt_attempts` GLOBALLY. The api-server
 * vitest suite shares a dev DB across files, so unscoped
 * `emailMock.toHaveBeenCalledTimes(N)` /
 * `pushMock.toHaveBeenCalledTimes(N)` totals would flake whenever a
 * sibling test leaks a `failed` attempt into the queue. We therefore
 * filter mock calls by the test-owned recipient email / `testUserId`.
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

// Wrap the real retry helpers so individual rows can be made to throw
// (simulating an unexpected DB / provider crash) while the rest of the
// batch continues to use the actual implementation.
vi.mock("../lib/sideGameSettlementPaidNotify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/sideGameSettlementPaidNotify.js")>();
  return {
    ...actual,
    retrySideGameReceiptEmail: vi.fn(actual.retrySideGameReceiptEmail),
    retrySideGameReceiptPush: vi.fn(actual.retrySideGameReceiptPush),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  sideGameInstancesTable,
  sideGameSettlementsTable,
  sideGameSettlementReceiptAttemptsTable,
  type SideGameSettlementReceiptAttempt,
} from "@workspace/db";
import { and, eq, ne, inArray } from "drizzle-orm";
import { retryFailedSideGameReceiptEmailPush } from "../lib/cron.js";
import {
  retrySideGameReceiptEmail,
  retrySideGameReceiptPush,
  SIDE_GAME_RECEIPT_MAX_EMAIL_ATTEMPTS,
  SIDE_GAME_RECEIPT_MAX_PUSH_ATTEMPTS,
} from "../lib/sideGameSettlementPaidNotify.js";
import { sendSideGameSettlementReceiptEmail } from "../lib/mailer.js";
import { sendPushToUsers } from "../lib/push.js";

const emailMock = vi.mocked(sendSideGameSettlementReceiptEmail);
const pushMock = vi.mocked(sendPushToUsers);
const retryEmailMock = vi.mocked(retrySideGameReceiptEmail);
const retryPushMock = vi.mocked(retrySideGameReceiptPush);

let testOrgId: number;
let testInstanceId: number;
let testUserId: number;
let testSettlementId: number;

async function makeAttempt(opts: Partial<SideGameSettlementReceiptAttempt> & {
  emailStatus?: string | null;
  pushStatus?: string | null;
}): Promise<SideGameSettlementReceiptAttempt> {
  const [a] = await db.insert(sideGameSettlementReceiptAttemptsTable).values({
    organizationId: testOrgId,
    settlementId: testSettlementId,
    recipientUserId: testUserId,
    payerName: "Payer P",
    recipientName: "Recipient R",
    recipientEmail: opts.recipientEmail ?? `rec-${testOrgId}@example.test`,
    gameLabel: "Skins",
    currency: "INR",
    amount: "150.00",
    paymentMethod: "wallet",
    paymentRef: "ref-1",
    paidAt: new Date(),
    emailStatus: opts.emailStatus ?? null,
    emailAttempts: opts.emailAttempts ?? 0,
    nextEmailRetryAt: opts.nextEmailRetryAt ?? null,
    emailRetryExhaustedAt: opts.emailRetryExhaustedAt ?? null,
    pushStatus: opts.pushStatus ?? null,
    pushAttempts: opts.pushAttempts ?? 0,
    nextPushRetryAt: opts.nextPushRetryAt ?? null,
    pushRetryExhaustedAt: opts.pushRetryExhaustedAt ?? null,
  }).returning();
  return a;
}

async function loadAttempt(id: number): Promise<SideGameSettlementReceiptAttempt> {
  const [row] = await db.select().from(sideGameSettlementReceiptAttemptsTable)
    .where(eq(sideGameSettlementReceiptAttemptsTable.id, id));
  return row;
}

async function deleteAllOurAttempts() {
  await db.delete(sideGameSettlementReceiptAttemptsTable)
    .where(eq(sideGameSettlementReceiptAttemptsTable.organizationId, testOrgId));
}

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_SGReceiptRetryCron_${stamp}`,
    slug: `test-sg-receipt-retry-cron-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [inst] = await db.insert(sideGameInstancesTable).values({
    organizationId: testOrgId,
    gameType: "skins",
    name: "Test Skins",
    status: "completed",
  }).returning({ id: sideGameInstancesTable.id });
  testInstanceId = inst.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `sg-cron-${stamp}`,
    username: `sg_cron_${stamp}`,
  }).returning({ id: appUsersTable.id });
  testUserId = u.id;

  const [s] = await db.insert(sideGameSettlementsTable).values({
    instanceId: testInstanceId,
    fromName: "Payer P",
    toName: "Recipient R",
    amount: "150.00",
    currency: "INR",
    status: "paid",
    paidAt: new Date(),
  }).returning({ id: sideGameSettlementsTable.id });
  testSettlementId = s.id;
});

afterAll(async () => {
  await deleteAllOurAttempts();
  await db.delete(sideGameSettlementsTable).where(eq(sideGameSettlementsTable.id, testSettlementId));
  await db.delete(sideGameInstancesTable).where(eq(sideGameInstancesTable.id, testInstanceId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(async () => {
  emailMock.mockReset();
  pushMock.mockReset();
  emailMock.mockResolvedValue(undefined);
  pushMock.mockImplementation(async (uids: number[]) => ({
    attempted: uids.length,
    sent: uids.length,
    failed: 0,
    invalid: 0,
  }));
  // Default to the real (wrapped) implementations; individual tests can
  // override per-row via mockImplementation. After mockReset() we must
  // re-bind to the unwrapped originals so subsequent cron invocations
  // execute the actual helper.
  retryEmailMock.mockReset();
  retryPushMock.mockReset();
  const real = await vi.importActual<typeof import("../lib/sideGameSettlementPaidNotify.js")>(
    "../lib/sideGameSettlementPaidNotify.js",
  );
  retryEmailMock.mockImplementation(real.retrySideGameReceiptEmail);
  retryPushMock.mockImplementation(real.retrySideGameReceiptPush);
  await deleteAllOurAttempts();
});

describe("retryFailedSideGameReceiptEmailPush — candidate selection", () => {
  it("only processes rows that are due for an email or push retry", async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 30 * 60_000);

    // Email: should be processed.
    const emailDuePast = await makeAttempt({
      emailStatus: "failed", emailAttempts: 1, nextEmailRetryAt: past,
    });
    const emailDueNullNext = await makeAttempt({
      emailStatus: "failed", emailAttempts: 1, nextEmailRetryAt: null,
    });
    // Email: should be skipped.
    const emailNotYetDue = await makeAttempt({
      emailStatus: "failed", emailAttempts: 1, nextEmailRetryAt: future,
    });
    const emailExhausted = await makeAttempt({
      emailStatus: "failed", emailAttempts: SIDE_GAME_RECEIPT_MAX_EMAIL_ATTEMPTS,
    });
    const emailSkipped = await makeAttempt({
      emailStatus: "skipped", emailAttempts: 2,
    });
    const emailSent = await makeAttempt({
      emailStatus: "sent", emailAttempts: 1,
    });

    // Push: should be processed.
    const pushDuePast = await makeAttempt({
      pushStatus: "failed", pushAttempts: 1, nextPushRetryAt: past,
    });
    // Push: should be skipped.
    const pushNotYetDue = await makeAttempt({
      pushStatus: "failed", pushAttempts: 1, nextPushRetryAt: future,
    });
    const pushExhausted = await makeAttempt({
      pushStatus: "failed", pushAttempts: SIDE_GAME_RECEIPT_MAX_PUSH_ATTEMPTS,
    });
    const pushSent = await makeAttempt({
      pushStatus: "sent", pushAttempts: 1,
    });

    await retryFailedSideGameReceiptEmailPush();

    // Mailer fires once per due email, push fires once per due push —
    // filter to OUR recipient so a sibling test leaking a global `failed`
    // attempt can't bump the count.
    const ourEmailCalls = emailMock.mock.calls.filter(
      (c) => (c[0] as { recipientEmail?: string }).recipientEmail === `rec-${testOrgId}@example.test`,
    );
    const ourPushCalls = pushMock.mock.calls.filter(
      (c) => (c[0] as number[]).includes(testUserId),
    );
    expect(ourEmailCalls).toHaveLength(2);
    expect(ourPushCalls).toHaveLength(1);

    // Tighter guardrail on the candidate-selection query: the cron must
    // only have invoked the retry helpers for the due attempt IDs.
    const dueEmailIds = [emailDuePast.id, emailDueNullNext.id].sort();
    const calledEmailIds = retryEmailMock.mock.calls.map((c) => c[0].attempt.id).sort();
    expect(calledEmailIds).toEqual(dueEmailIds);

    const calledPushIds = retryPushMock.mock.calls.map((c) => c[0].attempt.id).sort();
    expect(calledPushIds).toEqual([pushDuePast.id]);

    // Due rows flipped to sent.
    expect((await loadAttempt(emailDuePast.id)).emailStatus).toBe("sent");
    expect((await loadAttempt(emailDueNullNext.id)).emailStatus).toBe("sent");
    expect((await loadAttempt(pushDuePast.id)).pushStatus).toBe("sent");

    // Non-due rows untouched (status + attempts unchanged).
    const notDueRow = await loadAttempt(emailNotYetDue.id);
    expect(notDueRow.emailStatus).toBe("failed");
    expect(notDueRow.emailAttempts).toBe(1);

    const exhaustedRow = await loadAttempt(emailExhausted.id);
    expect(exhaustedRow.emailStatus).toBe("failed");
    expect(exhaustedRow.emailAttempts).toBe(SIDE_GAME_RECEIPT_MAX_EMAIL_ATTEMPTS);

    expect((await loadAttempt(emailSkipped.id)).emailStatus).toBe("skipped");
    expect((await loadAttempt(emailSent.id)).emailStatus).toBe("sent");
    expect((await loadAttempt(pushNotYetDue.id)).pushStatus).toBe("failed");
    expect((await loadAttempt(pushExhausted.id)).pushStatus).toBe("failed");
    expect((await loadAttempt(pushSent.id)).pushStatus).toBe("sent");
  });
});

describe("retryFailedSideGameReceiptEmailPush — per-row error isolation", () => {
  it("a thrown error on one row does not abort the rest of the batch", async () => {
    const past = new Date(Date.now() - 60_000);
    const a = await makeAttempt({ emailStatus: "failed", emailAttempts: 1, nextEmailRetryAt: past });
    const b = await makeAttempt({ emailStatus: "failed", emailAttempts: 1, nextEmailRetryAt: past });
    const c = await makeAttempt({ emailStatus: "failed", emailAttempts: 1, nextEmailRetryAt: past });

    const real = await vi.importActual<typeof import("../lib/sideGameSettlementPaidNotify.js")>(
      "../lib/sideGameSettlementPaidNotify.js",
    );
    // Make the helper throw when called for row `b`, but run the real
    // implementation for everyone else.
    retryEmailMock.mockImplementation(async (opts) => {
      if (opts.attempt.id === b.id) {
        throw new Error("simulated unexpected helper crash");
      }
      return real.retrySideGameReceiptEmail(opts);
    });

    await expect(retryFailedSideGameReceiptEmailPush()).resolves.toBeUndefined();

    // Helper was called for all three rows (cron did not bail after b).
    const calledIds = retryEmailMock.mock.calls.map((c) => c[0].attempt.id).sort();
    expect(calledIds).toEqual([a.id, b.id, c.id].sort());

    // Rows a and c were delivered; row b is unchanged (the throw bypassed
    // the helper's own DB update path).
    const rowA = await loadAttempt(a.id);
    const rowB = await loadAttempt(b.id);
    const rowC = await loadAttempt(c.id);
    expect(rowA.emailStatus).toBe("sent");
    expect(rowC.emailStatus).toBe("sent");
    expect(rowB.emailStatus).toBe("failed");
    expect(rowB.emailAttempts).toBe(1);
  });
});

describe("retryFailedSideGameReceiptEmailPush — batch limit", () => {
  it("processes at most 50 rows per pass; the rest stay queued for the next run", async () => {
    const past = new Date(Date.now() - 60_000);
    const SEED = 55;
    const created: number[] = [];
    for (let i = 0; i < SEED; i++) {
      const row = await makeAttempt({
        emailStatus: "failed",
        emailAttempts: 1,
        nextEmailRetryAt: past,
      });
      created.push(row.id);
    }

    await retryFailedSideGameReceiptEmailPush();

    // Mailer fired exactly 50 times for OUR seeded recipient — the cron's
    // hard batch cap. Filter by the test-owned recipient email so a sibling
    // test leaking a `failed` attempt into the global queue can't bump the
    // count.
    const ourEmailCalls = emailMock.mock.calls.filter(
      (c) => (c[0] as { recipientEmail?: string }).recipientEmail === `rec-${testOrgId}@example.test`,
    );
    expect(ourEmailCalls).toHaveLength(50);

    // Of our 55 seeded rows, 50 are now `sent` and 5 remain `failed`.
    const ourRows = await db
      .select({
        id: sideGameSettlementReceiptAttemptsTable.id,
        emailStatus: sideGameSettlementReceiptAttemptsTable.emailStatus,
      })
      .from(sideGameSettlementReceiptAttemptsTable)
      .where(and(
        eq(sideGameSettlementReceiptAttemptsTable.organizationId, testOrgId),
        inArray(sideGameSettlementReceiptAttemptsTable.id, created),
      ));
    const sent = ourRows.filter((r) => r.emailStatus === "sent").length;
    const stillFailed = ourRows.filter((r) => r.emailStatus === "failed").length;
    expect(sent).toBe(50);
    expect(stillFailed).toBe(5);

    // A second pass drains the remaining 5 rows.
    emailMock.mockClear();
    await retryFailedSideGameReceiptEmailPush();
    const ourSecondPassCalls = emailMock.mock.calls.filter(
      (c) => (c[0] as { recipientEmail?: string }).recipientEmail === `rec-${testOrgId}@example.test`,
    );
    expect(ourSecondPassCalls).toHaveLength(5);
    const drained = await db
      .select({ emailStatus: sideGameSettlementReceiptAttemptsTable.emailStatus })
      .from(sideGameSettlementReceiptAttemptsTable)
      .where(and(
        eq(sideGameSettlementReceiptAttemptsTable.organizationId, testOrgId),
        ne(sideGameSettlementReceiptAttemptsTable.emailStatus, "sent"),
      ));
    expect(drained).toHaveLength(0);
  });
});
