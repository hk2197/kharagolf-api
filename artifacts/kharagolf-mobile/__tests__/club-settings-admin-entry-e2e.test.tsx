/**
 * Task #2100 — End-to-end UI coverage for the admin "Club settings"
 * mobile flow: tap the More-tab row → navigate into the new
 * `app/club-admin/club-settings.tsx` screen → re-subscribe a director
 * from the tie-break email opt-outs panel.
 *
 * Task #1687 already pins the admin gating in the More menu and a
 * static render check of the new screen via the unit suite at
 * `__tests__/club-settings-admin-entry.test.tsx`. That suite mocks
 * everything around the row in isolation; it does *not* tap the row,
 * does *not* drive the route swap, and does *not* exercise the DELETE
 * roundtrip on the moved card.
 *
 * This e2e walks the *real* `(tabs)/more.tsx` Row → `router.push` →
 * `app/club-admin/club-settings.tsx` → `TieBreakEmailOptOutsCard` →
 * `DELETE /organizations/:orgId/tie-break-email-opt-outs/:userId`
 * roundtrip end-to-end so any regression in that wiring (wrong href,
 * wrong endpoint, button not actually firing the DELETE on tap, row
 * not removed after success) fails this suite instead of slipping
 * through. The web app already has the same end-to-end check; this
 * brings the mobile artifact to parity.
 *
 * Same vitest + react-native-web harness as the rest of the mobile
 * e2e tier (see `moreBadges-polling-gated-e2e.test.tsx` and
 * `wallet-payout-needs-reverify-e2e.test.tsx`), so the file is picked
 * up by `pnpm --filter @workspace/kharagolf-mobile test` without any
 * extra wiring. Playwright is not configured for the mobile artifact;
 * this is the same harness the rest of the mobile e2e tier uses.
 */
import React, { type ReactNode, useEffect, useState } from "react";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const { routerMock, alertMock } = vi.hoisted(() => ({
  routerMock: {
    push: vi.fn(),
    back: vi.fn(),
    replace: vi.fn(),
    canGoBack: () => true,
  },
  alertMock: vi.fn<(title: string, message?: string) => void>(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
  },
}));

// react-native-web ships an `AppState` that registers a real listener at
// import time; stubbing it keeps the test event loop quiet. We also
// route `Alert.alert` through the hoisted spy so the post-resubscribe
// success toast can be asserted without spawning a real native dialog.
vi.mock("react-native", async () => {
  const actual = await vi.importActual<typeof import("react-native")>("react-native");
  return {
    ...actual,
    AppState: {
      addEventListener: () => ({ remove: () => undefined }),
      currentState: "active",
    },
    Alert: { alert: alertMock },
  };
});

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    token: "test-token",
    user: { id: 1, role: "org_admin", organizationId: 7, username: "u" },
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

// The badge-polling provider isn't the contract under test here — the
// gating + navigation + DELETE roundtrip is. Stubbing it lets the More
// menu mount without an orchestrator provider in scope (matches the
// approach in `club-settings-admin-entry.test.tsx`).
vi.mock("@/context/moreBadges", () => ({
  useBadgePolling: () => undefined,
  useMoreBadges: () => ({
    counts: { notifications: 0, wallet: 0, feed: 0, updates: 0 },
    refresh: () => undefined,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
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

// Override the global expo-router stub from setup.ts: this suite needs
// a `router.push` spy whose implementation drives the test app's route
// swap (Row press → push → ClubSettings mounts), and a callable `Stack`
// because the destination screen ships under `app/club-admin/`.
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
    router: routerMock,
    useFocusEffect: () => undefined,
    useLocalSearchParams: () => ({}),
    useRouter: () => routerMock,
    Link: ({ children }: { children?: React.ReactNode }) => children,
  };
});

const ORG_ID = 7;
const OPTED_OUT_USER_ID = 99;
const LIST_URL = `https://example.test/api/organizations/${ORG_ID}/tie-break-email-opt-outs`;
const DELETE_URL = `${LIST_URL}/${OPTED_OUT_USER_ID}`;
const CLUB_SETTINGS_HREF = "/club-admin/club-settings";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Stand up a stateful fetch impl that:
 *   GET  /organizations/:orgId/tie-break-email-opt-outs        → current rows
 *   DELETE /organizations/:orgId/tie-break-email-opt-outs/:id  → 204 + drop row
 *
 * Anything else fails loudly so a regression that points the card at
 * the wrong endpoint can't accidentally pass.
 */
function setupFetchForOptOuts(
  initialRows: Array<{
    userId: number;
    email: string | null;
    displayName: string;
    optedOutAt: string;
  }>,
) {
  let currentRows = [...initialRows];
  fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u === LIST_URL && method === "GET") {
      return jsonResponse(currentRows);
    }
    if (u === DELETE_URL && method === "DELETE") {
      currentRows = currentRows.filter((r) => r.userId !== OPTED_OUT_USER_ID);
      return new Response(null, { status: 204 });
    }
    return jsonResponse(
      { error: `unexpected request: ${method} ${u}` },
      500,
    );
  });
}

