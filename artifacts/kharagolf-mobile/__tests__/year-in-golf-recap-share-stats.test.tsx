/** Task #1875 — recap-share-opens panel on the mobile Year-in-Golf screen. */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/context/auth", () => ({
  useAuth: () => ({ token: "fake-token", user: { displayName: "Tiger" } }),
}));

vi.mock("react-native", async () => {
  const actual = await vi.importActual<typeof import("react-native")>("react-native");
  return {
    ...actual,
    Share: { share: vi.fn(), sharedAction: "sharedAction", dismissedAction: "dismissedAction" },
    Alert: { alert: vi.fn() },
    Dimensions: { get: () => ({ width: 400, height: 800 }) },
  };
});

vi.mock("@/app/my-360/_shared", () => ({
  authedFetch: vi.fn(),
  BASE_URL: "https://api.test",
}));

vi.mock("react-native-view-shot", () => {
  const ReactMod = require("react");
  const ViewShot = ReactMod.forwardRef(({ children }: { children?: ReactNode }, _ref: unknown) =>
    ReactMod.createElement("div", null, children),
  );
  return { default: ViewShot, captureRef: async () => "" };
});

vi.mock("expo-sharing", () => ({
  isAvailableAsync: async () => false,
  shareAsync: async () => {},
}));

vi.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "/tmp/",
  copyAsync: async () => {},
  writeAsStringAsync: async () => {},
  EncodingType: { Base64: "base64" },
}));

import YearInGolfScreen from "@/app/year-in-golf";
import { authedFetch } from "@/app/my-360/_shared";

interface MockableFn {
  mockReset: () => void;
  mockImplementation: (fn: (...args: unknown[]) => unknown) => void;
}

const RECAP = {
  user: { id: 1, displayName: "Tiger" },
  window: { year: 2026, period: "year", label: "2026", startsAt: "2026-01-01", endsAt: "2026-12-31" },
  totals: { rounds: 12, holes: 216, courses: 4, partners: 6, achievementsUnlocked: 3 },
  bestRound: null,
  longestDrive: null,
  lowestHoleScore: null,
  mostImproved: null,
  topCourses: [],
  topPartners: [],
  achievements: [],
  handicapJourney: { startIndex: null, endIndex: null, deltaLabel: "", points: [] },
};

function stubAuthedFetch(opts: {
  publicProfile?: { publicHandle: string | null; publicProfileEnabled: boolean } | null;
  shareStats?: {
    total: number;
    totalsByAsset: Record<string, number>;
    totalsBySource: Record<string, number>;
    byPeriod: unknown[];
  };
}) {
  (authedFetch as unknown as MockableFn).mockImplementation((path: unknown) => {
    if (typeof path !== "string") return Promise.reject(new Error("bad path"));
    if (path.startsWith("/api/portal/year-in-golf?")) return Promise.resolve(RECAP);
    if (path === "/api/portal/year-in-golf/preferences") return Promise.resolve({ pushEnabled: true });
    if (path === "/api/portal/me/public-profile") {
      if (opts.publicProfile === null) return Promise.reject(new Error("404"));
      return Promise.resolve(opts.publicProfile ?? { publicHandle: null, publicProfileEnabled: false });
    }
    if (path === "/api/portal/me/recap-share-stats") {
      if (!opts.shareStats) return Promise.reject(new Error("should not be called"));
      return Promise.resolve(opts.shareStats);
    }
    return Promise.reject(new Error(`unexpected authedFetch path: ${path}`));
  });
}

beforeEach(() => {
  (authedFetch as unknown as MockableFn).mockReset();
});

afterEach(() => {
  cleanup();
});

describe("YearInGolfScreen — recap-share-stats panel (Task #1875)", () => {
  it("does NOT render the stats panel when the player has no reserved handle", async () => {
    stubAuthedFetch({ publicProfile: { publicHandle: null, publicProfileEnabled: false } });

    render(<YearInGolfScreen /> as ReactNode);

    await waitFor(() => {
      expect(screen.queryAllByText(/2026/).length).toBeGreaterThan(0);
    });

    expect(screen.queryByTestId("recap-share-stats")).not.toBeInTheDocument();
  });

  it("does NOT render the stats panel when the public profile toggle is off", async () => {
    stubAuthedFetch({ publicProfile: { publicHandle: "tigerw", publicProfileEnabled: false } });

    render(<YearInGolfScreen /> as ReactNode);

    await waitFor(() => {
      expect(screen.queryAllByText(/2026/).length).toBeGreaterThan(0);
    });

    expect(screen.queryByTestId("recap-share-stats")).not.toBeInTheDocument();
  });

  it("renders the headline and breakdown chips when the public profile is enabled", async () => {
    stubAuthedFetch({
      publicProfile: { publicHandle: "tigerw", publicProfileEnabled: true },
      shareStats: {
        total: 14,
        totalsByAsset: { card_png: 4, og: 10 },
        totalsBySource: { web_share: 3, native_share: 5, copy: 4, crawler: 1, qr_open: 1, unknown: 0 },
        byPeriod: [],
      },
    });

    render(<YearInGolfScreen /> as ReactNode);

    const headline = await screen.findByTestId("recap-share-stats-headline");
    expect(headline).toHaveTextContent(/Your recap has been opened 14 times\./);

    // Top three buckets by count: native share (3+5=8) > copy (4) > crawler (1).
    // The "other" bucket (qr_open+unknown=1) is dropped by the 3-chip cap.
    const native = await screen.findByTestId("recap-share-stats-chip-native_share");
    const copy = await screen.findByTestId("recap-share-stats-chip-copy");
    const crawler = await screen.findByTestId("recap-share-stats-chip-crawler");

    expect(native).toHaveTextContent(/Native share · 8/);
    expect(copy).toHaveTextContent(/Copied link · 4/);
    expect(crawler).toHaveTextContent(/Link previews · 1/);
  });

  it("singularizes the headline when only one open has been recorded", async () => {
    stubAuthedFetch({
      publicProfile: { publicHandle: "tigerw", publicProfileEnabled: true },
      shareStats: {
        total: 1,
        totalsByAsset: { card_png: 0, og: 1 },
        totalsBySource: { web_share: 0, native_share: 0, copy: 1, crawler: 0, qr_open: 0, unknown: 0 },
        byPeriod: [],
      },
    });

    render(<YearInGolfScreen /> as ReactNode);

    const headline = await screen.findByTestId("recap-share-stats-headline");
    expect(headline).toHaveTextContent(/Your recap has been opened 1 time\./);
  });

  it("renders a friendly empty state (and no chips) when nobody has opened the recap yet", async () => {
    stubAuthedFetch({
      publicProfile: { publicHandle: "tigerw", publicProfileEnabled: true },
      shareStats: {
        total: 0,
        totalsByAsset: { card_png: 0, og: 0 },
        totalsBySource: { web_share: 0, native_share: 0, copy: 0, crawler: 0, qr_open: 0, unknown: 0 },
        byPeriod: [],
      },
    });

    render(<YearInGolfScreen /> as ReactNode);

    const headline = await screen.findByTestId("recap-share-stats-headline");
    expect(headline).toHaveTextContent(/Your public recap hasn't been opened yet\./);
    // No chips when every bucket is zero.
    expect(screen.queryByTestId("recap-share-stats-chip-copy")).not.toBeInTheDocument();
    expect(screen.queryByTestId("recap-share-stats-chip-native_share")).not.toBeInTheDocument();
  });
});
