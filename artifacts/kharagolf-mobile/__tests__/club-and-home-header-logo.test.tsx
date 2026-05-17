/**
 * Task #2191 — pins the saved-club-logo render contract on the two
 * most-visited mobile player screens:
 *
 *   - `app/(tabs)/club.tsx` — the dedicated Club tab. Header shows the
 *     saved logo Image when the active org has a customised theme row
 *     with a `logoUrl`, and falls back to the Feather flag icon
 *     otherwise.
 *   - `app/(tabs)/index.tsx` — the Home tab greeting block. Header
 *     shows the saved logo Image alongside the greeting when the
 *     active org has a customised theme with a `logoUrl`, and renders
 *     no logo Image at all otherwise.
 *
 * Both screens consume the saved logo via `useTheme()` from
 * `@/theme/ThemeProvider`. Task #1438 made the provider gate the logo
 * on an explicit `customized` flag (rather than inferring it from
 * colour fields) so a future refactor that, e.g., renames `customized`
 * or changes the fallback semantics would silently regress the logo
 * here. These tests render the real screens wrapped in a real
 * `ThemeProvider` so any such drift in the provider contract or in the
 * screens' consumption of it is caught immediately.
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ThemeProvider, type ThemeBranding } from "../theme/ThemeProvider";

const LOGO_URL = "https://example.com/logo.png";
const ACTIVE_CLUB_NAME = "Test Country Club";

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

vi.mock("@/utils/expoNotifications", () => ({
  getExpoNotifications: () => ({
    addNotificationReceivedListener: () => ({ remove: () => {} }),
  }),
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
  useActiveClub: () => ({
    activeClub: { id: 1, name: ACTIVE_CLUB_NAME },
    activeOrgId: 1,
    clubs: [],
  }),
}));

// HomeScreen renders these heavy children — stub them so the tests stay
// focused on the header.
vi.mock("@/components/MyUpcomingWidget", () => ({
  MyUpcomingWidget: () => null,
}));

vi.mock("@/components/TournamentRegistrationSheet", () => ({
  __esModule: true,
  default: () => null,
}));

vi.mock("expo-web-browser", () => ({
  openBrowserAsync: vi.fn(async () => ({ type: "cancel" as const })),
}));

import ClubScreen from "../app/(tabs)/club";
import HomeScreen from "../app/(tabs)/index";

// Minimal fetch mock so HomeScreen's react-query calls resolve cleanly.
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/handicap/notifications/unread-count")) {
    return new Response(JSON.stringify({ unreadCount: 0, hasAny: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/announcements/side-game-receipt-toggle")) {
    return new Response(JSON.stringify({ announcement: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/api/portal/my-stats")) {
    return new Response(
      JSON.stringify({
        tournamentsPlayed: 0,
        totalScores: 0,
        averageStrokes: null,
        bestRound: null,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  if (url.includes("/api/portal/wellness/today")) {
    return new Response(JSON.stringify({ today: null, recommendation: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  // Default for any other endpoint (tournaments, leagues, feed, etc.) —
  // an empty JSON array works for every list-shaped endpoint the home
  // screen issues, and isn't exercised by these header-focused tests.
  return new Response(JSON.stringify([]), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

function renderWithTheme(
  ui: React.ReactElement,
  branding: ThemeBranding | null,
) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, refetchInterval: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider branding={branding}>{ui}</ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ClubScreen header — saved club logo (Task #2191)", () => {
  it("renders the saved logo Image in the header when the theme is customised", async () => {
    const { container } = renderWithTheme(<ClubScreen />, {
      customized: true,
      logoUrl: LOGO_URL,
    });

    // The screen renders an <Image accessibilityLabel="Test Country Club" />
    // inside the header. react-native-web maps that to <img alt="...">.
    await waitFor(() => {
      const img = container.querySelector(`img[alt="${ACTIVE_CLUB_NAME}"]`);
      expect(img).not.toBeNull();
      expect(img!.getAttribute("src")).toBe(LOGO_URL);
    });

    // Fallback flag icon must NOT be rendered alongside the logo.
    const flag = container.querySelector('[data-icon="flag"]');
    expect(flag).toBeNull();
  });

  it("falls back to the Feather flag icon and renders no logo Image when the theme is NOT customised", async () => {
    const { container } = renderWithTheme(<ClubScreen />, {
      customized: false,
    });

    // No <img> for the saved logo on the not-customised path.
    const img = container.querySelector(`img[alt="${ACTIVE_CLUB_NAME}"]`);
    expect(img).toBeNull();

    // The Feather flag icon (mocked in setup.ts as `<span data-icon="flag">`)
    // is the documented fallback.
    const flag = container.querySelector('[data-icon="flag"]');
    expect(flag).not.toBeNull();
  });

  // Defensive: if a future refactor accidentally drops the `customized`
  // gate and renders solely on `logoUrl` presence, the legacy
  // `activeClub` fallback during initial load would flash a stale logo.
  // Pin that the gate stays in place.
  it("does NOT render the logo Image when logoUrl is set but customized is false", async () => {
    const { container } = renderWithTheme(<ClubScreen />, {
      customized: false,
      logoUrl: LOGO_URL,
    });

    const img = container.querySelector(`img[alt="${ACTIVE_CLUB_NAME}"]`);
    expect(img).toBeNull();
    const flag = container.querySelector('[data-icon="flag"]');
    expect(flag).not.toBeNull();
  });
});

describe("HomeScreen header — saved club logo (Task #2191)", () => {
  it("renders the saved logo Image in the greeting block when the theme is customised", async () => {
    const { container } = renderWithTheme(<HomeScreen />, {
      customized: true,
      logoUrl: LOGO_URL,
    });

    await waitFor(() => {
      const img = container.querySelector(`img[alt="${ACTIVE_CLUB_NAME}"]`);
      expect(img).not.toBeNull();
      expect(img!.getAttribute("src")).toBe(LOGO_URL);
    });
  });

  it("renders no logo Image in the header when the theme is NOT customised", async () => {
    const { container } = renderWithTheme(<HomeScreen />, {
      customized: false,
    });

    // The home header has no fallback icon for the missing logo — it
    // simply renders the greeting text on its own — so we only need to
    // assert the absence of the Image.
    const img = container.querySelector(`img[alt="${ACTIVE_CLUB_NAME}"]`);
    expect(img).toBeNull();
  });

  it("does NOT render the logo Image when logoUrl is set but customized is false", async () => {
    const { container } = renderWithTheme(<HomeScreen />, {
      customized: false,
      logoUrl: LOGO_URL,
    });

    const img = container.querySelector(`img[alt="${ACTIVE_CLUB_NAME}"]`);
    expect(img).toBeNull();
  });
});
