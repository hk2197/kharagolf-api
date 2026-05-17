/**
 * UI test: peer-review invitation seen-state on the Updates screen
 * (Task #745 / #894).
 *
 * Verifies that:
 *   - The PeerReviewInviteCard renders an unread dot when `seenAt` is null.
 *   - Tapping the card hides the unread dot AND fires exactly one POST to
 *     /api/portal/handicap/peer-invites/:id/seen.
 *   - When the card is already seen, tapping it does NOT fire the seen request.
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { routerMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), back: vi.fn(), replace: vi.fn() },
}));

vi.mock("expo-router", () => ({
  router: routerMock,
  useRouter: () => routerMock,
  useFocusEffect: () => undefined,
  Stack: { Screen: () => null },
}));

vi.mock("expo-notifications", () => ({
  addNotificationReceivedListener: () => ({ remove: () => undefined }),
}));

vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (vars && typeof vars === "object") {
        let out = key;
        for (const [k, v] of Object.entries(vars)) out += ` ${k}=${String(v)}`;
        return out;
      }
      return key;
    },
  }),
}));

const { authValue, unreadValue } = vi.hoisted(() => {
  return {
    authValue: {
      token: "test-token",
      user: { id: 42, organizationId: 7 },
      isAuthenticated: true,
      isLoading: false,
    },
    unreadValue: {
      lastSeenAt: 0,
      setUnreadCount: () => undefined,
      markAllRead: async () => undefined,
    },
  };
});

vi.mock("@/context/auth", () => ({
  useAuth: () => authValue,
}));

vi.mock("@/context/unread", () => ({
  useUnread: () => unreadValue,
}));

// UpdatesScreen calls `useMoreBadges()` (to refresh the More-menu badge
// aggregator after a focus event); the real hook throws when there is no
// `MoreBadgesProvider` mounted above it. We don't care what those badge
// counts are in this test, so stub the context with no-op accessors —
// matches the pattern used by `notifications-inbox.test.tsx` etc.
vi.mock("@/context/moreBadges", () => ({
  useMoreBadges: () => ({
    counts: { notifications: 0, feed: 0, updates: 0, wallet: 0 },
    total: 0,
    refresh: () => undefined,
    markFeedSeen: async () => undefined,
    subscribe: () => () => undefined,
  }),
  useBadgePolling: () => undefined,
  MoreBadgesProvider: ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

import UpdatesScreen from "../app/(tabs)/updates";

interface PeerInviteFixture {
  id: number;
  token: string;
  invitedAt: string;
  seenAt: string | null;
  expiresAt: string | null;
  caseId: number;
  caseKind: string;
  caseStatus: string;
  periodLabel: string | null;
  subjectName: string | null;
  orgName: string | null;
}

function makeInvite(overrides: Partial<PeerInviteFixture> = {}): PeerInviteFixture {
  return {
    id: 501,
    token: "tok-501",
    invitedAt: "2026-04-20T10:00:00Z",
    seenAt: null,
    expiresAt: "2026-05-04T10:00:00Z",
    caseId: 9001,
    caseKind: "anomalous",
    caseStatus: "open",
    periodLabel: "2026-Q1",
    subjectName: "Alex Subject",
    orgName: "KharaGolf Club",
    ...overrides,
  };
}

let peerInvitesResponse: PeerInviteFixture[] = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();

  if (url.includes("/portal/handicap/my-peer-invites") && method === "GET") {
    return new Response(JSON.stringify(peerInvitesResponse), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  if (/\/portal\/handicap\/peer-invites\/\d+\/seen$/.test(url) && method === "POST") {
    return new Response(JSON.stringify({ success: true, updated: 1 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/portal/my-tournaments") && method === "GET") {
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.includes("/portal/feed") && method === "GET") {
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.includes("/notice-board/feed") && method === "GET") {
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }
  // Anything else (e.g. announcement read fan-out) is a harmless no-op for this test.
  return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
});

function seenCalls(): unknown[][] {
  return fetchMock.mock.calls.filter(
    (c) =>
      /\/portal\/handicap\/peer-invites\/\d+\/seen$/.test(String(c[0])) &&
      ((c[1] as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "POST",
  );
}

beforeEach(() => {
  peerInvitesResponse = [];
  fetchMock.mockClear();
  routerMock.push.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("UpdatesScreen — peer-review invitation seen-state (Task #745 / #894)", () => {
  it("shows the unread dot, then hides it and fires exactly one /seen POST when the card is tapped", async () => {
    const invite = makeInvite({ id: 777, seenAt: null });
    peerInvitesResponse = [invite];

    render(<UpdatesScreen />);

    // Wait for the peer-review card to render with its unread dot.
    const card = await screen.findByTestId(`peer-invite-card-${invite.id}`);
    expect(screen.getByTestId(`peer-invite-unread-dot-${invite.id}`)).toBeInTheDocument();

    // Tap the card.
    await act(async () => {
      fireEvent.click(card);
    });

    // The seen endpoint must be hit exactly once.
    await waitFor(() => {
      const calls = seenCalls();
      expect(calls.length).toBe(1);
      expect(String(calls[0]![0])).toContain("/portal/handicap/peer-invites/777/seen");
    });

    // Unread dot must be gone now (optimistic update).
    await waitFor(() => {
      expect(screen.queryByTestId(`peer-invite-unread-dot-${invite.id}`)).toBeNull();
    });

    // Router was asked to navigate to the peer-review screen.
    expect(routerMock.push).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/peer-review/[token]",
        params: { token: invite.token },
      }),
    );

    // Tapping again must NOT fire a second /seen POST (already seen locally).
    fetchMock.mockClear();
    await act(async () => {
      fireEvent.click(card);
    });
    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledTimes(2);
    });
    expect(seenCalls().length).toBe(0);
  });

  it("does not fire a /seen POST when the card was already seen", async () => {
    const invite = makeInvite({ id: 808, seenAt: "2026-04-20T11:00:00Z" });
    peerInvitesResponse = [invite];
    render(<UpdatesScreen />);

    const card = await screen.findByTestId(`peer-invite-card-${invite.id}`);
    expect(screen.queryByTestId(`peer-invite-unread-dot-${invite.id}`)).toBeNull();
    fetchMock.mockClear();

    await act(async () => {
      fireEvent.click(card);
    });

    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledTimes(1);
    });
    expect(seenCalls().length).toBe(0);
  });
});
