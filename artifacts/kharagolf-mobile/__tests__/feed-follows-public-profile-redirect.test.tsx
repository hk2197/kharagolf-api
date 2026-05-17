/**
 * Task #1789 — End-to-end coverage that the social feed and the
 * followers/following lists funnel taps into the public profile viewer
 * (`/profile/[handle]`) when the player has reserved a public handle, and
 * keep showing the existing private member card otherwise.
 *
 * Task #1457 already added a userId → publicHandle resolver and made the
 * `/member/[userId]` route auto-redirect when a handle exists. The feed
 * (app/(tabs)/feed.tsx) and the my-follows tabs (app/my-follows.tsx) both
 * navigate through that route, so the redirect works "for free" — but
 * nothing locks in their navigation params. A future refactor that drops
 * `userId` or pushes the wrong pathname would silently break the public
 * profile traffic from those screens. The cases below chain each tap
 * through the resolver shim so a regression on either side is caught.
 *
 * The handle resolver's HTTP contract (GET /api/public/users/:userId/handle)
 * is covered against the live PostgreSQL test DB by
 * artifacts/api-server/src/tests/public-profile-flows.test.ts. The
 * resolver-screen redirect itself is covered by
 * __tests__/member-stub-public-profile-redirect.test.tsx (Task #1457).
 * This file specifically guards the source-screen → resolver wiring the
 * task brief calls out.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const {
  routerMock,
  searchParamsRef,
  fetchPortalMock,
  followeeRefreshMock,
  stableEmptyFolloweeIds,
} = vi.hoisted(() => {
  // feed.tsx and @/utils/api both capture BASE_URL at module load time
  // from process.env.EXPO_PUBLIC_DOMAIN. vi.hoisted runs before the bare
  // imports below, so this is the safe place to seed it.
  process.env.EXPO_PUBLIC_DOMAIN = "test.example.com";
  return {
    routerMock: { push: vi.fn(), back: vi.fn(), replace: vi.fn() },
    searchParamsRef: {
      current: {} as { userId?: string; displayName?: string; avatar?: string },
    },
    fetchPortalMock: vi.fn(),
    followeeRefreshMock: vi.fn(),
    // Hoisted stable reference so the useFolloweeIds mock returns the
    // same array identity across renders (otherwise my-follows.tsx's
    // useFocusEffect dep array churns and the load loop never settles).
    stableEmptyFolloweeIds: [] as number[],
  };
});

vi.mock("expo-router", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const r = require("react") as typeof React;
  return {
    router: routerMock,
    Stack: { Screen: () => null },
    useLocalSearchParams: () => searchParamsRef.current,
    // Same pattern as my-follows.test.tsx — useFocusEffect runs the
    // supplied cb the way useEffect does in jsdom, which is what we
    // need so the screen actually loads on mount.
    useFocusEffect: (cb: () => void | (() => void)) => r.useEffect(cb, [cb]),
  };
});

vi.mock("@/context/auth", () => ({
  useAuth: () => ({ token: "tok", user: { id: 99 }, orgId: 42 }),
}));

vi.mock("@/hooks/useFolloweeIds", () => ({
  useFolloweeIds: () => ({
    followeeIds: stableEmptyFolloweeIds,
    loading: false,
    refresh: followeeRefreshMock,
  }),
}));

vi.mock("@/components/FollowButton", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactInner = require("react") as typeof React;
  return {
    FollowButton: ({ userId }: { userId: number }) =>
      ReactInner.createElement("div", { "data-testid": `follow-${userId}` }, "Follow"),
  };
});

vi.mock("@/context/moreBadges", () => ({
  useMoreBadges: () => ({ markFeedSeen: vi.fn() }),
}));

vi.mock("@/i18n", () => ({ getLocale: () => "en-US" }));

vi.mock("@expo/vector-icons", () => {
  const Stub = (props: { name?: string }) =>
    React.createElement("span", { "data-icon": props?.name ?? "icon" });
  return { Feather: Stub, Ionicons: Stub, MaterialIcons: Stub };
});

// feed.tsx imports expo-av (Video) and expo-sharing/expo-file-system at
// module scope for highlight-reel cards. Stub them so the test file can
// even load — none of the assertions exercise the reel path.
vi.mock("expo-av", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactInner = require("react") as typeof React;
  return {
    Video: () => ReactInner.createElement("div"),
    ResizeMode: { COVER: "cover", CONTAIN: "contain" },
  };
});

vi.mock("expo-sharing", () => ({
  isAvailableAsync: vi.fn(async () => false),
  shareAsync: vi.fn(),
}));

vi.mock("expo-file-system", () => ({
  File: class {
    uri = "";
    constructor(_d: string, n: string) {
      this.uri = `file:///cache/${n}`;
    }
    get exists() {
      return false;
    }
    delete() {}
    static downloadFileAsync = vi.fn(async (_u: string, t: { uri: string }) => t);
  },
  Paths: { cache: "file:///cache" },
}));

vi.mock("react-native-safe-area-context", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactInner = require("react") as typeof React;
  return {
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children: React.ReactNode }) =>
      ReactInner.createElement("div", null, children),
  };
});

// my-follows.tsx pulls fetchPortal from @/utils/api; member/[userId].tsx
// pulls BASE_URL from the same module to build the resolver URL. We have
// to keep BASE_URL intact — full-mocking with explicit exports is enough
// (the FollowButton (real) deps on postPortal/deletePortal aren't reached
// because we mock FollowButton above).
vi.mock("@/utils/api", () => ({
  BASE_URL: "https://test.example.com",
  fetchPortal: fetchPortalMock,
}));

// Imports below run after vi.mock setup.
import { PostCard } from "../app/(tabs)/feed";
import MyFollowsScreen from "../app/my-follows";
import MemberProfileScreen from "../app/member/[userId]";

interface FetchState {
  // userId → handle (string for "has a handle", null for "no handle").
  // A missing entry triggers the test's unexpected-fetch guard so a
  // stray resolver call against an unrelated user fails loudly.
  handles: Map<number, string | null>;
  handleCalls: number;
}

let fetchState: FetchState;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const m = url.match(/\/api\/public\/users\/(\d+)\/handle$/);
    if (m) {
      const id = Number(m[1]);
      if (!fetchState.handles.has(id)) {
        throw new Error(`Resolver hit for unmocked user ${id}: ${url}`);
      }
      fetchState.handleCalls += 1;
      return new Response(JSON.stringify({ handle: fetchState.handles.get(id) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as unknown as typeof fetch;
}

const VIEWER_ID = 99;
const ORG_ID = 42;
const TOKEN = "tok";

type Post = Parameters<typeof PostCard>[0]["post"];
function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: 1001,
    type: "member_post",
    body: "Round of the year",
    privacy: "all_members",
    isPinned: false,
    taggedHoleNumber: null,
    achievementType: null,
    reactionsCount: 0,
    commentsCount: 0,
    createdAt: new Date().toISOString(),
    authorUserId: 7,
    authorDisplayName: "Public Pat",
    authorUsername: "publicpat",
    authorProfileImage: null,
    media: [],
    hasReacted: false,
    reelId: null,
    ...overrides,
  };
}

const baseCardProps = {
  orgId: ORG_ID,
  token: TOKEN,
  currentUserId: VIEWER_ID,
  isAdmin: false,
  followeeIds: [] as number[],
  onDelete: vi.fn(),
  onReact: vi.fn(),
};

beforeEach(() => {
  fetchState = { handles: new Map(), handleCalls: 0 };
  routerMock.push.mockClear();
  routerMock.replace.mockClear();
  routerMock.back.mockClear();
  searchParamsRef.current = {};
  fetchPortalMock.mockReset();
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Task #1789 — feed + my-follows funnel into the public profile redirect", () => {
  it("Feed: tapping a post author chip whose user has a handle ends up on /profile/[handle]", async () => {
    fetchState.handles.set(7, "public-pat");
    const post = makePost({ authorUserId: 7, authorDisplayName: "Public Pat" });

    const { unmount } = render(
      React.createElement(PostCard, { ...baseCardProps, post }),
    );

    // Step 1 — tap the author chip on the feed card.
    //
    // The chip is the avatar TouchableOpacity wrapping the Avatar.
    // With no profile image the Avatar renders a fallback <View> whose
    // <Text> child is the initials ("Public Pat" → "PP"). react-native-web
    // wires TouchableOpacity.onPress as a div.onClick, so a click on the
    // initials bubbles up to the chip's handler.
    const initials = await screen.findByText("PP");
    await act(async () => {
      fireEvent.click(initials);
    });

    expect(routerMock.push).toHaveBeenCalledTimes(1);
    const pushArg = routerMock.push.mock.calls[0][0] as {
      pathname: string;
      params: { userId: string; displayName?: string; avatar?: string };
    };
    // The brief specifically calls out: don't drop userId, don't push
    // the wrong pathname.
    expect(pushArg.pathname).toBe("/member/[userId]");
    expect(pushArg.params.userId).toBe("7");
    expect(pushArg.params.displayName).toBe("Public Pat");

    // Step 2 — mount the resolver shim with the params the navigator
    // would have delivered, and confirm it replaces to /profile/[handle].
    unmount();
    searchParamsRef.current = {
      userId: "7",
      displayName: "Public Pat",
      avatar: "",
    };
    render(React.createElement(MemberProfileScreen));

    await waitFor(() => {
      expect(fetchState.handleCalls).toBe(1);
      expect(routerMock.replace).toHaveBeenCalledWith({
        pathname: "/profile/[handle]",
        params: { handle: "public-pat" },
      });
    });
    // Spinner-only — the private fallback must not flash through while
    // the redirect is in flight, otherwise the back button stack ends up
    // with the wrong screen.
    expect(screen.queryByTestId("follow-7")).toBeNull();
    expect(screen.queryByText("Member profile")).toBeNull();
  });

  it("Followers tab: tapping a row whose user has a handle ends up on /profile/[handle]", async () => {
    fetchState.handles.set(201, "gamma");
    fetchPortalMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/follows/list")) {
        return { items: [], total: 0, limit: 50, offset: 0 };
      }
      if (path.startsWith("/followers")) {
        return {
          items: [
            {
              userId: 201,
              username: "gamma",
              displayName: "Gamma Three",
              profileImage: null,
              followedAt: "2025-01-01T00:00:00Z",
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        };
      }
      throw new Error(`Unexpected fetchPortal: ${path}`);
    });

    const { unmount } = render(React.createElement(MyFollowsScreen));

    // Switch to the Followers tab so we exercise a *followee* surface
    // (the brief explicitly calls out the followers list).
    const followersTab = await screen.findByTestId("tab-followers");
    await act(async () => {
      fireEvent.click(followersTab);
    });

    // Wait for the row to render.
    await waitFor(() => {
      expect(screen.queryByTestId("row-201")).not.toBeNull();
    });

    // The displayName text "Gamma Three" lives inside the rowMain
    // TouchableOpacity, so a click bubbles up to its onPress.
    const nameNode = screen.getByText("Gamma Three");
    await act(async () => {
      fireEvent.click(nameNode);
    });

    expect(routerMock.push).toHaveBeenCalled();
    const lastPush = routerMock.push.mock.calls.at(-1)?.[0] as {
      pathname: string;
      params: { userId: string; displayName?: string };
    };
    expect(lastPush.pathname).toBe("/member/[userId]");
    expect(lastPush.params.userId).toBe("201");
    expect(lastPush.params.displayName).toBe("Gamma Three");

    unmount();
    searchParamsRef.current = {
      userId: "201",
      displayName: "Gamma Three",
      avatar: "",
    };
    render(React.createElement(MemberProfileScreen));

    await waitFor(() => {
      expect(fetchState.handleCalls).toBe(1);
      expect(routerMock.replace).toHaveBeenCalledWith({
        pathname: "/profile/[handle]",
        params: { handle: "gamma" },
      });
    });
    expect(screen.queryByTestId("follow-201")).toBeNull();
  });

  it("Negative: tapping a feed author chip whose user has NO handle keeps the private member card", async () => {
    // Resolver replies with { handle: null } → the screen must NOT redirect
    // and must fall back to the existing private member card (FollowButton
    // + display name) so members without a public profile still have a
    // sensible destination.
    fetchState.handles.set(8, null);
    const post = makePost({
      authorUserId: 8,
      authorDisplayName: "Private Quinn",
      authorUsername: "privateq",
    });

    const { unmount } = render(
      React.createElement(PostCard, { ...baseCardProps, post }),
    );

    const initials = await screen.findByText("PQ");
    await act(async () => {
      fireEvent.click(initials);
    });

    expect(routerMock.push).toHaveBeenCalledTimes(1);
    const pushArg = routerMock.push.mock.calls[0][0] as {
      pathname: string;
      params: { userId: string };
    };
    expect(pushArg.pathname).toBe("/member/[userId]");
    expect(pushArg.params.userId).toBe("8");

    unmount();
    searchParamsRef.current = {
      userId: "8",
      displayName: "Private Quinn",
      avatar: "",
    };
    render(React.createElement(MemberProfileScreen));

    await waitFor(() => {
      expect(fetchState.handleCalls).toBe(1);
      // Private fallback card renders with the display name…
      expect(screen.queryByText("Private Quinn")).not.toBeNull();
    });
    // …no redirect fires when the resolver returned null…
    expect(routerMock.replace).not.toHaveBeenCalled();
    // …and the private-card affordance (Follow button for the viewed
    // user, since viewer 99 ≠ target 8) is wired up.
    expect(screen.queryByTestId("follow-8")).not.toBeNull();
  });
});
