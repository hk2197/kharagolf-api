/**
 * E2E-style component test for the Badge Share Leaderboard drill-down on the
 * /analytics page — Task #1466 (regression coverage for Task #1248).
 *
 * The backend endpoint
 *   GET /api/organizations/:orgId/analytics/badge-share-leaderboard/:badgeType
 * is already exercised by `artifacts/api-server/src/tests/badge-share-events.test.ts`.
 * This test adds a browser-level safety net so a future refactor of the
 * SPA wiring (e.g. dropping `encodeURIComponent` on the badgeType path
 * segment, adding a stray `e.stopPropagation()` to the leaderboard row,
 * or changing the `drilldownBadge` query key) cannot silently break the
 * click-through flow.
 *
 * The test stubs `fetch` with a tiny in-memory backend that owns the
 * leaderboard + per-badge member breakdown, then walks the page through:
 *
 *   1. Page loads with the dashboard tab active → leaderboard renders our
 *      seeded badges sorted by total desc (first_birdie above first_eagle).
 *   2. Admin clicks the first_birdie row → the right-side drill-down sheet
 *      opens, the network request that fired hit the per-badge URL with
 *      `:badgeType = first_birdie` (URL-encoded), and the sheet renders the
 *      seeded member rows with their per-method counts.
 *   3. Admin closes the sheet, clicks the first_eagle row → the sheet
 *      reopens against the second badge (proves the query key re-keys on
 *      `drilldownBadge.badgeType`), the new request is fired against
 *      `:badgeType = first_eagle`, and only the alpha member is visible
 *      (bravo did not share that badge).
 *
 * Each step asserts on the same `data-testid` hooks the page exposes, so any
 * rename / removal of those hooks (or break in the click-to-fetch wiring)
 * fails this test.
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

// AnalyticsPage destructures activeOrgId out of useActiveOrgId(), and the
// real hook returns a bare number so destructuring it would yield undefined
// and silently disable every query. Mocking it here lets the page believe
// it has a stable org id without dragging in <ActiveOrgProvider />, the
// auth context, the API codegen client, or local storage.
vi.mock("@/context/ActiveOrgContext", () => ({
  useActiveOrgId: () => ({ activeOrgId: 42 }),
  useActiveOrgContext: () => ({
    activeOrgId: 42,
    isOrgOverridden: false,
    setActiveOrg: () => {},
  }),
  ActiveOrgProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// AnalyticsPage opens print previews for some PDF/print buttons we never
// click, but jsdom does not implement window.open. Stub it out so a
// stray click in the future doesn't blow up the test run.
beforeEach(() => {
  vi.stubGlobal("open", vi.fn(() => null));
});

interface MemberSeed {
  userId: number;
  displayName: string;
  byMethod: { copy: number; web_share: number; native_share: number };
  // Task #1798 — per-member visit + conversion attribution. Added to the
  // seed so the drill-down sheet, which now renders Visits/Conv columns,
  // has values to render. Defaulted in the per-badge seeds below to 0/null
  // since this regression test isn't asserting on attribution behaviour.
  visits?: number;
  conversionRate?: number | null;
}

interface BadgeSeed {
  badgeType: string;
  label: string;
  icon: string;
  category: string | null;
  members: MemberSeed[];
}

function methodTotal(m: MemberSeed["byMethod"]) {
  return m.copy + m.web_share + m.native_share;
}

/**
 * Tiny in-memory backend that knows just enough to render the dashboard
 * tab plus the badge-share leaderboard + drill-down. The other GETs the
 * page fires (kpi, profile-share-leaderboard, reports, schedules) get
 * empty/default payloads so the page mounts cleanly without 404 noise.
 *
 * The handler also records every request it sees so the test can assert
 * the drill-down URL was actually hit with the expected `:badgeType`
 * path segment.
 */
