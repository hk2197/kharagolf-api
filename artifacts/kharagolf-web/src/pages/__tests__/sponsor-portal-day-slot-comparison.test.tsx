/**
 * Task #1201 — Frontend coverage for the sponsor portal Per-Slot CTR Trend
 * chart's comparison-range overlay.
 *
 * The CSV export already showed comparison-range numbers next to the primary
 * range in the per-day per-slot trend section; this test pins down the
 * matching on-screen behaviour:
 *
 *   • With no comparison active, the trend section's caption falls back to
 *     the original "Same data as the Per-Day Per-Slot CTR Trend section in
 *     the CSV download." text and references no comparison range.
 *
 *   • Selecting "Previous period" refetches with `compare=previous`, and
 *     once the comparison payload arrives the caption switches to the
 *     "Dashed lines show the comparison range (...) aligned by day index."
 *     copy and quotes the comparison range's from/to labels.
 *
 *   • A slot present only in the comparison range (so impressions are zero
 *     in the primary range) still appears in the chart's legend, matching
 *     the union behaviour of the per-slot summary table.
 *
 * Task #2110 — recharts mock rework
 * --------------------------------
 * The previous incarnation of this file replaced recharts wholesale with a
 * hand-written mock that walked `props.children` itself. That mock happily
 * traversed `<React.Fragment>`-wrapped Lines, which masked a real-browser
 * regression: under React 19, recharts@2's `react-is@18` `isFragment` check
 * returns false (the element `$$typeof` switched to
 * `react.transitional.element`), so any `<Line>` wrapped in a fragment is
 * silently dropped from the chart. Only the e2e spec at
 * `artifacts/api-server/e2e/sponsor-portal-trend-overlay.spec.ts` caught it.
 *
 * The mock below now delegates to the real recharts module (only stubbing
 * `ResponsiveContainer` so jsdom's zero layout doesn't refuse to render the
 * SVG) and wraps `LineChart` to capture the `data` prop the source assembles.
 * Lines, dasharrays, legend wiring etc. are introspected from the real
 * rendered SVG so a future React/recharts mismatch — or anyone re-wrapping
 * the per-slot Lines in a Fragment — surfaces in this vitest suite without
 * needing to spin up Playwright. The dedicated regression test at the bottom
 * of the file pins that behaviour explicitly so it can't be undone by accident.
 */
import React, { isValidElement, cloneElement } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

// ─── Recharts shim ────────────────────────────────────────────────────────────
// We delegate to the *real* recharts module so its child traversal (which
// runs through `react-is`'s `isFragment` and `React.Children.toArray`) is the
// one the source code is exercised against. Only two shims are layered on
// top:
//
//   1. `ResponsiveContainer` — jsdom doesn't lay anything out, so the real
//      container reports zero width/height and bails out of rendering. We
//      clone its child with explicit dimensions so the SVG paths actually
//      reach the DOM.
//
//   2. `LineChart` — wrapped to push the resolved `data` prop (and the inner
//      `chartData` shape the source assembles) onto a per-test capture array
//      so the chartData-derivation assertions can inspect it directly. The
//      children prop is forwarded untouched, so recharts itself decides which
//      `<Line>` children survive — that's how a future React-19/Fragment
//      mismatch would now surface here too.
const capturedLineCharts: Array<{
  data: Array<Record<string, unknown>>;
}> = [];

vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  const ResponsiveContainer = ({ children }: { children: React.ReactNode }) =>
    isValidElement(children)
      ? cloneElement(
          children as React.ReactElement<Record<string, unknown>>,
          { width: 800, height: 320 },
        )
      : <>{children}</>;
  const RealLineChart = actual.LineChart;
  const LineChart = (props: React.ComponentProps<typeof RealLineChart>) => {
    capturedLineCharts.push({
      data: (props.data as Array<Record<string, unknown>>) ?? [],
    });
    return <RealLineChart {...props} />;
  };
  return { ...actual, ResponsiveContainer, LineChart };
});

// PortalDashboard import has to come AFTER vi.mock so the mocked recharts
// module is wired in before the dashboard module is evaluated.
import { PortalDashboard } from "../sponsor-portal";

// ─── Stub data ────────────────────────────────────────────────────────────────

const SPONSOR = {
  id: 1,
  name: "Acme Golf Co.",
  tier: "gold",
  contactEmail: "test@example.com",
  logoUrl: null,
};

