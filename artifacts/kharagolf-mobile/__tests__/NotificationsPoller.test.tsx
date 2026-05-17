/**
 * Verifies the bottom-tab notifications badge no longer relies on the
 * 30-second poll (Task #1053). The component now refreshes via the
 * expo-notifications "received" listener and falls back to a slow
 * 5-minute safety-net poll.
 *
 * Tests:
 *   1. Mount fetches once; no extra fetch at the old 30s mark.
 *   2. An incoming `handicap_case_update` push triggers an immediate
 *      refetch (real-time path).
 *   3. Unrelated push types do NOT trigger a refetch.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const { fetchPortalMock, listeners, expoMock } = vi.hoisted(() => {
  const listeners = { received: null as ((n: unknown) => void) | null };
  const expoMock = {
    addNotificationReceivedListener: (cb: (n: unknown) => void) => {
      listeners.received = cb;
      return { remove: () => { listeners.received = null; } };
    },
  };
  return {
    fetchPortalMock: vi.fn(async () => ({ unreadCount: 3 })),
    listeners,
    expoMock,
  };
});

vi.mock("@/utils/api", () => ({
  fetchPortal: fetchPortalMock,
}));

vi.mock("@/context/auth", () => ({
  useAuth: () => ({ token: "test-token", isAuthenticated: true }),
}));

vi.mock("@/context/unread", () => ({
  useUnread: () => ({ setNotifUnreadCount: () => undefined }),
}));

vi.mock("@/utils/expoNotifications", () => ({
  getExpoNotifications: () => expoMock,
}));

import NotificationsPoller from "@/components/NotificationsPoller";

beforeEach(() => {
  vi.useFakeTimers();
  fetchPortalMock.mockClear();
  listeners.received = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("NotificationsPoller — push-driven badge (Task #1053)", () => {
  it("fetches once on mount and not again at the old 30s polling mark", async () => {
    render(<NotificationsPoller />);
    await act(async () => { await Promise.resolve(); });
    expect(fetchPortalMock).toHaveBeenCalledTimes(1);
    expect(fetchPortalMock).toHaveBeenCalledWith("/handicap/notifications", "test-token");

    // The previous implementation polled every 30 seconds. The new
    // safety-net cadence is 5 minutes, so no extra fetch should fire here.
    await act(async () => { vi.advanceTimersByTime(60_000); await Promise.resolve(); });
    expect(fetchPortalMock).toHaveBeenCalledTimes(1);
  });

  it("refetches immediately when a handicap_case_update push arrives", async () => {
    render(<NotificationsPoller />);
    await act(async () => { await Promise.resolve(); });
    fetchPortalMock.mockClear();

    expect(listeners.received).toBeTypeOf("function");
    await act(async () => {
      listeners.received!({
        request: { content: { data: { type: "handicap_case_update" } } },
      });
      await Promise.resolve();
    });

    expect(fetchPortalMock).toHaveBeenCalledTimes(1);
    expect(fetchPortalMock).toHaveBeenCalledWith("/handicap/notifications", "test-token");
  });

  it("ignores push types unrelated to the handicap inbox", async () => {
    render(<NotificationsPoller />);
    await act(async () => { await Promise.resolve(); });
    fetchPortalMock.mockClear();

    expect(listeners.received).toBeTypeOf("function");
    await act(async () => {
      listeners.received!({
        request: { content: { data: { type: "shop_order" } } },
      });
      await Promise.resolve();
    });

    expect(fetchPortalMock).not.toHaveBeenCalled();
  });
});
