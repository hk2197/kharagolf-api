/**
 * Task #2229 — Browser-driven coverage for the badge drill-down PDF export
 * (`button-export-badge-drilldown-pdf`, shipped under Task #1788).
 *
 * The drill-down sheet on /analytics now offers both CSV and PDF export
 * buttons. CSV is exercised by the same path as the on-screen rows (Task
 * #1797's sort spec) and the click-through wiring is covered by
 * `badge-share-drilldown.test.tsx`. The PDF flow, however, side-steps any
 * in-app DOM by calling `window.open('', '_blank')` and writing a
 * standalone print document into the new window — that means a static
 * scan can't tell whether the printable view actually receives the
 * badge label, the active period, and one row per visible member. A
 * regression that, say, drops the period from the title or stops
 * iterating `sortedDrilldownMembers` would silently ship.
 *
 * This spec drives the same click-path as the existing drill-down tests:
 *
 *   1. Open /analytics, wait for the badge-share leaderboard.
 *   2. Click a badge row to open the drill-down sheet.
 *   3. Click the PDF export button.
 *   4. Capture the HTML the SPA writes into the popup `window.document`
 *      and assert it contains:
 *        - the badge label in the title heading,
 *        - the human period label ("This Month" for the default period),
 *        - one `<tr>` per seeded member, in the same on-screen sort order,
 *        - the rank / member / handle / total / copy / web / native column
 *          headers the task explicitly calls out.
 *
 * jsdom does not implement `window.open`, so we stub it with a fake
 * window whose `document.write` appends to a string buffer. That keeps
 * the assertions purely data-driven (no real popup, no real print
 * dialog) while still proving the printable view's contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  within,
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

const ORG_ID = 42;

// Three members with distinct per-method counts so we can prove every
// row makes it into the printable HTML in the same on-screen order.
// Default sort is "total desc" ⇒ alpha (10), bravo (8), charlie (6).
const MEMBERS = [
  {
    userId: 101,
    displayName: "Alpha PdfDrill",
    publicHandle: "alpha-handle",
    byMethod: { copy: 4, web_share: 4, native_share: 2 },
  },
  {
    userId: 202,
    displayName: "Bravo PdfDrill",
    publicHandle: "bravo-handle",
    byMethod: { copy: 1, web_share: 6, native_share: 1 },
  },
  {
    userId: 303,
    displayName: "Charlie PdfDrill",
    publicHandle: null,
    byMethod: { copy: 5, web_share: 1, native_share: 0 },
  },
];

function methodTotal(m: { copy: number; web_share: number; native_share: number }) {
  return m.copy + m.web_share + m.native_share;
}

function buildBackend() {
  const ok = (body: unknown) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    } as Response);

  const totals = { copy: 0, web_share: 0, native_share: 0 };
  for (const m of MEMBERS) {
    totals.copy += m.byMethod.copy;
    totals.web_share += m.byMethod.web_share;
    totals.native_share += m.byMethod.native_share;
  }

  const leaderboardPayload = {
    period: "month",
    from: new Date().toISOString(),
    to: new Date().toISOString(),
    totals: {
      total: totals.copy + totals.web_share + totals.native_share,
      byMethod: totals,
    },
    badges: [
      {
        badgeType: "first_birdie",
        label: "First Birdie",
        icon: "🐦",
        category: "milestone",
        total: totals.copy + totals.web_share + totals.native_share,
        byMethod: totals,
      },
    ],
  };

  const memberBreakdownPayload = {
    period: "month",
    from: new Date().toISOString(),
    to: new Date().toISOString(),
    badge: {
      badgeType: "first_birdie",
      label: "First Birdie",
      icon: "🐦",
      category: "milestone",
    },
    totals: {
      total: totals.copy + totals.web_share + totals.native_share,
      byMethod: totals,
      visits: 0,
      conversionRate: null,
    },
    members: MEMBERS.map((m) => ({
      userId: m.userId,
      displayName: m.displayName,
      username: null,
      publicHandle: m.publicHandle,
      total: methodTotal(m.byMethod),
      byMethod: m.byMethod,
      visits: 0,
      conversionRate: null,
    })),
  };

  const handler = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.split("?")[0].replace(/^.*\/api\//, "/api/");

    // Drill-down: must come before the leaderboard match because of the
    // shared prefix.
    const drillMatch = path.match(
      new RegExp(
        `^/api/organizations/${ORG_ID}/analytics/badge-share-leaderboard/([^/]+)$`,
      ),
    );
    if (method === "GET" && drillMatch) {
      return ok(memberBreakdownPayload);
    }
    if (
      method === "GET" &&
      path === `/api/organizations/${ORG_ID}/analytics/badge-share-leaderboard`
    ) {
      return ok(leaderboardPayload);
    }
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

/**
 * Capture-only stand-in for the popup window the SPA opens for PDF
 * export. jsdom does not implement `window.open`; the production code
 * does `win.document.write(html)` then `win.document.close()`. The
 * stand-in concatenates writes into a buffer so the test can inspect
 * exactly what the printable view received. `print()` is also exposed
 * because the production HTML embeds an inline `<script>window.print();</script>`
 * — that script never runs (we never parse the buffer as a document)
 * but having a `print` method here means a future refactor that calls
 * `win.print()` directly won't crash the test silently.
 */
