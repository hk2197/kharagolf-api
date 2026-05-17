/**
 * Task #653 — UI coverage for the wellness/handicap overlay.
 *
 * The /api/portal/wellness/daily response now also returns a `handicapTrend`
 * series. The dashboard overlays it as a dashed amber line on the Readiness
 * and HRV cards (the two metrics the product team most wants to correlate
 * with handicap movement), and surfaces an "Handicap index" legend chip
 * that reports the latest value and the delta across the window.
 *
 * These tests pin the three branches of that overlay:
 *   1. Populated  — dashed path + numeric "now X.Y (±Δ)" copy on both cards;
 *      the non-overlay cards (Sleep duration, Resting heart rate) carry
 *      neither.
 *   2. Empty      — no overlay path, but the legend explains "no handicap
 *      data in this range" so the user understands why the line is missing.
 *   3. Omitted    — older API responses (or partial test fixtures) may omit
 *      the field entirely; the dashboard must fall back to the empty-state
 *      copy without crashing.
 *
 * The file is kept separate from `wellness-dashboard.test.tsx` so each test
 * gets a fresh module-graph and the multiple ScrollView/Layout effects from
 * the dashboard component do not race past the default findByText timeout
 * when many tests render the screen back-to-back.
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

type SvgPrimitiveProps = React.SVGAttributes<Element> & { children?: ReactNode };

vi.mock("react-native-svg", () => {
  const ReactInner = require("react") as typeof React;
  const passthrough = (tag: string) =>
    ReactInner.forwardRef<Element, SvgPrimitiveProps>(({ children, ...rest }, ref) =>
      ReactInner.createElement(tag, { ...rest, ref }, children),
    );
  const Svg = passthrough("svg");
  return {
    __esModule: true,
    default: Svg,
    Svg,
    G: passthrough("g"),
    Circle: passthrough("circle"),
    Line: passthrough("line"),
    Path: passthrough("path"),
    Text: passthrough("svgtext"),
  };
});

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@/context/auth", () => ({
  useAuth: () => ({ token: "test-token" }),
}));

import WellnessDashboardScreen from "../app/wellness-dashboard";

type WellnessDay = {
  metricDate: string;
  readinessScore: number | null;
  sleepMinutes: number | null;
  sleepScore: number | null;
  hrvMs: number | null;
  restingHr: number | null;
  steps: number | null;
  sources: string[];
};

type HandicapPoint = { handicapIndex: number; recordedAt: string | null };

function day(date: string, overrides: Partial<WellnessDay> = {}): WellnessDay {
  return {
    metricDate: date,
    readinessScore: 80,
    sleepMinutes: 420,
    sleepScore: 85,
    hrvMs: 60,
    restingHr: 55,
    steps: 8000,
    sources: ["test"],
    ...overrides,
  };
}

type FetchMock = Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;
let fetchMock: FetchMock;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock = vi.fn() as unknown as FetchMock;
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// Find the card root that contains a given metric title AND its DAY-AVG label.
// `title` may also appear inside the legend chip (e.g. the "Readiness" legend
// swatch), so prefer the card-title node — the only one whose ancestor also
// carries the "DAY AVG" label.
function getCard(title: string): HTMLElement {
  const candidates = screen.getAllByText(title);
  const titleEl =
    candidates.find((el) => {
      let p: HTMLElement | null = el;
      while (p) {
        if (p.textContent?.includes("DAY AVG")) return true;
        p = p.parentElement;
      }
      return false;
    }) ?? candidates[0];
  let node: HTMLElement | null = titleEl;
  while (node && node.parentElement) {
    const parent: HTMLElement = node.parentElement;
    const hasChart =
      !!parent.querySelector("svg") ||
      !!parent.textContent?.includes("No data in this range");
    if (
      parent.textContent?.includes(title) &&
      parent.textContent?.includes("DAY AVG") &&
      hasChart
    ) {
      return parent;
    }
    node = parent;
  }
  throw new Error(`Could not find card for "${title}"`);
}

describe("<WellnessDashboardScreen /> handicap overlay (Task #653)", () => {
  it("renders the dashed handicap overlay and legend on Readiness and HRV when handicapTrend is present", async () => {
    const series: WellnessDay[] = [
      day("2026-04-18", { readinessScore: 80, hrvMs: 70 }),
      day("2026-04-17", { readinessScore: 80, hrvMs: 60 }),
      day("2026-04-16", { readinessScore: 80, hrvMs: 50 }),
    ];
    const handicapTrend: HandicapPoint[] = [
      { handicapIndex: 12.4, recordedAt: "2026-04-16T08:00:00.000Z" },
      { handicapIndex: 11.9, recordedAt: "2026-04-18T08:00:00.000Z" },
    ];
    fetchMock.mockResolvedValue(jsonResponse({ series, handicapTrend }));

    render(<WellnessDashboardScreen />);

    await waitFor(
      () => expect(screen.getAllByText(/Handicap index/).length).toBe(2),
      { timeout: 5000 },
    );

    // Latest handicap + signed delta in the legend copy.
    for (const legend of screen.getAllByText(/Handicap index/)) {
      expect(legend.textContent).toMatch(/now 11\.9/);
      expect(legend.textContent).toMatch(/-0\.5/);
    }

    // Non-overlay cards do NOT carry the handicap legend.
    expect(getCard("Sleep duration").textContent).not.toMatch(/Handicap index/);
    expect(getCard("Resting heart rate").textContent).not.toMatch(/Handicap index/);

    // Overlay path: dashed (4,3) and amber (#f59e0b), one per overlay card.
    for (const cardTitle of ["Readiness", "HRV"] as const) {
      const card = getCard(cardTitle);
      const dashedPath = card.querySelector('path[stroke-dasharray="4,3"]');
      expect(dashedPath, `expected dashed overlay path on ${cardTitle} card`).not.toBeNull();
      expect((dashedPath?.getAttribute("stroke") ?? "").toLowerCase()).toBe("#f59e0b");
    }
    expect(document.querySelectorAll('path[stroke-dasharray="4,3"]').length).toBe(2);
  });

  it("renders gracefully when handicapTrend is empty: legend explains why, no overlay path drawn", async () => {
    const series: WellnessDay[] = [
      day("2026-04-18", { readinessScore: 80, hrvMs: 70 }),
      day("2026-04-17", { readinessScore: 80, hrvMs: 60 }),
    ];
    fetchMock.mockResolvedValue(jsonResponse({ series, handicapTrend: [] }));

    render(<WellnessDashboardScreen />);

    await waitFor(
      () => expect(screen.getAllByText(/Handicap index/).length).toBe(2),
      { timeout: 5000 },
    );

    for (const legend of screen.getAllByText(/Handicap index/)) {
      expect(legend.textContent).toMatch(/no handicap data in this range/i);
      expect(legend.textContent).not.toMatch(/now \d/);
    }

    expect(document.querySelectorAll('path[stroke-dasharray="4,3"]').length).toBe(0);
  });

  it("falls back to the empty overlay state when the API response omits handicapTrend entirely", async () => {
    const series: WellnessDay[] = [
      day("2026-04-18", { readinessScore: 80, hrvMs: 70 }),
    ];
    // No `handicapTrend` field at all — older API responses or partial fixtures.
    fetchMock.mockResolvedValue(jsonResponse({ series }));

    render(<WellnessDashboardScreen />);

    await waitFor(
      () => expect(screen.getAllByText(/Handicap index/).length).toBe(2),
      { timeout: 5000 },
    );

    for (const legend of screen.getAllByText(/Handicap index/)) {
      expect(legend.textContent).toMatch(/no handicap data in this range/i);
    }
    expect(document.querySelectorAll('path[stroke-dasharray="4,3"]').length).toBe(0);
  });
});
