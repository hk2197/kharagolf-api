/**
 * Task #897 — Frontend coverage for the sponsor portal date-range
 * comparison feature.
 *
 * Renders the extracted `PortalDashboard` (the logged-in body of
 * `/sponsor-portal`) end-to-end at the React level, mocks `fetch` so we
 * can return a stubbed `/api/sponsor-portal/me` payload with both the
 * primary `analytics` block and the optional `comparison` block, and
 * verifies that:
 *
 *   • With no comparison active, the KPI cards render plain values and
 *     the per-slot table does NOT show Δ Impressions / Δ Clicks columns
 *     (the columns are conditional on `comparison` being non-null).
 *   • Selecting "Previous period" triggers a refetch with `compare=previous`
 *     in the query string and, once the comparison payload arrives, the
 *     KPI Impressions delta renders the signed % string vs the prior value
 *     and the per-slot table grows the two Δ columns.
 *   • The "new" zero-previous case is handled by `formatDelta`: a slot
 *     that has primary impressions but `0` in the comparison renders the
 *     literal string "new" in its Δ Impressions cell.
 *
 * The fetch mock is keyed on the query string so a single test can assert
 * both the no-comparison and comparison-active states by selecting the
 * comparison preset and waiting for the second fetch to settle.
 */
import React from "react";
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

import { PortalDashboard } from "../sponsor-portal";

// ─── Stub data ────────────────────────────────────────────────────────────────

const SPONSOR = {
  id: 1,
  name: "Acme Golf Co.",
  tier: "gold",
  contactEmail: "test@example.com",
  logoUrl: null,
};

// Two slots:
//   tv_ticker_top : 100 → 200 imps (a recoverable +100% Δ on the primary)
//   leaderboard_bug : 0 → 50 imps (the "new" zero-previous case the FE
//                                  explicitly labels "new")
const PRIMARY_BY_SLOT = [
  { slotKey: "tv_ticker_top", eventType: "impression", total: 200 },
  { slotKey: "tv_ticker_top", eventType: "click", total: 10 },
  { slotKey: "leaderboard_bug", eventType: "impression", total: 50 },
  { slotKey: "leaderboard_bug", eventType: "click", total: 5 },
];
const COMPARISON_BY_SLOT = [
  // tv_ticker_top had half the impressions in the prior period.
  { slotKey: "tv_ticker_top", eventType: "impression", total: 100 },
  { slotKey: "tv_ticker_top", eventType: "click", total: 4 },
  // leaderboard_bug intentionally omitted from the comparison so the FE
  // hits the previous=0 → "new" branch in formatDelta.
];

// Two tournaments:
//   Spring Open (id 101) : 150 → 75 imps  (+100.0% Δ)
//   Summer Cup (id 102)  : 100 → 0  imps  (the "new" zero-previous case for
//                                          the per-tournament breakdown)
const PRIMARY_BY_TOURNAMENT = [
  { tournamentId: 101, tournamentName: "Spring Open", eventType: "impression", total: 150 },
  { tournamentId: 101, tournamentName: "Spring Open", eventType: "click", total: 8 },
  { tournamentId: 102, tournamentName: "Summer Cup", eventType: "impression", total: 100 },
  { tournamentId: 102, tournamentName: "Summer Cup", eventType: "click", total: 7 },
];
const COMPARISON_BY_TOURNAMENT = [
  { tournamentId: 101, tournamentName: "Spring Open", eventType: "impression", total: 75 },
  { tournamentId: 101, tournamentName: "Spring Open", eventType: "click", total: 2 },
  // Summer Cup intentionally omitted from comparison so the FE hits the
  // previous=0 → "new" branch for the per-tournament table.
];

// Two ad campaigns:
//   "Spring Sale" (id 11, creative 21) : 80 → 40 imps  (+100.0% Δ)
//   "Launch Promo" (id 12, creative 22) : 30 → 0 imps  (the "new" case for
//                                                       the campaign table)
const PRIMARY_BY_CAMPAIGN = [
  { campaignId: 11, campaignName: "Spring Sale", slotKey: "tv_ticker_top", slotName: "TV Ticker Top", creativeId: 21, creativeName: "Spring Hero", eventType: "impression", total: 80 },
  { campaignId: 11, campaignName: "Spring Sale", slotKey: "tv_ticker_top", slotName: "TV Ticker Top", creativeId: 21, creativeName: "Spring Hero", eventType: "click", total: 6 },
  { campaignId: 12, campaignName: "Launch Promo", slotKey: "leaderboard_bug", slotName: "Leaderboard Bug", creativeId: 22, creativeName: "Launch Banner", eventType: "impression", total: 30 },
  { campaignId: 12, campaignName: "Launch Promo", slotKey: "leaderboard_bug", slotName: "Leaderboard Bug", creativeId: 22, creativeName: "Launch Banner", eventType: "click", total: 3 },
];
const COMPARISON_BY_CAMPAIGN = [
  // Spring Sale had half the impressions and 2 clicks in the prior period.
  { campaignId: 11, campaignName: "Spring Sale", slotKey: "tv_ticker_top", slotName: "TV Ticker Top", creativeId: 21, creativeName: "Spring Hero", eventType: "impression", total: 40 },
  { campaignId: 11, campaignName: "Spring Sale", slotKey: "tv_ticker_top", slotName: "TV Ticker Top", creativeId: 21, creativeName: "Spring Hero", eventType: "click", total: 2 },
  // Launch Promo intentionally omitted from the comparison so the FE
  // hits the previous=0 → "new" branch on the campaign table too.
];

