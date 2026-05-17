/**
 * Test: in-app push notification for settled payments (Task #832).
 *
 * Verifies `notifyPaymentSettled` (the processor-agnostic helper invoked
 * from both the Stripe webhook handler and the Razorpay confirmation paths):
 *   - Fires a push with type='payment_confirmed' + per-kind metadata for
 *     tournament/league/shop/dues kinds.
 *   - Skips silently when the recipient has no linked app user.
 *   - Skips when the recipient has set preferPush=false.
 *   - Reports no_address when there are no registered device tokens.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { sendPushToUsersMock } = vi.hoisted(() => ({
  sendPushToUsersMock: vi.fn(
    async (
      _userIds: number[],
      _title: string,
      _body: string,
      _data?: Record<string, unknown>,
    ) => ({
      attempted: 1, sent: 1, failed: 0, invalid: 0,
    }),
  ),
}));

vi.mock("../lib/push.js", () => ({
  sendPushToUsers: sendPushToUsersMock,
}));

import { db, organizationsTable, appUsersTable, userNotificationPrefsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { notifyPaymentSettled } from "../lib/notifications.js";

let orgId: number;
let userId: number;

beforeAll(async () => {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `StripeNotifyOrg_${ts}`,
    slug: `stripe-notify-${ts}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `stripe-notify-${ts}`,
    username: `stripe_notify_${ts}`,
    email: `${ts}@example.test`,
    displayName: "Stripe Notify Tester",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;
});

afterAll(async () => {
  if (userId) {
    await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
    await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  }
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  sendPushToUsersMock.mockClear();
  sendPushToUsersMock.mockResolvedValue({ attempted: 1, sent: 1, failed: 0, invalid: 0 });
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
});

describe("notifyPaymentSettled — in-app push for Stripe payments", () => {
  it("fires a tournament push with deep-link metadata", async () => {
    const result = await notifyPaymentSettled({
      userId,
      kind: "tournament",
      eventName: "Spring Open",
      amountMinor: 5000,
      currency: "USD",
      paymentRef: "pi_test_111",
      organizationId: orgId,
      entityId: 42,
    });
    expect(result.status).toBe("sent");
    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    const [recipients, title, body, data] = sendPushToUsersMock.mock.calls[0]!;
    expect(recipients).toEqual([userId]);
    expect(String(title)).toBe("Payment confirmed");
    expect(String(body)).toContain("Spring Open");
    expect(String(body)).toContain("$50.00");
    expect(data).toMatchObject({
      type: "payment_confirmed",
      kind: "tournament",
      paymentRef: "pi_test_111",
      organizationId: orgId,
      currency: "USD",
      amountMinor: 5000,
      entityId: 42,
      tournamentId: 42,
    });
  });

  it("fires a league push with leagueId metadata", async () => {
    await notifyPaymentSettled({
      userId, kind: "league", eventName: "Winter League",
      amountMinor: 2500, currency: "GBP", paymentRef: "pi_l", organizationId: orgId, entityId: 7,
    });
    const [, , body, data] = sendPushToUsersMock.mock.calls[0]!;
    expect(String(body)).toContain("Winter League");
    expect(String(body)).toContain("£25.00");
    expect(data).toMatchObject({ kind: "league", leagueId: 7 });
  });

  it("fires a shop push with orderId metadata", async () => {
    await notifyPaymentSettled({
      userId, kind: "shop", eventName: "Pro Shop",
      amountMinor: 12345, currency: "INR", paymentRef: "pi_s", organizationId: orgId, entityId: 99,
    });
    const [, , body, data] = sendPushToUsersMock.mock.calls[0]!;
    expect(String(body)).toContain("Pro Shop");
    expect(String(body)).toContain("₹123.45");
    expect(data).toMatchObject({ kind: "shop", orderId: 99 });
  });

  it("fires a dues push with invoiceId metadata", async () => {
    await notifyPaymentSettled({
      userId, kind: "dues", eventName: "City Golf Club",
      amountMinor: 9999, currency: "EUR", paymentRef: "pi_d", organizationId: orgId, entityId: 314,
    });
    const [, , body, data] = sendPushToUsersMock.mock.calls[0]!;
    expect(String(body)).toContain("City Golf Club");
    expect(String(body)).toContain("€99.99");
    expect(data).toMatchObject({ kind: "dues", invoiceId: 314 });
  });

  it("skips silently when there is no linked app user", async () => {
    const result = await notifyPaymentSettled({
      userId: null, kind: "tournament", eventName: "X",
      amountMinor: 100, currency: "USD", paymentRef: "pi", organizationId: orgId,
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_user");
    expect(sendPushToUsersMock).not.toHaveBeenCalled();
  });

  it("skips when the recipient has opted out of push", async () => {
    await db.insert(userNotificationPrefsTable).values({ userId, preferPush: false });
    const result = await notifyPaymentSettled({
      userId, kind: "tournament", eventName: "X",
      amountMinor: 100, currency: "USD", paymentRef: "pi", organizationId: orgId,
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("opted_out");
    expect(sendPushToUsersMock).not.toHaveBeenCalled();
  });

  it("returns no_address when the user has no registered device tokens", async () => {
    sendPushToUsersMock.mockResolvedValueOnce({ attempted: 0, sent: 0, failed: 0, invalid: 0 });
    const result = await notifyPaymentSettled({
      userId, kind: "shop", eventName: "Pro Shop",
      amountMinor: 100, currency: "USD", paymentRef: "pi", organizationId: orgId,
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_address");
  });

  it("omits the amount string when amountMinor is zero", async () => {
    await notifyPaymentSettled({
      userId, kind: "tournament", eventName: "Free Entry Open",
      amountMinor: 0, currency: "USD", paymentRef: "pi", organizationId: orgId, entityId: 1,
    });
    const [, , body] = sendPushToUsersMock.mock.calls[0]!;
    expect(String(body)).toContain("Free Entry Open");
    expect(String(body)).not.toContain("$0.00");
  });
});