// Two slots in the primary range across two days each.
//   tv_ticker_top : day1=200/10, day2=300/15  → CTRs 5.0% / 5.0%
//   leaderboard_bug : day1=50/5, day2=80/4    → CTRs 10.0% / 5.0%
const PRIMARY_BY_DAY_SLOT = [
  { day: "2026-04-20", slotKey: "tv_ticker_top", eventType: "impression", total: 200 },
  { day: "2026-04-20", slotKey: "tv_ticker_top", eventType: "click", total: 10 },
  { day: "2026-04-21", slotKey: "tv_ticker_top", eventType: "impression", total: 300 },
  { day: "2026-04-21", slotKey: "tv_ticker_top", eventType: "click", total: 15 },
  { day: "2026-04-20", slotKey: "leaderboard_bug", eventType: "impression", total: 50 },
  { day: "2026-04-20", slotKey: "leaderboard_bug", eventType: "click", total: 5 },
  { day: "2026-04-21", slotKey: "leaderboard_bug", eventType: "impression", total: 80 },
  { day: "2026-04-21", slotKey: "leaderboard_bug", eventType: "click", total: 4 },
];
// Comparison range: tv_ticker_top has half the volume on the same two day
// indices, leaderboard_bug is missing entirely (so it should still appear in
// the chart legend with a flat 0% comparison line), and a brand-new slot
// `scoreboard_footer` shows up that has zero impressions in the primary
// range — exercises the "slots present in only one of the two ranges still
// appear with zeros in the missing range" requirement.
const COMPARISON_BY_DAY_SLOT = [
  { day: "2026-03-20", slotKey: "tv_ticker_top", eventType: "impression", total: 100 },
  { day: "2026-03-20", slotKey: "tv_ticker_top", eventType: "click", total: 4 },
  { day: "2026-03-21", slotKey: "tv_ticker_top", eventType: "impression", total: 150 },
  { day: "2026-03-21", slotKey: "tv_ticker_top", eventType: "click", total: 9 },
  { day: "2026-03-21", slotKey: "scoreboard_footer", eventType: "impression", total: 60 },
  { day: "2026-03-21", slotKey: "scoreboard_footer", eventType: "click", total: 3 },
];

const PRIMARY_ANALYTICS = {
  impressions: 630,
  clicks: 34,
  ctr: 5.4,
  days: 30,
  from: "2026-03-22",
  to: "2026-04-21",
  bySource: [],
  byTournament: [],
  bySlot: [
    { slotKey: "tv_ticker_top", eventType: "impression", total: 500 },
    { slotKey: "tv_ticker_top", eventType: "click", total: 25 },
    { slotKey: "leaderboard_bug", eventType: "impression", total: 130 },
    { slotKey: "leaderboard_bug", eventType: "click", total: 9 },
  ],
  byDaySlot: PRIMARY_BY_DAY_SLOT,
  byAdCampaign: [],
};
const COMPARISON_ANALYTICS = {
  impressions: 313,
  clicks: 16,
  ctr: 5.1,
  days: 30,
  from: "2026-02-20",
  to: "2026-03-21",
  bySource: [],
  byTournament: [],
  bySlot: [
    { slotKey: "tv_ticker_top", eventType: "impression", total: 250 },
    { slotKey: "tv_ticker_top", eventType: "click", total: 13 },
    { slotKey: "scoreboard_footer", eventType: "impression", total: 60 },
    { slotKey: "scoreboard_footer", eventType: "click", total: 3 },
  ],
  byDaySlot: COMPARISON_BY_DAY_SLOT,
  byAdCampaign: [],
};

const ME_PAYLOAD_NO_COMPARISON = {
  sponsor: SPONSOR,
  assignments: [],
  invoices: [],
  analytics: PRIMARY_ANALYTICS,
  comparison: null,
};
const ME_PAYLOAD_WITH_COMPARISON = {
  sponsor: SPONSOR,
  assignments: [],
  invoices: [],
  analytics: PRIMARY_ANALYTICS,
  comparison: COMPARISON_ANALYTICS,
};

const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith("/api/sponsor-portal/me")) {
    throw new Error(`Unexpected fetch: ${url}`);
  }
  const hasCompare = /[?&](compare=|compareFrom=|compareTo=)/.test(url);
  const body = hasCompare ? ME_PAYLOAD_WITH_COMPARISON : ME_PAYLOAD_NO_COMPARISON;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

beforeEach(() => {
  fetchMock.mockClear();
  capturedLineCharts.length = 0;
  // Reset the per-slot mute state between tests so persistence in one test
  // doesn't leak into the next one's "starts unmuted" assumptions.
  try { sessionStorage.clear(); } catch {}
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  try { sessionStorage.clear(); } catch {}
});

// ─── Test helpers ─────────────────────────────────────────────────────────────

function getTrendSection(): HTMLElement {
  const heading = screen.getByRole("heading", { name: /Per-Slot CTR Trend/i });
  const section = heading.closest("section");
  if (!section) throw new Error("trend section not found");
  return section as HTMLElement;
}