const PRIMARY_ANALYTICS = {
  impressions: 250,
  clicks: 15,
  ctr: 6.0,
  days: 30,
  from: "2026-03-22",
  to: "2026-04-21",
  bySource: [],
  byTournament: PRIMARY_BY_TOURNAMENT,
  bySlot: PRIMARY_BY_SLOT,
  byDaySlot: [],
  byAdCampaign: PRIMARY_BY_CAMPAIGN,
};
const COMPARISON_ANALYTICS = {
  impressions: 125, // primary 250 vs 125 → +100.0%
  clicks: 4,
  ctr: 3.2,
  days: 30,
  from: "2026-02-20",
  to: "2026-03-21",
  bySource: [],
  byTournament: COMPARISON_BY_TOURNAMENT,
  bySlot: COMPARISON_BY_SLOT,
  byDaySlot: [],
  byAdCampaign: COMPARISON_BY_CAMPAIGN,
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
  // The dashboard always issues a GET — the comparison vs no-comparison
  // payload selection is keyed off the presence of any compare* param.
  const hasCompare = /[?&](compare=|compareFrom=|compareTo=)/.test(url);
  const body = hasCompare ? ME_PAYLOAD_WITH_COMPARISON : ME_PAYLOAD_NO_COMPARISON;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Helper: locate a section's table by walking up from its heading.
function getSectionTable(headingPattern: RegExp): HTMLTableElement {
  const heading = screen.getByRole("heading", { name: headingPattern });
  const section = heading.closest("section");
  if (!section) throw new Error(`section not found for ${headingPattern}`);
  const table = section.querySelector("table");
  if (!table) throw new Error(`table not found in section for ${headingPattern}`);
  return table as HTMLTableElement;
}
const getSlotTable = () => getSectionTable(/Performance by Ad Slot/i);
const getCampaignTable = () => getSectionTable(/Ad Campaign Performance/i);
const getTournamentTable = () => getSectionTable(/Performance by Tournament/i);

function rowFor(table: HTMLTableElement, label: RegExp): HTMLTableRowElement {
  const cell = within(table).getByText(label);
  const row = cell.closest("tr");
  if (!row) throw new Error(`row for ${label} not found`);
  return row as HTMLTableRowElement;
}

describe("PortalDashboard — date-range comparison (Task #897)", () => {
  it("does NOT render Δ columns or KPI deltas when no comparison is active", async () => {
    render(<PortalDashboard token="fake-token" onLogout={() => {}} />);

    // First fetch settles with comparison: null.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await screen.findByRole("heading", { name: /Performance by Ad Slot/i });

    const initialUrl = String(fetchMock.mock.calls[0][0]);
    expect(initialUrl).toContain("/api/sponsor-portal/me");
    // Default preset is 30d, no comparison.
    expect(initialUrl).toContain("days=30");
    expect(initialUrl).not.toMatch(/compare/);

    const slotTable = getSlotTable();
    const campaignTable = getCampaignTable();
    // The Δ headers must NOT exist on either table when comparison is null.
    expect(within(slotTable).queryByText(/Δ Impressions/)).toBeNull();
    expect(within(slotTable).queryByText(/Δ Clicks/)).toBeNull();
    expect(within(campaignTable).queryByText(/Δ Impressions/)).toBeNull();
    expect(within(campaignTable).queryByText(/Δ Clicks/)).toBeNull();
    const tournamentTable = getTournamentTable();
    expect(within(tournamentTable).queryByText(/Δ Impressions/)).toBeNull();
    expect(within(tournamentTable).queryByText(/Δ Clicks/)).toBeNull();

    // KPI Impressions card shows the plain "last N days" caption (exact
    // lowercase form distinguishes the caption from the "Last 30 days"
    // range-preset button), and no Δ % strings appear anywhere on the page.
    expect(screen.getByText("last 30 days")).toBeInTheDocument();
    expect(screen.queryByText(/^[+-]\d/)).toBeNull();
  });

  it("renders the KPI Δ and per-slot Δ columns once 'Previous period' is selected, including the 'new' zero-previous case", async () => {
    render(<PortalDashboard token="fake-token" onLogout={() => {}} />);

    // Wait for first fetch.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await screen.findByRole("heading", { name: /Performance by Ad Slot/i });

    // Click the "Previous period" comparison preset.
    const prevBtn = screen.getByRole("button", { name: /Previous period/i });
    await act(async () => {
      fireEvent.click(prevBtn);
    });

    // The dashboard should refetch with compare=previous in the URL.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }, { timeout: 4000 });
    const secondUrl = String(fetchMock.mock.calls[1][0]);
    expect(secondUrl).toContain("compare=previous");

    // KPI Impressions card now shows a signed % delta vs the prior value.
    // Primary 250 vs comparison 125 → +100.0%. The KPI card's distinguishing
    // sibling text is "vs 125" (the comparison absolute), which only appears
    // in the KPI block, not in the per-slot Δ cells (those show "(100)").
    const kpiVs = await screen.findByText(/vs 125/, undefined, { timeout: 4000 });
    const kpiCard = kpiVs.closest("div");
    expect(kpiCard).not.toBeNull();
    expect(within(kpiCard!).getByText("+100.0%")).toBeInTheDocument();

    // Per-slot table grows two Δ headers.
    const slotTable = getSlotTable();
    await waitFor(() => {
      expect(within(slotTable).getByText(/Δ Impressions/)).toBeInTheDocument();
    });
    expect(within(slotTable).getByText(/Δ Clicks/)).toBeInTheDocument();

    // tv_ticker_top: primary 200 vs prior 100 → +100.0% Δ Impressions,
    //                primary 10 vs prior 4    → +150.0% Δ Clicks.
    const tvRow = rowFor(slotTable, /Tv Ticker Top/);
    expect(within(tvRow).getByText("+100.0%")).toBeInTheDocument();
    expect(within(tvRow).getByText("+150.0%")).toBeInTheDocument();
    // The Δ cells also include the prior absolute in parentheses.
    expect(within(tvRow).getByText(/\(100\)/)).toBeInTheDocument();
    expect(within(tvRow).getByText(/\(4\)/)).toBeInTheDocument();

    // leaderboard_bug: previous impressions/clicks were 0 in the comparison
    // payload, so formatDelta must emit the literal "new" label (not a %
    // — percent change is undefined when the base is zero).
    const lbRow = rowFor(slotTable, /Leaderboard Bug/);
    const slotNewCells = within(lbRow).getAllByText(/^new$/);
    // One Δ Impressions cell + one Δ Clicks cell.
    expect(slotNewCells.length).toBe(2);
    // And both Δ cells reference a 0 prior value.
    expect(within(lbRow).getAllByText(/\(0\)/).length).toBe(2);

    // Per-campaign table grows the same two Δ headers and renders Δ rows.
    const campaignTable = getCampaignTable();
    expect(within(campaignTable).getByText(/Δ Impressions/)).toBeInTheDocument();
    expect(within(campaignTable).getByText(/Δ Clicks/)).toBeInTheDocument();

    // Spring Sale: primary 80 vs prior 40 → +100.0% Δ Impressions,
    //              primary 6 vs prior 2   → +200.0% Δ Clicks.
    const springRow = rowFor(campaignTable, /Spring Sale/);
    expect(within(springRow).getByText("+100.0%")).toBeInTheDocument();
    expect(within(springRow).getByText("+200.0%")).toBeInTheDocument();
    expect(within(springRow).getByText(/\(40\)/)).toBeInTheDocument();
    expect(within(springRow).getByText(/\(2\)/)).toBeInTheDocument();

    // Launch Promo was missing from the comparison payload → both Δ cells
    // render the "new" label and reference a 0 prior absolute. This is the
    // campaign-table equivalent of the slot-table zero-previous case.
    const launchRow = rowFor(campaignTable, /Launch Promo/);
    const campaignNewCells = within(launchRow).getAllByText(/^new$/);
    expect(campaignNewCells.length).toBe(2);
    expect(within(launchRow).getAllByText(/\(0\)/).length).toBe(2);

    // Per-tournament table also grows the same two Δ headers and renders
    // Δ rows mirroring the per-slot table.
    const tournamentTable = getTournamentTable();
    expect(within(tournamentTable).getByText(/Δ Impressions/)).toBeInTheDocument();
    expect(within(tournamentTable).getByText(/Δ Clicks/)).toBeInTheDocument();

    // Spring Open: primary 150 vs prior 75 → +100.0% Δ Impressions,
    //              primary 8 vs prior 2   → +300.0% Δ Clicks.
    const springOpenRow = rowFor(tournamentTable, /Spring Open/);
    expect(within(springOpenRow).getByText("+100.0%")).toBeInTheDocument();
    expect(within(springOpenRow).getByText("+300.0%")).toBeInTheDocument();
    expect(within(springOpenRow).getByText(/\(75\)/)).toBeInTheDocument();
    expect(within(springOpenRow).getByText(/\(2\)/)).toBeInTheDocument();

    // Summer Cup was missing from the comparison payload → both Δ cells
    // render the "new" label and reference a 0 prior absolute. This is the
    // tournament-table equivalent of the slot-table zero-previous case.
    const summerCupRow = rowFor(tournamentTable, /Summer Cup/);
    const tournamentNewCells = within(summerCupRow).getAllByText(/^new$/);
    expect(tournamentNewCells.length).toBe(2);
    expect(within(summerCupRow).getAllByText(/\(0\)/).length).toBe(2);
  });
});
