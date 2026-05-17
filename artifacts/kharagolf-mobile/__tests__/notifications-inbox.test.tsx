/**
 * UI tests: mobile handicap-committee notifications inbox (Task #760 — covers
 * `app/(tabs)/notifications.tsx`).
 *
 * Verifies:
 *   1. The loading spinner renders while the GET /handicap/notifications is
 *      in flight.
 *   2. Empty state copy renders when the server returns an empty list.
 *   3. Notification rows render with title, body, event tag, and unread dot.
 *   4. Tapping an unread item POSTs to /:id/read AND routes to
 *      /handicap-profile.
 *   5. The "Mark all" button POSTs to /read-all, clears the unread badge, and
 *      becomes disabled.
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { routerMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), back: vi.fn(), replace: vi.fn(), canGoBack: () => true },
}));

vi.mock("expo-router", () => ({
  router: routerMock,
  Stack: { Screen: () => null },
  useFocusEffect: () => undefined,
}));

const { unreadValue } = vi.hoisted(() => ({
  unreadValue: {
    unreadCount: 0,
    lastSeenAt: 0,
    setUnreadCount: () => undefined,
    markAllRead: async () => undefined,
    notifUnreadCount: 0,
    setNotifUnreadCount: () => undefined,
  },
}));
vi.mock("@/context/unread", () => ({
  useUnread: () => unreadValue,
}));

vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const { alertMock } = vi.hoisted(() => ({
  alertMock: vi.fn(),
}));
vi.mock("react-native", async () => {
  const RN = await vi.importActual<typeof import("react-native")>("react-native");
  return { ...RN, Alert: { alert: alertMock } };
});

vi.mock("@/context/auth", () => ({
  useAuth: () => ({ token: "test-token", user: { id: 1 }, isAuthenticated: true, isLoading: false }),
}));

vi.mock("@/context/activeClub", () => ({
  useActiveClub: () => ({
    activeOrgId: 7,
    activeClub: { id: 7, name: "KharaGolf Club" },
    clubs: [],
    switchClub: async () => undefined,
    isSuperAdmin: false,
    canSwitchClub: false,
  }),
}));

vi.mock("@/context/moreBadges", () => ({
  useMoreBadges: () => ({
    counts: {},
    total: 0,
    refresh: () => undefined,
    markFeedSeen: async () => undefined,
    registerViewer: () => () => undefined,
  }),
}));

vi.mock("@/i18n", () => ({
  getLocale: () => "en-US",
}));

import NotificationsScreen from "../app/(tabs)/notifications";

interface NotificationItem {
  id: number;
  caseId: number;
  organizationId: number;
  orgName: string | null;
  event: string;
  title: string;
  body: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
  readAt: string | null;
  caseStatus: string | null;
  caseKind: string | null;
  deepLink: string;
}

interface ListResponse {
  unreadCount: number;
  items: NotificationItem[];
  nextCursor?: number | null;
}

function makeItem(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 1,
    caseId: 100,
    organizationId: 7,
    orgName: "KharaGolf Club",
    event: "opened",
    title: "Handicap review opened",
    body: "Committee opened a review on your last round.",
    payload: null,
    createdAt: "2026-04-01T10:00:00Z",
    readAt: null,
    caseStatus: "open",
    caseKind: "score_review",
    deepLink: "/handicap-profile",
    ...overrides,
  };
}

let serverResponse: ListResponse = { unreadCount: 0, items: [], nextCursor: null };
// Optional per-cursor pages keyed by the `before` query parameter. When set,
// the fetch mock looks up the requested page here instead of returning the
// default `serverResponse`. This lets tests assert lazy-loading behavior.
let pagedResponses: Record<string, ListResponse> = {};
let getResolver: (() => void) | null = null;
let nextGetIsPending = false;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();

  if (url.includes("/handicap/notifications/read-all") && method === "POST") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  const readMatch = url.match(/\/handicap\/notifications\/(\d+)\/read$/);
  if (readMatch && method === "POST") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/handicap/notifications") && method === "GET") {
    if (nextGetIsPending) {
      await new Promise<void>((resolve) => { getResolver = resolve; });
    }
    const beforeMatch = url.match(/[?&]before=(\d+)/);
    const beforeKey = beforeMatch ? beforeMatch[1] : "";
    const body = pagedResponses[beforeKey] ?? serverResponse;
    return new Response(JSON.stringify(body), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected fetch: ${method} ${url}`);
});

beforeEach(() => {
  serverResponse = { unreadCount: 0, items: [], nextCursor: null };
  pagedResponses = {};
  nextGetIsPending = false;
  getResolver = null;
  fetchMock.mockClear();
  routerMock.push.mockClear();
  routerMock.back.mockClear();
  alertMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NotificationsScreen — handicap committee inbox (Task #760)", () => {
  it("shows a loading spinner while the initial GET is pending", async () => {
    nextGetIsPending = true;
    const { container } = render(<NotificationsScreen />);
    // ActivityIndicator on RN-Web exposes role="progressbar".
    await waitFor(() => {
      expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    });
    // Resolve the pending GET so the screen finishes mounting cleanly.
    await act(async () => { getResolver?.(); });
  });

  it("renders the empty state when the server returns no notifications", async () => {
    serverResponse = { unreadCount: 0, items: [] };
    render(<NotificationsScreen />);
    expect(await screen.findByText("No notifications")).toBeInTheDocument();
    expect(
      screen.getByText(/When a handicap review case is opened.+it will show up here/i),
    ).toBeInTheDocument();
    // No unread badge when count is zero.
    expect(screen.queryByText(/\d+ new$/)).toBeNull();
  });

  it("renders notification rows with title, body, tag, and the unread badge", async () => {
    serverResponse = {
      unreadCount: 2,
      items: [
        makeItem({ id: 11, title: "Review opened", body: "Body A", event: "opened", readAt: null }),
        makeItem({
          id: 12, title: "Decision recorded", body: "Body B",
          event: "decided", readAt: "2026-04-02T10:00:00Z",
        }),
      ],
    };
    render(<NotificationsScreen />);
    expect(await screen.findByText("Review opened")).toBeInTheDocument();
    // "Decision recorded" appears twice: once as the row title and once as the
    // event tag label.
    expect(screen.getAllByText("Decision recorded").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Body A")).toBeInTheDocument();
    expect(screen.getByText("Body B")).toBeInTheDocument();
    // Event tag labels
    expect(screen.getByText("Case opened")).toBeInTheDocument();
    // Unread badge shows the count
    expect(screen.getByText("2 new")).toBeInTheDocument();
  });

  it("tapping an unread item marks it read AND deep-links to /handicap-profile", async () => {
    serverResponse = {
      unreadCount: 1,
      items: [makeItem({ id: 99, title: "Open this one", readAt: null })],
    };
    render(<NotificationsScreen />);
    const title = await screen.findByText("Open this one");

    await act(async () => {
      fireEvent.click(title);
    });

    await waitFor(() => {
      const readCalls = fetchMock.mock.calls.filter(
        (c) => String(c[0]).endsWith("/handicap/notifications/99/read")
          && (c[1]?.method ?? "GET").toUpperCase() === "POST",
      );
      expect(readCalls.length).toBe(1);
    });

    expect(routerMock.push).toHaveBeenCalledWith("/handicap-profile");
  });

  it("tapping an already-read item routes to /handicap-profile WITHOUT calling /:id/read", async () => {
    serverResponse = {
      unreadCount: 0,
      items: [makeItem({ id: 55, title: "Already read", readAt: "2026-04-02T10:00:00Z" })],
    };
    render(<NotificationsScreen />);
    const title = await screen.findByText("Already read");

    await act(async () => {
      fireEvent.click(title);
    });

    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith("/handicap-profile");
    });
    const readCalls = fetchMock.mock.calls.filter(
      (c) => /\/handicap\/notifications\/\d+\/read$/.test(String(c[0])),
    );
    expect(readCalls.length).toBe(0);
  });

  it("renders the peer-response committee section and routes peer_responded items to the case detail screen", async () => {
    serverResponse = {
      unreadCount: 1,
      items: [
        makeItem({
          id: 77,
          caseId: 314,
          organizationId: 9,
          event: "peer_responded",
          title: "New peer response — Jane",
          body: "Jane confirmed the score.",
          readAt: null,
          deepLink: "/handicap-committee?caseId=314",
        }),
      ],
    };
    render(<NotificationsScreen />);

    expect(await screen.findByText("New peer responses")).toBeInTheDocument();
    expect(screen.getByText("1 unread")).toBeInTheDocument();
    expect(screen.getByText("Peer response")).toBeInTheDocument();

    const title = await screen.findByText("New peer response — Jane");
    await act(async () => {
      fireEvent.click(title);
    });

    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith({
        pathname: "/handicap-committee/case/[id]",
        params: { id: "314", orgId: "9" },
      });
    });
    // It also marked the item read.
    const readCalls = fetchMock.mock.calls.filter(
      (c) => String(c[0]).endsWith("/handicap/notifications/77/read")
        && (c[1]?.method ?? "GET").toUpperCase() === "POST",
    );
    expect(readCalls.length).toBe(1);
  });

  it("requests a small first page (limit=25) instead of downloading the entire backlog", async () => {
    serverResponse = { unreadCount: 0, items: [], nextCursor: null };
    render(<NotificationsScreen />);
    await screen.findByText("No notifications");
    const inboxGets = fetchMock.mock.calls.filter(
      (c) => /\/handicap\/notifications(\?|$)/.test(String(c[0]))
        && (c[1]?.method ?? "GET").toUpperCase() === "GET",
    );
    expect(inboxGets.length).toBeGreaterThanOrEqual(1);
    // The first-page request must scope itself to a small page so a heavily-
    // used committee inbox doesn't pay for the full backlog on first render.
    expect(String(inboxGets[0][0])).toMatch(/[?&]limit=25(?:&|$)/);
    // It does NOT include a `before` cursor on the first page.
    expect(String(inboxGets[0][0])).not.toMatch(/[?&]before=/);
  });

  it("lazily loads older items when the user scrolls near the bottom", async () => {
    serverResponse = {
      unreadCount: 1,
      items: [
        makeItem({ id: 30, title: "Newest A", readAt: null }),
        makeItem({ id: 29, title: "Newer B", readAt: "2026-04-02T10:00:00Z" }),
      ],
      nextCursor: 29,
    };
    pagedResponses = {
      "29": {
        unreadCount: 1,
        items: [
          makeItem({ id: 28, title: "Older C", readAt: "2026-04-02T10:00:00Z" }),
          makeItem({ id: 27, title: "Older D", readAt: "2026-04-02T10:00:00Z" }),
        ],
        nextCursor: null,
      },
    };
    render(<NotificationsScreen />);
    // Initial page rendered.
    await screen.findByText("Newest A");
    await screen.findByText("Newer B");
    // Older items are NOT fetched until the user scrolls down.
    expect(screen.queryByText("Older C")).toBeNull();

    // The ScrollView root is tagged with testID="notifications-scroll".
    // react-native-web translates onScroll into a DOM scroll event on this
    // node. We mock the DOM scroll-geometry properties (which react-native-
    // web reads to build SyntheticEvent.nativeEvent) so the handler sees a
    // near-bottom scroll position.
    const scrollContainer = screen.getByTestId("notifications-scroll");
    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 9000 });
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 9200 });
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(scrollContainer, "scrollLeft", { configurable: true, value: 0 });
    Object.defineProperty(scrollContainer, "scrollWidth", { configurable: true, value: 0 });
    Object.defineProperty(scrollContainer, "clientWidth", { configurable: true, value: 0 });
    await act(async () => {
      fireEvent.scroll(scrollContainer);
    });

    // Older items now show up.
    await screen.findByText("Older C");
    await screen.findByText("Older D");
    // The lazy-load request used the cursor returned by the first page.
    const pageCalls = fetchMock.mock.calls.filter((c) => {
      const u = String(c[0]);
      return /\/handicap\/notifications/.test(u)
        && /[?&]before=29(?:&|$)/.test(u)
        && (c[1]?.method ?? "GET").toUpperCase() === "GET";
    });
    expect(pageCalls.length).toBe(1);
  });

  it("'Mark all' POSTs to /read-all, clears the unread badge, and disables the button", async () => {
    serverResponse = {
      unreadCount: 2,
      items: [
        makeItem({ id: 21, title: "First", readAt: null }),
        makeItem({ id: 22, title: "Second", readAt: null }),
      ],
    };
    render(<NotificationsScreen />);
    expect(await screen.findByText("2 new")).toBeInTheDocument();

    const markAllBtn = screen.getByLabelText("Mark all read");
    // Initially enabled because there are unread items.
    expect(markAllBtn.getAttribute("aria-disabled")).not.toBe("true");
    await act(async () => {
      fireEvent.click(markAllBtn);
    });

    await waitFor(() => {
      const readAllCalls = fetchMock.mock.calls.filter(
        (c) => String(c[0]).endsWith("/handicap/notifications/read-all")
          && (c[1]?.method ?? "GET").toUpperCase() === "POST",
      );
      expect(readAllCalls.length).toBe(1);
    });

    // Unread badge is gone.
    await waitFor(() => {
      expect(screen.queryByText(/\d+ new$/)).toBeNull();
    });
    // The Mark-all button is now disabled (no unread items remain).
    await waitFor(() => {
      const refreshedBtn = screen.getByLabelText("Mark all read");
      expect(refreshedBtn.getAttribute("aria-disabled")).toBe("true");
    });
    // No alert was shown (the read-all succeeded).
    expect(alertMock).not.toHaveBeenCalled();
  });
});
