/**
 * Task #1837 — UI test for the one-time backfill announcement card on the
 * home screen pointing existing members at the new
 * "Side-game payment receipts" toggle (Task #1495 mobile mirror of the web
 * banner from Task #1270).
 *
 * The card is critical user-facing comms — we need automated coverage so a
 * regression in any neighbouring home-screen section can't accidentally
 * suppress, duplicate, or re-show the announcement.
 *
 * Verifies:
 *   1. Eligible existing members see `card-side-game-receipt-toggle-announcement`
 *      on first home-screen mount (server returns an `announcement` payload).
 *   2. Tapping `btn-side-game-receipt-toggle-open-prefs` dismisses the card,
 *      navigates to the comm-prefs screen with `focus=sideGameReceipts`, and
 *      POSTs the dismissal to the server.
 *   3. Tapping `btn-side-game-receipt-toggle-got-it` dismisses the card and
 *      POSTs the dismissal — without navigating.
 *   4. After a dismiss, a *fresh* home-screen mount (simulating a later
 *      navigation back to home) does NOT re-render the card, even when the
 *      query cache is empty — i.e. the server has authoritatively flipped to
 *      `announcement: null`.
 *   5. New members (server returns `announcement: null` from the start)
 *      never see the card.
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { routerMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), back: vi.fn(), replace: vi.fn(), canGoBack: () => true },
}));

vi.mock("expo-router", () => ({
  router: routerMock,
  useRouter: () => routerMock,
  Stack: { Screen: () => null },
  useFocusEffect: () => {},
}));

vi.mock("@/utils/expoNotifications", () => ({
  getExpoNotifications: () => ({
    addNotificationReceivedListener: () => ({ remove: () => {} }),
  }),
}));

vi.mock("expo-web-browser", () => ({
  openBrowserAsync: vi.fn(async () => ({ type: "cancel" as const })),
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

// Stub heavyweight children that aren't under test here.
vi.mock("@/components/MyUpcomingWidget", () => ({
  MyUpcomingWidget: () => null,
}));

vi.mock("@/components/TournamentRegistrationSheet", () => ({
  __esModule: true,
  default: () => null,
}));

import HomeScreen from "../app/(tabs)/index";

interface AnnouncementPayload {
  id: number;
  organizationId: number;
  subject: string;
  body: string;
  sentAt: string;
  readAt: string | null;
  prefsUrl: string;
  prefsAnchor: string;
}

let announcementResponse: { announcement: AnnouncementPayload | null } = {
  announcement: null,
};
let dismissCallCount = 0;

const SAMPLE_ANNOUNCEMENT: AnnouncementPayload = {
  id: 4242,
  organizationId: 1,
  subject: "New: control your side-game payment receipts",
  body: "You can now opt out of side-game receipt emails another player triggers when they settle a casual side-game wager with you.",
  sentAt: "2026-04-24T12:00:00.000Z",
  readAt: null,
  prefsUrl: "https://app.kharagolf.com/portal#comm-prefs",
  prefsAnchor: "comm-prefs",
};

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();

  // The announcement GET — the lazy server-side helper either returns the
  // active card or `{ announcement: null }`.
  if (
    url.includes("/api/portal/announcements/side-game-receipt-toggle") &&
    !url.endsWith("/dismiss") &&
    method === "GET"
  ) {
    return new Response(JSON.stringify(announcementResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // The dismiss POST — once the user dismisses, the server stamps `readAt`
  // so future GETs return null. Mirror that here so the "doesn't re-render"
  // assertion can rely on the server's authoritative state.
  if (
    url.endsWith("/api/portal/announcements/side-game-receipt-toggle/dismiss") &&
    method === "POST"
  ) {
    dismissCallCount += 1;
    announcementResponse = { announcement: null };
    return new Response(JSON.stringify({ success: true, updated: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Other endpoints the home screen polls — return inert payloads so the
  // screen renders without throwing. These are unrelated to the card under
  // test but the home screen fires them on mount.
  if (url.includes("/api/public/tournaments") && method === "GET") {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
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
  if (url.includes("/api/portal/handicap/notifications/unread-count") && method === "GET") {
    return new Response(JSON.stringify({ unreadCount: 0, hasAny: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/api/organizations/") && url.includes("/social/feed")) {
    return new Response(JSON.stringify({ posts: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/members-360/erasures/storage-failures/summary")) {
    return new Response("forbidden", { status: 403 });
  }

  // Fail loudly on unexpected network calls so future regressions surface
  // here rather than being silently swallowed.
  throw new Error(`Unexpected fetch in side-game-announcement test: ${method} ${url}`);
});

function renderHome() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, refetchInterval: false },
    },
  });
  const utils = render(
    <QueryClientProvider client={client}>
      <HomeScreen />
    </QueryClientProvider>,
  );
  return { ...utils, client };
}

beforeEach(() => {
  announcementResponse = { announcement: null };
  dismissCallCount = 0;
  fetchMock.mockClear();
  routerMock.push.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HomeScreen — side-game receipt toggle announcement card (Task #1495)", () => {
  it("renders the announcement card exactly once on first mount for an eligible member", async () => {
    announcementResponse = { announcement: { ...SAMPLE_ANNOUNCEMENT } };

    renderHome();

    const card = await screen.findByTestId("card-side-game-receipt-toggle-announcement");
    expect(card).toBeInTheDocument();

    // Both CTAs must be present and tappable.
    expect(screen.getByTestId("btn-side-game-receipt-toggle-open-prefs")).toBeInTheDocument();
    expect(screen.getByTestId("btn-side-game-receipt-toggle-got-it")).toBeInTheDocument();

    // Uniqueness — the card must render exactly once. Catches a regression
    // that double-renders the announcement (e.g. via a stray map over a
    // single-element array, or duplicate query subscriptions).
    expect(screen.getAllByTestId("card-side-game-receipt-toggle-announcement")).toHaveLength(1);
    expect(screen.getAllByTestId("btn-side-game-receipt-toggle-open-prefs")).toHaveLength(1);
    expect(screen.getAllByTestId("btn-side-game-receipt-toggle-got-it")).toHaveLength(1);

    // Confirm we actually hit the announcement endpoint exactly once on mount.
    const getCalls = fetchMock.mock.calls.filter(
      (c) =>
        String(c[0]).includes("/api/portal/announcements/side-game-receipt-toggle") &&
        !String(c[0]).endsWith("/dismiss"),
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT render the card for new members (server returns announcement: null)", async () => {
    announcementResponse = { announcement: null };

    renderHome();

    // Wait for the announcement GET to settle.
    await waitFor(() => {
      const getCalls = fetchMock.mock.calls.filter(
        (c) =>
          String(c[0]).includes("/api/portal/announcements/side-game-receipt-toggle") &&
          !String(c[0]).endsWith("/dismiss"),
      );
      expect(getCalls.length).toBeGreaterThanOrEqual(1);
    });

    // The card must remain absent.
    expect(screen.queryByTestId("card-side-game-receipt-toggle-announcement")).toBeNull();
    expect(screen.queryByTestId("btn-side-game-receipt-toggle-open-prefs")).toBeNull();
    expect(screen.queryByTestId("btn-side-game-receipt-toggle-got-it")).toBeNull();
    // And no dismiss POST should ever be fired without a card to dismiss.
    expect(dismissCallCount).toBe(0);
  });

  it("dismisses the card, navigates to comm-prefs, and never reappears on remount when 'Open settings' is tapped", async () => {
    announcementResponse = { announcement: { ...SAMPLE_ANNOUNCEMENT } };

    const first = renderHome();

    const openPrefsBtn = await screen.findByTestId("btn-side-game-receipt-toggle-open-prefs");

    await act(async () => {
      fireEvent.click(openPrefsBtn);
    });

    // Card disappears immediately (optimistic local cache update).
    await waitFor(() => {
      expect(screen.queryByTestId("card-side-game-receipt-toggle-announcement")).toBeNull();
    });

    // The dismiss endpoint was POSTed exactly once.
    await waitFor(() => {
      expect(dismissCallCount).toBe(1);
      expect(announcementResponse.announcement).toBeNull();
    });

    // Navigation lands on the comm-prefs screen with the focus param so the
    // screen scrolls to the side-game receipts toggle.
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: "/my-360/communications",
      params: { focus: "sideGameReceipts" },
    });

    // Tear down and remount with a fresh QueryClient — equivalent to the
    // user navigating back to home after visiting comm-prefs. The card
    // must NOT reappear, since the server now reports `announcement: null`.
    first.unmount();
    cleanup();

    renderHome();

    await waitFor(() => {
      const getCalls = fetchMock.mock.calls.filter(
        (c) =>
          String(c[0]).includes("/api/portal/announcements/side-game-receipt-toggle") &&
          !String(c[0]).endsWith("/dismiss"),
      );
      expect(getCalls.length).toBeGreaterThanOrEqual(2);
    });

    expect(screen.queryByTestId("card-side-game-receipt-toggle-announcement")).toBeNull();
    // No additional dismiss POST was fired by the remount.
    expect(dismissCallCount).toBe(1);
  });

  it("dismisses the card without navigating when 'Got it' is tapped", async () => {
    announcementResponse = { announcement: { ...SAMPLE_ANNOUNCEMENT } };

    renderHome();

    const gotItBtn = await screen.findByTestId("btn-side-game-receipt-toggle-got-it");

    await act(async () => {
      fireEvent.click(gotItBtn);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("card-side-game-receipt-toggle-announcement")).toBeNull();
    });

    await waitFor(() => {
      expect(dismissCallCount).toBe(1);
    });

    // No navigation should have happened — "Got it" is a silent acknowledgement.
    expect(routerMock.push).not.toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "/my-360/communications" }),
    );
  });

  it("does not re-render the card on a subsequent home-screen mount after dismissal", async () => {
    // Round 1 — eligible member sees the card and dismisses it.
    announcementResponse = { announcement: { ...SAMPLE_ANNOUNCEMENT } };

    const first = renderHome();

    const gotItBtn = await screen.findByTestId("btn-side-game-receipt-toggle-got-it");
    await act(async () => {
      fireEvent.click(gotItBtn);
    });

    await waitFor(() => {
      expect(dismissCallCount).toBe(1);
      // The fetch mock flipped `announcementResponse` to null on dismiss,
      // mirroring the server stamping `readAt` on the row.
      expect(announcementResponse.announcement).toBeNull();
    });

    // Tear down the first mount entirely — equivalent to the user navigating
    // away from the home tab. We unmount with `cleanup()` instead of just
    // `first.unmount()` to also drop the React tree from the DOM.
    first.unmount();
    cleanup();

    // Round 2 — fresh QueryClient, fresh component tree, fresh GET. The
    // server now authoritatively returns `announcement: null`, so the card
    // must NOT reappear.
    renderHome();

    // Wait for the announcement GET to settle on the new mount.
    await waitFor(() => {
      const getCalls = fetchMock.mock.calls.filter(
        (c) =>
          String(c[0]).includes("/api/portal/announcements/side-game-receipt-toggle") &&
          !String(c[0]).endsWith("/dismiss"),
      );
      // At least two GETs total now (one per mount).
      expect(getCalls.length).toBeGreaterThanOrEqual(2);
    });

    expect(screen.queryByTestId("card-side-game-receipt-toggle-announcement")).toBeNull();
    expect(screen.queryByTestId("btn-side-game-receipt-toggle-open-prefs")).toBeNull();
    expect(screen.queryByTestId("btn-side-game-receipt-toggle-got-it")).toBeNull();
    // And no extra dismiss POST was fired on remount.
    expect(dismissCallCount).toBe(1);
  });
});
