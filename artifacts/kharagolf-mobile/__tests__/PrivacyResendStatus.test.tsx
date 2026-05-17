import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PrivacyResendStatus } from "../app/my-360/PrivacyResendStatus";
import { RESEND_COOLDOWN_MS, type CooldownRequest } from "../app/my-360/privacy-cooldown";

const FIXED_NOW = new Date("2026-04-18T12:00:00.000Z").getTime();

function freshlyResent(at: number): CooldownRequest {
  return {
    lastNotifiedAt: new Date(at).toISOString(),
    lastEmailStatus: "sent",
    lastPushStatus: "sent",
    lastSmsStatus: "sent",
  };
}

function tickSeconds(seconds: number) {
  act(() => {
    vi.advanceTimersByTime(seconds * 1000);
  });
}

describe("<PrivacyResendStatus /> countdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the cooldown hint right after a freshly resent notice", () => {
    render(
      <PrivacyResendStatus
        request={freshlyResent(Date.now())}
        resending={false}
        onResend={() => {}}
      />,
    );

    expect(screen.getByText(/Available again in 5m 00s/i)).toBeInTheDocument();
    expect(screen.queryByText(/Resend acknowledgement/i)).not.toBeInTheDocument();
  });

  it("ticks the timer label down as time passes", () => {
    render(
      <PrivacyResendStatus
        request={freshlyResent(Date.now())}
        resending={false}
        onResend={() => {}}
      />,
    );

    expect(screen.getByText(/Available again in 5m 00s/i)).toBeInTheDocument();

    tickSeconds(1);
    expect(screen.getByText(/Available again in 4m 59s/i)).toBeInTheDocument();
    expect(screen.queryByText(/5m 00s/)).not.toBeInTheDocument();

    tickSeconds(1);
    expect(screen.getByText(/Available again in 4m 58s/i)).toBeInTheDocument();

    tickSeconds(58);
    expect(screen.getByText(/Available again in 4m 00s/i)).toBeInTheDocument();
    tickSeconds(1);
    expect(screen.getByText(/Available again in 3m 59s/i)).toBeInTheDocument();
  });

  it("replaces the hint with the Resend button when the cooldown elapses", () => {
    const onResend = vi.fn();
    render(
      <PrivacyResendStatus
        request={freshlyResent(Date.now())}
        resending={false}
        onResend={onResend}
      />,
    );

    tickSeconds((RESEND_COOLDOWN_MS - 1000) / 1000);
    expect(screen.getByText(/Available again in 0m 01s/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Resend acknowledgement/i })).toBeNull();

    tickSeconds(1);
    expect(screen.queryByText(/Available again in/i)).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: /Resend acknowledgement/i });
    expect(button).toBeInTheDocument();

    fireEvent.click(button);
    expect(onResend).toHaveBeenCalledTimes(1);
  });

  it("bypasses the cooldown when a delivery channel failed", () => {
    render(
      <PrivacyResendStatus
        request={{ ...freshlyResent(Date.now()), lastEmailStatus: "failed" }}
        resending={false}
        onResend={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: /Resend acknowledgement/i })).toBeInTheDocument();
    expect(screen.queryByText(/Available again in/i)).not.toBeInTheDocument();
  });
});
