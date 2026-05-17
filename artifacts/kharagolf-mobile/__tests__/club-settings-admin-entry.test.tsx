/**
 * Task #1687 — Coverage for the new admin-only "Club settings" screen
 * and its More-menu entry point.
 *
 * Pins three contracts:
 *   1. The More menu shows the "Club settings" row when the signed-in
 *      user has an admin role (super_admin / org_admin /
 *      tournament_director).
 *   2. The same row is hidden for non-admin users (e.g. plain `member`).
 *   3. The new club-settings screen renders the moved
 *      `TieBreakEmailOptOutsCard` panel using the active org id and
 *      auth token from context.
 *
 * Uses the same vitest + react-native-web harness as the rest of the
 * mobile e2e tier (see `moreBadges-polling-gated-e2e.test.tsx`).
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

let currentUserRole = "member";
const fetchMock = vi.fn(async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
  },
}));

vi.mock("react-native", async () => {
  const actual = await vi.importActual<typeof import("react-native")>("react-native");
  return {
    ...actual,
    AppState: {
      addEventListener: () => ({ remove: () => undefined }),
      currentState: "active",
    },
  };
});

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    token: "test-token",
    user: { id: 1, role: currentUserRole, organizationId: 7, username: "u" },
  }),
}));

vi.mock("@/context/activeClub", () => ({
  useActiveClub: () => ({
    activeOrgId: 7,
    activeClub: { id: 7, name: "Test Club", slug: "test", subscriptionTier: "pro" },
  }),
}));

vi.mock("@/context/unread", () => ({
  useUnread: () => ({
    notifUnreadCount: 0,
    unreadCount: 0,
    setNotifUnreadCount: () => undefined,
    refresh: () => undefined,
    markAllSeen: async () => undefined,
  }),
}));

// Stub the badge polling hook so the More menu can mount without an
// orchestrator provider; the gating contract under test is independent
// of badge counts.
vi.mock("@/context/moreBadges", () => ({
  useBadgePolling: () => undefined,
  useMoreBadges: () => ({
    counts: { notifications: 0, wallet: 0, feed: 0, updates: 0 },
    refresh: () => undefined,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
    i18n: { language: "en", changeLanguage: async () => undefined },
  }),
}));

vi.mock("@/i18n", () => ({ getLocale: () => "en-US" }));

vi.mock("@/utils/api", () => ({
  getApiUrl: (path: string) => `https://example.test/api${path}`,
}));

vi.mock("@/constants/colors", () => ({
  default: {
    primary: "#0a0",
    background: "#000",
    surface: "#111",
    border: "#222",
    card: "#1a1a1a",
    error: "#ef4444",
    text: "#fff",
    textSecondary: "#999",
    muted: "#888",
    tabIconDefault: "#888",
  },
}));

vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("expo-router", () => {
  const ReactLib = require("react");
  function Stack(props: { children?: React.ReactNode }) {
    return ReactLib.createElement(ReactLib.Fragment, null, props.children);
  }
  (Stack as unknown as { Screen: React.FC }).Screen = function Screen() {
    return null;
  };
  return {
    Stack,
    router: {
      push: () => undefined,
      back: () => undefined,
      replace: () => undefined,
      canGoBack: () => false,
    },
    useFocusEffect: () => undefined,
    useLocalSearchParams: () => ({}),
    useRouter: () => ({
      push: () => undefined,
      back: () => undefined,
      replace: () => undefined,
    }),
    Link: ({ children }: { children?: React.ReactNode }) => children,
  };
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Task #1687 — Club settings admin entry & screen", () => {
  it("hides the Club settings row in the More menu for non-admin users", async () => {
    currentUserRole = "member";
    const MoreScreen = (await import("../app/(tabs)/more")).default;
    render(<MoreScreen />);
    expect(screen.queryByText("moreItems.clubSettings")).toBeNull();
  });

  it("shows the Club settings row in the More menu for org_admin users", async () => {
    currentUserRole = "org_admin";
    const MoreScreen = (await import("../app/(tabs)/more")).default;
    render(<MoreScreen />);
    expect(screen.getByText("moreItems.clubSettings")).toBeTruthy();
  });

  it("shows the row for tournament_director and super_admin too", async () => {
    currentUserRole = "tournament_director";
    let MoreScreen = (await import("../app/(tabs)/more")).default;
    const { unmount } = render(<MoreScreen />);
    expect(screen.getByText("moreItems.clubSettings")).toBeTruthy();
    unmount();

    currentUserRole = "super_admin";
    MoreScreen = (await import("../app/(tabs)/more")).default;
    render(<MoreScreen />);
    expect(screen.getByText("moreItems.clubSettings")).toBeTruthy();
  });

  it("renders the new club-settings screen with the moved tie-break opt-outs panel", async () => {
    currentUserRole = "org_admin";
    const ClubSettings = (await import("../app/club-admin/club-settings")).default;
    render(<ClubSettings />);
    // Header
    expect(screen.getByText("Club settings")).toBeTruthy();
    expect(screen.getByText("Admin controls for Test Club")).toBeTruthy();
    // The moved card mounts and starts loading from the org endpoint.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/organizations/7/tie-break-email-opt-outs");
  });

  it("shows a 'not available' state and skips the panel fetch for non-admin direct navigation", async () => {
    currentUserRole = "member";
    const ClubSettings = (await import("../app/club-admin/club-settings")).default;
    render(<ClubSettings />);
    expect(screen.getByText("Not available")).toBeTruthy();
    expect(
      screen.getByText("Club settings are only visible to club admins and tournament directors."),
    ).toBeTruthy();
    // The opt-outs endpoint must NOT be hit for a non-admin viewer — the
    // route-level guard fires before the card even mounts.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
