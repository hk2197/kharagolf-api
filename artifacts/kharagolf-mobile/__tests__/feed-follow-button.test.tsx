/**
 * Task #1422 — Mobile coverage for the Follow button on feed post cards.
 *
 * The web side of the same task is covered by
 * artifacts/kharagolf-web/src/pages/__tests__/club-members-follow-button.test.tsx
 *
 * The HTTP contract for /api/portal/follows + /api/portal/follows/:id is
 * separately covered against the live PostgreSQL test DB by
 * artifacts/api-server/src/tests/follows-status.test.ts.
 *
 * This test exercises the *mobile feed wiring* the task brief specifically
 * calls out: each <PostCard /> for a non-owner author must render
 * <FollowButton initialFollowing={...} /> with the value pre-populated
 * from the parent's useFolloweeIds() pull of /api/portal/follows. Concretely:
 *
 *   1. A post by a non-owner author whose id is NOT in followeeIds renders
 *      the button in its "Follow" state.
 *   2. A post by a non-owner author whose id IS in followeeIds renders the
 *      button hydrated as "Following" — i.e. initialFollowing was passed
 *      through from the pre-fetch instead of being defaulted to false.
 *   3. A post by the viewer themselves (post.authorUserId === currentUserId
 *      via the !isOwner guard at feed.tsx:291) never renders the button,
 *      regardless of whether the viewer's own id is in followeeIds.
 *   4. A post by an anonymous author (post.authorUserId === null) never
 *      renders the button either.
 *
 * Mirrors the lightweight component-level harness used by
 * feed-reel-engagement.test.tsx (PostCard imported in isolation, expo-av /
 * sharing / file-system / vector-icons / router / auth context all stubbed).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

// Hoisted mocks — vi.mock factories run before module-scope variables init.
// We also have to seed process.env.EXPO_PUBLIC_DOMAIN before
// `app/(tabs)/feed.tsx` is evaluated, because that module captures
// BASE_URL at module load time and FeedScreen's fetchFeed() builds its
// fetch target with `new URL(...)` (which rejects relative URLs under
// jsdom). vi.hoisted runs before the bare imports, so this is the safe
// place to set it.
const { latestPlaybackHandler, sharingMock, downloadMock, focusEffectMock } = vi.hoisted(() => {
  process.env.EXPO_PUBLIC_DOMAIN = "test.example.com";
  return {
    latestPlaybackHandler: { current: null as null | ((s: unknown) => void) },
    sharingMock: {
      isAvailableAsync: vi.fn(async () => true),
      shareAsync: vi.fn(async (_uri: string, _opts?: unknown) => {}),
    },
    downloadMock: vi.fn(async (_remote: string, target: { uri: string }) => target),
    // Capture the FeedScreen's useFocusEffect callback so the test can
    // actually invoke loadInitial / refreshFollowees instead of waiting
    // for an expo-router focus event that never arrives under jsdom.
    focusEffectMock: { current: null as null | (() => void | (() => void)) },
  };
});

vi.mock("expo-av", () => {
  const ReactInner = require("react") as typeof React;
  const Video = (props: { onPlaybackStatusUpdate?: (s: unknown) => void }) => {
    if (props.onPlaybackStatusUpdate) {
      latestPlaybackHandler.current = props.onPlaybackStatusUpdate;
    }
    return ReactInner.createElement("div", { "data-testid": "reel-video" });
  };
  return {
    Video,
    ResizeMode: { COVER: "cover", CONTAIN: "contain" },
  };
});

vi.mock("expo-sharing", () => sharingMock);

vi.mock("expo-file-system", () => {
  class File {
    uri: string;
    constructor(_dir: string, name: string) {
      this.uri = `file:///cache/${name}`;
    }
    get exists() { return false; }
    delete() {}
    static downloadFileAsync = (...args: Parameters<typeof downloadMock>) => downloadMock(...args);
  }
  return { File, Paths: { cache: "file:///cache" } };
});

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("expo-router", () => ({
  router: { push: vi.fn(), back: vi.fn(), replace: vi.fn() },
  // Capture the callback so the FeedScreen-level test can invoke it
  // explicitly. The PostCard-only tests below don't depend on this.
  useFocusEffect: (cb: () => void | (() => void)) => {
    focusEffectMock.current = cb;
  },
  Stack: { Screen: () => null },
}));

const VIEWER_USER_ID = 99;
const VIEWER_ORG_ID = 42;
const VIEWER_TOKEN = "test-token";

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: VIEWER_TOKEN,
    user: { id: VIEWER_USER_ID },
    orgId: VIEWER_ORG_ID,
  }),
}));

// feed.tsx pulls in useMoreBadges at module scope, which transitively loads
// expo-secure-store / expo-modules-core (not safe under jsdom). Stub it.
vi.mock("@/context/moreBadges", () => ({
  useMoreBadges: () => ({ markFeedSeen: vi.fn() }),
}));

vi.mock("@/i18n", () => ({
  getLocale: () => "en-US",
}));

vi.mock("@expo/vector-icons", () => {
  const Stub = (props: { name?: string }) =>
    React.createElement("span", { "data-icon": props?.name ?? "icon" });
  return { Feather: Stub, Ionicons: Stub, MaterialIcons: Stub };
});

import FeedScreen, { PostCard } from "../app/(tabs)/feed";

interface FeedFetchHandler {
  /** /organizations/:orgId/feed payload. */
  posts: unknown[];
  /** GET /api/portal/follows payload. */
  followeeIds: number[];
  followsCalls: number;
  feedCalls: number;
}