// The source's per-slot stroke palette, tied 1:1 to `topSlots` ordering
// (sorted by total impressions desc). Matching on stroke colour is how this
// suite identifies which path in the rendered SVG belongs to which slot —
// JSDOM-friendly and survives recharts' internal class/data attribute churn.
const SOURCE_PALETTE = [
  "#fbbf24",
  "#60a5fa",
  "#34d399",
  "#f472b6",
  "#a78bfa",
  "#fb923c",
];
const SLOT_INDEX: Record<string, number> = {
  // Primary-only payload: tv_ticker_top (500) > leaderboard_bug (130).
  // Comparison payload: tv_ticker_top (750) > leaderboard_bug (130) >
  // scoreboard_footer (60).
  tv_ticker_top: 0,
  leaderboard_bug: 1,
  scoreboard_footer: 2,
};
const SLOT_LABEL: Record<string, string> = {
  tv_ticker_top: "Tv Ticker Top",
  leaderboard_bug: "Leaderboard Bug",
  scoreboard_footer: "Scoreboard Footer",
};
function colourFor(slotKey: string): string {
  const idx = SLOT_INDEX[slotKey];
  if (idx === undefined) throw new Error(`Unknown slot ${slotKey}`);
  return SOURCE_PALETTE[idx];
}

// All `<Line>`s rendered by recharts surface as
// `<path class="recharts-curve recharts-line-curve">`. Hidden lines
// (`hide={true}`) are not rendered at all, so their absence here is the
// signal we use to verify the per-slot mute toggle below.
function getRenderedCurves(section: HTMLElement): Array<{ stroke: string; dasharray: string | null }> {
  return Array.from(section.querySelectorAll("path.recharts-line-curve")).map((p) => ({
    stroke: p.getAttribute("stroke") || "",
    dasharray: p.getAttribute("stroke-dasharray"),
  }));
}

function findCurve(
  section: HTMLElement,
  slotKey: string,
  variant: "primary" | "cmp",
) {
  const colour = colourFor(slotKey);
  return getRenderedCurves(section).find(
    (c) => c.stroke.toLowerCase() === colour.toLowerCase()
      && (variant === "cmp") === !!c.dasharray,
  );
}

// Recharts wraps each legend entry's text in a span the source's `formatter`
// returns (a plain or strike-through `<span>`). Find the entry by its
// human-readable label so the test reads roughly like the user sees it.
function getLegendItem(slotKey: string): HTMLElement {
  const label = SLOT_LABEL[slotKey];
  const items = document.querySelectorAll("li.recharts-legend-item");
  for (const item of Array.from(items)) {
    const text = item.querySelector("span.recharts-legend-item-text");
    if (text && text.textContent && text.textContent.trim() === label) {
      return item as HTMLElement;
    }
  }
  throw new Error(`Legend item for ${slotKey} (${label}) not found`);
}
function queryLegendItem(slotKey: string): HTMLElement | null {
  try { return getLegendItem(slotKey); } catch { return null; }
}

function getLegendLabels(): string[] {
  return Array.from(document.querySelectorAll("li.recharts-legend-item span.recharts-legend-item-text"))
    .map((el) => (el.textContent || "").trim())
    .filter(Boolean);
}

// ─── Comparison overlay (Task #1201) ─────────────────────────────────────────

