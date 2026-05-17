/**
 * Unit tests: notify serializers for the two new badge surfaces (Task #1841)
 *
 * Verifies that `serializeReceiptNotify` (folded into the
 * `GET /side-game-instances/:id` `settlements[]` rows) and
 * `serializeTopupRefundNotify` (folded into the wallet `transactions[]`
 * rows of `GET /wallet` for `wallet_topup_refund` txns) thread the same
 * `nextRetryAt` / `exhaustedAt` ISO timestamps that
 * `serializeWithdrawalNotify` already exposes (Task #1499). This is what
 * powers the shared `formatRetryRelative` "next try in 2m 14s" / "gave
 * up X ago" suffix on the web + mobile badges.
 *
 * Pure unit test — no DB/HTTP — invoking the serializers directly with
 * hand-crafted attempt rows. The integration that joins these into the
 * route response is exercised by the existing route-level tests for
 * those two endpoints.
 */
import { describe, it, expect } from "vitest";
import {
  serializeReceiptNotify,
  serializeTopupRefundNotify,
  serializeTopupRefundDelivery,
  deriveRefundDeliveryStatus,
} from "../routes/side-games-v2.js";
import {
  type SideGameSettlementReceiptAttempt,
  type WalletTopupRefundNotifyAttempt,
} from "@workspace/db";

describe("serializeReceiptNotify (Task #1841)", () => {
  it("returns null when no attempt row exists yet", () => {
    expect(serializeReceiptNotify(null)).toBeNull();
  });

  it("threads nextRetryAt for a retrying email channel", () => {
    const nextRetry = new Date("2026-04-30T10:05:14Z");
    const lastEmail = new Date("2026-04-30T10:03:00Z");
    const attempt = {
      id: 1,
      settlementId: 99,
      emailStatus: "failed",
      emailAttempts: 2,
      lastEmailAt: lastEmail,
      nextEmailRetryAt: nextRetry,
      emailRetryExhaustedAt: null,
      pushStatus: "sent",
      pushAttempts: 1,
      lastPushAt: lastEmail,
      nextPushRetryAt: null,
      pushRetryExhaustedAt: null,
      createdAt: lastEmail,
      updatedAt: lastEmail,
    } as unknown as SideGameSettlementReceiptAttempt;

    const out = serializeReceiptNotify(attempt);
    expect(out).not.toBeNull();
    expect(out!.email.status).toBe("retrying");
    expect(out!.email.attempts).toBe(2);
    expect(out!.email.nextRetryAt).toBe(nextRetry.toISOString());
    expect(out!.email.exhaustedAt).toBeNull();
    expect(out!.push.status).toBe("sent");
    expect(out!.push.nextRetryAt).toBeNull();
  });

  it("flags the channel as failed_permanent and threads exhaustedAt", () => {
    const exhausted = new Date("2026-04-30T09:00:00Z");
    const attempt = {
      id: 2,
      settlementId: 100,
      emailStatus: "failed",
      emailAttempts: 5,
      lastEmailAt: exhausted,
      nextEmailRetryAt: null,
      emailRetryExhaustedAt: exhausted,
      pushStatus: null,
      pushAttempts: 0,
      lastPushAt: null,
      nextPushRetryAt: null,
      pushRetryExhaustedAt: null,
      createdAt: exhausted,
      updatedAt: exhausted,
    } as unknown as SideGameSettlementReceiptAttempt;

    const out = serializeReceiptNotify(attempt);
    expect(out!.email.status).toBe("failed_permanent");
    expect(out!.email.exhaustedAt).toBe(exhausted.toISOString());
    expect(out!.email.nextRetryAt).toBeNull();
    expect(out!.push.status).toBeNull();
  });
});

