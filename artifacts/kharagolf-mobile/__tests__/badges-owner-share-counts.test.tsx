/**
 * Task #1251 — UI coverage for the per-badge "Shared N times" indicator on
 * the mobile /badges screen, added in Task #1095. Mirrors the website
 * coverage in `public-profile-owner-badge-share.test.tsx`.
 *
 * The mobile screen always shows the signed-in user their own badges, so
 * "owner-only" is implicit — there is no other-viewer surface. We assert:
 *   1. After /api/portal/me/badge-share-stats resolves, the indicator
 *      renders for each unlocked badge with count > 0 with the correct
 *      count and pluralization ("Shared 5 times" vs "Shared 1 time").
 *   2. The indicator is hidden on locked badges entirely (the source gates
 *      the Text on `b.unlocked`).
 *   3. The indicator is hidden when the count is 0 — either because the
 *      badge is missing from the share-stats response or the response
 *      explicitly returned 0. We don't show "Shared 0 times" because it
 *      is noisy social proof for a never-shared badge.
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/context/auth", () => ({
  useAuth: () => ({ token: "fake-token" }),
}));

vi.mock("react-native", async () => {
  const actual = await vi.importActual<typeof import("react-native")>("react-native");
  return {
    ...actual,
    Share: { share: vi.fn(), sharedAction: "sharedAction", dismissedAction: "dismissedAction" },
    Alert: { alert: vi.fn() },
  };
});

vi.mock("@/app/my-360/_shared", () => ({
  authedFetch: vi.fn(),
  BASE_URL: "https://api.test",
}));

vi.mock("@/i18n", () => ({ getLocale: () => "en-US" }));

import BadgesScreen from "@/app/badges";
import { authedFetch } from "@/app/my-360/_shared";

const HANDLE = "tigerw";

const UNLOCKED_BIRDIE = {
  type: "first_birdie",
  label: "First Birdie",
  icon: "🐦",
  category: "milestone",
  description: "Score your first birdie.",
  unlocked: true,
  earnedAt: "2025-08-01T10:00:00Z",
  progress: null,
};

const UNLOCKED_EAGLE = {
  type: "first_eagle",
  label: "First Eagle",
  icon: "🦅",
  category: "milestone",
  description: "Score your first eagle.",
  unlocked: true,
  earnedAt: "2025-08-15T10:00:00Z",
  progress: null,
};

const LOCKED_WITH_PROGRESS = {
  type: "10_rounds",
  label: "10 Rounds Played",
  icon: "🏅",
  category: "consistency",
  description: "Complete 10 rounds.",
  unlocked: false,
  earnedAt: null,
  progress: { current: 4, target: 10 },
};

function buildMyBadgesPayload() {
  return {
    badges: [UNLOCKED_BIRDIE, UNLOCKED_EAGLE, LOCKED_WITH_PROGRESS],
    unlockedCount: 2,
    totalCount: 3,
    publicHandle: HANDLE,
    canShare: true,
  };
}

interface MockableFn {
  mockReset: () => void;
  mockImplementation: (fn: (...args: unknown[]) => unknown) => void;
}

beforeEach(() => {
  (authedFetch as unknown as MockableFn).mockReset();
  (globalThis as { fetch?: unknown }).fetch = vi.fn().mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
});

function stubAuthedFetchWith(stats: { total: number; badges: Array<{ badgeType: string; total: number }> }) {
  (authedFetch as unknown as MockableFn).mockImplementation((path: unknown) => {
    if (path === "/api/portal/my-badges") {
      return Promise.resolve(buildMyBadgesPayload());
    }
    if (path === "/api/portal/me/badge-share-stats") {
      return Promise.resolve(stats);
    }
    return Promise.reject(new Error(`unexpected authedFetch path: ${String(path)}`));
  });
}

describe("BadgesScreen — per-badge share-count indicator (Task #1251)", () => {
  it("renders 'Shared N times' for unlocked badges with the correct count and pluralization", async () => {
    stubAuthedFetchWith({
      total: 6,
      badges: [
        { badgeType: "first_birdie", total: 5 },
        { badgeType: "first_eagle", total: 1 },
      ],
    });

    render(<BadgesScreen /> as ReactNode);

    const birdie = await screen.findByTestId("badge-share-count-first_birdie");
    const eagle = await screen.findByTestId("badge-share-count-first_eagle");

    expect(birdie).toHaveTextContent(/^Shared 5 times$/);
    // Singular form when the count is exactly 1.
    expect(eagle).toHaveTextContent(/^Shared 1 time$/);
  });

  it("hides the share-count indicator on locked badges", async () => {
    stubAuthedFetchWith({
      total: 5,
      badges: [
        { badgeType: "first_birdie", total: 5 },
        // Even if the API returns a count for a locked badge, the row only
        // renders the indicator when `b.unlocked === true`.
        { badgeType: "10_rounds", total: 99 },
      ],
    });

    render(<BadgesScreen /> as ReactNode);

    // Wait for the unlocked indicator so the badges fetch + share-stats
    // fetch have both resolved before the absence assertion runs.
    await screen.findByTestId("badge-share-count-first_birdie");

    expect(screen.queryByTestId("badge-share-count-10_rounds")).not.toBeInTheDocument();
    // The locked badge row itself still renders normally.
    expect(screen.getByTestId("badge-10_rounds")).toBeInTheDocument();
  });

  it("hides the share-count indicator for an unlocked badge with no entry in the share-stats response (count is 0)", async () => {
    // Stats endpoint only returns one badge — first_eagle has no entry, so
    // its count defaults to 0 and the indicator must NOT render.
    stubAuthedFetchWith({
      total: 5,
      badges: [{ badgeType: "first_birdie", total: 5 }],
    });

    render(<BadgesScreen /> as ReactNode);

    // Wait for first_birdie's indicator so the share-stats fetch has
    // resolved before asserting the absence on first_eagle.
    await screen.findByTestId("badge-share-count-first_birdie");

    expect(screen.queryByTestId("badge-share-count-first_eagle")).not.toBeInTheDocument();
    // The unlocked first_eagle row itself still renders.
    expect(screen.getByTestId("badge-first_eagle")).toBeInTheDocument();
  });

  it("hides the share-count indicator when the share-stats response explicitly reports 0 shares", async () => {
    // Even if the API returns an explicit 0, we hide the indicator —
    // "Shared 0 times" is noisy social proof for a never-shared badge.
    stubAuthedFetchWith({
      total: 5,
      badges: [
        { badgeType: "first_birdie", total: 5 },
        { badgeType: "first_eagle", total: 0 },
      ],
    });

    render(<BadgesScreen /> as ReactNode);

    await screen.findByTestId("badge-share-count-first_birdie");
    expect(screen.queryByTestId("badge-share-count-first_eagle")).not.toBeInTheDocument();
  });
});