describe("PortalDashboard — Per-Slot CTR Trend comparison overlay (Task #1201)", () => {
  it("renders only the primary series and original caption when no comparison is active", async () => {
    render(<PortalDashboard token="fake-token" onLogout={() => {}} />);

    await waitFor(() => { expect(fetchMock).toHaveBeenCalled(); });
    await screen.findByRole("heading", { name: /Per-Slot CTR Trend/i });

    const section = getTrendSection();
    // The fallback caption (no comparison range mentioned) is rendered.
    expect(within(section).getByText(/Same data as the Per-Day Per-Slot CTR Trend section in the CSV download\./i)).toBeInTheDocument();
    expect(within(section).queryByText(/Dashed lines show the comparison range/i)).toBeNull();

    // Wait for the SVG to actually paint before introspecting it — recharts
    // renders inside a couple of nested layout passes.
    await waitFor(() => {
      expect(getRenderedCurves(section).length).toBeGreaterThan(0);
    });

    // Only the two primary slots reach the SVG; nothing dashed because the
    // comparison overlay isn't in play yet.
    const curves = getRenderedCurves(section);
    expect(curves).toHaveLength(2);
    expect(curves.filter((c) => c.dasharray)).toHaveLength(0);
    // Each primary slot's colour shows up exactly once.
    expect(findCurve(section, "tv_ticker_top", "primary")).toBeDefined();
    expect(findCurve(section, "leaderboard_bug", "primary")).toBeDefined();
    expect(findCurve(section, "tv_ticker_top", "cmp")).toBeUndefined();
    expect(findCurve(section, "leaderboard_bug", "cmp")).toBeUndefined();

    // Legend lists both primary slots — and only those.
    expect(getLegendLabels().sort()).toEqual(["Leaderboard Bug", "Tv Ticker Top"]);

    // Source still feeds plain primary `dataKey`s into the chart — no
    // `__cmp` overlay sneaks into the data buckets either.
    const last = capturedLineCharts[capturedLineCharts.length - 1];
    expect(last).toBeDefined();
    for (const row of last.data) {
      for (const key of Object.keys(row)) {
        expect(key.endsWith("__cmp")).toBe(false);
      }
    }
  });

  it("overlays a dashed comparison line per slot, includes comparison-only slots, and updates the caption when 'Previous period' is selected", async () => {
    render(<PortalDashboard token="fake-token" onLogout={() => {}} />);
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });
    await screen.findByRole("heading", { name: /Per-Slot CTR Trend/i });

    const prevBtn = screen.getByRole("button", { name: /Previous period/i });
    await act(async () => { fireEvent.click(prevBtn); });

    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2); }, { timeout: 4000 });
    const secondUrl = String(fetchMock.mock.calls[1][0]);
    expect(secondUrl).toContain("compare=previous");

    // Wait for the comparison-aware caption to appear so we know the
    // dashboard has re-rendered with the new payload before we introspect
    // the chart.
    await waitFor(() => {
      const section = getTrendSection();
      expect(within(section).getByText(/Dashed lines show the comparison range/i)).toBeInTheDocument();
    }, { timeout: 4000 });

    const section = getTrendSection();
    expect(within(section).getByText(/2026-02-20 → 2026-03-21/)).toBeInTheDocument();
    expect(within(section).getByText(/aligned by day index/i)).toBeInTheDocument();

    // Wait until the dashed companion overlay has actually been painted —
    // there can be a brief tick where recharts hasn't re-rendered yet.
    await waitFor(() => {
      expect(getRenderedCurves(section).filter((c) => c.dasharray)).toHaveLength(3);
    });

    // 3 primary + 3 dashed companions → 6 paths total. Each slot's colour
    // appears once as a solid line and once as a dashed companion, even
    // tv_ticker_top/leaderboard_bug/scoreboard_footer where one of the two
    // ranges has no rows — they're still drawn so the overlay stays
    // visually consistent.
    const curves = getRenderedCurves(section);
    expect(curves).toHaveLength(6);
    for (const slot of ["tv_ticker_top", "leaderboard_bug", "scoreboard_footer"]) {
      expect(findCurve(section, slot, "primary"), `expected solid curve for ${slot}`).toBeDefined();
      const cmp = findCurve(section, slot, "cmp");
      expect(cmp, `expected dashed companion for ${slot}`).toBeDefined();
      // The dashed companion uses the same recharts dasharray pattern the
      // source declares (`strokeDasharray="4 3"`).
      expect(cmp!.dasharray).toBe("4 3");
    }

    // Dashed companions stay out of the legend (legendType="none") so the
    // legend doesn't double in size when comparison is on.
    expect(getLegendLabels().sort()).toEqual([
      "Leaderboard Bug",
      "Scoreboard Footer",
      "Tv Ticker Top",
    ]);

    // The chart data is index-aligned: position 0 has the first sorted day
    // from each range; position 1 has the second. tv_ticker_top primary
    // CTR @ position 1 is 15/300 = 5%, comparison CTR @ position 1 is
    // 9/150 = 6%. scoreboard_footer is missing entirely from the primary
    // range so its primary value stays 0; leaderboard_bug is missing from
    // the comparison range so its `__cmp` value stays 0 across both days.
    const last = capturedLineCharts[capturedLineCharts.length - 1];
    expect(last).toBeDefined();
    expect(last.data).toHaveLength(2);
    expect(last.data[0].day).toBe("2026-04-20");
    expect(last.data[0].cmpDay).toBe("2026-03-20");
    expect(last.data[0].tv_ticker_top).toBe(5);
    expect(last.data[0].tv_ticker_top__cmp).toBe(4);
    expect(last.data[0].scoreboard_footer).toBe(0);
    expect(last.data[0].scoreboard_footer__cmp).toBe(0); // no day0 in comparison
    expect(last.data[0].leaderboard_bug).toBe(10);
    expect(last.data[0].leaderboard_bug__cmp).toBe(0);
    expect(last.data[1].day).toBe("2026-04-21");
    expect(last.data[1].cmpDay).toBe("2026-03-21");
    expect(last.data[1].tv_ticker_top).toBe(5);
    expect(last.data[1].tv_ticker_top__cmp).toBe(6);
    expect(last.data[1].scoreboard_footer).toBe(0);
    expect(last.data[1].scoreboard_footer__cmp).toBe(5); // 3/60 = 5%
    expect(last.data[1].leaderboard_bug).toBe(5);
    expect(last.data[1].leaderboard_bug__cmp).toBe(0);
  });
});

