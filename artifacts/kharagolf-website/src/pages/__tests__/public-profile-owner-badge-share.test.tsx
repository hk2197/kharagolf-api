/**
 * Task #1251 — UI coverage for the owner-only "Shared N times" indicator
 * added in Task #1095 under each unlocked badge on the public profile.
 *
 * The indicator MUST only render when:
 *   - The signed-in viewer's publicHandle (from GET /api/portal/me) matches
 *     the handle of the profile being viewed (case-insensitive).
 *   - GET /api/portal/me/badge-share-stats returns successfully.
 *
 * Specifically asserts:
 *   1. Owner viewing their own profile → indicator renders for each
 *      unlocked badge with the correct count and pluralization
 *      ("Shared 5 times" vs. "Shared 1 time").
 *   2. Owner sees no indicator on locked badges (they live inside the
 *      `isUnlocked` branch of the catalog row).
 *   3. Logged-out visitor (GET /api/portal/me → 401) → indicator hidden.
 *   4. Visitor viewing someone else's profile (GET /api/portal/me returns a
 *      different publicHandle) → indicator hidden, and the share-stats
 *      endpoint is NOT called at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,QRSTUB") },
}));

import PublicProfilePage from "../public-profile";

const HANDLE = "tigerw";

const CATALOG = [
  { type: "first_birdie", label: "First Birdie", icon: "🐦", category: "milestone", description: "Score your first birdie" },
  { type: "first_eagle", label: "First Eagle", icon: "🦅", category: "milestone", description: "Score your first eagle" },
  { type: "10_rounds", label: "10 Rounds Played", icon: "🏅", category: "consistency", description: "Complete 10 rounds" },
];

function buildProfilePayload() {
  return {
    handle: HANDLE,
    displayName: "Tiger W",
    profileImage: null,
    bio: null,
    location: null,
    homeClub: null,
    memberSince: "2020-01-01T00:00:00.000Z",
    privacy: {
      showHandicap: false,
      showRecentRounds: false,
      showAchievements: true,
      showFavoriteCourses: false,
    },
    currentHandicap: null,
    handicapJourney: [],
    recentRounds: [],
    achievements: [
      {
        badgeType: "first_birdie",
        badgeLabel: "First Birdie",
        badgeIcon: "🐦",
        badgeCategory: "milestone",
        badgeDescription: "Score your first birdie",
        earnedAt: "2025-08-01T10:00:00.000Z",
      },
      {
        badgeType: "first_eagle",
        badgeLabel: "First Eagle",
        badgeIcon: "🦅",
        badgeCategory: "milestone",
        badgeDescription: "Score your first eagle",
        earnedAt: "2025-08-15T10:00:00.000Z",
      },
    ],
    badgeCatalog: CATALOG,
    badgeProgress: { "10_rounds": { current: 4, target: 10 } },
    favoriteCourses: [],
    deepLinks: { web: "https://example.com/web", mobile: "kharagolf://p/tigerw" },
  };
}

interface FetchScenario {
  meStatus: number;
  mePayload?: { publicHandle: string | null };
  shareStatsPayload?: { total: number; badges: Array<{ badgeType: string; total: number }> };
}

function stubFetch(scenario: FetchScenario) {
  const calls = { profile: 0, me: 0, shareStats: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === `/api/public/p/${HANDLE}`) {
        calls.profile += 1;
        return new Response(JSON.stringify(buildProfilePayload()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/portal/me") {
        calls.me += 1;
        return new Response(
          scenario.mePayload ? JSON.stringify(scenario.mePayload) : "",
          { status: scenario.meStatus, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/api/portal/me/badge-share-stats") {
        calls.shareStats += 1;
        return new Response(
          scenario.shareStatsPayload ? JSON.stringify(scenario.shareStatsPayload) : "{}",
          { status: scenario.shareStatsPayload ? 200 : 404, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "unexpected", url }), { status: 404 });
    }),
  );
  return calls;
}

function renderProfilePage() {
  const { hook } = memoryLocation({ path: `/p/${HANDLE}` });
  return render(
    <WouterRouter hook={hook}>
      <PublicProfilePage />
    </WouterRouter>,
  );
}

beforeEach(() => {
  document.head
    .querySelectorAll('meta[property], meta[name="twitter:image"], meta[name="twitter:title"], meta[name="twitter:description"], meta[name="twitter:card"], meta[name="description"]')
    .forEach(el => el.remove());
  document.title = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Owner-only badge share-count indicator on /p/<handle> (Task #1251)", () => {
  it("renders 'Shared N times' under each unlocked badge for the owner with correct pluralization", async () => {
    const calls = stubFetch({
      meStatus: 200,
      mePayload: { publicHandle: HANDLE },
      shareStatsPayload: {
        total: 6,
        badges: [
          { badgeType: "first_birdie", total: 5 },
          { badgeType: "first_eagle", total: 1 },
        ],
      },
    });

    renderProfilePage();

    // Wait for both unlocked-badge indicators to appear (driven by the
    // owner-detect + share-stats fetches resolving).
    const birdieIndicator = await screen.findByTestId("badge-share-count-first_birdie");
    const eagleIndicator = await screen.findByTestId("badge-share-count-first_eagle");

    expect(birdieIndicator).toHaveTextContent(/^Shared 5 times$/);
    // Singular form when the count is exactly 1.
    expect(eagleIndicator).toHaveTextContent(/^Shared 1 time$/);

    // Sanity-check the owner gate ran the two expected fetches.
    expect(calls.me).toBe(1);
    expect(calls.shareStats).toBe(1);
  });

  it("does not render the share-count indicator on locked badges, even for the owner", async () => {
    stubFetch({
      meStatus: 200,
      mePayload: { publicHandle: HANDLE },
      shareStatsPayload: {
        total: 5,
        badges: [
          { badgeType: "first_birdie", total: 5 },
          // Even if the API somehow returned a count for a locked badge,
          // the catalog row hides it because it lives inside the
          // `isUnlocked` branch.
          { badgeType: "10_rounds", total: 99 },
        ],
      },
    });

    renderProfilePage();

    // Wait for the unlocked indicator so we know the owner gate has run.
    await screen.findByTestId("badge-share-count-first_birdie");

    expect(screen.queryByTestId("badge-share-count-10_rounds")).not.toBeInTheDocument();
  });

  it("hides the share-count indicator for logged-out visitors (GET /api/portal/me → 401)", async () => {
    const calls = stubFetch({
      meStatus: 401,
      shareStatsPayload: {
        total: 5,
        badges: [{ badgeType: "first_birdie", total: 5 }],
      },
    });

    renderProfilePage();

    // Wait for the badges section so the absence assertion is meaningful —
    // the owner-detect effect has had time to resolve the /me fetch by then.
    await screen.findByTestId("section-achievements");

    expect(screen.queryByTestId("badge-share-count-first_birdie")).not.toBeInTheDocument();
    expect(screen.queryByTestId("badge-share-count-first_eagle")).not.toBeInTheDocument();

    // /me ran but share-stats must NOT be called when the viewer isn't signed in.
    expect(calls.me).toBe(1);
    expect(calls.shareStats).toBe(0);
  });

  it("hides the share-count indicator when a different signed-in user views the profile", async () => {
    const calls = stubFetch({
      meStatus: 200,
      mePayload: { publicHandle: "someone_else" },
      shareStatsPayload: {
        total: 5,
        badges: [{ badgeType: "first_birdie", total: 5 }],
      },
    });

    renderProfilePage();

    await screen.findByTestId("section-achievements");

    expect(screen.queryByTestId("badge-share-count-first_birdie")).not.toBeInTheDocument();
    expect(screen.queryByTestId("badge-share-count-first_eagle")).not.toBeInTheDocument();

    // Critically, share-stats must NOT be requested when /me's publicHandle
    // does not match the viewed profile's handle. This protects against
    // accidentally leaking another user's owner-only counts.
    expect(calls.me).toBe(1);
    expect(calls.shareStats).toBe(0);
  });

  it("treats publicHandle case-insensitively when deciding whether to render the indicator", async () => {
    stubFetch({
      meStatus: 200,
      // Different casing on the server-reported publicHandle vs. the URL handle.
      mePayload: { publicHandle: "TigerW" },
      shareStatsPayload: {
        total: 7,
        badges: [{ badgeType: "first_birdie", total: 7 }],
      },
    });

    renderProfilePage();

    const indicator = await screen.findByTestId("badge-share-count-first_birdie");
    expect(indicator).toHaveTextContent(/^Shared 7 times$/);
  });

  it("renders 'Shared 0 times' for an unlocked badge the owner has never shared (still gated on owner detection)", async () => {
    // Owner is detected, share-stats responds with no entry for first_eagle.
    // The component falls back to 0 inside the owner branch, so the indicator
    // renders with the plural "0 times" — and a visitor would still see no
    // indicator at all (covered separately above).
    stubFetch({
      meStatus: 200,
      mePayload: { publicHandle: HANDLE },
      shareStatsPayload: {
        total: 5,
        badges: [{ badgeType: "first_birdie", total: 5 }],
      },
    });

    renderProfilePage();

    await screen.findByTestId("badge-share-count-first_birdie");
    const eagle = await screen.findByTestId("badge-share-count-first_eagle");
    expect(eagle).toHaveTextContent(/^Shared 0 times$/);
  });
});