function buildBackend(badges: BadgeSeed[]) {
  const calls: { url: string; method: string }[] = [];

  const orgId = 42;

  const leaderboardPayload = () => {
    const totalByMethod = { copy: 0, web_share: 0, native_share: 0 };
    const out = badges.map(b => {
      const byMethod = { copy: 0, web_share: 0, native_share: 0 };
      for (const m of b.members) {
        byMethod.copy += m.byMethod.copy;
        byMethod.web_share += m.byMethod.web_share;
        byMethod.native_share += m.byMethod.native_share;
      }
      totalByMethod.copy += byMethod.copy;
      totalByMethod.web_share += byMethod.web_share;
      totalByMethod.native_share += byMethod.native_share;
      return {
        badgeType: b.badgeType,
        label: b.label,
        icon: b.icon,
        category: b.category,
        total:
          byMethod.copy + byMethod.web_share + byMethod.native_share,
        byMethod,
      };
    });
    out.sort((a, b) => b.total - a.total);
    return {
      period: "month",
      from: new Date().toISOString(),
      to: new Date().toISOString(),
      totals: {
        total:
          totalByMethod.copy +
          totalByMethod.web_share +
          totalByMethod.native_share,
        byMethod: totalByMethod,
      },
      badges: out,
    };
  };

  const memberBreakdownPayload = (badgeType: string) => {
    const badge = badges.find(b => b.badgeType === badgeType);
    if (!badge) return null;
    const totals = { copy: 0, web_share: 0, native_share: 0 };
    const members = badge.members.map(m => {
      totals.copy += m.byMethod.copy;
      totals.web_share += m.byMethod.web_share;
      totals.native_share += m.byMethod.native_share;
      return {
        userId: m.userId,
        displayName: m.displayName,
        username: null,
        publicHandle: null,
        total: methodTotal(m.byMethod),
        byMethod: m.byMethod,
        // Task #1798 — drill-down sheet renders Visits/Conv columns;
        // default to 0/null since this regression test is about click-
        // through wiring, not attribution.
        visits: m.visits ?? 0,
        conversionRate: m.conversionRate ?? null,
      };
    });
    members.sort((a, b) => b.total - a.total);
    return {
      period: "month",
      from: new Date().toISOString(),
      to: new Date().toISOString(),
      badge: {
        badgeType: badge.badgeType,
        label: badge.label,
        icon: badge.icon,
        category: badge.category,
      },
      totals: {
        total: totals.copy + totals.web_share + totals.native_share,
        byMethod: totals,
        // Task #1798 — header chip reads totals.conversionRate.
        visits: 0,
        conversionRate: null,
      },
      members,
    };
  };

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
    calls.push({ url, method });

    // Strip any base prefix (vite's import.meta.env.BASE_URL is "/" in tests)
    // and any query string so the route match below is robust.
    const path = url.split("?")[0].replace(/^.*\/api\//, "/api/");

    // Drill-down: must come BEFORE the leaderboard match, otherwise the
    // shared "/api/.../analytics/badge-share-leaderboard" prefix would
    // swallow the per-badge URL.
    const drillMatch = path.match(
      new RegExp(
        `^/api/organizations/${orgId}/analytics/badge-share-leaderboard/([^/]+)$`,
      ),
    );
    if (method === "GET" && drillMatch) {
      const badgeType = decodeURIComponent(drillMatch[1]);
      const payload = memberBreakdownPayload(badgeType);
      if (!payload) {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ error: "unknown badge" }),
        } as Response);
      }
      return ok(payload);
    }

    if (
      method === "GET" &&
      path === `/api/organizations/${orgId}/analytics/badge-share-leaderboard`
    ) {
      return ok(leaderboardPayload());
    }

    // Tolerant defaults for everything else the page touches on mount.
    if (
      method === "GET" &&
      path === `/api/organizations/${orgId}/analytics/profile-share-leaderboard`
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
      path === `/api/organizations/${orgId}/analytics/reports`
    ) {
      return ok({ reports: [] });
    }
    if (
      method === "GET" &&
      path === `/api/organizations/${orgId}/analytics/schedules`
    ) {
      return ok({ schedules: [] });
    }
    if (
      method === "GET" &&
      path === `/api/organizations/${orgId}/analytics/kpi`
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

    // Anything else: empty 200 keeps the page from spamming the console.
    return ok({});
  };

  return { handler, calls };
}

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe("Badge Share Leaderboard drill-down (Task #1466)", () => {
  let backend: ReturnType<typeof buildBackend>;

  beforeEach(() => {
    backend = buildBackend([
      {
        badgeType: "first_birdie",
        label: "First Birdie",
        icon: "🐦",
        category: "milestone",
        members: [
          {
            userId: 101,
            displayName: "Alpha BadgeDrill",
            byMethod: { copy: 3, web_share: 1, native_share: 0 },
          },
          {
            userId: 202,
            displayName: "Bravo BadgeDrill",
            byMethod: { copy: 0, web_share: 0, native_share: 1 },
          },
        ],
      },
      {
        badgeType: "first_eagle",
        label: "First Eagle",
        icon: "🦅",
        category: "milestone",
        members: [
          {
            userId: 101,
            displayName: "Alpha BadgeDrill",
            byMethod: { copy: 0, web_share: 2, native_share: 0 },
          },
        ],
      },
      // A deliberately URL-sensitive badgeType — contains characters
      // (`/`, ` `, `&`) that encodeURIComponent must transform. If a
      // future refactor drops encodeURIComponent on the path segment,
      // the outgoing URL would either 404 (the `/` would split the
      // path) or the server would see the wrong badgeType. The
      // assertions in step 4 below catch both regressions.
      {
        badgeType: "birdie/ace & co",
        label: "Birdie / Ace & Co",
        icon: "🎯",
        category: "milestone",
        members: [
          {
            userId: 303,
            displayName: "Charlie BadgeDrill",
            byMethod: { copy: 1, web_share: 0, native_share: 0 },
          },
        ],
      },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(backend.handler) as unknown as typeof fetch,
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens the per-member sheet when a leaderboard row is clicked, and re-keys when a different badge is clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AnalyticsPage />);

    // ── Step 1: Leaderboard renders both seeded badges ──────────────────
    const card = await screen.findByTestId("card-badge-share-leaderboard");
    const birdieRow = await within(card).findByTestId(
      "row-badge-share-first_birdie",
    );
    const eagleRow = await within(card).findByTestId(
      "row-badge-share-first_eagle",
    );
    expect(birdieRow).toHaveTextContent(/First Birdie/);
    expect(eagleRow).toHaveTextContent(/First Eagle/);
    // Sheet not yet mounted.
    expect(screen.queryByTestId("sheet-badge-share-members")).toBeNull();

    // ── Step 2: Click the first_birdie row → sheet opens with members ──
    await user.click(birdieRow);

    const sheet = await screen.findByTestId("sheet-badge-share-members");
    // Header shows the badge label.
    expect(sheet).toHaveTextContent(/First Birdie/);

    // The drill-down request fired with badgeType in the path segment
    // AND carried the active `period` as a query param. Both pieces are
    // load-bearing: a future refactor that drops the `period=` param
    // would silently make the drill-down ignore the dashboard's period
    // selector, and a refactor that drops the path segment would 404.
    await waitFor(() => {
      const drillCall = backend.calls.find(c =>
        c.url.includes(
          "/analytics/badge-share-leaderboard/first_birdie",
        ),
      );
      expect(drillCall, "drill-down GET for first_birdie").toBeTruthy();
      expect(drillCall!.method).toBe("GET");
      // Default period on /analytics is "month".
      expect(drillCall!.url).toMatch(/[?&]period=month(?:&|$)/);
    });

    // Both seeded members appear with their per-method counts.
    const alphaRow = await within(sheet).findByTestId(
      "row-badge-share-member-101",
    );
    const bravoRow = await within(sheet).findByTestId(
      "row-badge-share-member-202",
    );
    expect(alphaRow).toHaveTextContent(/Alpha BadgeDrill/);
    expect(bravoRow).toHaveTextContent(/Bravo BadgeDrill/);

    // Per-method cells: alpha = total 4, copy 3, web 1, native 0
    //                   bravo = total 1, copy 0, web 0, native 1
    const alphaCells = within(alphaRow).getAllByRole("cell");
    expect(alphaCells.map(c => c.textContent)).toEqual([
      "1",
      // The "Member" cell wraps the display name in nested <div>s; just
      // assert it contains the name rather than equal a flattened string.
      expect.stringContaining("Alpha BadgeDrill"),
      "4",
      "3",
      "1",
      "0",
      // Task #1798 — Visits + Conv. cells. Seeded as 0/null since this
      // test isn't asserting on attribution behaviour.
      "0",
      "—",
    ]);
    const bravoCells = within(bravoRow).getAllByRole("cell");
    expect(bravoCells.map(c => c.textContent)).toEqual([
      "2",
      expect.stringContaining("Bravo BadgeDrill"),
      "1",
      "0",
      "0",
      "1",
      "0",
      "—",
    ]);

    // ── Step 3: Close the sheet and click a DIFFERENT badge row ─────────
    // Radix Sheet wires Escape to onOpenChange(false), which the page maps
    // to setDrilldownBadge(null). After Escape the Sheet content unmounts.
    await act(async () => {
      await user.keyboard("{Escape}");
    });
    await waitFor(() =>
      expect(screen.queryByTestId("sheet-badge-share-members")).toBeNull(),
    );

    // Snapshot how many drill-down calls have fired so far so we can
    // assert a NEW one fires for the second badge.
    const callsBefore = backend.calls.filter(c =>
      c.url.includes("/analytics/badge-share-leaderboard/"),
    ).length;

    await user.click(
      within(card).getByTestId("row-badge-share-first_eagle"),
    );

    const sheet2 = await screen.findByTestId("sheet-badge-share-members");
    expect(sheet2).toHaveTextContent(/First Eagle/);
    expect(sheet2).not.toHaveTextContent(/First Birdie/);

    // The new drill-down GET fires with the new badgeType — proves the
    // useQuery key reacts to drilldownBadge.badgeType and the
    // encodeURIComponent path-segment build is intact.
    await waitFor(() => {
      const callsAfter = backend.calls.filter(c =>
        c.url.includes("/analytics/badge-share-leaderboard/"),
      );
      expect(callsAfter.length).toBeGreaterThan(callsBefore);
      expect(
        callsAfter.some(c =>
          c.url.includes(
            "/analytics/badge-share-leaderboard/first_eagle",
          ),
        ),
      ).toBe(true);
    });

    // Only alpha shared first_eagle in the seed → bravo must NOT appear.
    expect(
      await within(sheet2).findByTestId("row-badge-share-member-101"),
    ).toBeInTheDocument();
    expect(
      within(sheet2).queryByTestId("row-badge-share-member-202"),
    ).toBeNull();

    // Alpha's first_eagle counts: total 2, copy 0, web 2, native 0
    const alphaEagleCells = within(
      within(sheet2).getByTestId("row-badge-share-member-101"),
    ).getAllByRole("cell");
    expect(alphaEagleCells.map(c => c.textContent)).toEqual([
      "1",
      expect.stringContaining("Alpha BadgeDrill"),
      "2",
      "0",
      "2",
      "0",
      // Task #1798 — Visits + Conv. cells (seeded 0/null).
      "0",
      "—",
    ]);

    // ── Step 4: URL-encoding regression guard ──────────────────────────
    // Click the third seeded badge whose `badgeType` contains characters
    // ('/', ' ', '&') that MUST be URL-encoded to survive the path
    // segment. If a future refactor drops `encodeURIComponent` on
    // `drilldownBadge.badgeType`, the outgoing URL would contain a raw
    // '/', which splits the path and breaks the route match in
    // `routes/analytics.ts`. This step asserts the encoded form is on
    // the wire AND the server response still flows back into the sheet.
    await act(async () => {
      await user.keyboard("{Escape}");
    });
    await waitFor(() =>
      expect(screen.queryByTestId("sheet-badge-share-members")).toBeNull(),
    );

    const callsBeforeEncoded = backend.calls.length;
    await user.click(
      within(card).getByTestId("row-badge-share-birdie/ace & co"),
    );

    const sheet3 = await screen.findByTestId("sheet-badge-share-members");
    expect(sheet3).toHaveTextContent(/Birdie \/ Ace & Co/);

    await waitFor(() => {
      const newCalls = backend.calls.slice(callsBeforeEncoded);
      const encoded = encodeURIComponent("birdie/ace & co");
      const drillCall = newCalls.find(c =>
        c.url.includes(
          `/analytics/badge-share-leaderboard/${encoded}`,
        ),
      );
      // 1) Encoded form is present on the wire.
      expect(
        drillCall,
        `drill-down GET hit the encoded path '${encoded}'`,
      ).toBeTruthy();
      // 2) Period query param is preserved.
      expect(drillCall!.url).toMatch(/[?&]period=month(?:&|$)/);
      // 3) The raw, unencoded form must NOT be on the wire — that's the
      //    exact regression the task calls out (a stripped
      //    encodeURIComponent would push 'birdie/ace & co' into the URL
      //    verbatim and the '/' would split the path segment).
      const rawHit = newCalls.find(c =>
        c.url.includes(
          "/analytics/badge-share-leaderboard/birdie/ace",
        ),
      );
      expect(
        rawHit,
        "raw, unencoded badgeType MUST NOT appear in the request path",
      ).toBeUndefined();
    });

    // The server response (keyed off the decoded badgeType) flows back
    // into the sheet — proves the round-trip works end-to-end.
    expect(
      await within(sheet3).findByTestId("row-badge-share-member-303"),
    ).toHaveTextContent(/Charlie BadgeDrill/);
  });
});