// ─── Legend toggle (Task #1394) ──────────────────────────────────────────────

describe("PortalDashboard — Per-Slot CTR Trend legend toggle (Task #1394)", () => {
  // Helper: with a slot muted, recharts skips the matching `<Line>` entirely
  // (both primary and dashed companion) so its colour disappears from the
  // SVG. The legend entry stays — recharts marks it as "inactive" — but the
  // source's formatter renders it with a strike-through label.
  function expectSlotHidden(section: HTMLElement, slotKey: string, expected: boolean) {
    const primary = findCurve(section, slotKey, "primary");
    if (expected) {
      expect(primary, `expected primary line for ${slotKey} to be hidden`).toBeUndefined();
    } else {
      expect(primary, `expected primary line for ${slotKey} to be visible`).toBeDefined();
    }
    // If the comparison overlay is on, the dashed companion mirrors the
    // primary's hidden state. We can tell whether the overlay is on by
    // checking whether ANY dashed line is rendered for ANY other slot.
    const anyDashed = getRenderedCurves(section).some((c) => c.dasharray);
    if (anyDashed || expected) {
      const cmp = findCurve(section, slotKey, "cmp");
      if (expected) {
        expect(cmp, `expected dashed companion for ${slotKey} to be hidden`).toBeUndefined();
      } else if (anyDashed) {
        expect(cmp, `expected dashed companion for ${slotKey} to be visible`).toBeDefined();
      }
    }
  }

  it("hides the primary and dashed companion lines for a slot when its legend entry is clicked, and restores them on a second click", async () => {
    render(<PortalDashboard token="fake-token" onLogout={() => {}} />);
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });
    await screen.findByRole("heading", { name: /Per-Slot CTR Trend/i });

    // Turn on the comparison overlay so we have dashed companions to verify
    // get muted alongside their primary line.
    const prevBtn = screen.getByRole("button", { name: /Previous period/i });
    await act(async () => { fireEvent.click(prevBtn); });
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2); }, { timeout: 4000 });
    await waitFor(() => {
      const section = getTrendSection();
      expect(within(section).getByText(/Dashed lines show the comparison range/i)).toBeInTheDocument();
    }, { timeout: 4000 });
    await waitFor(() => {
      const section = getTrendSection();
      expect(getRenderedCurves(section).filter((c) => c.dasharray)).toHaveLength(3);
    });

    let section = getTrendSection();
    // Sanity: nothing muted to start with.
    expectSlotHidden(section, "tv_ticker_top", false);
    expectSlotHidden(section, "leaderboard_bug", false);
    expectSlotHidden(section, "scoreboard_footer", false);

    // Click the tv_ticker_top legend entry — both its primary and dashed
    // companion should disappear from the chart.
    const tvLegend = getLegendItem("tv_ticker_top");
    await act(async () => { fireEvent.click(tvLegend); });

    await waitFor(() => {
      const s = getTrendSection();
      expect(findCurve(s, "tv_ticker_top", "primary")).toBeUndefined();
    });
    section = getTrendSection();
    expectSlotHidden(section, "tv_ticker_top", true);
    // Other slots must remain visible — the toggle is per-slot, not all-or-nothing.
    expectSlotHidden(section, "leaderboard_bug", false);
    expectSlotHidden(section, "scoreboard_footer", false);

    // Muted label is rendered with strike-through styling so the user can
    // tell which slot they've hidden at a glance.
    const mutedLegend = getLegendItem("tv_ticker_top");
    const styledChild = mutedLegend.querySelector("span.recharts-legend-item-text > span[style]") as HTMLElement | null;
    expect(styledChild).not.toBeNull();
    expect(styledChild!.style.textDecoration).toContain("line-through");

    // Click the same legend entry again — both lines come back.
    await act(async () => { fireEvent.click(getLegendItem("tv_ticker_top")); });
    await waitFor(() => {
      const s = getTrendSection();
      expect(findCurve(s, "tv_ticker_top", "primary")).toBeDefined();
    });
    section = getTrendSection();
    expectSlotHidden(section, "tv_ticker_top", false);
    expectSlotHidden(section, "leaderboard_bug", false);
    expectSlotHidden(section, "scoreboard_footer", false);
  });

  it("persists the muted slot across remounts within the same session", async () => {
    // First mount: hide leaderboard_bug.
    const first = render(<PortalDashboard token="fake-token" onLogout={() => {}} />);
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });
    await screen.findByRole("heading", { name: /Per-Slot CTR Trend/i });
    await waitFor(() => {
      expect(getRenderedCurves(getTrendSection())).toHaveLength(2);
    });

    await act(async () => { fireEvent.click(getLegendItem("leaderboard_bug")); });
    await waitFor(() => {
      expect(findCurve(getTrendSection(), "leaderboard_bug", "primary")).toBeUndefined();
    });
    let section = getTrendSection();
    expectSlotHidden(section, "leaderboard_bug", true);
    expectSlotHidden(section, "tv_ticker_top", false);

    // Unmount the dashboard (simulating navigating away within the session).
    first.unmount();
    capturedLineCharts.length = 0;
    fetchMock.mockClear();

    // Re-mount and verify the muted state was restored from sessionStorage —
    // the user comes back to the chart and finds it the way they left it.
    render(<PortalDashboard token="fake-token" onLogout={() => {}} />);
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });
    await screen.findByRole("heading", { name: /Per-Slot CTR Trend/i });
    await waitFor(() => {
      // Only one primary curve should be visible (leaderboard_bug stays muted).
      const cs = getRenderedCurves(getTrendSection());
      expect(cs.filter((c) => !c.dasharray)).toHaveLength(1);
    });

    section = getTrendSection();
    expectSlotHidden(section, "leaderboard_bug", true);
    expectSlotHidden(section, "tv_ticker_top", false);
    // The persisted-muted legend entry still renders with the strike-through
    // styling so the user immediately sees what's hidden.
    const persistedLegend = getLegendItem("leaderboard_bug");
    const persistedStyled = persistedLegend.querySelector("span.recharts-legend-item-text > span[style]") as HTMLElement | null;
    expect(persistedStyled).not.toBeNull();
    expect(persistedStyled!.style.textDecoration).toContain("line-through");
  });

  it("does not affect the impressions CSV download — every slot is still requested regardless of the muted state", async () => {
    render(<PortalDashboard token="fake-token" onLogout={() => {}} />);
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });
    await screen.findByRole("heading", { name: /Per-Slot CTR Trend/i });
    await waitFor(() => {
      expect(getRenderedCurves(getTrendSection())).toHaveLength(2);
    });

    // Mute every visible slot. The CSV download endpoint takes no slot
    // filter parameters, so even with everything muted it must hit the same
    // URL with the same query string as a no-mutes session would.
    for (const key of ["tv_ticker_top", "leaderboard_bug"]) {
      await act(async () => { fireEvent.click(getLegendItem(key)); });
    }
    await waitFor(() => {
      const s = getTrendSection();
      expect(findCurve(s, "tv_ticker_top", "primary")).toBeUndefined();
      expect(findCurve(s, "leaderboard_bug", "primary")).toBeUndefined();
    });

    // Stub the CSV endpoint just for this assertion (the default fetchMock
    // only knows about /api/sponsor-portal/me).
    const csvFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sponsor-portal/impressions")) {
        return new Response("day,slot,impressions,clicks\n", {
          status: 200,
          headers: { "Content-Type": "text/csv" },
        });
      }
      // Fall back to the standard /me payload for everything else.
      return fetchMock(input);
    });
    vi.stubGlobal("fetch", csvFetch as unknown as typeof fetch);

    const downloadBtn = screen.getByRole("button", { name: /Download CSV/i });
    await act(async () => { fireEvent.click(downloadBtn); });
    await waitFor(() => {
      const csvCalls = csvFetch.mock.calls.filter((c) => String(c[0]).startsWith("/api/sponsor-portal/impressions"));
      expect(csvCalls).toHaveLength(1);
      const csvUrl = String(csvCalls[0][0]);
      // No "hide" / slot-filter parameter is appended to the CSV URL.
      expect(csvUrl).not.toMatch(/(?:^|[?&])(hide|slots?|hidden|excludeSlots)=/);
    });
  });
});

