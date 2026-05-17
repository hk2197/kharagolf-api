/**
 * Task #2040 — `notifyCoachingGapClosed` helper contract.
 *
 * The daily sweep in `lib/cron.ts` (`runCoachingGapClosedDailySweep`)
 * uses the helper's *return value* — specifically `recipients[].channels`
 * — to decide whether to insert the 14-day per-club dedup audit row.
 * That gating is what prevents an opt-out / failed push from
 * silencing the encouragement nudge for a fortnight, so both the
 * payload shape AND the result-passthrough are part of the public
 * contract this test pins down.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { dispatchNotificationMock } = vi.hoisted(() => ({
  dispatchNotificationMock: vi.fn(),
}));

vi.mock("../lib/notifyDispatch.js", () => ({
  dispatchNotification: dispatchNotificationMock,
}));

import { notifyCoachingGapClosed } from "../lib/brandedNotifications.js";

beforeEach(() => {
  dispatchNotificationMock.mockReset();
});

describe("Task #2040 — notifyCoachingGapClosed", () => {
  it("returns null without invoking dispatch when userIds is empty", async () => {
    const result = await notifyCoachingGapClosed({
      userIds: [],
      clubLabel: "7-iron",
      clubKey: "7i",
      improvedByFt: 1.7,
    });
    expect(result).toBeNull();
    expect(dispatchNotificationMock).not.toHaveBeenCalled();
  });

  it("dispatches with the deep-link statsUrl, club metadata, and rendered body", async () => {
    dispatchNotificationMock.mockResolvedValue({
      key: "coaching.gap.closed",
      digestable: false,
      recipients: [
        { id: 7, channels: [{ channel: "push", status: "sent" }] },
      ],
    });

    const result = await notifyCoachingGapClosed({
      userIds: [7],
      clubLabel: "7-iron",
      clubKey: "7i",
      improvedByFt: 1.7,
    });

    expect(dispatchNotificationMock).toHaveBeenCalledTimes(1);
    const [key, recipients, payload] = dispatchNotificationMock.mock.calls[0]!;
    expect(key).toBe("coaching.gap.closed");
    expect(recipients).toEqual([7]);
    expect(payload.title).toContain("7-iron");
    expect(payload.body).toContain("1.7 ft");
    const data = payload.data as Record<string, unknown>;
    expect(data.type).toBe("coaching_gap_closed");
    expect(data.clubKey).toBe("7i");
    expect(data.clubLabel).toBe("7-iron");
    expect(data.improvedByFt).toBe(1.7);
    expect(typeof data.statsUrl).toBe("string");
    expect(String(data.statsUrl)).toContain("/portal/stats");
    expect(String(data.statsUrl)).toContain("club=7i");

    // Caller must see the dispatch result so it can gate the dedup row
    // on real push delivery.
    expect(result).not.toBeNull();
    expect(result!.recipients[0]?.channels[0]?.status).toBe("sent");
  });

  it("URL-encodes the clubKey when building the default statsUrl", async () => {
    dispatchNotificationMock.mockResolvedValue({
      key: "coaching.gap.closed",
      digestable: false,
      recipients: [{ id: 1, channels: [{ channel: "push", status: "sent" }] }],
    });

    await notifyCoachingGapClosed({
      userIds: [1],
      clubLabel: "Pitching Wedge",
      clubKey: "pitch wedge",
      improvedByFt: 2.4,
    });

    const payload = dispatchNotificationMock.mock.calls[0]![2];
    const data = payload.data as Record<string, unknown>;
    expect(String(data.statsUrl)).toContain("club=pitch%20wedge");
  });

  it("propagates a skipped-status dispatch result so the caller can skip the dedup write", async () => {
    // Simulates the user having `notifyCoachingTipClosed = false` —
    // notifyDispatch records the recipient as `event_opted_out` and
    // returns no `sent` channel. The cron's gating expression
    // (`channel === "push" && status === "sent"`) must be false here.
    dispatchNotificationMock.mockResolvedValue({
      key: "coaching.gap.closed",
      digestable: false,
      recipients: [
        { id: 9, channels: [{ channel: "skipped", status: "skipped", reason: "event_opted_out" }] },
      ],
    });

    const result = await notifyCoachingGapClosed({
      userIds: [9],
      clubLabel: "8-iron",
      clubKey: "8i",
      improvedByFt: 1.6,
    });

    const wasDelivered = result?.recipients.some((r) =>
      r.channels.some((ch) => ch.channel === "push" && ch.status === "sent"),
    ) ?? false;
    expect(wasDelivered).toBe(false);
  });

  it("propagates a failed-push dispatch result so the caller can skip the dedup write", async () => {
    dispatchNotificationMock.mockResolvedValue({
      key: "coaching.gap.closed",
      digestable: false,
      recipients: [
        { id: 12, channels: [{ channel: "push", status: "failed", reason: "no_devices" }] },
      ],
    });

    const result = await notifyCoachingGapClosed({
      userIds: [12],
      clubLabel: "9-iron",
      clubKey: "9i",
      improvedByFt: 1.9,
    });

    const wasDelivered = result?.recipients.some((r) =>
      r.channels.some((ch) => ch.channel === "push" && ch.status === "sent"),
    ) ?? false;
    expect(wasDelivered).toBe(false);
  });

  it("does NOT swallow dispatch errors — caller relies on the throw to skip the audit insert", async () => {
    dispatchNotificationMock.mockRejectedValue(new Error("dispatch boom"));
    await expect(notifyCoachingGapClosed({
      userIds: [3],
      clubLabel: "5-iron",
      clubKey: "5i",
      improvedByFt: 1.8,
    })).rejects.toThrow(/dispatch boom/);
  });
});
