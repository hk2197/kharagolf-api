/**
 * Task #1080 — UI coverage for the per-badge Share button on the mobile
 * achievements screen, mirroring the website coverage added in Task #927.
 *
 * Asserts:
 *   1. Visibility rule — share buttons render for unlocked badges, and are
 *      gated entirely by `canShare` + `publicHandle` from the API. When the
 *      player has not opted into public sharing, NO badge gets a share
 *      button. (Note: as of Task #1071 locked badges with progress also
 *      surface a share button — both are covered here.)
 *   2. Tapping a share button on an unlocked badge invokes the native share
 *      sheet (React Native's `Share.share`) with:
 *        - the canonical deep link `https://kharagolf.com/p/<handle>/badge/<type>`
 *        - a title containing both the player handle and the badge label
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/context/auth", () => ({
  useAuth: () => ({ token: "fake-token" }),
}));

const { shareMock } = vi.hoisted(() => ({ shareMock: vi.fn() }));

vi.mock("react-native", async () => {
  const actual = await vi.importActual<typeof import("react-native")>("react-native");
  return {
    ...actual,
    Share: {
      share: shareMock,
      sharedAction: "sharedAction",
      dismissedAction: "dismissedAction",
    },
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

const UNLOCKED_BADGE = {
  type: "first_birdie",
  label: "First Birdie",
  icon: "🐦",
  category: "milestone",
  description: "Score your first birdie.",
  unlocked: true,
  earnedAt: "2025-08-01T10:00:00Z",
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

function buildPayload(overrides: Partial<{ canShare: boolean; publicHandle: string | null }> = {}) {
  return {
    badges: [UNLOCKED_BADGE, LOCKED_WITH_PROGRESS],
    unlockedCount: 1,
    totalCount: 2,
    publicHandle: HANDLE,
    canShare: true,
    ...overrides,
  };
}

beforeEach(() => {
  shareMock.mockReset();
  shareMock.mockResolvedValue({ action: "sharedAction" });
  (authedFetch as unknown as { mockReset: () => void }).mockReset();
  (globalThis as { fetch?: unknown }).fetch = vi.fn().mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
});

describe("BadgesScreen — per-badge Share button visibility (Task #1080)", () => {
  it("renders a Share button on unlocked badges when sharing is enabled", async () => {
    (authedFetch as unknown as { mockResolvedValue: (v: unknown) => void })
      .mockResolvedValue(buildPayload());

    render(<BadgesScreen /> as ReactNode);

    expect(await screen.findByTestId(`badge-share-${UNLOCKED_BADGE.type}`)).toBeInTheDocument();
  });

  it("does NOT render any per-badge Share button when canShare=false", async () => {
    (authedFetch as unknown as { mockResolvedValue: (v: unknown) => void })
      .mockResolvedValue(buildPayload({ canShare: false }));

    render(<BadgesScreen /> as ReactNode);

    // Wait for the catalog to render so the absence assertion is meaningful.
    await screen.findByTestId(`badge-${UNLOCKED_BADGE.type}`);

    expect(screen.queryByTestId(`badge-share-${UNLOCKED_BADGE.type}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`badge-share-${LOCKED_WITH_PROGRESS.type}`)).not.toBeInTheDocument();
  });

  it("does NOT render any per-badge Share button when there is no public handle", async () => {
    (authedFetch as unknown as { mockResolvedValue: (v: unknown) => void })
      .mockResolvedValue(buildPayload({ publicHandle: null }));

    render(<BadgesScreen /> as ReactNode);

    await screen.findByTestId(`badge-${UNLOCKED_BADGE.type}`);

    expect(screen.queryByTestId(`badge-share-${UNLOCKED_BADGE.type}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`badge-share-${LOCKED_WITH_PROGRESS.type}`)).not.toBeInTheDocument();
  });
});

describe("BadgesScreen — per-badge Share button native share payload (Task #1080)", () => {
  it("opens the native share sheet with the canonical /p/<handle>/badge/<type> URL and a title containing the player handle + badge label", async () => {
    (authedFetch as unknown as { mockResolvedValue: (v: unknown) => void })
      .mockResolvedValue(buildPayload());

    render(<BadgesScreen /> as ReactNode);

    const btn = await screen.findByTestId(`badge-share-${UNLOCKED_BADGE.type}`);
    fireEvent.click(btn);

    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    const arg = shareMock.mock.calls[0][0];
    expect(arg.url).toBe(`https://kharagolf.com/p/${HANDLE}/badge/${UNLOCKED_BADGE.type}`);
    expect(arg.title).toContain(UNLOCKED_BADGE.label);
    expect(arg.title).toContain(HANDLE);
    // The message body should reference the badge and the canonical deep link too.
    expect(arg.message).toContain(UNLOCKED_BADGE.label);
    expect(arg.message).toContain(`https://kharagolf.com/p/${HANDLE}/badge/${UNLOCKED_BADGE.type}`);
  });
});
