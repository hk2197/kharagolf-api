/**
 * Task #2065 — UI tests for the daily skipped/failed trend panel.
 *
 * Task #2110 — recharts mock rework
 * --------------------------------
 * The previous incarnation of this file replaced recharts wholesale with a
 * hand-written mock (each component a no-op stub returning a `data-testid`
 * div). That stub couldn't catch React-19 / recharts mismatches — most
 * notably the bug where `<React.Fragment>`-wrapped chart children are
 * silently dropped because `react-is@18`'s `isFragment` returns false under
 * React 19. The shim below now delegates to the real recharts module (only
 * stubbing `ResponsiveContainer` so jsdom's zero layout doesn't refuse to
 * render the SVG), and assertions look at the actual rendered SVG instead
 * of fake test ids.
 */
import React, { isValidElement, cloneElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";

vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  const ResponsiveContainer = ({ children }: { children: React.ReactNode }) =>
    isValidElement(children)
      ? cloneElement(
          children as React.ReactElement<Record<string, unknown>>,
          { width: 600, height: 240 },
        )
      : <>{children}</>;
  return { ...actual, ResponsiveContainer };
});

import {
  SkipReasonDailyTrendPanel,
  buildChartRows,
  formatDayLabel,
  type SkipReasonDailySeries,
} from "../SkipReasonDailyTrendPanel";

function buildSeries(
  overrides: Partial<SkipReasonDailySeries> = {},
): SkipReasonDailySeries {
  // Three-day window with two reasons. Mirrors the column-oriented
  // shape the API returns; the test asserts the row-zip and the
  // legend's per-reason totals.
  return {
    sinceDays: 30,
    since: "2026-04-01T00:00:00.000Z",
    days: ["2026-04-01", "2026-04-02", "2026-04-03"],
    series: [
      { reason: "org_muted", isOther: false, counts: [1, 0, 4], total: 5 },
      { reason: "org_lookup_failed", isOther: false, counts: [0, 2, 0], total: 2 },
      { reason: "below_threshold", isOther: false, counts: [0, 0, 0], total: 0 },
    ],
    totalCount: 7,
    ...overrides,
  };
}

// The active-series colour palette the source assigns by index. Used by the
// helpers below to identify which `<Area>` (rendered as a path with
// `class="recharts-curve recharts-area-area"` and a `fill` attribute) belongs
// to which reason without depending on test-only DOM hooks.
const REASON_COLOUR: Record<string, string> = {
  org_muted: "#60a5fa",
  org_lookup_failed: "#f472b6",
  below_threshold: "#34d399",
};

function getAreaFills(): string[] {
  return Array.from(document.querySelectorAll("path.recharts-area-area"))
    .map((p) => (p.getAttribute("fill") || "").toLowerCase());
}
function hasAreaFor(reason: string): boolean {
  const colour = REASON_COLOUR[reason]?.toLowerCase();
  if (!colour) throw new Error(`Unknown reason ${reason}`);
  return getAreaFills().includes(colour);
}

describe("SkipReasonDailyTrendPanel", () => {
  beforeEach(() => {
    // Each test starts with no hidden series.
  });

  it("renders an empty state when no rows fall in the window", () => {
    render(
      <SkipReasonDailyTrendPanel
        data={buildSeries({
          series: [
            { reason: "org_muted", isOther: false, counts: [0, 0, 0], total: 0 },
          ],
          totalCount: 0,
        })}
      />,
    );
    expect(screen.getByTestId("skip-reason-trend-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("skip-reason-trend-chart")).toBeNull();
    // No SVG areas should be rendered when the empty-state takes over.
    expect(getAreaFills()).toHaveLength(0);
  });

  it("renders one Area per non-empty series and skips zero-total reasons", () => {
    render(<SkipReasonDailyTrendPanel data={buildSeries()} />);

    // Active reasons get charted; below_threshold (total=0) does not.
    expect(getAreaFills()).toHaveLength(2);
    expect(hasAreaFor("org_muted")).toBe(true);
    expect(hasAreaFor("org_lookup_failed")).toBe(true);
    expect(hasAreaFor("below_threshold")).toBe(false);

    // Legend mirrors the active set so ops can isolate either spike.
    const legend = screen.getByTestId("skip-reason-trend-legend");
    expect(within(legend).getByTestId("skip-reason-trend-legend-org_muted")).toBeInTheDocument();
    expect(within(legend).getByTestId("skip-reason-trend-legend-org_lookup_failed")).toBeInTheDocument();
    expect(within(legend).queryByTestId("skip-reason-trend-legend-below_threshold")).toBeNull();
  });

  it("toggles a reason on/off when its legend chip is clicked, and shows the all-hidden state", () => {
    render(<SkipReasonDailyTrendPanel data={buildSeries()} />);

    const mutedChip = screen.getByTestId("skip-reason-trend-legend-org_muted");
    const lookupChip = screen.getByTestId("skip-reason-trend-legend-org_lookup_failed");

    expect(mutedChip).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(mutedChip);
    expect(mutedChip).toHaveAttribute("aria-pressed", "false");
    // Hiding org_muted removes its Area but leaves the other reason.
    expect(hasAreaFor("org_muted")).toBe(false);
    expect(hasAreaFor("org_lookup_failed")).toBe(true);

    // Hiding the second too triggers the explicit all-hidden hint.
    fireEvent.click(lookupChip);
    expect(hasAreaFor("org_lookup_failed")).toBe(false);
    expect(getAreaFills()).toHaveLength(0);
    expect(screen.getByTestId("skip-reason-trend-all-hidden")).toBeInTheDocument();

    // Re-showing one restores its area and clears the hint.
    fireEvent.click(mutedChip);
    expect(hasAreaFor("org_muted")).toBe(true);
    expect(screen.queryByTestId("skip-reason-trend-all-hidden")).toBeNull();
  });
});

describe("buildChartRows", () => {
  it("zips column-oriented series into one row per day with a __total per row", () => {
    const { rows, activeSeries } = buildChartRows(buildSeries());
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ day: "2026-04-01", org_muted: 1, org_lookup_failed: 0, __total: 1 });
    expect(rows[1]).toEqual({ day: "2026-04-02", org_muted: 0, org_lookup_failed: 2, __total: 2 });
    expect(rows[2]).toEqual({ day: "2026-04-03", org_muted: 4, org_lookup_failed: 0, __total: 4 });
    // below_threshold is dropped from activeSeries so the chart's
    // legend stays focused on reasons that actually fired.
    expect(activeSeries.map((s) => s.reason)).toEqual(["org_muted", "org_lookup_failed"]);
  });
});

describe("formatDayLabel", () => {
  it("renders ISO YYYY-MM-DD as a compact MMM d label in UTC", () => {
    // Locale-dependent; assert the date parts present rather than the
    // exact en-US "Apr 1" so the test doesn't fail in different envs.
    const out = formatDayLabel("2026-04-01");
    expect(out).toMatch(/Apr/);
    expect(out).toMatch(/1/);
  });

  it("falls back to the input when the string isn't an ISO date", () => {
    expect(formatDayLabel("garbage")).toBe("garbage");
  });
});
