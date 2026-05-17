/**
 * Task #1727 — Mobile coverage for the deep-link booking highlight flow.
 *
 * The home `MyUpcomingWidget` (mobile) routes each upcoming kind to a
 * destination tab via `router.push({ pathname, params: { <param>: id } })`,
 * and each destination screen feeds the param through `useHighlightFlash`
 * (see `hooks/use-highlight.ts`) which exposes the matching id for ~2.4s so
 * the receiving FlatList can scroll-and-flash the matching row.
 *
 * The full web click → navigate → scroll → flash flow is exercised by the
 * Playwright spec at
 * `artifacts/api-server/e2e/portal-upcoming-deeplink-highlight.spec.ts`.
 * The Expo app has no Playwright/native e2e harness in this repo, so the
 * task explicitly allows mobile to be covered with a single representative
 * kind. We pick `lesson` because it exercises the same `bookingId` param
 * shape that range and tee also use, so a regression in the param wiring
 * would surface here even though only one kind runs the assertions.
 *
 * Coverage split:
 *   1. Widget-side: stub `fetchPortal('/my-upcoming', …)` to return a single
 *      lesson item and assert the click on the row calls `router.push` with
 *      `{ pathname: "/(tabs)/lessons", params: { bookingId: "<id>" } }` —
 *      the exact shape `MyUpcomingWidget.hrefFor()` builds for `lesson`.
 *   2. Receiving side: feed the same id through `useHighlightFlash` (the
 *      hook every receiving screen uses) and assert it returns the parsed
 *      id while the flash is active and `null` once the timer fires. This
 *      covers the "row briefly shows the highlight style" half without
 *      having to render the whole `app/(tabs)/lessons.tsx` screen, which
 *      pulls in scoring/auth/fetch plumbing that's already covered by
 *      its own tests.
 *
 * Companion to
 * `artifacts/kharagolf-mobile/__tests__/my-upcoming-widget-wallet-topup.test.tsx`
 * which covers the wallet_topup branch (Task #1718).
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";

const { routerMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), back: vi.fn(), replace: vi.fn() },
}));

// The widget imports `router` directly from `expo-router` rather than via
// `useRouter()`, so we need a real spy on `router.push` to capture the
// destination of the click. The shared setup file's stub no-ops `push`,
// which would silently swallow the navigation we're verifying here.
vi.mock("expo-router", () => ({
  router: routerMock,
  useRouter: () => routerMock,
  useLocalSearchParams: () => ({}),
  useSegments: () => [],
  useFocusEffect: () => {},
  Link: ({ children }: { children?: React.ReactNode }) => children,
  Stack: { Screen: () => null },
}));

// `useAuth` normally pulls in `expo-secure-store` and the auth context;
// the widget only needs `token` to fire the fetchPortal call.
vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { id: 1 },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

interface UpcomingItem {
  kind: string;
  id: number;
  organizationId: number | null;
  startsAt: string;
}

const fetchPortalMock = vi.fn<(path: string, token: string) => Promise<{ items: UpcomingItem[] }>>();

// Stubbing the higher-level `fetchPortal` helper (rather than `fetch`)
// keeps us decoupled from the BASE_URL / Authorization header plumbing
// and matches what other component-level tests in this directory do.
vi.mock("@/utils/api", () => ({
  fetchPortal: (path: string, token: string) => fetchPortalMock(path, token),
}));

import { MyUpcomingWidget } from "../components/MyUpcomingWidget";
import { useHighlightFlash } from "../hooks/use-highlight";

beforeEach(() => {
  routerMock.push.mockClear();
  routerMock.back.mockClear();
  routerMock.replace.mockClear();
  fetchPortalMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function renderAndAwaitItems() {
  // The widget calls fetchPortal in a useEffect and renders rows once the
  // returned promise resolves. Letting microtasks flush inside `act` keeps
  // React's effect/setState batching from leaking warnings.
  await act(async () => {
    render(<MyUpcomingWidget />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Task #1727 — MyUpcomingWidget deep-link highlight (mobile)", () => {
  it("renders the lesson row with the user glyph and the 'Coaching lesson' label", async () => {
    fetchPortalMock.mockResolvedValueOnce({
      items: [
        {
          kind: "lesson",
          id: 314,
          organizationId: 5,
          startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        },
      ],
    });

    await renderAndAwaitItems();

    // Confirms the widget actually queried the unified upcoming endpoint
    // with the auth token threaded through — a regression here would mean
    // members see an empty card even when lessons exist.
    expect(fetchPortalMock).toHaveBeenCalledWith("/my-upcoming", "test-token");

    const row = await screen.findByTestId("upcoming-lesson-314");
    expect(within(row).getByText("Coaching lesson")).toBeInTheDocument();

    // The shared `@expo/vector-icons` stub in __tests__/setup.ts renders
    // each Feather icon as `<span data-icon="<name>">`, so checking for
    // `user` guards against edits dropping the lesson entry from the
    // CATEGORY map or falling back to the generic "calendar" glyph.
    const icons = row.querySelectorAll('[data-icon="user"]');
    expect(icons.length).toBeGreaterThan(0);
  });

  it("routes the lesson tap to /(tabs)/lessons with the bookingId param", async () => {
    fetchPortalMock.mockResolvedValueOnce({
      items: [
        {
          kind: "lesson",
          id: 271,
          organizationId: 5,
          startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        },
      ],
    });

    await renderAndAwaitItems();

    const row = await screen.findByTestId("upcoming-lesson-271");

    // react-native-web turns TouchableOpacity into a clickable element.
    fireEvent.click(row);

    expect(routerMock.push).toHaveBeenCalledTimes(1);
    // The widget builds an Href object of the form
    //   { pathname: "/(tabs)/lessons", params: { bookingId: "<id>" } }
    // — the lessons screen reads `bookingId` via useLocalSearchParams,
    // feeds it to useHighlightFlash, and switches to the "my" tab so the
    // matching row can scroll into view and flash. Pinning the pathname +
    // param shape catches refactors that, e.g., rename the param to `id`
    // (which the screen wouldn't read) or re-point the lesson tap at a
    // different tab.
    const arg = routerMock.push.mock.calls[0]![0] as {
      pathname: string;
      params: Record<string, string>;
    };
    expect(arg.pathname).toBe("/(tabs)/lessons");
    expect(arg.params.bookingId).toBe("271");
  });

  it("does NOT use the lessons pathname for unrelated kinds (negative guard)", async () => {
    // Tee bookings have their own destination (`/tee-bookings`) — the lesson
    // pathname must stay scoped to the lesson branch of `hrefFor()`.
    fetchPortalMock.mockResolvedValueOnce({
      items: [
        {
          kind: "tee",
          id: 88,
          organizationId: 1,
          startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        },
      ],
    });

    await renderAndAwaitItems();

    const teeRow = await screen.findByTestId("upcoming-tee-88");
    fireEvent.click(teeRow);

    expect(routerMock.push).toHaveBeenCalledTimes(1);
    const arg = routerMock.push.mock.calls[0]![0] as { pathname: string };
    expect(arg.pathname).toBe("/tee-bookings");
  });

  it("useHighlightFlash returns the bookingId for the flash window then clears it", async () => {
    // The receiving lessons (and range / rentals / tee) screens funnel the
    // route param through useHighlightFlash, which is what makes the matching
    // FlatList row briefly highlight (`styles.highlightCard`) before settling
    // back to neutral. We exercise it directly here with the param value the
    // widget produced above (string "271"), then advance fake timers past
    // the 2.4s flash window and confirm it clears so the row stops flashing
    // on subsequent re-renders.
    vi.useFakeTimers();

    const { result } = renderHook(() => useHighlightFlash("271"));

    // While the flash is active the hook surfaces the parsed id so the
    // receiving screen can pass `isHighlight = highlightId === bk.id` to
    // its row component.
    expect(result.current.highlightId).toBe(271);

    // Past the 2.4s flash window the hook clears the id so the row stops
    // flashing. Using a 2.5s advance keeps a tiny safety margin without
    // being so generous it hides a regression that, e.g., bumped the
    // duration to 5s.
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    expect(result.current.highlightId).toBeNull();
  });
});