beforeEach(() => {
  routerMock.push.mockReset();
  routerMock.back.mockReset();
  routerMock.replace.mockReset();
  alertMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Task #2100 — Mobile club-settings entry e2e", () => {
  it("admin taps More → Club settings → re-subscribes a director from the tie-break opt-outs panel", async () => {
    setupFetchForOptOuts([
      {
        userId: OPTED_OUT_USER_ID,
        email: "director@example.test",
        displayName: "Diana Director",
        optedOutAt: "2026-04-01T10:00:00.000Z",
      },
    ]);

    const MoreScreen = (await import("../app/(tabs)/more")).default;
    const ClubSettings = (await import("../app/club-admin/club-settings"))
      .default;

    /**
     * Tiny test-only router shell: mounts MoreScreen first, then swaps
     * to ClubSettings the moment `router.push("/club-admin/club-settings")`
     * fires. Mirrors how `app/_layout.tsx` swaps the active child when
     * the user navigates — without dragging in expo-router's real
     * file-system tree.
     */
    function App() {
      const [route, setRoute] = useState("/(tabs)/more");
      useEffect(() => {
        routerMock.push.mockImplementation((href: unknown) => {
          const path =
            typeof href === "string"
              ? href
              : (href as { pathname?: string } | null)?.pathname ?? "";
          setRoute(path);
        });
      }, []);
      return route === CLUB_SETTINGS_HREF ? <ClubSettings /> : <MoreScreen />;
    }

    render(<App />);

    // 1) The admin-only "Club settings" row is visible in the More
    //    menu (Task #1687 covers the negative case for non-admins).
    //    The unit-test transport returns i18n keys verbatim, so we
    //    target the row by its key text.
    const row = await screen.findByText("moreItems.clubSettings");

    // 2) Tapping the row pushes the new club-settings deep link. A
    //    regression that renames the href would fail this assertion
    //    (and therefore the route swap below).
    fireEvent.click(row);
    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith(CLUB_SETTINGS_HREF);
    });

    // 3) The test app swaps to the club-settings screen and the moved
    //    `TieBreakEmailOptOutsCard` mounts and loads the org's opt-outs
    //    from the documented endpoint. The card carries
    //    `testID="card-tie-break-email-opt-outs"`.
    await screen.findByTestId("card-tie-break-email-opt-outs");
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(calls).toContain(LIST_URL);
    });

    // 4) The opted-out director's row renders with a "Re-subscribe"
    //    CTA. Display-name comes from the GET response above.
    const resubscribe = await screen.findByTestId(
      `button-resubscribe-tie-break-${OPTED_OUT_USER_ID}`,
    );
    expect(screen.getByText("Diana Director")).toBeTruthy();
    expect(screen.getByText("director@example.test")).toBeTruthy();

    // 5) Tapping "Re-subscribe" fires DELETE against the same org
    //    endpoint with the director's userId, and the row disappears
    //    from the panel. The success toast fires too — same UX as
    //    the web equivalent.
    fireEvent.click(resubscribe);

    await waitFor(() => {
      const deleteCalls = fetchMock.mock.calls.filter((c) => {
        const init = (c[1] ?? {}) as RequestInit;
        return String(c[0]) === DELETE_URL && init.method === "DELETE";
      });
      expect(deleteCalls).toHaveLength(1);
      // Authorization header is sent so the server can authorize the
      // mutation against the admin's session.
      const headers = (deleteCalls[0][1] as RequestInit).headers as
        | Record<string, string>
        | undefined;
      expect(headers?.["Authorization"]).toBe("Bearer test-token");
    });

    await waitFor(() => {
      expect(
        screen.queryByTestId(
          `button-resubscribe-tie-break-${OPTED_OUT_USER_ID}`,
        ),
      ).toBeNull();
    });
    expect(screen.queryByText("Diana Director")).toBeNull();

    // The empty-state copy now renders in place of the list row.
    expect(screen.getByTestId("text-no-tie-break-opt-outs")).toBeTruthy();

    // The success toast was surfaced through `Alert.alert` with the
    // re-subscribed director's name in the body, matching the web
    // version's confirmation copy.
    expect(alertMock).toHaveBeenCalledWith(
      "Re-subscribed",
      expect.stringContaining("Diana Director"),
    );
  });
});
