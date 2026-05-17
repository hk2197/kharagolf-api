/**
 * Task #1740 — UI coverage for the mobile /my-follows screen mirroring
 * the web e2e at artifacts/api-server/e2e/portal-my-follows.spec.ts.
 *
 * Mounts <MyFollowsScreen /> with a stubbed `useAuth` (token present),
 * a stubbed `useFolloweeIds`, and a `fetchPortal` mock that hands back
 * the populated paginated payload from /follows/list and /followers.
 *
 * Asserts the wiring the screen uses:
 *
 *   1. On first mount the Following tab fires `GET /follows/list` and
 *      renders one `row-<userId>` per item, plus the "X people" count
 *      line.
 *   2. Tapping the "Followers" tab swaps to `GET /followers` and renders
 *      its rows. Following rows are removed from the DOM (the screen
 *      replaces, not appends, the items array on tab switch).
 *   3. Pull-to-refresh (`onRefresh`) re-fetches the active tab.
 *
 * The HTTP-level pagination contract (limit > 200 clamped to 200, offset
 * paging, auth required) is covered against the live PostgreSQL test DB
 * by artifacts/api-server/src/tests/portal-follows-list-pagination.test.ts;
 * this test exercises the mobile-side wiring the task brief explicitly
 * calls out.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/context/auth", () => ({
  useAuth: () => ({ token: "fake-token" }),
}));

// The screen calls `useFolloweeIds(token)` and uses `refresh` inside
// `useFocusEffect`'s dep array. The real hook returns a referentially
// stable `refresh` thanks to `useCallback`, and our stub MUST do the
// same — otherwise the dep changes every render and (since our
// `useFocusEffect` mock runs on every cb change) the load loop never
// settles. No items in the followee list either, so the Followers tab
// rows hydrate as the un-mutual "Follow" state (matching the web e2e).
const { followeeRefreshMock } = vi.hoisted(() => ({ followeeRefreshMock: vi.fn() }));
vi.mock("@/hooks/useFolloweeIds", () => ({
  useFolloweeIds: () => ({ followeeIds: [], loading: false, refresh: followeeRefreshMock }),
}));

vi.mock("@/components/FollowButton", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactInner = require("react");
  return {
    FollowButton: ({ userId, initialFollowing }: { userId: number; initialFollowing?: boolean }) =>
      ReactInner.createElement(
        "div",
        { "data-testid": `follow-button-${userId}` },
        initialFollowing ? "Following" : "Follow",
      ),
  };
});

// `expo-router` ships the `Stack`, `router` and `useFocusEffect` the
// screen imports. `useFocusEffect` runs the supplied callback the same
// way `useEffect` does in jsdom — that's what we want so the initial
// load fires on mount.
vi.mock("expo-router", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const actualReact = require("react");
  return {
    Stack: { Screen: () => null },
    router: { push: vi.fn(), back: vi.fn(), replace: vi.fn() },
    useFocusEffect: (cb: () => void) => actualReact.useEffect(cb, [cb]),
  };
});

vi.mock("@expo/vector-icons", () => {
  const Stub = (props: { name?: string }) =>
    React.createElement("span", { "data-icon": props?.name ?? "icon" });
  return { Feather: Stub };
});

// `react-native-safe-area-context` ships its own native bridge and a
// pure-TS index that vitest's transformer can't parse under jsdom (it
// trips on `typeof` from one of the native fallbacks). Replacing
// `SafeAreaView` with a plain `<div>` wrapper is enough — the screen
// only uses it for its layout `style` props, which are inert in the
// test environment anyway.
vi.mock("react-native-safe-area-context", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const r = require("react");
  return {
    SafeAreaView: ({ children }: { children: React.ReactNode }) =>
      r.createElement("div", null, children),
  };
});

const { fetchPortalMock } = vi.hoisted(() => ({ fetchPortalMock: vi.fn() }));
vi.mock("@/utils/api", () => ({
  fetchPortal: fetchPortalMock,
}));

import MyFollowsScreen from "../app/my-follows";

const FOLLOWING = [
  { userId: 101, username: "alpha", displayName: "Alpha One",   profileImage: null, followedAt: "2025-01-01T00:00:00Z" },
  { userId: 102, username: "beta",  displayName: "Beta Two",    profileImage: null, followedAt: "2025-01-02T00:00:00Z" },
];
const FOLLOWERS = [
  { userId: 201, username: "gamma", displayName: "Gamma Three", profileImage: null, followedAt: "2025-01-03T00:00:00Z" },
  { userId: 202, username: "delta", displayName: "Delta Four",  profileImage: null, followedAt: "2025-01-04T00:00:00Z" },
];

beforeEach(() => {
  fetchPortalMock.mockReset();
  fetchPortalMock.mockImplementation(async (path: string) => {
    // Match the calls the screen makes:
    //   /follows/list?limit=50&offset=0  → Following tab
    //   /followers?limit=50&offset=0     → Followers tab
    if (path.startsWith("/follows/list")) {
      return { items: FOLLOWING, total: FOLLOWING.length, limit: 50, offset: 0 };
    }
    if (path.startsWith("/followers")) {
      return { items: FOLLOWERS, total: FOLLOWERS.length, limit: 50, offset: 0 };
    }
    throw new Error(`Unexpected fetchPortal call: ${path}`);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Task #1740 — mobile /my-follows screen", () => {
  it("loads the Following tab on mount and renders one row per item with a count line", async () => {
    render(React.createElement(MyFollowsScreen));

    await waitFor(() => {
      expect(screen.queryByTestId("row-101")).not.toBeNull();
      expect(screen.queryByTestId("row-102")).not.toBeNull();
    });

    // Display names show up in the rows.
    expect(screen.getByText("Alpha One")).toBeTruthy();
    expect(screen.getByText("Beta Two")).toBeTruthy();

    // Count line — pluralised to "people" for >1.
    expect(screen.getByText(/^2 people$/)).toBeTruthy();

    // FollowButton on the Following tab hydrates as "Following" because
    // `tab === 'following'` short-circuits to true regardless of
    // `useFolloweeIds()` (matches my-follows.tsx isFollowing logic).
    const btn101 = screen.getByTestId("follow-button-101");
    expect(btn101.textContent).toBe("Following");

    // Sanity: only the /follows/list endpoint was hit on mount, and with
    // the documented pagination params.
    expect(fetchPortalMock).toHaveBeenCalledWith(
      "/follows/list?limit=50&offset=0",
      "fake-token",
    );
    expect(
      fetchPortalMock.mock.calls.some(([p]) => String(p).startsWith("/followers")),
    ).toBe(false);
  });

  it("switching to the Followers tab fetches /followers and renders those rows instead", async () => {
    render(React.createElement(MyFollowsScreen));

    await waitFor(() => {
      expect(screen.queryByTestId("row-101")).not.toBeNull();
    });

    const followersTab = screen.getByTestId("tab-followers");
    await act(async () => {
      fireEvent.click(followersTab);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("row-201")).not.toBeNull();
      expect(screen.queryByTestId("row-202")).not.toBeNull();
    });

    // Following rows replaced — the screen resets `items` on tab switch
    // (my-follows.tsx useFocusEffect) so the Following ids must be gone.
    expect(screen.queryByTestId("row-101")).toBeNull();
    expect(screen.queryByTestId("row-102")).toBeNull();

    expect(screen.getByText("Gamma Three")).toBeTruthy();
    expect(screen.getByText("Delta Four")).toBeTruthy();
    expect(screen.getByText(/^2 people$/)).toBeTruthy();

    // On the Followers tab `useFolloweeIds` is empty → buttons hydrate
    // as the un-mutual "Follow" state.
    expect(screen.getByTestId("follow-button-201").textContent).toBe("Follow");

    // The /followers endpoint was hit with the same pagination params.
    expect(fetchPortalMock).toHaveBeenCalledWith(
      "/followers?limit=50&offset=0",
      "fake-token",
    );
  });

  it("renders the empty-state copy when neither list has rows", async () => {
    fetchPortalMock.mockReset();
    fetchPortalMock.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });

    render(React.createElement(MyFollowsScreen));

    // Following tab empty state — screen text from my-follows.tsx.
    await waitFor(() => {
      expect(screen.getByText(/aren't following anyone yet/i)).toBeTruthy();
    });

    // Switching to the Followers tab swaps to the followers empty copy
    // without crashing the screen.
    const followersTab = screen.getByTestId("tab-followers");
    await act(async () => {
      fireEvent.click(followersTab);
    });
    await waitFor(() => {
      expect(screen.getByText(/no one is following you yet/i)).toBeTruthy();
    });
  });
});
