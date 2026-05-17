/**
 * Sort behavior for the Badge Share Leaderboard drill-down — Task #1797.
 *
 * Covers:
 *   1. Default sort is total desc (rows ordered by `entry.total` descending).
 *   2. Clicking the Copy / Web / Native column header re-sorts the visible
 *      rows by that method desc, and shows a sort indicator on the active
 *      column.
 *   3. Closing and reopening the sheet resets the sort back to total desc
 *      (state lives only inside the sheet).
 *
 * Sort happens client-side, so the in-memory backend deliberately returns
 * members in an order that DIFFERS from any per-method ordering. That way
 * we can prove the SPA — not the API — is doing the work.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  within,
  act,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AnalyticsPage from "@/pages/analytics";

vi.mock("@/context/ActiveOrgContext", () => ({
  useActiveOrgId: () => ({ activeOrgId: 42 }),
  useActiveOrgContext: () => ({
    activeOrgId: 42,
    isOrgOverridden: false,
    setActiveOrg: () => {},
  }),
  ActiveOrgProvider: ({ children }: { children: React.ReactNode }) => children,
}));

beforeEach(() => {
  vi.stubGlobal("open", vi.fn(() => null));
});

const ORG_ID = 42;

// Three members with deliberately mixed per-method counts so each sort key
// produces a distinct row order:
//   Total order:  alpha (10), bravo (8),  charlie (6)
//   Copy order:   charlie (5), alpha (4), bravo (1)
//   Web order:    bravo (6),  alpha (4),  charlie (1)
//   Native order: alpha (2),  bravo (1),  charlie (0)
const MEMBERS = [
  {
    userId: 101,
    displayName: "Alpha SortDrill",
    byMethod: { copy: 4, web_share: 4, native_share: 2 },
  },
  {
    userId: 202,
    displayName: "Bravo SortDrill",
    byMethod: { copy: 1, web_share: 6, native_share: 1 },
  },
  {
    userId: 303,
    displayName: "Charlie SortDrill",
    byMethod: { copy: 5, web_share: 1, native_share: 0 },
  },
];

function buildBackend() {
  const totals = { copy: 0, web_share: 0, native_share: 0 };
  for (const m of MEMBERS) {
    totals.copy += m.byMethod.copy;
    totals.web_share += m.byMethod.web_share;
    totals.native_share += m.byMethod.native_share;
  }

  const ok = (body: unknown) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    } as Response);

  const handler = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.split("?")[0].replace(/^.*\/api\//, "/api/");

    if (
      method === "GET" &&
      path ===
        `/api/organizations/${ORG_ID}/analytics/badge-share-leaderboard/sort_test`
    ) {
      // IMPORTANT: backend returns members in an order that does NOT match
      // total desc (or any per-method desc). The page must sort.
      return ok({
        period: "month",
        from: new Date().toISOString(),
        to: new Date().toISOString(),
        badge: {
          badgeType: "sort_test",
          label: "Sort Test Badge",
          icon: "🏷️",
          category: "milestone",
        },
        totals: {
          total: totals.copy + totals.web_share + totals.native_share,
          byMethod: totals,
          // Task #1798 — drill-down sheet now reads totals.conversionRate
          // for the header chip; safe defaults so we don't render NaN.
          visits: 0,
          conversionRate: null,
        },
        members: [
          // bravo first (lowest total), then charlie (mid), then alpha (top)
          {
            userId: MEMBERS[1].userId,
            displayName: MEMBERS[1].displayName,
            username: null,
            publicHandle: null,
            total:
              MEMBERS[1].byMethod.copy +
              MEMBERS[1].byMethod.web_share +
              MEMBERS[1].byMethod.native_share,
            byMethod: MEMBERS[1].byMethod,
            visits: 0,
            conversionRate: null,
          },
          {
            userId: MEMBERS[2].userId,
            displayName: MEMBERS[2].displayName,
            username: null,
            publicHandle: null,
            total:
              MEMBERS[2].byMethod.copy +
              MEMBERS[2].byMethod.web_share +
              MEMBERS[2].byMethod.native_share,
            byMethod: MEMBERS[2].byMethod,
            visits: 0,
            conversionRate: null,
          },
          {
            userId: MEMBERS[0].userId,
            displayName: MEMBERS[0].displayName,
            username: null,
            publicHandle: null,
            total:
              MEMBERS[0].byMethod.copy +
              MEMBERS[0].byMethod.web_share +
              MEMBERS[0].byMethod.native_share,
            byMethod: MEMBERS[0].byMethod,
            visits: 0,
            conversionRate: null,
          },
        ],
      });
    }

    if (
      method === "GET" &&
      path === `/api/organizations/${ORG_ID}/analytics/badge-share-leaderboard`
    ) {
      return ok({
        period: "month",
        from: new Date().toISOString(),
        to: new Date().toISOString(),
        totals: {
          total: totals.copy + totals.web_share + totals.native_share,
          byMethod: totals,
        },
        badges: [
          {
            badgeType: "sort_test",
            label: "Sort Test Badge",
            icon: "🏷️",
            category: "milestone",
            total: totals.copy + totals.web_share + totals.native_share,
            byMethod: totals,
          },
        ],
      });
    }

    // Tolerant defaults so the page mounts cleanly.
    if (
      method === "GET" &&
      path === `/api/organizations/${ORG_ID}/analytics/profile-share-leaderboard`
    ) {
      return ok({
        period: "month",
        from: "",
        to: "",
        limit: 10,
        totals: {
          total: 0,
          byMethod: { copy: 0, web_share: 0, native_share: 0, qr_open: 0 },
        },
        leaderboard: [],
      });
    }
    if (
      method === "GET" &&
      path === `/api/organizations/${ORG_ID}/analytics/reports`
    ) {
      return ok({ reports: [] });
    }
    if (
      method === "GET" &&
      path === `/api/organizations/${ORG_ID}/analytics/schedules`
    ) {
      return ok({ schedules: [] });
    }
    if (
      method === "GET" &&
      path === `/api/organizations/${ORG_ID}/analytics/kpi`
    ) {
      return ok({
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
      });
    }
    return ok({});
  };

  return { handler };
}

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

// Helper: read the current order of member rows inside the open sheet by
// scraping the userId out of the row's data-testid attribute.
function rowOrder(sheet: HTMLElement): number[] {
  const rows = within(sheet).getAllByTestId(/^row-badge-share-member-/);
  return rows.map(r => {
    const id = r.getAttribute("data-testid")!;
    return Number(id.replace("row-badge-share-member-", ""));
  });
}

describe("Badge Share drill-down sort (Task #1797)", () => {
  beforeEach(() => {
    const backend = buildBackend();
    vi.stubGlobal(
      "fetch",
      vi.fn(backend.handler) as unknown as typeof fetch,
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("defaults to total desc, re-sorts on header click, and resets on close+reopen", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AnalyticsPage />);

    const card = await screen.findByTestId("card-badge-share-leaderboard");
    await user.click(
      await within(card).findByTestId("row-badge-share-sort_test"),
    );

    const sheet = await screen.findByTestId("sheet-badge-share-members");
    // Wait for all 3 member rows to render.
    await waitFor(() => expect(rowOrder(sheet)).toHaveLength(3));

    // ── Default sort: total desc → alpha (10), bravo (8), charlie (6) ──
    expect(rowOrder(sheet)).toEqual([101, 202, 303]);

    // ── Click "Copy" header → copy desc → charlie (5), alpha (4), bravo (1)
    await user.click(within(sheet).getByTestId("sort-badge-drilldown-copy"));
    await waitFor(() => expect(rowOrder(sheet)).toEqual([303, 101, 202]));
    // Active column shows the sort indicator (aria-sort=descending).
    expect(
      within(sheet).getByTestId("sort-badge-drilldown-copy"),
    ).toHaveAttribute("aria-sort", "descending");
    // Other method columns are NOT marked sorted.
    expect(
      within(sheet).getByTestId("sort-badge-drilldown-web_share"),
    ).toHaveAttribute("aria-sort", "none");
    expect(
      within(sheet).getByTestId("sort-badge-drilldown-native_share"),
    ).toHaveAttribute("aria-sort", "none");

    // Rank column reflects the new order: charlie should now be rank 1.
    const charlieRow = within(sheet).getByTestId("row-badge-share-member-303");
    expect(within(charlieRow).getAllByRole("cell")[0].textContent).toBe("1");

    // ── Click "Web" header → web desc → bravo (6), alpha (4), charlie (1)
    await user.click(
      within(sheet).getByTestId("sort-badge-drilldown-web_share"),
    );
    await waitFor(() => expect(rowOrder(sheet)).toEqual([202, 101, 303]));
    expect(
      within(sheet).getByTestId("sort-badge-drilldown-web_share"),
    ).toHaveAttribute("aria-sort", "descending");
    expect(
      within(sheet).getByTestId("sort-badge-drilldown-copy"),
    ).toHaveAttribute("aria-sort", "none");

    // ── Click "Native" header → native desc → alpha (2), bravo (1), charlie (0)
    await user.click(
      within(sheet).getByTestId("sort-badge-drilldown-native_share"),
    );
    await waitFor(() => expect(rowOrder(sheet)).toEqual([101, 202, 303]));
    expect(
      within(sheet).getByTestId("sort-badge-drilldown-native_share"),
    ).toHaveAttribute("aria-sort", "descending");

    // ── Task #2249 — clicking "Shares" (Total) header reverts to total desc
    //    without having to close & reopen the sheet.
    // First go back to a method sort so Total is NOT the active key.
    await user.click(within(sheet).getByTestId("sort-badge-drilldown-copy"));
    await waitFor(() => expect(rowOrder(sheet)).toEqual([303, 101, 202]));
    expect(
      within(sheet).getByTestId("sort-badge-drilldown-total"),
    ).toHaveAttribute("aria-sort", "none");

    // Now click Total → reverts to total desc, indicator moves to Total.
    await user.click(within(sheet).getByTestId("sort-badge-drilldown-total"));
    await waitFor(() => expect(rowOrder(sheet)).toEqual([101, 202, 303]));
    expect(
      within(sheet).getByTestId("sort-badge-drilldown-total"),
    ).toHaveAttribute("aria-sort", "descending");
    expect(
      within(sheet).getByTestId("sort-badge-drilldown-copy"),
    ).toHaveAttribute("aria-sort", "none");
    expect(
      within(sheet).getByTestId("sort-badge-drilldown-web_share"),
    ).toHaveAttribute("aria-sort", "none");
    expect(
      within(sheet).getByTestId("sort-badge-drilldown-native_share"),
    ).toHaveAttribute("aria-sort", "none");

    // Clicking Total again while it's already active is a no-op visually.
    await user.click(within(sheet).getByTestId("sort-badge-drilldown-total"));
    expect(rowOrder(sheet)).toEqual([101, 202, 303]);
    expect(
      within(sheet).getByTestId("sort-badge-drilldown-total"),
    ).toHaveAttribute("aria-sort", "descending");

    // ── Close and reopen → sort resets back to default (total desc) ────
    await act(async () => {
      await user.keyboard("{Escape}");
    });
    await waitFor(() =>
      expect(screen.queryByTestId("sheet-badge-share-members")).toBeNull(),
    );

    await user.click(
      within(card).getByTestId("row-badge-share-sort_test"),
    );
    const sheet2 = await screen.findByTestId("sheet-badge-share-members");
    await waitFor(() => expect(rowOrder(sheet2)).toHaveLength(3));
    // Back to default order — total desc.
    expect(rowOrder(sheet2)).toEqual([101, 202, 303]);
    // None of the method columns are marked active any more.
    expect(
      within(sheet2).getByTestId("sort-badge-drilldown-copy"),
    ).toHaveAttribute("aria-sort", "none");
    expect(
      within(sheet2).getByTestId("sort-badge-drilldown-web_share"),
    ).toHaveAttribute("aria-sort", "none");
    expect(
      within(sheet2).getByTestId("sort-badge-drilldown-native_share"),
    ).toHaveAttribute("aria-sort", "none");
  });
});
