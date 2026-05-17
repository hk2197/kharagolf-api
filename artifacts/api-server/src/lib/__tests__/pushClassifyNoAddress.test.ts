/**
 * Task #1070 — when a recipient has no Expo push tokens registered,
 * `sendPushToUsers` returns `{ attempted: 1, sent: 0, failed: 0, invalid: 0 }`
 * and the notify helpers must classify that as `no_address` (a benign
 * "nothing to deliver to") rather than `failed` (a real provider problem).
 *
 * Covers two distinct call sites that previously misclassified the
 * no-devices shape as `failed`:
 *
 *   1. `notifyPaymentSettled` — fires on the Stripe / Razorpay
 *      payment-confirmation webhook. Misclassifying here was the bug
 *      surfaced by the task title ("payment confirmation 'failed'").
 *   2. `notifyHighlightReady`        — fires when a highlight reel
 *      transitions to a terminal render status.
 *
 * Both helpers go through the shared `classifyPushDelivery` mapping in
 * `src/lib/push.ts`. We also assert the classifier's contract directly so
 * future call sites have a single regression target.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { sendPushToUsersMock } = vi.hoisted(() => ({
  // No-devices shape: attempted is the userIds.length, but no tokens are
  // registered so sent/failed/invalid all stay zero. This is exactly what
  // `sendPushToUsers` returns for a user with no `device_tokens` rows.
  sendPushToUsersMock: vi.fn(async (userIds: number[]) => ({
    attempted: userIds.length,
    sent: 0,
    failed: 0,
    invalid: 0,
  })),
}));

vi.mock("../push.js", async () => {
  const actual = await vi.importActual<typeof import("../push.js")>("../push.js");
  return {
    ...actual,
    sendPushToUsers: sendPushToUsersMock,
  };
});

import { db, appUsersTable, organizationsTable, highlightReelsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { classifyPushDelivery } from "../push.js";
import { notifyPaymentSettled, notifyHighlightReady } from "../notifications.js";

const createdUserIds: number[] = [];
const createdOrgIds: number[] = [];
const createdReelIds: number[] = [];

beforeAll(async () => {
  // No-op; per-test setup creates everything.
});

afterAll(async () => {
  if (createdReelIds.length > 0) {
    await db.delete(highlightReelsTable).where(inArray(highlightReelsTable.id, createdReelIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length > 0) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

beforeEach(() => {
  sendPushToUsersMock.mockClear();
});

let counter = 0;
function uniq(label: string): string {
  counter++;
  return `${label}_${Date.now()}_${counter}_${Math.random().toString(36).slice(2, 8)}`;
}

async function makeOrg(): Promise<number> {
  const stamp = uniq("org");
  const [org] = await db.insert(organizationsTable).values({
    name: `Org ${stamp}`,
    slug: stamp,
  }).returning();
  createdOrgIds.push(org.id);
  return org.id;
}

async function makeUser(): Promise<number> {
  const stamp = uniq("user");
  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `task1070-${stamp}`,
    username: `t1070_${stamp}`,
  }).returning();
  createdUserIds.push(user.id);
  return user.id;
}

describe("classifyPushDelivery", () => {
  it("treats the no-devices shape (attempted=1, sent=0, failed=0, invalid=0) as no_address", () => {
    expect(classifyPushDelivery({ attempted: 1, sent: 0, failed: 0, invalid: 0 })).toBe("no_address");
  });

  it("treats an empty userIds list as no_address", () => {
    expect(classifyPushDelivery({ attempted: 0, sent: 0, failed: 0, invalid: 0 })).toBe("no_address");
  });

  it("treats all-invalid tokens as no_address (no valid Expo addresses)", () => {
    expect(classifyPushDelivery({ attempted: 1, sent: 0, failed: 0, invalid: 1 })).toBe("no_address");
  });

  it("treats any successful ticket as sent", () => {
    expect(classifyPushDelivery({ attempted: 1, sent: 1, failed: 0, invalid: 0 })).toBe("sent");
  });

  it("treats any failed ticket as failed", () => {
    expect(classifyPushDelivery({ attempted: 1, sent: 0, failed: 1, invalid: 0 })).toBe("failed");
  });
});

describe("notifyPaymentSettled — payment confirmation with no devices linked (Task #1070)", () => {
  it("returns skipped/no_address instead of failed", async () => {
    const userId = await makeUser();
    const orgId = await makeOrg();

    const result = await notifyPaymentSettled({
      userId,
      kind: "tournament",
      eventName: "Spring Open",
      amountMinor: 5000,
      currency: "INR",
      paymentRef: "pay_test_no_devices",
      organizationId: orgId,
      entityId: 42,
    });

    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_address");
    // Critical: must NOT be reported as a failed delivery just because
    // the payer has no Expo tokens registered yet.
    expect(result.status).not.toBe("failed");
  });
});

describe("notifyHighlightReady — terminal render with no devices linked (Task #1070)", () => {
  it("returns skipped/no_address instead of failed", async () => {
    const userId = await makeUser();
    const orgId = await makeOrg();

    const [reel] = await db.insert(highlightReelsTable).values({
      organizationId: orgId,
      userId,
      title: "My Round",
      status: "ready",
    }).returning();
    createdReelIds.push(reel.id);

    const result = await notifyHighlightReady(reel.id);

    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_address");
    expect(result.reelStatus).toBe("ready");
    // Critical: a player with push not yet set up must not see their
    // reel reported as a failed-to-deliver notification.
    expect(result.status).not.toBe("failed");
  });
});