// ─── Reset hidden slots (Task #1681) ─────────────────────────────────────────

describe("PortalDashboard — Per-Slot CTR Trend reset hidden slots (Task #1681)", () => {
  function expectSlotHidden(section: HTMLElement, slotKey: string, expected: boolean) {
    const primary = findCurve(section, slotKey, "primary");
    if (expected) {
      expect(primary, `expected primary line for ${slotKey} to be hidden`).toBeUndefined();
    } else {
      expect(primary, `expected primary line for ${slotKey} to be visible`).toBeDefined();
    }
  }

  it("hides the 'Show all slots' control by default and only reveals it once at least one slot is muted", async () => {
    render(<PortalDashboard token="fake-token" onLogout={() => {}} />);
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });
    await screen.findByRole("heading", { name: /Per-Slot CTR Trend/i });
    await waitFor(() => {
      expect(getRenderedCurves(getTrendSection())).toHaveLength(2);
    });

    // Nothing is hidden — the reset action stays out of the chrome so the
    // default chart UI remains minimal.
    expect(screen.queryByTestId("reset-hidden-trend-slots")).toBeNull();

    // Mute one slot — the reset control should now appear.
    await act(async () => { fireEvent.click(getLegendItem("tv_ticker_top")); });
    await waitFor(() => {
      expect(findCurve(getTrendSection(), "tv_ticker_top", "primary")).toBeUndefined();
    });
    const resetBtn = await screen.findByTestId("reset-hidden-trend-slots");
    expect(resetBtn).toHaveTextContent(/Show all slots/i);
    // Sponsors should see the count of currently-muted slots inline so the
    // scope of what the reset will undo is obvious without scanning the
    // legend. With one slot muted, the copy should read "(1 hidden)".
    expect(resetBtn).toHaveTextContent(/Show all slots \(1 hidden\)/i);

    // Mute a second slot — the count should update live without a remount.
    await act(async () => { fireEvent.click(getLegendItem("leaderboard_bug")); });
    await waitFor(() => {
      expect(screen.getByTestId("reset-hidden-trend-slots"))
        .toHaveTextContent(/Show all slots \(2 hidden\)/i);
    });

    // Un-muting one of them via its legend toggle should drop the count back
    // down (and not, say, leave the previous "(2 hidden)" copy stuck).
    await act(async () => { fireEvent.click(getLegendItem("tv_ticker_top")); });
    await waitFor(() => {
      expect(screen.getByTestId("reset-hidden-trend-slots"))
        .toHaveTextContent(/Show all slots \(1 hidden\)/i);
    });

    // Un-muting the last one removes the control entirely — the count copy
    // disappears with it instead of lingering as "(0 hidden)".
    await act(async () => { fireEvent.click(getLegendItem("leaderboard_bug")); });
    await waitFor(() => {
      expect(screen.queryByTestId("reset-hidden-trend-slots")).toBeNull();
    });
  });

  it("clears every muted slot and removes the sessionStorage entry when 'Show all slots' is clicked", async () => {
    render(<PortalDashboard token="fake-token" onLogout={() => {}} />);
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });
    await screen.findByRole("heading", { name: /Per-Slot CTR Trend/i });
    await waitFor(() => {
      expect(getRenderedCurves(getTrendSection())).toHaveLength(2);
    });

    // Mute multiple slots so we can verify the reset un-mutes ALL of them in
    // a single click — not just the most recently toggled one.
    for (const key of ["tv_ticker_top", "leaderboard_bug"]) {
      await act(async () => { fireEvent.click(getLegendItem(key)); });
    }
    await waitFor(() => {
      const s = getTrendSection();
      expect(findCurve(s, "tv_ticker_top", "primary")).toBeUndefined();
      expect(findCurve(s, "leaderboard_bug", "primary")).toBeUndefined();
    });
    let section = getTrendSection();
    expectSlotHidden(section, "tv_ticker_top", true);
    expectSlotHidden(section, "leaderboard_bug", true);
    // Storage should reflect the muted set so persistence is in play before
    // we hit reset — that's what we want the reset to actually clear.
    const storedBefore = sessionStorage.getItem("sponsor_portal_trend_hidden_slots");
    expect(storedBefore).not.toBeNull();
    expect(JSON.parse(storedBefore!).sort()).toEqual(["leaderboard_bug", "tv_ticker_top"]);

    // One click clears the lot.
    const resetBtn = screen.getByTestId("reset-hidden-trend-slots");
    await act(async () => { fireEvent.click(resetBtn); });

    await waitFor(() => {
      const s = getTrendSection();
      expect(findCurve(s, "tv_ticker_top", "primary")).toBeDefined();
      expect(findCurve(s, "leaderboard_bug", "primary")).toBeDefined();
    });
    section = getTrendSection();
    expectSlotHidden(section, "tv_ticker_top", false);
    expectSlotHidden(section, "leaderboard_bug", false);

    // The reset control disappears once every slot is back, so the chart UI
    // returns to its minimal default state.
    await waitFor(() => {
      expect(screen.queryByTestId("reset-hidden-trend-slots")).toBeNull();
    });

    // The matching sessionStorage entry is removed (not just rewritten as
    // "[]") so a remount truly starts fresh with nothing hidden.
    expect(sessionStorage.getItem("sponsor_portal_trend_hidden_slots")).toBeNull();
  });

  it("does not persist any hidden slots across remounts after a reset", async () => {
    // First mount: mute a slot, then immediately reset everything.
    const first = render(<PortalDashboard token="fake-token" onLogout={() => {}} />);
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });
    await screen.findByRole("heading", { name: /Per-Slot CTR Trend/i });
    await waitFor(() => {
      expect(getRenderedCurves(getTrendSection())).toHaveLength(2);
    });

    await act(async () => { fireEvent.click(getLegendItem("leaderboard_bug")); });
    await waitFor(() => {
      expect(findCurve(getTrendSection(), "leaderboard_bug", "primary")).toBeUndefined();
    });
    const resetBtn = await screen.findByTestId("reset-hidden-trend-slots");
    await act(async () => { fireEvent.click(resetBtn); });
    await waitFor(() => {
      expect(screen.queryByTestId("reset-hidden-trend-slots")).toBeNull();
    });

    // Unmount and re-mount in the same session — nothing should come back
    // muted, and the reset control should stay hidden because the muted set
    // is empty.
    first.unmount();
    capturedLineCharts.length = 0;
    fetchMock.mockClear();

    render(<PortalDashboard token="fake-token" onLogout={() => {}} />);
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });
    await screen.findByRole("heading", { name: /Per-Slot CTR Trend/i });
    await waitFor(() => {
      expect(getRenderedCurves(getTrendSection())).toHaveLength(2);
    });

    const section = getTrendSection();
    expectSlotHidden(section, "leaderboard_bug", false);
    expectSlotHidden(section, "tv_ticker_top", false);
    expect(screen.queryByTestId("reset-hidden-trend-slots")).toBeNull();
    // The legend item also comes back without the strike-through styling,
    // so the user sees a fully restored chart on remount.
    const restored = queryLegendItem("leaderboard_bug");
    expect(restored).not.toBeNull();
    const restoredStyled = restored!.querySelector("span.recharts-legend-item-text > span[style]") as HTMLElement | null;
    if (restoredStyled) {
      expect(restoredStyled.style.textDecoration).not.toContain("line-through");
    }
  });
});

