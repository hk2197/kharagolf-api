/**
 * Task #2236 — Verifies the campaign-stats dialog now renders the
 * push-delivery counts and a failure-rate chip when applicable.
 *
 * The marketing API has been emitting `totalPushSent`,
 * `totalPushFailed`, `totalPushAttempted`, and `pushFailureRate` since
 * Task #1786, but the campaign-stats UI ignored them. These tests pin
 * the new card's rendering so admins can see at a glance when push
 * fan-out dropped members or a delivery pipeline is broken.
 */
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { PushDeliveryStatsCard } from "../marketing";

afterEach(() => cleanup());

describe("PushDeliveryStatsCard", () => {
  it("renders the 'Push delivered: X / Y · N failed' line for a clean send", () => {
    render(
      <PushDeliveryStatsCard
        totalPushSent={42}
        totalPushFailed={0}
        totalPushAttempted={42}
        pushFailureRate={0}
      />,
    );

    const line = screen.getByTestId("push-delivery-line");
    expect(line).toHaveTextContent("Push delivered: 42 / 42 · 0 failed");
    // No failure-rate chip when the rate is zero.
    expect(screen.queryByTestId("push-failure-rate-chip")).toBeNull();
  });

  it("shows the failure-rate chip and red failure count when push deliveries failed", () => {
    render(
      <PushDeliveryStatsCard
        totalPushSent={70}
        totalPushFailed={30}
        totalPushAttempted={100}
        pushFailureRate={30}
      />,
    );

    expect(screen.getByTestId("push-delivery-line")).toHaveTextContent(
      "Push delivered: 70 / 100 · 30 failed",
    );
    const chip = screen.getByTestId("push-failure-rate-chip");
    expect(chip).toHaveTextContent("30% failure rate");
  });

  it("hides itself entirely when the campaign had no push attempts and no failures", () => {
    const { container } = render(
      <PushDeliveryStatsCard
        totalPushSent={0}
        totalPushFailed={0}
        totalPushAttempted={0}
        pushFailureRate={0}
      />,
    );

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("push-delivery-stats")).toBeNull();
  });

  it("falls back gracefully when fields are null/undefined", () => {
    // Some older / partial campaign rows may not have the new push
    // counters yet; the card should treat null as zero and stay hidden
    // rather than crash with a NaN.
    const { container } = render(
      <PushDeliveryStatsCard
        totalPushSent={null}
        totalPushFailed={null}
        totalPushAttempted={null}
        pushFailureRate={null}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("derives totalPushAttempted from sent+failed when the API omits it", () => {
    render(
      <PushDeliveryStatsCard
        totalPushSent={4}
        totalPushFailed={1}
        // totalPushAttempted intentionally omitted
        pushFailureRate={20}
      />,
    );

    expect(screen.getByTestId("push-delivery-line")).toHaveTextContent(
      "Push delivered: 4 / 5 · 1 failed",
    );
    expect(screen.getByTestId("push-failure-rate-chip")).toHaveTextContent(
      "20% failure rate",
    );
  });
});