function buildPrintWindow() {
  let buffer = "";
  let closed = false;
  const win = {
    document: {
      write(html: string) {
        buffer += html;
      },
      close() {
        closed = true;
      },
    },
    print: vi.fn(),
    focus: vi.fn(),
  };
  return {
    win,
    getHtml: () => buffer,
    isClosed: () => closed,
  };
}

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe("Badge Share Leaderboard drill-down — PDF export (Task #2229)", () => {
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

  it("opens a printable window with the badge label, active period, and one row per member when the PDF button is clicked", async () => {
    // Stub window.open to hand back our capturing fake. We hold the
    // captured-HTML accessor in a closure so the test can inspect it
    // after the PDF button click.
    const captured = buildPrintWindow();
    const openSpy = vi.fn(() => captured.win as unknown as Window);
    vi.stubGlobal("open", openSpy);

    const user = userEvent.setup();
    renderWithProviders(<AnalyticsPage />);

    // 1. Leaderboard loads, click the seeded badge row to open the sheet.
    const card = await screen.findByTestId("card-badge-share-leaderboard");
    const badgeRow = await within(card).findByTestId(
      "row-badge-share-first_birdie",
    );
    await user.click(badgeRow);

    const sheet = await screen.findByTestId("sheet-badge-share-members");
    // Sanity: every seeded member is rendered in the on-screen table.
    // The PDF export reads from the same sortedDrilldownMembers array,
    // so this also pins the row count we're about to assert in the
    // printable HTML.
    for (const m of MEMBERS) {
      await within(sheet).findByTestId(`row-badge-share-member-${m.userId}`);
    }

    // 2. Click the PDF export button.
    const pdfButton = within(sheet).getByTestId(
      "button-export-badge-drilldown-pdf",
    );
    await user.click(pdfButton);

    // 3. window.open was called with an empty URL + new-tab target —
    // matches `window.open('', '_blank')` in exportToPDF. A future
    // refactor that swapped the popup for an in-app modal would skip
    // this call and the assertion would fail loudly.
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.calls[0]?.[0]).toBe("");
    expect(openSpy.mock.calls[0]?.[1]).toBe("_blank");

    // 4. Pull the HTML the SPA wrote into the popup.
    const html = captured.getHtml();
    expect(html.length).toBeGreaterThan(0);
    // The production code calls document.close() after writing — confirm
    // it ran so we know the popup wasn't left in an open-write state.
    expect(captured.isClosed()).toBe(true);

    // Title heading carries the badge label AND the active period. The
    // period selector defaults to "month" ⇒ "This Month".
    expect(html).toMatch(/<h2>First Birdie\s*&mdash;|<h2>First Birdie\s*—/);
    expect(html).toContain("First Birdie");
    expect(html).toContain("This Month");

    // 5. Column headers — the task explicitly calls out
    // rank/member/handle/total/copy/web/native. They're keys of the
    // exported row objects and become <th> labels inside the
    // printable table.
    for (const header of ["rank", "member", "handle", "total", "copy", "web", "native"]) {
      expect(html).toMatch(new RegExp(`<th>${header}</th>`));
    }

    // 6. One <tr>...</tr> per member inside the <tbody>. Pull the
    // tbody slice so the thead row doesn't pad the count.
    const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(tbodyMatch, "printable HTML must include a <tbody>").toBeTruthy();
    const tbody = tbodyMatch![1];
    const rowMatches = tbody.match(/<tr>/g) ?? [];
    expect(rowMatches.length).toBe(MEMBERS.length);

    // Every member's display name + handle appears in a row, and the
    // rows come out in the on-screen sort order (total desc): alpha,
    // bravo, charlie. Asserting on `indexOf` ordering proves the PDF
    // iterates `sortedDrilldownMembers` rather than the API's raw
    // members array — a regression that swapped to the unsorted source
    // would flip alpha/charlie since charlie has more copies but a
    // smaller total.
    const expectedOrder = [...MEMBERS].sort(
      (a, b) => methodTotal(b.byMethod) - methodTotal(a.byMethod),
    );
    let cursor = 0;
    for (const m of expectedOrder) {
      const idx = tbody.indexOf(m.displayName, cursor);
      expect(
        idx,
        `printable PDF must include ${m.displayName} after the previous member`,
      ).toBeGreaterThan(-1);
      cursor = idx + m.displayName.length;
    }
    // Handles are escaped by the same path; null handles fall back to ''
    // (so charlie has no handle to assert on, but the row still exists).
    expect(tbody).toContain("alpha-handle");
    expect(tbody).toContain("bravo-handle");

    // 7. Rank column is 1-based and matches the on-screen position. The
    // rank cell is the first <td> inside each <tr>, so the first row's
    // rank is 1, second is 2, third is 3. Pull the per-row rank cells
    // and assert they're sequential — guards against a regression that
    // accidentally exported the array index instead of `idx + 1`.
    const trBlocks = tbody
      .split(/<tr>/)
      .slice(1)
      .map((s) => s.split("</tr>")[0]);
    expect(trBlocks).toHaveLength(MEMBERS.length);
    trBlocks.forEach((block, i) => {
      const firstCell = block.match(/<td[^>]*>([^<]*)<\/td>/);
      expect(firstCell, `row ${i} should have a rank <td>`).toBeTruthy();
      expect(firstCell![1]).toBe(String(i + 1));
    });
  });
});