// ─── React-19 + recharts fragment regression guard (Task #2110) ──────────────
//
// The bug that prompted this whole task: under React 19, `<React.Fragment>`'s
// `$$typeof` switched to `react.transitional.element`, so recharts@2 (which
// uses `react-is@18`'s `isFragment` to walk its children) silently drops any
// `<Line>` wrapped in a fragment. The previous hand-written recharts mock
// papered over this because it walked `props.children` itself, regardless of
// whether the wrapper was a Fragment. With the new shim that delegates to
// real recharts, the bug must surface in this very file. This direct test
// guarantees no future "let's just stub recharts again" change can re-bury
// it without one of these assertions firing first.
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer } from "recharts";

describe("recharts + React 19 child traversal regression guard (Task #2110)", () => {
  function renderTwoLines(useFragment: boolean) {
    const data = [
      { day: "2026-04-20", a: 5, b: 10 },
      { day: "2026-04-21", a: 5, b: 5 },
    ];
    const lines = [
      <Line key="a" dataKey="a" stroke="#fbbf24" isAnimationActive={false} />,
      <Line key="b" dataKey="b" stroke="#60a5fa" isAnimationActive={false} />,
    ];
    return render(
      <ResponsiveContainer width={400} height={200}>
        <LineChart data={data}>
          <XAxis dataKey="day" />
          <YAxis />
          {useFragment ? <>{lines}</> : lines}
        </LineChart>
      </ResponsiveContainer>,
    );
  }

  it("renders both <Line> paths when they are passed as a flat array (the source's `flatMap` path)", () => {
    const { container } = renderTwoLines(false);
    expect(container.querySelectorAll("path.recharts-line-curve")).toHaveLength(2);
  });

  it("DROPS both <Line> paths when they are wrapped in a React.Fragment (regression repro)", () => {
    // If this test ever flips to "renders 2 paths", recharts has shipped a
    // fix for the React-19 fragment-traversal bug and the per-slot Lines in
    // sponsor-portal.tsx are no longer at risk from being wrapped in a
    // fragment. Update the guard alongside the upgrade. Until then, this is
    // the canary the previous hand-written mock was missing — it would
    // gladly walk through fragments and report 2 lines either way.
    const { container } = renderTwoLines(true);
    expect(container.querySelectorAll("path.recharts-line-curve")).toHaveLength(0);
  });
});
