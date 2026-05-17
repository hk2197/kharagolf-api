/**
 * Task #865 — End-to-end coverage for the mobile feed's reel engagement pings.
 *
 * The API-side contract for POST /api/portal/highlights/:id/events
 * (auth, event-type whitelist, count aggregation) is covered against the
 * live PostgreSQL test DB by
 * artifacts/api-server/src/tests/highlight-engagement-types.test.ts.
 *
 * This test exercises the *mobile client wiring* on the (tabs)/feed.tsx
 * <PostCard /> for highlight-reel posts (the bit that previously had no
 * automated coverage). A genuine Detox run on a simulator is too heavy for
 * the regular CI; this is the lightweight equivalent the task description
 * called out ("a unit test that mocks `onPlaybackStatusUpdate`"):
 *
 *   1. Once expo-av's onPlaybackStatusUpdate reports positionMillis ≥ 2000,
 *      the card fires exactly one POST /events with
 *      { type: "view", source: "mobile_feed" }. Sub-2s status updates do
 *      NOT fire, and repeated >=2s status updates do not double-fire.
 *   2. The new "Share" button only renders when post.reelId is set AND the
 *      post has video media. Pressing it downloads the reel into the cache
 *      dir, hands the local file URI to expo-sharing, and POSTs
 *      { type: "feed_share", source: "mobile_feed" }.
 *   3. Non-reel posts (post.reelId === null) never render the Share button
 *      and never fire engagement pings.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Hoisted mock state — vi.mock factories run before module-scope variables
// initialise, so anything the factory touches has to live inside vi.hoisted.
const { latestPlaybackHandler, sharingMock, downloadMock } = vi.hoisted(() => ({
  // Mutable ref that always points to the *most recent* render's
  // onPlaybackStatusUpdate callback. Re-renders create fresh closures
  // (the implementation uses a useState flag, not a ref) so we have
  // to overwrite this on every render to avoid stale-closure reads.
  latestPlaybackHandler: { current: null as null | ((s: unknown) => void) },
  sharingMock: {
    isAvailableAsync: vi.fn(async () => true),
    shareAsync: vi.fn(async (_uri: string, _opts?: unknown) => {}),
  },
  downloadMock: vi.fn(async (_remote: string, target: { uri: string }) => target),
}));

// expo-av — capture the onPlaybackStatusUpdate prop so we can drive it
// directly from the test instead of relying on real video playback. The
// test stub renders a div tagged with data-testid="reel-video".
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

// expo-sharing — pretend the share sheet is available and accepts the
// hand-off without throwing.
vi.mock("expo-sharing", () => sharingMock);

// expo-file-system — stub the File class & Paths.cache used by the share
// helper to download the reel into a local cache file.
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

vi.mock("@/context/auth", () => ({
  useAuth: () => ({ token: "test-token", user: { id: 99 }, orgId: 42 }),
}));

// `feed.tsx` imports useMoreBadges at module scope; that module
// transitively pulls in expo-secure-store / expo-modules-core, which
// can't load under jsdom. Stub it out so PostCard renders cleanly.
vi.mock("@/context/moreBadges", () => ({
  useMoreBadges: () => ({ markFeedSeen: vi.fn() }),
}));

vi.mock("@/i18n", () => ({
  getLocale: () => "en-US",
}));

// Match the existing setup.ts pattern — Feather icons render as a stub
// so we don't need to wire up vector-icon assets.
vi.mock("@expo/vector-icons", () => {
  const Stub = (props: { name?: string }) =>
    React.createElement("span", { "data-icon": props?.name ?? "icon" });
  return { Feather: Stub, Ionicons: Stub, MaterialIcons: Stub };
});

import { PostCard } from "../app/(tabs)/feed";

interface EngagementCall { type: string; source: string }
let engagementCalls: EngagementCall[];
let lastEngagementUrl: string | null;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/api/portal/highlights/") && url.endsWith("/events") && method === "POST") {
      lastEngagementUrl = url;
      engagementCalls.push(JSON.parse((init?.body as string) ?? "{}"));
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as unknown as Response;
  }) as typeof fetch;
}

function makeReelPost(overrides: Partial<Parameters<typeof PostCard>[0]["post"]> = {}) {
  return {
    id: 101,
    type: "member_post" as const,
    body: "Birdie reel from yesterday",
    privacy: "all_members" as const,
    isPinned: false,
    taggedHoleNumber: null,
    achievementType: null,
    reactionsCount: 0,
    commentsCount: 0,
    createdAt: new Date().toISOString(),
    authorUserId: 7,
    authorDisplayName: "Reel Owner",
    authorUsername: "reelowner",
    authorProfileImage: null,
    media: [{ url: "/objects/reels/abc.mp4", mimeType: "video/mp4", sortOrder: 0 }],
    hasReacted: false,
    reelId: 55,
    ...overrides,
  };
}

const baseProps = {
  orgId: 42,
  token: "test-token",
  currentUserId: 99,
  isAdmin: false,
  followeeIds: [] as number[],
  onDelete: vi.fn(),
  onReact: vi.fn(),
};

beforeEach(() => {
  engagementCalls = [];
  lastEngagementUrl = null;
  latestPlaybackHandler.current = null;
  sharingMock.isAvailableAsync.mockClear();
  sharingMock.shareAsync.mockClear();
  downloadMock.mockClear();
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Task #865 — mobile feed reel engagement pings", () => {
  it("fires a single 'view' engagement ping once playback crosses the 2s threshold", async () => {
    const post = makeReelPost();
    render(<PostCard post={post} {...baseProps} />);

    await waitFor(() => expect(latestPlaybackHandler.current).not.toBeNull());
    // Always read .current at fire-time so we pick up the freshest closure
    // (the implementation re-renders after state updates).
    const onPlayback = (status: unknown) => latestPlaybackHandler.current?.(status);

    // Sub-threshold update — must NOT fire.
    act(() => {
      onPlayback({ isLoaded: true, positionMillis: 800 });
    });
    expect(engagementCalls.length).toBe(0);

    // Cross the 2s threshold — exactly one 'view' ping should fire.
    act(() => {
      onPlayback({ isLoaded: true, positionMillis: 2100 });
    });
    await waitFor(() => expect(engagementCalls.length).toBe(1));
    expect(engagementCalls[0]).toEqual({ type: "view", source: "mobile_feed" });
    expect(lastEngagementUrl).toContain("/api/portal/highlights/55/events");

    // Subsequent updates at or past threshold must NOT re-fire, even when
    // expo-av delivers them back-to-back in a single tick (Task #1014).
    act(() => {
      onPlayback({ isLoaded: true, positionMillis: 5000 });
      onPlayback({ isLoaded: true, positionMillis: 12000 });
    });
    await new Promise(r => setTimeout(r, 0));
    expect(engagementCalls.length).toBe(1);

    // A status update from a not-yet-loaded video should never fire either.
    act(() => {
      onPlayback({ isLoaded: false });
    });
    await new Promise(r => setTimeout(r, 0));
    expect(engagementCalls.length).toBe(1);
  });

  it("Task #1014 — a synchronous burst of >=2s status updates only fires one 'view' ping", async () => {
    const post = makeReelPost();
    render(<PostCard post={post} {...baseProps} />);

    await waitFor(() => expect(latestPlaybackHandler.current).not.toBeNull());
    const onPlayback = (status: unknown) => latestPlaybackHandler.current?.(status);

    // Simulate expo-av delivering several past-threshold status updates
    // in a single tick (e.g. after a stall recovers). With the previous
    // useState-based gate every callback would observe the stale `false`
    // and each fire its own POST; the ref-based gate must collapse them
    // down to exactly one ping.
    act(() => {
      onPlayback({ isLoaded: true, positionMillis: 2100 });
      onPlayback({ isLoaded: true, positionMillis: 2200 });
      onPlayback({ isLoaded: true, positionMillis: 2300 });
      onPlayback({ isLoaded: true, positionMillis: 2400 });
      onPlayback({ isLoaded: true, positionMillis: 2500 });
    });
    await new Promise(r => setTimeout(r, 0));
    expect(engagementCalls.length).toBe(1);
    expect(engagementCalls[0]).toEqual({ type: "view", source: "mobile_feed" });
  });

  it("pressing Share downloads the reel, opens the share sheet, and fires a 'feed_share' ping", async () => {
    const post = makeReelPost();
    render(<PostCard post={post} {...baseProps} />);

    const shareBtn = await screen.findByText(/share/i);
    fireEvent.click(shareBtn);

    // Local download happened with the absolute remote URL.
    await waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(1));
    const remote = downloadMock.mock.calls[0][0] as string;
    expect(remote).toMatch(/\/objects\/reels\/abc\.mp4$/);

    // Share sheet was handed the *local* cache URI (not the remote URL —
    // expo-sharing fails silently on most devices when given a remote URL).
    await waitFor(() => expect(sharingMock.shareAsync).toHaveBeenCalledTimes(1));
    const sharedUri = sharingMock.shareAsync.mock.calls[0][0] as string;
    expect(sharedUri.startsWith("file://")).toBe(true);

    // Engagement ping with the right type + source.
    await waitFor(() => expect(engagementCalls.length).toBe(1));
    expect(engagementCalls[0]).toEqual({ type: "feed_share", source: "mobile_feed" });
    expect(lastEngagementUrl).toContain("/api/portal/highlights/55/events");
  });

  it("does NOT render the Share button or fire engagement pings for non-reel posts", async () => {
    const post = makeReelPost({ reelId: null });
    render(<PostCard post={post} {...baseProps} />);

    expect(screen.queryByText(/share/i)).toBeNull();

    // Even if a video status update somehow fires (e.g. another video on
    // the same screen), no ping should leave the device for a non-reel post.
    if (latestPlaybackHandler.current) {
      act(() => {
        latestPlaybackHandler.current?.({ isLoaded: true, positionMillis: 5000 });
      });
    }
    await new Promise(r => setTimeout(r, 0));
    expect(engagementCalls.length).toBe(0);
  });
});
