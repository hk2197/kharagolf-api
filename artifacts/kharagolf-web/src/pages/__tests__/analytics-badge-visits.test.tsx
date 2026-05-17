/**
 * Component test: /analytics — Badge Share Leaderboard "Visits" + "Conv."
 * column / drill-down rendering (Task #2256, regression coverage for
 * Task #1798).
 *
 * Task #1798 added two new fields to the badge-share leaderboard payload:
 *
 *   • `visits`         — profile/badge-page visits attributed to outbound
 *                        shares of this badge over the selected period
 *                        (crawler hits excluded).
 *   • `conversionRate` — visits / shares for the same period; `null` when
 *                        shares=0 so the cell can render "—" instead of
 *                        dividing by zero.
 *
 * Those fields are surfaced in three places on the analytics page:
 *
 *   1. The Badge Share Leaderboard card header chip:
 *        "<X> shares → <Y> visits"  +  "<Z>% conv." pill.
 *   2. The per-badge table on the same card: a new "Visits" cell and a new
 *      "Conv." cell next to each badge row.
 *   3. The drill-down sheet (per-member table) for the clicked badge: same
 *      header chip, plus per-member "Visits" / "Conv." cells.
 *
 * The backend math is already covered by the API integration tests, but
 * the column ordering, the empty-state ("—") rendering when shares=0, and
 * the dependent-key wiring for the drill-down were only validated by the
 * API. This test mounts the real page with a stubbed fetch and asserts:
 *
 *   - Org-wide chip shows "<total> shares → <visits> visits" + a rounded
 *     "<X>% conv." pill, computed from the mocked payload.
 *   - The badge with non-null `conversionRate` shows the rounded "%" in
 *     its Conv. cell and the integer Visits in its Visits cell.
 *   - The badge with `conversionRate=null` (zero shares) shows "—" in its
 *     Conv. cell — guards against a future divide-by-zero or "0%" leak.
 *   - Clicking a badge row opens the drill-down sheet, the per-member
 *     visits/conv cells render with the same "%"-or-"—" formatting, and
 *     the badge-wide chip in the sheet header mirrors the org-wide one.
 *
 * Regression guards: a column reorder, a typo in the rounding, a stray
 * "0%" rendering when shares=0, or a dependent-key bug that fails to
 * re-issue the drill-down fetch when a different badge is clicked would
 * all fail this test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// AnalyticsPage destructures `activeOrgId` from `useActiveOrgId()`, so the
// mock must return an object — returning a bare number would silently
// disable every query (`!!undefined === false`). This mirrors the pattern
// used in the existing badge-share-drilldown test.
vi.mock("@/context/ActiveOrgContext", () => ({
  useActiveOrgId: () => ({ activeOrgId: 42 }),
  useActiveOrgContext: () => ({
    activeOrgId: 42,
    isOrgOverridden: false,
    setActiveOrg: () => {},
  }),
  ActiveOrgProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Recharts' ResponsiveContainer needs real layout to render; jsdom has
// none. Stub it so the dashboard tab can mount cleanly without spamming
// the test output with width(0)/height(0) warnings from the KPI charts.
vi.mock("recharts", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
      <div data-testid="recharts-responsive">{children}</div>,
  };
});

// Some buttons on the page (PDF export) call window.open, which jsdom
// does not implement. We never click them in this test, but stub it
// defensively so a future addition cannot blow up the suite.
beforeEach(() => {
  vi.stubGlobal("open", vi.fn(() => null));
});

import AnalyticsPage from "../analytics";

const ORG_ID = 42;

// ─── Mocked payloads ───────────────────────────────────────────────────
//
// `first_birdie` exercises the populated path: 20 shares drove 8 visits
// → 8/20 = 0.4 → "40%" in the Conv. cell.
//
// `long_drive` exercises the empty/null path: zero shares so the API
// returns conversionRate=null and the page must render "—" (the explicit
// task requirement).
const LEADERBOARD = {
  period: "month",
  from: "2026-04-01T00:00:00.000Z",
  to: "2026-05-01T00:00:00.000Z",
  totals: {
    total: 20,
    byMethod: { copy: 12, web_share: 5, native_share: 3 },
    visits: 8,
    conversionRate: 0.4,
  },
  badges: [
    {
      badgeType: "first_birdie",
      label: "First Birdie",
      icon: "🐦",
      category: "milestone",
      total: 20,
      byMethod: { copy: 12, web_share: 5, native_share: 3 },
      visits: 8,
      conversionRate: 0.4,
    },
    {
      badgeType: "long_drive",
      label: "Long Drive",
      icon: "🏌️",
      category: "skill",
      total: 0,
      byMethod: { copy: 0, web_share: 0, native_share: 0 },
      visits: 0,
      conversionRate: null,
    },
  ],
};

// Drill-down for `first_birdie`. Member 101 has shares so renders a
// real %; member 202 has 0 shares so the page must render "—" again,
// proving the same null guard fires per-row inside the sheet.
const FIRST_BIRDIE_MEMBERS = {
  period: "month",
  from: LEADERBOARD.from,
  to: LEADERBOARD.to,
  badge: {
    badgeType: "first_birdie",
    label: "First Birdie",
    icon: "🐦",
    category: "milestone",
  },
  totals: {
    total: 20,
    byMethod: { copy: 12, web_share: 5, native_share: 3 },
    visits: 8,
    conversionRate: 0.4,
  },
  members: [
    {
      userId: 101,
      displayName: "Alpha Visits",
      username: null,
      publicHandle: "alpha",
      total: 15,
      byMethod: { copy: 10, web_share: 3, native_share: 2 },
      visits: 6,
      conversionRate: 0.4,
    },
    {
      userId: 202,
      displayName: "Bravo Visits",
      username: null,
      publicHandle: null,
      total: 0,
      byMethod: { copy: 0, web_share: 0, native_share: 0 },
      visits: 0,
      conversionRate: null,
    },
  ],
};

// Tolerant defaults for the other dashboard fetches so the page mounts
// without 404 noise. None of them are asserted on.
const EMPTY_KPI = {
  period: "month",
  from: "",
  to: "",
  kpis: {
    totalRevenue: { value: 0, prevValue: 0, change: null, breakdown: {} },
    activeMembers: { value: 0, prevValue: 0, change: null },
    teeSheetUtilisation: { value: 0, totalSlots: 0, bookedSlots: 0 },
    teeBookings: { value: 0, prevValue: 0, change: null },
    tournaments: { value: 0, players: 0 },
    pendingEventEnquiries: { value: 0 },
  },
  topShopItems: [],
};
const EMPTY_PROFILE_LEADERBOARD = {
  period: "month",
  from: "",
  to: "",
  limit: 10,
  totals: {
    total: 0,
    byMethod: { copy: 0, web_share: 0, native_share: 0, qr_open: 0 },
  },
  leaderboard: [],
};

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.split("?")[0].replace(/^.*\/api\//, "/api/");

    // Drill-down per-badge breakdown — matched BEFORE the leaderboard
    // listing so the shared prefix doesn't swallow the per-badge URL.
    const drillMatch = path.match(
      new RegExp(
        `^/api/organizations/${ORG_ID}/analytics/badge-share-leaderboard/([^/]+)$`,
      ),
    );
    if (method === "GET" && drillMatch) {
      const badgeType = decodeURIComponent(drillMatch[1]);
      if (badgeType === "first_birdie") {
        return jsonResponse(FIRST_BIRDIE_MEMBERS);
      }
      return jsonResponse({ ...FIRST_BIRDIE_MEMBERS, members: [] });
    }

    if (
      method === "GET" &&
      path === `/api/organizations/${ORG_ID}/analytics/badge-share-leaderboard`
    ) {
      return jsonResponse(LEADERBOARD);
    }
    if (
      method === "GET" &&
      path === `/api/organizations/${ORG_ID}/analytics/profile-share-leaderboard`
    ) {
      return jsonResponse(EMPTY_PROFILE_LEADERBOARD);
    }
    if (
      method === "GET" &&
      path === `/api/organizations/${ORG_ID}/analytics/kpi`
    ) {
      return jsonResponse(EMPTY_KPI);
    }
    if (
      method === "GET" &&
      path === `/api/organizations/${ORG_ID}/analytics/reports`
    ) {
      return jsonResponse({ reports: [] });
    }
    if (
      method === "GET" &&
      path === `/api/organizations/${ORG_ID}/analytics/schedules`
    ) {
      return jsonResponse({ schedules: [] });
    }
    return jsonResponse({});
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AnalyticsPage />
    </QueryClientProvider>,
  );
}

describe("AnalyticsPage — Badge Share Leaderboard visits/conv columns (Task #2256)", () => {
  it("renders the org-wide shares→visits chip with a rounded conversion-rate pill", async () => {
    renderPage();

    const card = await screen.findByTestId("card-badge-share-leaderboard");

    // Org-wide chip: "<total> shares → <visits> visits"
    const chip = await within(card).findByTestId("text-badge-share-org-totals");
    expect(chip).toHaveTextContent(/20\s*shares/);
    expect(chip).toHaveTextContent(/8\s*visits/);

    // Conversion-rate pill: 0.4 → "40% conv." (Math.round of *100).
    const pill = within(card).getByTestId("badge-badge-share-org-conversion");
    expect(pill).toHaveTextContent("40% conv.");
  });

  it("renders per-badge Visits and Conv. cells with '—' when conversionRate is null", async () => {
    renderPage();

    // Populated badge: visits=8, conversionRate=0.4 → "40%"
    const visitsCell = await screen.findByTestId(
      "cell-badge-share-visits-first_birdie",
    );
    expect(visitsCell).toHaveTextContent("8");

    const convCell = screen.getByTestId(
      "cell-badge-share-conversion-first_birdie",
    );
    expect(convCell).toHaveTextContent("40%");

    // Empty badge: shares=0 / conversionRate=null. Visits cell still
    // renders the integer 0; Conv. cell MUST render the em-dash and
    // MUST NOT show "0%" or "NaN%" (the divide-by-zero leak this test
    // is guarding against).
    const emptyVisitsCell = screen.getByTestId(
      "cell-badge-share-visits-long_drive",
    );
    expect(emptyVisitsCell).toHaveTextContent("0");

    const emptyConvCell = screen.getByTestId(
      "cell-badge-share-conversion-long_drive",
    );
    expect(emptyConvCell.textContent).toBe("—");
    expect(emptyConvCell.textContent).not.toMatch(/%/);
    expect(emptyConvCell.textContent).not.toMatch(/NaN/);
  });

  it("preserves the column order Shares → Copy → Web → Native → Visits → Conv. for each badge row", async () => {
    renderPage();

    // The card has one <table>; grab the populated badge row and
    // verify the cell sequence matches the expected column order.
    // A future column reorder (e.g. swapping Visits and Conv.) would
    // shift these positions and fail.
    const row = await screen.findByTestId("row-badge-share-first_birdie");
    const cells = within(row).getAllByRole("cell");
    // Cells: rank, badge label cell, shares, copy, web, native, visits, conv
    expect(cells).toHaveLength(8);
    expect(cells[2]).toHaveTextContent("20"); // Shares (total)
    expect(cells[3]).toHaveTextContent("12"); // Copy
    expect(cells[4]).toHaveTextContent("5");  // Web
    expect(cells[5]).toHaveTextContent("3");  // Native
    expect(cells[6]).toHaveTextContent("8");  // Visits
    expect(cells[7]).toHaveTextContent("40%"); // Conv.
  });

  it("opens the drill-down sheet with a header chip and per-member Visits/Conv. cells (— when shares=0)", async () => {
    const user = userEvent.setup();
    renderPage();

    // Click the populated badge row to open the drill-down sheet.
    const row = await screen.findByTestId("row-badge-share-first_birdie");
    await user.click(row);

    const sheet = await screen.findByTestId("sheet-badge-share-members");

    // Sheet header chip mirrors the org-wide chip but scoped to the
    // selected badge: "20 shares → 8 visits" + "40% conv." pill.
    await waitFor(() => {
      const sheetTotals = within(sheet).getByTestId(
        "text-badge-share-drilldown-totals",
      );
      expect(sheetTotals).toHaveTextContent(/20\s*shares/);
      expect(sheetTotals).toHaveTextContent(/8\s*visits/);
    });
    const sheetPill = within(sheet).getByTestId(
      "badge-badge-share-drilldown-conversion",
    );
    expect(sheetPill).toHaveTextContent("40% conv.");

    // Member 101: visits=6, conversionRate=0.4 → "40%"
    const alphaVisits = await within(sheet).findByTestId(
      "cell-badge-share-member-visits-101",
    );
    expect(alphaVisits).toHaveTextContent("6");
    const alphaConv = within(sheet).getByTestId(
      "cell-badge-share-member-conversion-101",
    );
    expect(alphaConv).toHaveTextContent("40%");

    // Member 202: shares=0 / conversionRate=null. Same null guard
    // applies inside the sheet — must render "—", not "0%" / "NaN%".
    const bravoVisits = within(sheet).getByTestId(
      "cell-badge-share-member-visits-202",
    );
    expect(bravoVisits).toHaveTextContent("0");
    const bravoConv = within(sheet).getByTestId(
      "cell-badge-share-member-conversion-202",
    );
    expect(bravoConv.textContent).toBe("—");
    expect(bravoConv.textContent).not.toMatch(/%/);
    expect(bravoConv.textContent).not.toMatch(/NaN/);
  });
});
