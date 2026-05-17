/**
 * Task #865 — End-to-end coverage for the web feed's reel engagement pings.
 *
 * The API-side contract for POST /api/portal/highlights/:id/events
 * (auth, event-type whitelist, count aggregation) is covered against the
 * live PostgreSQL test DB by
 * artifacts/api-server/src/tests/highlight-engagement-types.test.ts.
 *
 * This test exercises the *client wiring* on the web feed's <PostCard /> for
 * highlight-reel posts (the bit that previously had zero automated coverage):
 *
 *   1. Once a feed video crosses the 2s playback threshold, the card fires
 *      exactly one POST /events with { type: "view", source: "web_feed" }.
 *      Repeated time-update events past 2s do not double-fire.
 *   2. The new "Share" button only renders when post.reelId is set AND the
 *      post has video media. Clicking it copies the absolute reel URL to
 *      the clipboard (the navigator.share-less fallback path used in CI)
 *      and POSTs { type: "feed_share", source: "web_feed" }.
 *   3. Non-reel posts (post.reelId === null) never fire engagement pings
 *      and never render the Share button — guards the regression where the
 *      ping was wired to fire for any video.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { PostCard } from "../feed";

interface EngagementCall { type: string; source: string }

let engagementCalls: EngagementCall[];
let lastEngagementUrl: string | null;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/api/portal/highlights/") && url.endsWith("/events") && method === "POST") {
      lastEngagementUrl = url;
      engagementCalls.push(JSON.parse((init?.body as string) ?? "{}"));
      return new Response(JSON.stringify({ ok: true, viewCount: 1, downloadCount: 0, shareCount: 0, feedShareCount: 0 }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    // Comments lookup, etc — unused by these assertions, return empties.
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
  }) as typeof fetch;
}

function makeReelPost(overrides: Partial<Parameters<typeof PostCard>[0]["post"]> = {}) {
  return {
    id: 101,
    type: "member_post" as const,
    body: "Birdie reel from yesterday",
    privacy: "all_members" as const,
    isPinned: false,
    isHidden: false,
    taggedCourseId: null,
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
  currentUserId: 99,
  isAdmin: false,
  onDelete: vi.fn(),
  onReact: vi.fn(),
  onPin: vi.fn(),
  onHide: vi.fn(),
};

beforeEach(() => {
  engagementCalls = [];
  lastEngagementUrl = null;
  toastMock.mockReset();
  installFetch();
  // The shareReelFromFeed code first checks for `navigator.share`. We want
  // to exercise the clipboard fallback in CI, so we make sure no `share`
  // method is exposed.
  // (jsdom doesn't define one by default, but be explicit.)
  delete (navigator as unknown as { share?: unknown }).share;
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(async () => undefined) },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Task #865 — web feed reel engagement pings", () => {
  it("fires a single 'view' engagement ping once the video crosses 2s of playback", async () => {
    const post = makeReelPost();
    render(<PostCard post={post} {...baseProps} />);

    const video = document.querySelector("video") as HTMLVideoElement;
    expect(video).toBeTruthy();

    // First ping below the 2s threshold — must NOT log.
    Object.defineProperty(video, "currentTime", { value: 1.2, configurable: true });
    fireEvent.timeUpdate(video);
    expect(engagementCalls.length).toBe(0);

    // Cross the threshold — exactly one 'view' ping should fire.
    Object.defineProperty(video, "currentTime", { value: 2.5, configurable: true });
    fireEvent.timeUpdate(video);
    await waitFor(() => expect(engagementCalls.length).toBe(1));
    expect(engagementCalls[0]).toEqual({ type: "view", source: "web_feed" });
    expect(lastEngagementUrl).toContain("/api/portal/highlights/55/events");

    // Subsequent timeUpdates past the threshold must NOT re-fire (prevents
    // floods on long videos).
    Object.defineProperty(video, "currentTime", { value: 5, configurable: true });
    fireEvent.timeUpdate(video);
    Object.defineProperty(video, "currentTime", { value: 12, configurable: true });
    fireEvent.timeUpdate(video);
    await new Promise(r => setTimeout(r, 0));
    expect(engagementCalls.length).toBe(1);
  });

  it("clicking the Share button copies the reel URL and fires a 'feed_share' ping", async () => {
    const post = makeReelPost();
    render(<PostCard post={post} {...baseProps} />);

    const shareBtn = screen.getByRole("button", { name: /share/i });
    expect(shareBtn).toBeInTheDocument();

    await userEvent.click(shareBtn);

    // Clipboard fallback: absolute URL was copied.
    const writeText = (navigator.clipboard as unknown as { writeText: ReturnType<typeof vi.fn> }).writeText;
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toMatch(/\/objects\/reels\/abc\.mp4$/);
    expect(/^https?:\/\//.test(copied)).toBe(true);

    // Engagement ping with the right type + source.
    await waitFor(() => expect(engagementCalls.length).toBe(1));
    expect(engagementCalls[0]).toEqual({ type: "feed_share", source: "web_feed" });
    expect(lastEngagementUrl).toContain("/api/portal/highlights/55/events");

    // User-facing confirmation toast.
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/copied/i) }),
    );
  });

  it("does NOT render the Share button or fire engagement pings for non-reel posts", async () => {
    const post = makeReelPost({ reelId: null });
    render(<PostCard post={post} {...baseProps} />);

    expect(screen.queryByRole("button", { name: /share/i })).toBeNull();

    const video = document.querySelector("video") as HTMLVideoElement;
    expect(video).toBeTruthy();
    Object.defineProperty(video, "currentTime", { value: 5, configurable: true });
    fireEvent.timeUpdate(video);
    await new Promise(r => setTimeout(r, 0));
    expect(engagementCalls.length).toBe(0);
  });
});
