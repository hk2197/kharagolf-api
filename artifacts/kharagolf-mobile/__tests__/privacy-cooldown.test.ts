import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  RESEND_COOLDOWN_MS,
  canResend,
  cooldownRemainingMs,
  formatCooldown,
  type CooldownRequest,
} from "../app/my-360/privacy-cooldown";

const FIXED_NOW = new Date("2026-04-18T12:00:00.000Z").getTime();

function freshlyResent(nowMs: number): CooldownRequest {
  return {
    lastNotifiedAt: new Date(nowMs).toISOString(),
    lastEmailStatus: "sent",
    lastPushStatus: "sent",
    lastSmsStatus: "sent",
  };
}

describe("privacy resend cooldown helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts at the full 5-minute cooldown", () => {
    const r = freshlyResent(Date.now());
    expect(cooldownRemainingMs(r, Date.now())).toBe(RESEND_COOLDOWN_MS);
    expect(formatCooldown(cooldownRemainingMs(r, Date.now()))).toBe("5m 00s");
    expect(canResend(r, Date.now())).toBe(false);
  });

  it("formats labels as the cooldown decreases", () => {
    const r = freshlyResent(Date.now());
    const labels: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      labels.push(formatCooldown(cooldownRemainingMs(r, Date.now())));
      vi.advanceTimersByTime(1000);
    }
    expect(labels).toEqual(["5m 00s", "4m 59s", "4m 58s", "4m 57s"]);
  });

  it("crosses the minute boundary", () => {
    const r = freshlyResent(Date.now());
    vi.advanceTimersByTime(RESEND_COOLDOWN_MS - 4 * 60_000 - 1_000);
    expect(formatCooldown(cooldownRemainingMs(r, Date.now()))).toBe("4m 01s");
    vi.advanceTimersByTime(1000);
    expect(formatCooldown(cooldownRemainingMs(r, Date.now()))).toBe("4m 00s");
    vi.advanceTimersByTime(1000);
    expect(formatCooldown(cooldownRemainingMs(r, Date.now()))).toBe("3m 59s");
  });

  it("flips canResend the moment the cooldown elapses", () => {
    const r = freshlyResent(Date.now());
    vi.advanceTimersByTime(RESEND_COOLDOWN_MS - 1);
    expect(canResend(r, Date.now())).toBe(false);
    expect(formatCooldown(cooldownRemainingMs(r, Date.now()))).toBe("0m 01s");
    vi.advanceTimersByTime(1);
    expect(canResend(r, Date.now())).toBe(true);
  });

  it("bypasses the cooldown when a channel failed", () => {
    const r: CooldownRequest = { ...freshlyResent(Date.now()), lastEmailStatus: "failed" };
    expect(canResend(r, Date.now())).toBe(true);
  });
});
