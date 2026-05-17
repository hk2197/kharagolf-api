/**
 * Task #1718 — UI coverage for the new wallet_topup category surfaced by
 * Task #1423 in the home `MyUpcomingWidget` (mobile).
 *
 * The integration test
 * (`artifacts/api-server/src/tests/portal-my-upcoming-wallet-topup.test.ts`)
 * already covers the server response shape — wallet top-up requests in
 * `pending_verification`, `refund_pending`, or `refunded` flow through as
 * `kind: "wallet_topup"`. This spec is the missing piece on the mobile
 * client: it stubs `fetchPortal('/my-upcoming', …)` and asserts the widget
 * actually renders the row with the wallet icon + "Wallet top-up refund"
 * label and routes the tap to `/wallet` (the standalone screen Task #1423
 * deep-links to — it lists the member's recent wallet activity).
 *
 * Companion to the web coverage in
 * `artifacts/kharagolf-web/src/components/__tests__/MyUpcomingWidget.wallet-topup.test.tsx`.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const { routerMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), back: vi.fn(), replace: vi.fn() },
}));

// The component under test imports `router` directly from `expo-router`
// (not via `useRouter()`), so we need a real spy on `router.push` to
// assert the destination of the wallet_topup tap. The setup file's stub
// only no-ops push, which would silently swallow the navigation we're
// trying to verify here.
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

beforeEach(() => {
  routerMock.push.mockClear();
  routerMock.back.mockClear();
  routerMock.replace.mockClear();
  fetchPortalMock.mockReset();
});

afterEach(() => {
  cleanup();
});

async function renderAndAwaitItems() {
  // The widget calls fetchPortal in a useEffect and renders rows once the
  // returned promise resolves. Letting microtasks flush inside `act` keeps
  // React's effect / setState batching from leaking warnings.
  await act(async () => {
    render(<MyUpcomingWidget />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("MyUpcomingWidget — wallet_topup category (Task #1718, mobile)", () => {
  it("renders the wallet_topup row with the credit-card glyph and the 'Wallet top-up refund' label", async () => {
    fetchPortalMock.mockResolvedValueOnce({
      items: [
        {
          kind: "wallet_topup",
          id: 4242,
          organizationId: 7,
          startsAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });

    await renderAndAwaitItems();

    // Confirms the widget actually queried the unified upcoming endpoint
    // with the auth token threaded through — a regression here would
    // mean members see an empty card even when wallet activity exists.
    expect(fetchPortalMock).toHaveBeenCalledWith("/my-upcoming", "test-token");

    const row = await screen.findByTestId("upcoming-wallet_topup-4242");
    expect(within(row).getByText("Wallet top-up refund")).toBeInTheDocument();

    // The mobile widget picks the icon from its CATEGORY map — the
    // shared `@expo/vector-icons` stub in __tests__/setup.ts renders
    // each Feather icon as `<span data-icon="<name>">`, so checking for
    // `credit-card` guards against future edits dropping the wallet
    // entry or falling back to the generic "calendar" glyph.
    const icons = row.querySelectorAll('[data-icon="credit-card"]');
    expect(icons.length).toBeGreaterThan(0);
  });

  it("routes the wallet_topup tap to the /wallet screen", async () => {
    fetchPortalMock.mockResolvedValueOnce({
      items: [
        {
          kind: "wallet_topup",
          id: 99,
          organizationId: 1,
          startsAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });

    await renderAndAwaitItems();

    const row = await screen.findByTestId("upcoming-wallet_topup-99");

    // react-native-web turns TouchableOpacity into a clickable element.
    fireEvent.click(row);

    expect(routerMock.push).toHaveBeenCalledTimes(1);
    // The widget builds an Href object of the form
    //   { pathname: "/wallet", params: { requestId: "<id>" } }
    // — the standalone wallet screen ignores `requestId` (the page lists
    // recent activity rather than focusing one row), but we still pin
    // the pathname so a future refactor can't silently re-point the
    // wallet_topup tap at, say, /tee-bookings.
    const arg = routerMock.push.mock.calls[0]![0] as { pathname: string; params: Record<string, string> };
    expect(arg.pathname).toBe("/wallet");
    expect(arg.params.requestId).toBe("99");
  });

  it("does not route to the wallet screen for unrelated categories (negative guard)", async () => {
    fetchPortalMock.mockResolvedValueOnce({
      items: [
        {
          kind: "tee",
          id: 11,
          organizationId: 1,
          startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        },
      ],
    });

    await renderAndAwaitItems();

    const teeRow = await screen.findByTestId("upcoming-tee-11");
    fireEvent.click(teeRow);

    // The tee row must route to its own `/tee-bookings` deep-link, not
    // the wallet screen — i.e. the wallet_topup branch isn't catching
    // every kind.
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    const arg = routerMock.push.mock.calls[0]![0] as { pathname: string };
    expect(arg.pathname).toBe("/tee-bookings");
  });
});
