/**
 * UI tests: mobile badges screen share sheet (Task #1071).
 *
 * Verifies:
 *   1. Locked badges with progress are shareable from the badges screen.
 *   2. Locked-badge share text mentions current progress (e.g. "closing in
 *      on ... — 8 of 10!") and points at /p/<handle>/badge/<type>.
 *   3. Unlocked-badge share text retains the existing celebratory copy.
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

const sample = {
  badges: [
    {
      type: "first-round",
      label: "First Round",
      icon: "🏌️",
      category: "milestone",
      description: "Complete your first round.",
      unlocked: true,
      earnedAt: "2025-01-02T00:00:00Z",
      progress: null,
    },
    {
      type: "ten-rounds",
      label: "Frequent Flyer",
      icon: "✈️",
      category: "milestone",
      description: "Play 10 rounds.",
      unlocked: false,
      earnedAt: null,
      progress: { current: 8, target: 10 },
    },
    {
      type: "secret-badge",
      label: "Secret",
      icon: "🤫",
      category: "milestone",
      description: "A surprise badge.",
      unlocked: false,
      earnedAt: null,
      progress: null,
    },
  ],
  unlockedCount: 1,
  totalCount: 3,
  publicHandle: "hiro",
  canShare: true,
};

beforeEach(() => {
  shareMock.mockReset();
  shareMock.mockResolvedValue({ action: "sharedAction" });
  (authedFetch as unknown as { mockReset: () => void; mockResolvedValue: (v: unknown) => void })
    .mockReset();
  (authedFetch as unknown as { mockResolvedValue: (v: unknown) => void })
    .mockResolvedValue(sample);
  // jsdom fetch stub for the share-tracking analytics POST.
  (globalThis as { fetch?: unknown }).fetch = vi.fn().mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
});

describe("BadgesScreen — locked share progress hint", () => {
  it("shows a share button on locked badges with progress", async () => {
    render(<BadgesScreen /> as ReactNode);
    await waitFor(() =>
      expect(screen.getByTestId("badge-share-ten-rounds")).toBeInTheDocument()
    );
    expect(screen.getByTestId("badge-share-first-round")).toBeInTheDocument();
  });

  it("includes 'closing in' progress copy when sharing a locked badge", async () => {
    render(<BadgesScreen /> as ReactNode);
    const btn = await screen.findByTestId("badge-share-ten-rounds");
    fireEvent.click(btn);
    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    const arg = shareMock.mock.calls[0][0];
    expect(arg.url).toBe("https://kharagolf.com/p/hiro/badge/ten-rounds");
    expect(arg.message).toContain("closing in on");
    expect(arg.message).toContain("Frequent Flyer");
    expect(arg.message).toContain("8 of 10");
    expect(arg.message).toContain("https://kharagolf.com/p/hiro/badge/ten-rounds");
  });

  it("falls back to a no-progress 'closing in' message for locked badges without progress data", async () => {
    render(<BadgesScreen /> as ReactNode);
    const btn = await screen.findByTestId("badge-share-secret-badge");
    fireEvent.click(btn);
    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    const arg = shareMock.mock.calls[0][0];
    expect(arg.url).toBe("https://kharagolf.com/p/hiro/badge/secret-badge");
    expect(arg.message).toContain("closing in on");
    expect(arg.message).toContain("Secret");
    expect(arg.message).not.toMatch(/\d+ of \d+/);
  });

  it("keeps the celebratory copy when sharing an unlocked badge", async () => {
    render(<BadgesScreen /> as ReactNode);
    const btn = await screen.findByTestId("badge-share-first-round");
    fireEvent.click(btn);
    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    const arg = shareMock.mock.calls[0][0];
    expect(arg.message).toContain("just unlocked");
    expect(arg.message).toContain("First Round");
    expect(arg.url).toBe("https://kharagolf.com/p/hiro/badge/first-round");
  });
});
