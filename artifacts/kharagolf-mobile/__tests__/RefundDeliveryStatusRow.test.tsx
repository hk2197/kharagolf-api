/**
 * UI test: mobile `RefundDeliveryStatusRow` — Task #1862.
 *
 * Mirror of the web component test in
 * `kharagolf-web/src/components/__tests__/RefundDeliveryStatusRow.test.tsx`
 * so the cross-surface contract for the new four-channel
 * (Email / Push / SMS / WhatsApp) refund delivery row stays in sync.
 *
 * Specifically asserts:
 *   1. All four channels are always rendered, even when their
 *      backing status is null — this is what answers "did the SMS
 *      ever go out?" rather than the row silently disappearing.
 *   2. Each of the five mapped statuses (sent | retrying | failed
 *      | exhausted | skipped) renders the right human label.
 *   3. The unknown / not-yet-attempted state collapses to an em-dash.
 *
 * The mobile row is member-facing and does NOT take a
 * `showLastError` prop in any production callsite — the wallet
 * screen always calls it without one — so the error-rendering
 * gating is exercised on the web side only (admin dashboard).
 */
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import {
  RefundDeliveryStatusRow,
  refundDeliveryStatusLabel,
  type RefundDeliveryInfo,
} from "../components/RefundDeliveryStatusRow";

afterEach(() => cleanup());

function makeChannel(overrides: Partial<RefundDeliveryInfo["email"]> = {}): RefundDeliveryInfo["email"] {
  return {
    status: null,
    attempts: 0,
    lastAt: null,
    nextRetryAt: null,
    exhaustedAt: null,
    lastError: null,
    ...overrides,
  };
}

describe("refundDeliveryStatusLabel (mobile)", () => {
  it("maps every known status (and null) to a human label", () => {
    expect(refundDeliveryStatusLabel("sent")).toBe("Sent");
    expect(refundDeliveryStatusLabel("retrying")).toBe("Retrying");
    expect(refundDeliveryStatusLabel("failed")).toBe("Failed");
    expect(refundDeliveryStatusLabel("exhausted")).toBe("Gave up");
    expect(refundDeliveryStatusLabel("skipped")).toBe("Skipped");
    expect(refundDeliveryStatusLabel(null)).toBe("—");
  });
});

describe("RefundDeliveryStatusRow — mobile (Task #1862)", () => {
  it("renders all four channels (even when statuses are null)", () => {
    const delivery: RefundDeliveryInfo = {
      email: makeChannel(),
      push: makeChannel(),
      sms: makeChannel(),
      whatsapp: makeChannel(),
    };
    render(
      <RefundDeliveryStatusRow
        delivery={delivery}
        rowTestID="row-mr"
        channelTestIDPrefix="ch-mr"
      />,
    );
    expect(screen.getByTestId("row-mr")).toBeTruthy();
    for (const channel of ["email", "push", "sms", "whatsapp"]) {
      const cell = screen.getByTestId(`ch-mr-${channel}`);
      expect(cell).toBeTruthy();
      expect(cell.textContent).toContain("—");
    }
  });

  it("renders each mapped status with the right per-channel label", () => {
    const delivery: RefundDeliveryInfo = {
      email: makeChannel({ status: "sent", attempts: 1 }),
      push: makeChannel({ status: "retrying", attempts: 2, nextRetryAt: "2026-04-30T12:00:00Z" }),
      sms: makeChannel({ status: "exhausted", attempts: 5, exhaustedAt: "2026-04-30T11:00:00Z" }),
      whatsapp: makeChannel({ status: "skipped" }),
    };
    render(
      <RefundDeliveryStatusRow
        delivery={delivery}
        rowTestID="row-mr2"
        channelTestIDPrefix="ch-mr2"
      />,
    );
    expect(screen.getByTestId("ch-mr2-email").textContent).toContain("Email: Sent");
    expect(screen.getByTestId("ch-mr2-push").textContent).toContain("Push: Retrying");
    expect(screen.getByTestId("ch-mr2-sms").textContent).toContain("SMS: Gave up");
    expect(screen.getByTestId("ch-mr2-whatsapp").textContent).toContain("WhatsApp: Skipped");
  });

  it("renders the transient `failed` status (no exhaustedAt, no nextRetryAt — between cron passes)", () => {
    const delivery: RefundDeliveryInfo = {
      email: makeChannel({ status: "failed", attempts: 1 }),
      push: makeChannel(),
      sms: makeChannel(),
      whatsapp: makeChannel(),
    };
    render(
      <RefundDeliveryStatusRow
        delivery={delivery}
        rowTestID="row-mr3"
        channelTestIDPrefix="ch-mr3"
      />,
    );
    expect(screen.getByTestId("ch-mr3-email").textContent).toContain("Email: Failed");
  });

  it("does NOT render any per-channel error block by default (mobile callers never pass showLastError)", () => {
    const delivery: RefundDeliveryInfo = {
      email: makeChannel({ status: "failed", lastError: "smtp timeout" }),
      push: makeChannel({ status: "exhausted", lastError: "FCM 500" }),
      sms: makeChannel({ status: "exhausted", lastError: "Twilio 30007" }),
      whatsapp: makeChannel({ status: "failed", lastError: "Meta 131026" }),
    };
    render(
      <RefundDeliveryStatusRow
        delivery={delivery}
        rowTestID="row-mr4"
        channelTestIDPrefix="ch-mr4"
      />,
    );
    for (const channel of ["email", "push", "sms", "whatsapp"]) {
      expect(screen.queryByTestId(`ch-mr4-${channel}-error`)).toBeNull();
    }
  });
});