describe("serializeTopupRefundNotify (Task #1841)", () => {
  it("returns null when no attempt row exists yet", () => {
    expect(serializeTopupRefundNotify(null)).toBeNull();
  });

  it("threads nextRetryAt / exhaustedAt for a refund retrying email", () => {
    const nextRetry = new Date("2026-04-30T11:08:00Z");
    const exhausted = new Date("2026-04-30T11:00:00Z");
    const attempt = {
      id: 3,
      paymentId: "pay_test_xyz",
      organizationId: 7,
      userId: 11,
      walletTopupRefundId: 5,
      currency: "INR",
      amountMinor: 25000,
      emailStatus: "failed",
      emailAttempts: 3,
      lastEmailAt: nextRetry,
      nextEmailRetryAt: nextRetry,
      emailRetryExhaustedAt: null,
      pushStatus: "failed",
      pushAttempts: 5,
      lastPushAt: exhausted,
      nextPushRetryAt: null,
      pushRetryExhaustedAt: exhausted,
      smsStatus: null,
      smsAttempts: 0,
      lastSmsAt: null,
      nextSmsRetryAt: null,
      smsRetryExhaustedAt: null,
      whatsappStatus: null,
      whatsappAttempts: 0,
      lastWhatsappAt: null,
      nextWhatsappRetryAt: null,
      whatsappRetryExhaustedAt: null,
      createdAt: exhausted,
      updatedAt: exhausted,
    } as unknown as WalletTopupRefundNotifyAttempt;

    const out = serializeTopupRefundNotify(attempt);
    expect(out).not.toBeNull();
    expect(out!.email.status).toBe("retrying");
    expect(out!.email.nextRetryAt).toBe(nextRetry.toISOString());
    expect(out!.email.exhaustedAt).toBeNull();
    expect(out!.email.attempts).toBe(3);
    expect(out!.push.status).toBe("failed_permanent");
    expect(out!.push.exhaustedAt).toBe(exhausted.toISOString());
    expect(out!.push.nextRetryAt).toBeNull();
    // Surface intentionally omits sms/whatsapp — badges only render
    // email + push to match the existing wallet-withdrawal pills.
    expect((out as unknown as Record<string, unknown>).sms).toBeUndefined();
    expect((out as unknown as Record<string, unknown>).whatsapp).toBeUndefined();
  });
});

/**
 * Task #1862 — `serializeTopupRefundDelivery` powers the new wallet
 * refund "delivery status" row that lists Email / Push / SMS /
 * WhatsApp side by side. Unlike `serializeTopupRefundNotify`, this
 * surface intentionally returns all four channels and a five-state
 * enum (sent | failed | retrying | exhausted | skipped) so members
 * (and admins) can answer "did the SMS ever go out?" without the DB.
 *
 * The admin caller passes `includeLastError: true` so support can see
 * the most recent provider error string inline; the member caller
 * passes `false` so the underlying provider message never leaks to
 * the affected wallet owner.
 */
describe("deriveRefundDeliveryStatus (Task #1862)", () => {
  it("maps null status to null (no attempt yet for this channel)", () => {
    expect(deriveRefundDeliveryStatus(null, null, null)).toBeNull();
  });
  it("maps sent → sent regardless of timestamps", () => {
    expect(deriveRefundDeliveryStatus("sent", null, null)).toBe("sent");
    // exhaustedAt should not fire once the channel landed successfully
    // (the cron clears the retry stamps once `sent`).
    expect(deriveRefundDeliveryStatus("sent", new Date(), new Date())).toBe("sent");
  });
  it("maps failed + exhaustedAt → exhausted (gave up)", () => {
    expect(deriveRefundDeliveryStatus("failed", new Date("2026-04-30T09:00:00Z"), null)).toBe("exhausted");
  });
  it("prefers exhausted over retrying when both timestamps exist (defensive)", () => {
    // Should never happen in practice (the cron clears nextRetryAt
    // when it stamps exhaustedAt), but if a row gets into that state
    // we want the harsher status to win so support doesn't think the
    // pipeline is still trying.
    expect(deriveRefundDeliveryStatus(
      "failed",
      new Date("2026-04-30T09:00:00Z"),
      new Date("2026-04-30T09:30:00Z"),
    )).toBe("exhausted");
  });
  it("maps failed + nextRetryAt → retrying", () => {
    expect(deriveRefundDeliveryStatus("failed", null, new Date("2026-04-30T11:08:00Z"))).toBe("retrying");
  });
  it("maps failed without either stamp → failed (transient, between retries)", () => {
    expect(deriveRefundDeliveryStatus("failed", null, null)).toBe("failed");
  });
  it("maps skipped, opted_out, no_address → skipped", () => {
    expect(deriveRefundDeliveryStatus("skipped", null, null)).toBe("skipped");
    expect(deriveRefundDeliveryStatus("opted_out", null, null)).toBe("skipped");
    expect(deriveRefundDeliveryStatus("no_address", null, null)).toBe("skipped");
  });
  it("maps unknown status strings to null (defensive)", () => {
    expect(deriveRefundDeliveryStatus("queued", null, null)).toBeNull();
    expect(deriveRefundDeliveryStatus("totally-bogus", null, null)).toBeNull();
  });
});

