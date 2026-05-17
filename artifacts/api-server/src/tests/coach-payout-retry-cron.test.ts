/**
 * Integration tests: Task #1283 — end-to-end behavior of the coach
 * payout-paid retry cron entrypoint `retryFailedCoachPayoutPushSms`
 * (runs every 15 minutes).
 *
 * The bottom-half retry helpers `retryCoachPayoutPush` and
 * `retryCoachPayoutSms` are already covered per-row by
 * `coach-payout-retry.test.ts`. This file pins down the cron
 * entrypoint itself, which is otherwise un-tested:
 *
 *   1. Candidate-selection query — only rows that are actually due for
 *      a retry are processed (failed AND attempts < cap on either
 *      channel). Sent / skipped / exhausted rows are left untouched.
 *   2. Per-row error isolation — if the retry helper throws for one
 *      row, the cron still processes the remaining rows in the batch.
 *   3. Batch limit — the cron processes at most 50 rows per pass; any
 *      excess due rows remain `failed` and are picked up by a later
 *      pass.
 *
 * ─── Test isolation (Task #1808 / #2266) ──────────────────────────────
 * `retryFailedCoachPayoutPushSms` sweeps `coach_payout_notification_attempts`
 * GLOBALLY. The api-server vitest suite shares a dev DB across files,
 * so unscoped `pushMock.toHaveBeenCalledTimes(N)` /
 * `retryPushMock.toHaveBeenCalledTimes(N)` totals would flake whenever
 * a sibling test leaks a `failed` attempt into the queue. We therefore
 * filter mock calls by the test-owned `testCoachUserId` (push mock) /
 * `attempt.organizationId === testOrgId` (helper mocks).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/comms.js", async () => ({
  sendTransactionalPush: vi.fn(async (userIds: number[]) => ({
    attempted: userIds.length,
    sent: userIds.length,
    failed: 0,
    invalid: 0,
  })),
  sendTransactionalSms: vi.fn(async () => undefined),
}));

// Wrap the real retry helpers so individual rows can be made to throw
// (simulating an unexpected DB / provider crash) while the rest of the
// batch continues to use the actual implementation.
vi.mock("../lib/coachPayoutNotify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/coachPayoutNotify.js")>();
  return {
    ...actual,
    retryCoachPayoutPush: vi.fn(actual.retryCoachPayoutPush),
    retryCoachPayoutSms: vi.fn(actual.retryCoachPayoutSms),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  teachingProsTable,
  coachPayoutsTable,
  coachPayoutNotificationAttemptsTable,
  type CoachPayoutNotificationAttempt,
} from "@workspace/db";
import { and, eq, ne, inArray } from "drizzle-orm";
import { retryFailedCoachPayoutPushSms } from "../lib/cron.js";
import {
  retryCoachPayoutPush,
  retryCoachPayoutSms,
  COACH_PAYOUT_MAX_PUSH_ATTEMPTS,
  COACH_PAYOUT_MAX_SMS_ATTEMPTS,
} from "../lib/coachPayoutNotify.js";
import { sendTransactionalPush, sendTransactionalSms } from "../lib/comms.js";

const pushMock = vi.mocked(sendTransactionalPush);
const smsMock = vi.mocked(sendTransactionalSms);
const retryPushMock = vi.mocked(retryCoachPayoutPush);
const retrySmsMock = vi.mocked(retryCoachPayoutSms);

let testOrgId: number;
let testProId: number;
let testCoachUserId: number;
let payoutSeq = 0;

async function makePayout(): Promise<number> {
  payoutSeq += 1;
  const now = new Date();
  const [p] = await db.insert(coachPayoutsTable).values({
    proId: testProId,
    organizationId: testOrgId,
    periodStart: now,
    periodEnd: now,
    grossPaise: 50000,
    platformFeePaise: 0,
    netPayoutPaise: 50000,
    status: "paid",
    payoutReference: `REF-CRON-${payoutSeq}`,
    paidAt: now,
  }).returning({ id: coachPayoutsTable.id });
  return p.id;
}

async function makeAttempt(opts: {
  pushStatus?: string | null;
  pushAttempts?: number;
  smsStatus?: string | null;
  smsAttempts?: number;
}): Promise<CoachPayoutNotificationAttempt> {
  const payoutId = await makePayout();
  const [a] = await db.insert(coachPayoutNotificationAttemptsTable).values({
    payoutId,
    proId: testProId,
    organizationId: testOrgId,
    coachUserId: testCoachUserId,
    amountPaise: 50000,
    reference: `REF-CRON-${payoutSeq}`,
    notes: null,
    orgName: "Test Coach Payout Retry Cron Org",
    pushStatus: opts.pushStatus ?? null,
    pushAttempts: opts.pushAttempts ?? 0,
    smsStatus: opts.smsStatus ?? null,
    smsAttempts: opts.smsAttempts ?? 0,
  }).returning();
  return a;
}

async function loadAttempt(id: number): Promise<CoachPayoutNotificationAttempt> {
  const [row] = await db.select().from(coachPayoutNotificationAttemptsTable)
    .where(eq(coachPayoutNotificationAttemptsTable.id, id));
  return row;
}

async function deleteAllOurRows() {
  await db.delete(coachPayoutNotificationAttemptsTable)
    .where(eq(coachPayoutNotificationAttemptsTable.organizationId, testOrgId));
  await db.delete(coachPayoutsTable)
    .where(eq(coachPayoutsTable.organizationId, testOrgId));
}

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_CoachPayoutRetryCron_${stamp}`,
    slug: `test-coach-payout-retry-cron-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `coach-cron-${stamp}`,
    username: `coach_cron_${stamp}`,
  }).returning({ id: appUsersTable.id });
  testCoachUserId = u.id;

  const [pro] = await db.insert(teachingProsTable).values({
    organizationId: testOrgId,
    userId: testCoachUserId,
    displayName: "Coach Cron",
    email: null,
    phone: "+911234599001",
  }).returning({ id: teachingProsTable.id });
  testProId = pro.id;
});

afterAll(async () => {
  await deleteAllOurRows();
  await db.delete(teachingProsTable).where(eq(teachingProsTable.id, testProId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, testCoachUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(async () => {
  pushMock.mockReset();
  smsMock.mockReset();
  pushMock.mockImplementation(async (uids: number[]) => ({
    attempted: uids.length,
    sent: uids.length,
    failed: 0,
    invalid: 0,
  }));
  smsMock.mockResolvedValue(undefined);
  // Default the wrapped retry helpers to the real implementations;
  // individual tests can override via mockImplementation. After
  // mockReset() we must re-bind to the unwrapped originals so subsequent
  // cron invocations execute the actual helper.
  retryPushMock.mockReset();
  retrySmsMock.mockReset();
  const real = await vi.importActual<typeof import("../lib/coachPayoutNotify.js")>(
    "../lib/coachPayoutNotify.js",
  );
  retryPushMock.mockImplementation(real.retryCoachPayoutPush);
  retrySmsMock.mockImplementation(real.retryCoachPayoutSms);
  await deleteAllOurRows();
});

describe("retryFailedCoachPayoutPushSms — candidate selection", () => {
  it("only processes rows that are due for a push or SMS retry", async () => {
    // Push: should be processed (failed AND attempts < cap).
    const pushDue1 = await makeAttempt({ pushStatus: "failed", pushAttempts: 1 });
    const pushDue2 = await makeAttempt({
      pushStatus: "failed", pushAttempts: COACH_PAYOUT_MAX_PUSH_ATTEMPTS - 1,
    });
    // Push: should be skipped.
    const pushExhausted = await makeAttempt({
      pushStatus: "failed", pushAttempts: COACH_PAYOUT_MAX_PUSH_ATTEMPTS,
    });
    const pushSent = await makeAttempt({ pushStatus: "sent", pushAttempts: 1 });
    const pushSkipped = await makeAttempt({ pushStatus: "skipped", pushAttempts: 2 });
    const pushNoAddress = await makeAttempt({ pushStatus: "no_address", pushAttempts: 1 });

    // SMS: should be processed.
    const smsDue1 = await makeAttempt({ smsStatus: "failed", smsAttempts: 1 });
    // SMS: should be skipped.
    const smsExhausted = await makeAttempt({
      smsStatus: "failed", smsAttempts: COACH_PAYOUT_MAX_SMS_ATTEMPTS,
    });
    const smsSent = await makeAttempt({ smsStatus: "sent", smsAttempts: 1 });
    const smsSkipped = await makeAttempt({ smsStatus: "skipped", smsAttempts: 2 });

    await retryFailedCoachPayoutPushSms();

    // Provider mocks fire once per due channel — filter to OUR coach so
    // a sibling test leaking a global `failed` row can't bump the count.
    const ourPushCalls = pushMock.mock.calls.filter(
      (c) => (c[0] as number[]).includes(testCoachUserId),
    );
    const ourSmsCalls = smsMock.mock.calls.filter(
      (c) => (c[0] as string) === "+911234599001",
    );
    expect(ourPushCalls).toHaveLength(2);
    expect(ourSmsCalls).toHaveLength(1);

    // Tighter guardrail on the candidate-selection query: the cron must
    // only have invoked the retry helpers for the due attempt IDs.
    const duePushIds = [pushDue1.id, pushDue2.id].sort();
    const calledPushIds = retryPushMock.mock.calls.map((c) => c[0].attempt.id).sort();
    expect(calledPushIds).toEqual(duePushIds);

    const calledSmsIds = retrySmsMock.mock.calls.map((c) => c[0].attempt.id).sort();
    expect(calledSmsIds).toEqual([smsDue1.id]);

    // Due rows flipped to sent.
    expect((await loadAttempt(pushDue1.id)).pushStatus).toBe("sent");
    expect((await loadAttempt(pushDue2.id)).pushStatus).toBe("sent");
    expect((await loadAttempt(smsDue1.id)).smsStatus).toBe("sent");

    // Non-due rows untouched (status + attempts unchanged).
    const exhaustedPushRow = await loadAttempt(pushExhausted.id);
    expect(exhaustedPushRow.pushStatus).toBe("failed");
    expect(exhaustedPushRow.pushAttempts).toBe(COACH_PAYOUT_MAX_PUSH_ATTEMPTS);

    expect((await loadAttempt(pushSent.id)).pushStatus).toBe("sent");
    expect((await loadAttempt(pushSkipped.id)).pushStatus).toBe("skipped");
    expect((await loadAttempt(pushNoAddress.id)).pushStatus).toBe("no_address");

    const exhaustedSmsRow = await loadAttempt(smsExhausted.id);
    expect(exhaustedSmsRow.smsStatus).toBe("failed");
    expect(exhaustedSmsRow.smsAttempts).toBe(COACH_PAYOUT_MAX_SMS_ATTEMPTS);

    expect((await loadAttempt(smsSent.id)).smsStatus).toBe("sent");
    expect((await loadAttempt(smsSkipped.id)).smsStatus).toBe("skipped");
  });
});

describe("retryFailedCoachPayoutPushSms — per-row error isolation", () => {
  it("a thrown error on one push row does not abort the rest of the batch", async () => {
    const a = await makeAttempt({ pushStatus: "failed", pushAttempts: 1 });
    const b = await makeAttempt({ pushStatus: "failed", pushAttempts: 1 });
    const c = await makeAttempt({ pushStatus: "failed", pushAttempts: 1 });

    const real = await vi.importActual<typeof import("../lib/coachPayoutNotify.js")>(
      "../lib/coachPayoutNotify.js",
    );
    // Make the helper throw when called for row `b`, but run the real
    // implementation for everyone else.
    retryPushMock.mockImplementation(async (opts) => {
      if (opts.attempt.id === b.id) {
        throw new Error("simulated unexpected helper crash");
      }
      return real.retryCoachPayoutPush(opts);
    });

    await expect(retryFailedCoachPayoutPushSms()).resolves.toBeUndefined();

    // Helper was called for all three rows (cron did not bail after b).
    const calledIds = retryPushMock.mock.calls.map((c) => c[0].attempt.id).sort();
    expect(calledIds).toEqual([a.id, b.id, c.id].sort());

    // Rows a and c were delivered; row b is unchanged (the throw bypassed
    // the helper's own DB update path).
    const rowA = await loadAttempt(a.id);
    const rowB = await loadAttempt(b.id);
    const rowC = await loadAttempt(c.id);
    expect(rowA.pushStatus).toBe("sent");
    expect(rowC.pushStatus).toBe("sent");
    expect(rowB.pushStatus).toBe("failed");
    expect(rowB.pushAttempts).toBe(1);
  });

  it("a thrown error in the push helper does not prevent the SMS helper from running on the same row", async () => {
    // Row has both channels failed: push helper throws but SMS helper
    // should still be invoked (the cron's per-channel try/catch is
    // independent).
    const row = await makeAttempt({
      pushStatus: "failed", pushAttempts: 1,
      smsStatus: "failed", smsAttempts: 1,
    });

    const real = await vi.importActual<typeof import("../lib/coachPayoutNotify.js")>(
      "../lib/coachPayoutNotify.js",
    );
    retryPushMock.mockImplementation(async () => {
      throw new Error("push helper exploded");
    });
    retrySmsMock.mockImplementation(real.retryCoachPayoutSms);

    await expect(retryFailedCoachPayoutPushSms()).resolves.toBeUndefined();

    // Filter by attempt.id so a sibling test's leaked attempt can't bump count.
    const ourPushHelperCalls = retryPushMock.mock.calls.filter(
      (c) => c[0].attempt.id === row.id,
    );
    const ourSmsHelperCalls = retrySmsMock.mock.calls.filter(
      (c) => c[0].attempt.id === row.id,
    );
    expect(ourPushHelperCalls).toHaveLength(1);
    expect(ourSmsHelperCalls).toHaveLength(1);

    const reloaded = await loadAttempt(row.id);
    // Push left as `failed` (the throw bypassed the helper's own DB
    // update path); SMS was delivered.
    expect(reloaded.pushStatus).toBe("failed");
    expect(reloaded.pushAttempts).toBe(1);
    expect(reloaded.smsStatus).toBe("sent");
  });
});

describe("retryFailedCoachPayoutPushSms — batch limit", () => {
  it("processes at most 50 rows per pass; the rest stay queued for the next run", async () => {
    const SEED = 55;
    const created: number[] = [];
    for (let i = 0; i < SEED; i++) {
      const row = await makeAttempt({ pushStatus: "failed", pushAttempts: 1 });
      created.push(row.id);
    }

    await retryFailedCoachPayoutPushSms();

    // Push provider fired exactly 50 times for OUR coach — the cron's
    // hard batch cap. (Sibling tests can leak attempts; filter so we
    // only count calls dispatched to userIds the test owns.)
    const ourPushCalls = pushMock.mock.calls.filter(
      (c) => (c[0] as number[]).includes(testCoachUserId),
    );
    expect(ourPushCalls).toHaveLength(50);

    // Of our 55 seeded rows, 50 are now `sent` and 5 remain `failed`.
    const ourRows = await db
      .select({
        id: coachPayoutNotificationAttemptsTable.id,
        pushStatus: coachPayoutNotificationAttemptsTable.pushStatus,
      })
      .from(coachPayoutNotificationAttemptsTable)
      .where(and(
        eq(coachPayoutNotificationAttemptsTable.organizationId, testOrgId),
        inArray(coachPayoutNotificationAttemptsTable.id, created),
      ));
    const sent = ourRows.filter((r) => r.pushStatus === "sent").length;
    const stillFailed = ourRows.filter((r) => r.pushStatus === "failed").length;
    expect(sent).toBe(50);
    expect(stillFailed).toBe(5);

    // A second pass drains the remaining 5 rows.
    pushMock.mockClear();
    await retryFailedCoachPayoutPushSms();
    const ourSecondPushCalls = pushMock.mock.calls.filter(
      (c) => (c[0] as number[]).includes(testCoachUserId),
    );
    expect(ourSecondPushCalls).toHaveLength(5);
    const drained = await db
      .select({ pushStatus: coachPayoutNotificationAttemptsTable.pushStatus })
      .from(coachPayoutNotificationAttemptsTable)
      .where(and(
        eq(coachPayoutNotificationAttemptsTable.organizationId, testOrgId),
        ne(coachPayoutNotificationAttemptsTable.pushStatus, "sent"),
      ));
    expect(drained).toHaveLength(0);
  });
});
