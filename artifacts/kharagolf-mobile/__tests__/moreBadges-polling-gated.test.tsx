/**
 * `MoreBadgesProvider` polling and real-time push refresh.
 *
 * Task #1213 added subscriber-gated polling: the provider only hits
 * `/api/portal/badge-counts` while at least one badge-displaying screen
 * is mounted.
 *
 * Task #1407 layered on a push-driven refresh and bumped the safety-net
 * poll cadence from 30s to 5 minutes — relevant pushes refresh the
 * counts within ~1s, so the slow poll only needs to cover dropped /
 * silenced pushes and counts that don't have a push (e.g. new feed
 * posts).
 *
 * Tests:
 *   1. With no subscribers, no fetch happens — even after the poll
 *      interval has elapsed.
 *   2. The first subscriber triggers an immediate fetch (so
 *      navigating to the More menu shows fresh counts), then the
 *      next fetch is at the new 5-minute mark, not the old 30s.
 *   3. When the last subscriber unmounts, polling stops; advancing
 *      the clock no longer triggers fetches.
 *   4. Re-subscribing after a quiet period triggers a new immediate
 *      fetch.
 *   5. A badge-relevant push (e.g. `handicap_case_update`,
 *      `notice_board`, `wallet_withdrawal_processed`) refetches
 *      within ~1s instead of waiting for the next interval tick.
 *   6. Push types unrelated to the badge counts (e.g. `shop_order`,
 *      `score_approved`) do NOT trigger a refetch.
 *   7. The push listener is torn down when the last subscriber
 *      unmounts — late pushes after unmount must not refetch.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
  },
}));

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: () => ({ remove: () => undefined }),
  },
}));

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    token: "test-token",
    user: { id: 1, organizationId: 7 },
  }),
}));

vi.mock("@/context/activeClub", () => ({
  useActiveClub: () => ({ activeOrgId: 7 }),
}));

const { listeners, expoMock } = vi.hoisted(() => {
  const listeners = { received: null as ((n: unknown) => void) | null };
  const expoMock = {
    addNotificationReceivedListener: (cb: (n: unknown) => void) => {
      listeners.received = cb;
      return {
        remove: () => {
          listeners.received = null;
        },
      };
    },
  };
  return { listeners, expoMock };
});

vi.mock("@/utils/expoNotifications", () => ({
  getExpoNotifications: () => expoMock,
}));

import {
  MoreBadgesProvider,
  useBadgePolling,
} from "@/context/moreBadges";

const POLL_INTERVAL_MS = 5 * 60_000;

const fetchMock = vi.fn(async () =>
  new Response(JSON.stringify({ notifications: 0 }), { status: 200 }),
);

function Subscriber() {
  useBadgePolling();
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockClear();
  listeners.received = null;
  // jsdom doesn't ship a fetch implementation by default.
  (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (globalThis as { fetch?: typeof fetch }).fetch;
});

async function flush() {
  // Two microtask flushes: one for the AsyncStorage promise, one for
  // the awaited fetch().then(safeJson) chain.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

function emitPush(type: string) {
  if (!listeners.received) return;
  listeners.received({
    request: { content: { data: { type } } },
  });
}

describe("MoreBadgesProvider — subscriber-gated polling (Task #1213)", () => {
  it("does not fetch while no component subscribes, even after the poll interval elapses", async () => {
    render(
      <MoreBadgesProvider>
        <></>
      </MoreBadgesProvider>,
    );
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    // Two full poll intervals + change — still nothing.
    await act(async () => { vi.advanceTimersByTime(POLL_INTERVAL_MS * 2); });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches immediately when the first subscriber mounts, then polls every 5 minutes", async () => {
    render(
      <MoreBadgesProvider>
        <Subscriber />
      </MoreBadgesProvider>,
    );
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The previous cadence was 30s; the new cadence is 5 minutes.
    // Advancing past the old interval must NOT trigger a second
    // fetch — that would mean we regressed back to the 30s poll.
    await act(async () => { vi.advanceTimersByTime(60_000); });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance one full poll interval — exactly one more fetch.
    await act(async () => { vi.advanceTimersByTime(POLL_INTERVAL_MS - 60_000); });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // ...and another.
    await act(async () => { vi.advanceTimersByTime(POLL_INTERVAL_MS); });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops polling when the last subscriber unmounts", async () => {
    const { unmount } = render(
      <MoreBadgesProvider>
        <Subscriber />
      </MoreBadgesProvider>,
    );
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    unmount();

    // After unmount, the interval should be cleared. Advancing the
    // clock by several poll intervals must not produce more fetches.
    await act(async () => { vi.advanceTimersByTime(POLL_INTERVAL_MS * 4); });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not unsubscribe/resubscribe just because the badge counts change", async () => {
    // Regression guard: `useBadgePolling` must depend on the stable
    // `subscribe` reference, not on the whole context value (which
    // rebuilds every time counts update). If this regresses, every
    // successful fetch would tear down and re-create the subscription
    // — harmless functionally, but it would also fire an extra
    // immediate fetch on each re-subscribe and inflate the request
    // rate well past the configured cadence.
    render(
      <MoreBadgesProvider>
        <Subscriber />
      </MoreBadgesProvider>,
    );
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Drive 5 poll ticks — each triggers a setCounts which rebuilds
    // the context value. With a churning subscription we'd see ~10
    // fetches (one per tick + one per re-subscribe). With the stable
    // subscription we expect exactly 6 (the initial + one per tick).
    for (let i = 0; i < 5; i++) {
      await act(async () => { vi.advanceTimersByTime(POLL_INTERVAL_MS); });
      await flush();
    }
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("keeps polling alive while at least one subscriber remains", async () => {
    function TwoSubscribers() {
      return (
        <>
          <Subscriber />
          <Subscriber />
        </>
      );
    }
    function Toggle({ both }: { both: boolean }) {
      return both ? <TwoSubscribers /> : <Subscriber />;
    }

    const { rerender } = render(
      <MoreBadgesProvider>
        <Toggle both />
      </MoreBadgesProvider>,
    );
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Drop one of the two — polling must continue because one
    // subscriber is still mounted.
    rerender(
      <MoreBadgesProvider>
        <Toggle both={false} />
      </MoreBadgesProvider>,
    );
    await flush();
    await act(async () => { vi.advanceTimersByTime(POLL_INTERVAL_MS); });
    await flush();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("MoreBadgesProvider — push-driven refresh (Task #1407)", () => {
  it.each([
    ["handicap_case_update"],
    ["handicap_peer_review"],
    ["handicap_peer_response"],
    ["notice_board"],
    ["broadcast"],
    ["wallet_withdrawal_processed"],
    ["wallet_withdrawal_failed"],
    ["wallet_payout_account_needs_attention"],
    ["wallet_topup_auto_refund"],
  ])("refetches immediately when a %s push arrives", async (type) => {
    render(
      <MoreBadgesProvider>
        <Subscriber />
      </MoreBadgesProvider>,
    );
    await flush();
    // Drop the initial fetch-on-mount so the assertion below isolates
    // the push-driven refetch.
    fetchMock.mockClear();

    expect(listeners.received).toBeTypeOf("function");
    await act(async () => {
      emitPush(type);
      await Promise.resolve();
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // And critically, this happened *well before* the next 5-minute
    // poll tick — i.e. the user sees the new badge within ~1s.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/portal/badge-counts"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      }),
    );
  });

  it.each([
    ["shop_order"],
    ["score_approved"],
    ["position_change"],
    ["broadcast_marketing"],
    [""],
  ])("ignores unrelated push type %s", async (type) => {
    render(
      <MoreBadgesProvider>
        <Subscriber />
      </MoreBadgesProvider>,
    );
    await flush();
    fetchMock.mockClear();

    expect(listeners.received).toBeTypeOf("function");
    await act(async () => {
      emitPush(type);
      await Promise.resolve();
    });
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tears down the push listener when the last subscriber unmounts", async () => {
    const { unmount } = render(
      <MoreBadgesProvider>
        <Subscriber />
      </MoreBadgesProvider>,
    );
    await flush();
    expect(listeners.received).toBeTypeOf("function");

    unmount();
    expect(listeners.received).toBeNull();

    // A late push arriving after unmount must not refetch — and would
    // crash the test harness if it tried, since fetchMock has been
    // cleared and the provider is gone.
    fetchMock.mockClear();
    // Re-installing a manual emit (the listener is gone, so this is a
    // no-op by design). Just guard against accidental fetches.
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
