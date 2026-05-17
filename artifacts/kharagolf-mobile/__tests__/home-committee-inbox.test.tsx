/**
 * UI tests: home-screen committee inbox entry (Task #1204 — covers the entry
 * added to `app/(tabs)/index.tsx` in Task #1043).
 *
 * Verifies:
 *   1. The entry (testID `home-committee-inbox-entry`) is hidden when the
 *      `/handicap/notifications` response contains no `peer_responded` items.
 *   2. The entry renders and the badge (testID `home-committee-inbox-badge`)
 *      shows the count of UNREAD `peer_responded` items.
 *   3. Tapping the entry navigates to `/(tabs)/notifications`.
 *   4. Re-focusing the screen (via the captured `useFocusEffect` callback)
 *      refetches `/handicap/notifications` and updates the badge count.
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { routerMock, focusCallbacks, pushListeners, expoNotificationsMock } = vi.hoisted(() => {
  const pushListeners: Array<(n: unknown) => void> = [];
  return {
    routerMock: { push: vi.fn(), back: vi.fn(), replace: vi.fn(), canGoBack: () => true },
    focusCallbacks: [] as Array<() => void | (() => void)>,
    pushListeners,
    expoNotificationsMock: {
      addNotificationReceivedListener: (cb: (n: unknown) => void) => {
        pushListeners.push(cb);
        return {
          remove: () => {
            const idx = pushListeners.indexOf(cb);
            if (idx >= 0) pushListeners.splice(idx, 1);
          },
        };
      },
    },
  };
});

vi.mock("expo-router", () => ({
  router: routerMock,
  useRouter: () => routerMock,
  Stack: { Screen: () => null },
  useFocusEffect: (cb: () => void | (() => void)) => {
    focusCallbacks.push(cb);
  },
}));

vi.mock("@/utils/expoNotifications", () => ({
  getExpoNotifications: () => expoNotificationsMock,
}));

vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (vars && "count" in vars) return `${key} ${(vars as { count: number }).count}`;
      return key;
    },
    i18n: { language: "en", changeLanguage: async () => {} },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("@/i18n", () => ({
  getLocale: () => "en-US",
}));

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { id: 1, organizationId: undefined, displayName: "Tester", username: "tester" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("@/context/activeClub", () => ({
  useActiveClub: () => ({ activeClub: null, activeOrgId: null, clubs: [] }),
}));

// The MyUpcomingWidget makes its own /my-upcoming call and is irrelevant to
// the committee-inbox entry under test. Stub it to keep the render minimal.
vi.mock("@/components/MyUpcomingWidget", () => ({
  MyUpcomingWidget: () => null,
}));

// The TournamentRegistrationSheet pulls in a large component tree and is
// never opened in these tests.
vi.mock("@/components/TournamentRegistrationSheet", () => ({
  __esModule: true,
  default: () => null,
}));

import HomeScreen from "../app/(tabs)/index";

interface PeerResponseSummary {
  unreadCount: number;
  hasAny: boolean;
}

let unreadCountResponse: PeerResponseSummary = { unreadCount: 0, hasAny: false };

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();

  // The home screen now hits the lightweight count endpoint, NOT the full
  // /handicap/notifications list. Surfacing the full-list path here lets us
  // assert (below) that the home screen never downloads the heavy payload.
  if (url.includes("/handicap/notifications/unread-count") && method === "GET") {
    // Sanity check: the home-screen badge is scoped to peer responses.
    expect(url).toContain("event=peer_responded");
    return new Response(JSON.stringify(unreadCountResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/handicap/notifications") && method === "GET") {
    throw new Error(
      `Home screen must not fetch the full /handicap/notifications list (Task #1396): ${url}`,
    );
  }
  // Public tournaments endpoint → return an empty list (no hero card).
  if (url.includes("/api/public/tournaments") && method === "GET") {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  // Portal endpoints used by other queries on the home screen.
  if (url.includes("/api/portal/my-tournaments") && method === "GET") {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/api/portal/my-leagues") && method === "GET") {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/api/portal/my-stats") && method === "GET") {
    return new Response(
      JSON.stringify({ tournamentsPlayed: 0, totalScores: 0, averageStrokes: null, bestRound: null }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  if (url.includes("/api/portal/wellness/today") && method === "GET") {
    return new Response(JSON.stringify({ today: null, recommendation: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  // Fail loudly on unexpected network calls so future regressions in the
  // home screen surface here rather than being silently swallowed.
  throw new Error(`Unexpected fetch in home-committee-inbox test: ${method} ${url}`);
});

function renderHome() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, refetchInterval: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <HomeScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  unreadCountResponse = { unreadCount: 0, hasAny: false };
  fetchMock.mockClear();
  routerMock.push.mockClear();
  focusCallbacks.length = 0;
  pushListeners.length = 0;
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HomeScreen — committee inbox entry (Task #1204)", () => {
  it("hides the entry when there are no peer-response items", async () => {
    // The lightweight count endpoint reports zero peer-response items at
    // all, so the home screen must hide the inbox entry entirely. Other
    // event types (e.g. `opened`, `decided`) are filtered server-side via
    // the `event=peer_responded` query param, so they cannot bleed in here.
    unreadCountResponse = { unreadCount: 0, hasAny: false };

    renderHome();

    // Wait until the count endpoint fetch has resolved at least once.
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes("/handicap/notifications/unread-count"),
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });

    // Give react-query a microtask to commit the state, then assert the entry
    // and badge are absent.
    await waitFor(() => {
      expect(screen.queryByTestId("home-committee-inbox-entry")).toBeNull();
      expect(screen.queryByTestId("home-committee-inbox-badge")).toBeNull();
    });
  });

  it("renders the entry and shows the unread peer-response count in the badge", async () => {
    // Server tally: 3 peer-response notifications exist, 2 of which are
    // unread. The lightweight endpoint returns just those two numbers.
    unreadCountResponse = { unreadCount: 2, hasAny: true };

    renderHome();

    const entry = await screen.findByTestId("home-committee-inbox-entry");
    expect(entry).toBeInTheDocument();

    const badge = await screen.findByTestId("home-committee-inbox-badge");
    expect(badge).toBeInTheDocument();
    // The badge contains the unread count — 2 unread peer responses out of 3.
    expect(badge.textContent).toBe("2");
  });

  it("tapping the entry navigates to /(tabs)/notifications", async () => {
    unreadCountResponse = { unreadCount: 1, hasAny: true };

    renderHome();

    const entry = await screen.findByTestId("home-committee-inbox-entry");
    await act(async () => {
      fireEvent.click(entry);
    });

    expect(routerMock.push).toHaveBeenCalledWith("/(tabs)/notifications");
  });

  it("re-focusing the screen refetches the count endpoint and updates the badge", async () => {
    // Initial: 1 unread peer response.
    unreadCountResponse = { unreadCount: 1, hasAny: true };

    renderHome();

    const badge = await screen.findByTestId("home-committee-inbox-badge");
    expect(badge.textContent).toBe("1");

    const initialNotifGets = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/handicap/notifications/unread-count"),
    ).length;
    expect(initialNotifGets).toBeGreaterThanOrEqual(1);

    // Simulate the inbox being read elsewhere AND new peer responses arriving:
    // the next focus should pull a fresh count of 3.
    unreadCountResponse = { unreadCount: 3, hasAny: true };

    // Fire the most recently captured useFocusEffect callback to simulate
    // the home screen regaining focus.
    expect(focusCallbacks.length).toBeGreaterThan(0);
    await act(async () => {
      const cb = focusCallbacks[focusCallbacks.length - 1];
      cb();
    });

    // The screen should refetch and the badge should update to 3.
    await waitFor(() => {
      const refreshed = screen.getByTestId("home-committee-inbox-badge");
      expect(refreshed.textContent).toBe("3");
    });

    // Verify that an additional GET to the count endpoint was issued when
    // the screen regained focus.
    const finalNotifGets = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/handicap/notifications/unread-count"),
    ).length;
    expect(finalNotifGets).toBeGreaterThan(initialNotifGets);
  });

  // Task #1686 — a `peer_responded` push that arrives while the home screen
  // is mounted (and therefore *not* refocused) should still invalidate the
  // count query so the badge updates within ~1s instead of waiting for the
  // user to navigate away and back.
  it("invalidates the count query when a peer_responded push arrives", async () => {
    unreadCountResponse = { unreadCount: 1, hasAny: true };

    renderHome();

    const badge = await screen.findByTestId("home-committee-inbox-badge");
    expect(badge.textContent).toBe("1");

    // Sanity check: the home screen subscribed to the push channel.
    expect(pushListeners.length).toBeGreaterThan(0);

    const beforePushGets = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/handicap/notifications/unread-count"),
    ).length;

    // A new peer response lands on the server; the next refetch should
    // pull a count of 4.
    unreadCountResponse = { unreadCount: 4, hasAny: true };

    // Fire the push listener directly — no focus event involved.
    await act(async () => {
      const listener = pushListeners[pushListeners.length - 1];
      listener({ request: { content: { data: { type: "peer_responded" } } } });
    });

    // The query was invalidated, so the count endpoint is hit again and
    // the badge surfaces the new total without waiting for refocus.
    await waitFor(() => {
      const refreshed = screen.getByTestId("home-committee-inbox-badge");
      expect(refreshed.textContent).toBe("4");
    });

    const afterPushGets = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/handicap/notifications/unread-count"),
    ).length;
    expect(afterPushGets).toBeGreaterThan(beforePushGets);
  });

  // Unrelated push types must NOT trigger a refetch — otherwise every
  // tournament/league/wallet push would needlessly hit the count endpoint
  // (the same negative-case guard the NotificationsPoller test enforces).
  it("ignores push types other than peer_responded", async () => {
    unreadCountResponse = { unreadCount: 1, hasAny: true };

    renderHome();

    await screen.findByTestId("home-committee-inbox-badge");
    expect(pushListeners.length).toBeGreaterThan(0);

    const beforePushGets = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/handicap/notifications/unread-count"),
    ).length;

    await act(async () => {
      const listener = pushListeners[pushListeners.length - 1];
      listener({ request: { content: { data: { type: "shop_order" } } } });
      // Give react-query a microtask to flush any (unwanted) refetch.
      await Promise.resolve();
    });

    const afterPushGets = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/handicap/notifications/unread-count"),
    ).length;
    expect(afterPushGets).toBe(beforePushGets);
  });
});