describe("serializeTopupRefundDelivery (Task #1862)", () => {
  /**
   * Helper to build a notify-attempts row with a baseline of nulls so
   * each test case only has to spell out the channels it cares about.
   */
  function buildAttempt(overrides: Partial<WalletTopupRefundNotifyAttempt> = {}): WalletTopupRefundNotifyAttempt {
    const baseDate = new Date("2026-04-30T11:00:00Z");
    return {
      id: 99,
      paymentId: "pay_test_xyz",
      organizationId: 7,
      userId: 11,
      walletTopupRefundId: 5,
      currency: "INR",
      amountMinor: 25000,
      emailStatus: null,
      emailAttempts: 0,
      lastEmailAt: null,
      nextEmailRetryAt: null,
      emailRetryExhaustedAt: null,
      lastEmailError: null,
      pushStatus: null,
      pushAttempts: 0,
      lastPushAt: null,
      nextPushRetryAt: null,
      pushRetryExhaustedAt: null,
      lastPushError: null,
      smsStatus: null,
      smsAttempts: 0,
      lastSmsAt: null,
      nextSmsRetryAt: null,
      smsRetryExhaustedAt: null,
      lastSmsError: null,
      whatsappStatus: null,
      whatsappAttempts: 0,
      lastWhatsappAt: null,
      nextWhatsappRetryAt: null,
      whatsappRetryExhaustedAt: null,
      lastWhatsappError: null,
      createdAt: baseDate,
      updatedAt: baseDate,
      ...overrides,
    } as unknown as WalletTopupRefundNotifyAttempt;
  }

  it("returns null when no attempt row exists yet (refund cron hasn't run)", () => {
    expect(serializeTopupRefundDelivery(null, { includeLastError: false })).toBeNull();
    expect(serializeTopupRefundDelivery(null, { includeLastError: true })).toBeNull();
  });

  it("returns all four channels with null status when nothing has been attempted", () => {
    const out = serializeTopupRefundDelivery(buildAttempt(), { includeLastError: false });
    expect(out).not.toBeNull();
    expect(Object.keys(out!).sort()).toEqual(["email", "push", "sms", "whatsapp"]);
    expect(out!.email.status).toBeNull();
    expect(out!.push.status).toBeNull();
    expect(out!.sms.status).toBeNull();
    expect(out!.whatsapp.status).toBeNull();
  });

  it("renders every status combination across the four channels", () => {
    const sent = new Date("2026-04-30T11:01:00Z");
    const exhausted = new Date("2026-04-30T11:00:00Z");
    const nextRetry = new Date("2026-04-30T11:08:00Z");
    const out = serializeTopupRefundDelivery(buildAttempt({
      // sent
      emailStatus: "sent",
      emailAttempts: 1,
      lastEmailAt: sent,
      // retrying
      pushStatus: "failed",
      pushAttempts: 2,
      lastPushAt: sent,
      nextPushRetryAt: nextRetry,
      lastPushError: "FCM 500",
      // exhausted
      smsStatus: "failed",
      smsAttempts: 5,
      lastSmsAt: exhausted,
      smsRetryExhaustedAt: exhausted,
      lastSmsError: "Twilio code 30007 (carrier filtered)",
      // skipped
      whatsappStatus: "no_address",
    }), { includeLastError: false });
    expect(out!.email.status).toBe("sent");
    expect(out!.email.attempts).toBe(1);
    expect(out!.email.lastAt).toBe(sent.toISOString());
    expect(out!.push.status).toBe("retrying");
    expect(out!.push.nextRetryAt).toBe(nextRetry.toISOString());
    expect(out!.push.exhaustedAt).toBeNull();
    expect(out!.sms.status).toBe("exhausted");
    expect(out!.sms.exhaustedAt).toBe(exhausted.toISOString());
    expect(out!.sms.nextRetryAt).toBeNull();
    expect(out!.whatsapp.status).toBe("skipped");
    expect(out!.whatsapp.attempts).toBe(0);
  });

  it("renders the transient failed state (no nextRetryAt, no exhaustedAt) — between cron passes", () => {
    const out = serializeTopupRefundDelivery(buildAttempt({
      emailStatus: "failed",
      emailAttempts: 1,
      lastEmailAt: new Date("2026-04-30T11:00:00Z"),
      lastEmailError: "smtp timeout",
    }), { includeLastError: false });
    expect(out!.email.status).toBe("failed");
    expect(out!.email.nextRetryAt).toBeNull();
    expect(out!.email.exhaustedAt).toBeNull();
  });

  it("renders the opted_out skip distinctly from no_address, both as 'skipped'", () => {
    const out = serializeTopupRefundDelivery(buildAttempt({
      smsStatus: "opted_out",
      whatsappStatus: "no_address",
    }), { includeLastError: false });
    expect(out!.sms.status).toBe("skipped");
    expect(out!.whatsapp.status).toBe("skipped");
  });

  it("omits lastError on every channel for member-facing callers (defence in depth)", () => {
    const out = serializeTopupRefundDelivery(buildAttempt({
      emailStatus: "failed",
      emailRetryExhaustedAt: new Date("2026-04-30T11:00:00Z"),
      lastEmailError: "550 mailbox unavailable",
      smsStatus: "failed",
      lastSmsError: "Twilio code 21610 (recipient unsubscribed)",
    }), { includeLastError: false });
    expect((out!.email as Record<string, unknown>).lastError).toBeUndefined();
    expect((out!.push as Record<string, unknown>).lastError).toBeUndefined();
    expect((out!.sms as Record<string, unknown>).lastError).toBeUndefined();
    expect((out!.whatsapp as Record<string, unknown>).lastError).toBeUndefined();
  });

  it("includes lastError on every channel for admin callers (even when null)", () => {
    const out = serializeTopupRefundDelivery(buildAttempt({
      emailStatus: "sent",
      // Admin sees the field, even if it's null on the happy path.
      lastEmailError: null,
      smsStatus: "failed",
      smsRetryExhaustedAt: new Date("2026-04-30T11:00:00Z"),
      lastSmsError: "Twilio code 30007 (carrier filtered)",
      whatsappStatus: "failed",
      nextWhatsappRetryAt: new Date("2026-04-30T11:08:00Z"),
      lastWhatsappError: "Meta error 131026 (message undeliverable)",
    }), { includeLastError: true });
    expect((out!.email as Record<string, unknown>).lastError).toBeNull();
    expect((out!.sms as Record<string, unknown>).lastError).toBe("Twilio code 30007 (carrier filtered)");
    expect((out!.whatsapp as Record<string, unknown>).lastError).toBe("Meta error 131026 (message undeliverable)");
    expect(out!.sms.status).toBe("exhausted");
    expect(out!.whatsapp.status).toBe("retrying");
  });
});