let feedHandler: FeedFetchHandler;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/api/portal/follows") && !/\/api\/portal\/follows\/\d+/.test(url)) {
      feedHandler.followsCalls += 1;
      return new Response(JSON.stringify({ followeeIds: feedHandler.followeeIds }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    if (url.includes("/feed")) {
      feedHandler.feedCalls += 1;
      return new Response(JSON.stringify({
        posts: feedHandler.posts,
        hasMore: false,
        nextCursor: null,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as unknown as Response;
  }) as typeof fetch;
}

type Post = Parameters<typeof PostCard>[0]["post"];
function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: 1001,
    type: "member_post",
    body: "Great round today!",
    privacy: "all_members",
    isPinned: false,
    taggedHoleNumber: null,
    achievementType: null,
    reactionsCount: 0,
    commentsCount: 0,
    createdAt: new Date().toISOString(),
    authorUserId: 7,
    authorDisplayName: "Some Member",
    authorUsername: "somemember",
    authorProfileImage: null,
    media: [],
    hasReacted: false,
    reelId: null,
    ...overrides,
  };
}

const baseProps = {
  orgId: VIEWER_ORG_ID,
  token: VIEWER_TOKEN,
  currentUserId: VIEWER_USER_ID,
  isAdmin: false,
  onDelete: vi.fn(),
  onReact: vi.fn(),
};

beforeEach(() => {
  latestPlaybackHandler.current = null;
  focusEffectMock.current = null;
  feedHandler = { posts: [], followeeIds: [], followsCalls: 0, feedCalls: 0 };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Task #1422 — feed post card Follow button hydration", () => {
  it("renders the Follow button in 'Follow' state when the author is NOT in the pre-fetched followee list", async () => {
    // Author user 7 — viewer is 99 (so !isOwner) and NOT yet following 7.
    const post = makePost({ authorUserId: 7 });
    render(<PostCard post={post} {...baseProps} followeeIds={[]} />);

    const btn = await screen.findByTestId("follow-button-7");
    expect(btn).toHaveTextContent(/^Follow$/);
    // Negative assertion: the "Following" label must not be present.
    expect(btn).not.toHaveTextContent(/Following/);
  });

  it("hydrates the button to 'Following' when the author IS in the pre-fetched followee list", async () => {
    const post = makePost({ authorUserId: 7 });
    // The parent's useFolloweeIds(token) returned [7] from /api/portal/follows
    // — feed.tsx then forwards it down so the FollowButton's
    // initialFollowing={followeeIds.includes(authorUserId)} is true.
    render(<PostCard post={post} {...baseProps} followeeIds={[7, 42]} />);

    const btn = await screen.findByTestId("follow-button-7");
    await waitFor(() => {
      expect(btn).toHaveTextContent(/^Following$/);
    });
  });

  it("does NOT render the Follow button on the viewer's own posts (the !isOwner guard)", async () => {
    // Author === viewer.
    const post = makePost({ authorUserId: VIEWER_USER_ID });
    // Even if the viewer's own id were in followeeIds (a corrupt API
    // response), the !isOwner guard at feed.tsx:291 must keep the button
    // off self-authored cards.
    render(<PostCard post={post} {...baseProps} followeeIds={[VIEWER_USER_ID]} />);

    // Wait for the card body to render.
    await screen.findByText(/Great round today!/);
    expect(screen.queryByTestId(`follow-button-${VIEWER_USER_ID}`)).toBeNull();
    // No follow-button-* of any kind should exist on this card.
    expect(screen.queryByTestId(/^follow-button-\d+$/)).toBeNull();
  });

  it("does NOT render the Follow button on posts with no author user id (anonymous / org announcements)", async () => {
    const post = makePost({
      authorUserId: null,
      type: "club_announcement",
      authorDisplayName: "KharaGolf Club",
    });
    render(<PostCard post={post} {...baseProps} followeeIds={[]} />);

    await screen.findByText(/Great round today!/);
    expect(screen.queryByTestId(/^follow-button-\d+$/)).toBeNull();
  });
});

describe("Task #1422 — feed-level pre-fetch wiring", () => {
  // This is the wiring assertion the task brief explicitly calls out:
  // "post cards in the feed render the FollowButton with initialFollowing
  // pre-populated from /api/portal/follows". The PostCard tests above
  // inject `followeeIds` directly, so a regression where FeedScreen
  // stops pulling /api/portal/follows or stops forwarding the result
  // would still slip past them. This test mounts the actual FeedScreen
  // so the parent wiring is exercised end-to-end.
  it("FeedScreen pulls /api/portal/follows and forwards followee IDs into each post card's FollowButton", async () => {
    feedHandler.followeeIds = [7];
    feedHandler.posts = [
      // Post by user 7 — viewer (99) is following them, so the button
      // should hydrate as "Following" thanks to the pre-fetch.
      makePost({
        id: 1,
        authorUserId: 7,
        authorDisplayName: "Already Followed",
        body: "Pre-followed post",
      }),
      // Post by user 8 — viewer is NOT following them, so the button
      // should render as "Follow".
      makePost({
        id: 2,
        authorUserId: 8,
        authorDisplayName: "Not Followed",
        body: "Net new author",
      }),
    ];

    render(<FeedScreen />);

    // FeedScreen kicks loadInitial + refreshFollowees off useFocusEffect,
    // which doesn't fire under jsdom. Invoke the captured callback so
    // the screen actually fetches its initial data.
    await waitFor(() => expect(focusEffectMock.current).not.toBeNull());
    await waitFor(async () => {
      const ret = focusEffectMock.current?.();
      // useFocusEffect callbacks may return a cleanup fn — ignore it.
      void ret;
      expect(feedHandler.feedCalls).toBeGreaterThanOrEqual(1);
    });

    // The pre-fetch endpoint actually fired — locking in the wiring
    // (the regression the task brief specifically calls out).
    await waitFor(() => expect(feedHandler.followsCalls).toBeGreaterThanOrEqual(1));

    const btn7 = await screen.findByTestId("follow-button-7");
    const btn8 = await screen.findByTestId("follow-button-8");

    // The button for the pre-fetched followee hydrates to "Following"
    // (initialFollowing=true forwarded from useFolloweeIds()).
    await waitFor(() => {
      expect(btn7).toHaveTextContent(/^Following$/);
    });
    // And the button for the not-yet-followed author renders as "Follow".
    expect(btn8).toHaveTextContent(/^Follow$/);
  });
});
