/**
 * Task #1550 — "First surfaced X ago" age cue in the Plan Migration Audit
 * panel.
 *
 * Task #1313 added a "first surfaced X days ago" line to the daily plan-
 * migration digest email so super admins triaging from their inbox could
 * spot stale, unacknowledged rows. This task closes the loop by surfacing
 * the same age signal — using the same buckets and colour ramp — in the
 * in-app Plan Migration Audit panel so support staff who triage from the
 * dashboard see the same priority cue.
 *
 * What this file pins down:
 *   1. The pure helper `planMigrationFirstSurfaced` produces the right
 *      label + tone class for each bucket boundary.
 *   2. The panel renders a "first surfaced …" line on unacknowledged rows,
 *      preferring `firstDigestedAt` and falling back to `createdAt` when
 *      the row hasn't been digested yet.
 *   3. Acknowledged rows do NOT show the age cue (the row is no longer
 *      actionable, so the "stale" signal would be noise).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: 1, organizationId: 1, role: "super_admin" },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/super-admin", vi.fn()],
}));

import SuperAdminPage, { planMigrationFirstSurfaced } from "../super-admin";

interface MigrationEntry {
  id: number;
  organizationId: number;
  orgName: string | null;
  orgSlug: string | null;
  currentTier: string | null;
  fromTier: string | null;
  toTier: string | null;
  reason: string | null;
  createdAt: string;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  acknowledgedByUserId: number | null;
  acknowledgedByName: string | null;
  acknowledgedVia: 'email' | 'dashboard' | null;
  firstDigestedAt: string | null;
}

function makeEntry(over: Partial<MigrationEntry> & { id: number }): MigrationEntry {
  return {
    organizationId: 200 + over.id,
    orgName: `Club ${over.id}`,
    orgSlug: `club-${over.id}`,
    currentTier: "free",
    fromTier: "pro",
    toTier: "free",
    reason: "downgraded automatically",
    createdAt: "2026-04-29T00:00:00.000Z",
    acknowledged: false,
    acknowledgedAt: null,
    acknowledgedByUserId: null,
    acknowledgedByName: null,
    acknowledgedVia: null,
    firstDigestedAt: null,
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SuperAdminPage />
    </QueryClientProvider>,
  );
}

describe("planMigrationFirstSurfaced — bucket + colour helper", () => {
  // Pin "now" so the bucket boundaries are deterministic.
  const NOW_MS = new Date("2026-04-29T12:00:00.000Z").getTime();

  it("returns null for missing or unparseable timestamps", () => {
    expect(planMigrationFirstSurfaced(null, NOW_MS)).toBeNull();
    expect(planMigrationFirstSurfaced(undefined, NOW_MS)).toBeNull();
    expect(planMigrationFirstSurfaced("", NOW_MS)).toBeNull();
    expect(planMigrationFirstSurfaced("not-a-date", NOW_MS)).toBeNull();
  });

  it("uses grey 'just now' label when under 1 hour old", () => {
    // 30 minutes ago — well within the <1h grey bucket.
    const iso = new Date(NOW_MS - 30 * 60 * 1000).toISOString();
    const out = planMigrationFirstSurfaced(iso, NOW_MS);
    expect(out).toEqual({ label: "first surfaced just now", toneClass: "text-gray-400" });
  });

  it("uses grey 'N hours ago' label between 1h and 24h", () => {
    // Exactly 1h → grey "1 hour" (singular).
    const oneHour = new Date(NOW_MS - 60 * 60 * 1000).toISOString();
    expect(planMigrationFirstSurfaced(oneHour, NOW_MS)).toEqual({
      label: "first surfaced 1 hour ago",
      toneClass: "text-gray-400",
    });
    // 5h → grey "5 hours" (plural).
    const fiveHours = new Date(NOW_MS - 5 * 60 * 60 * 1000).toISOString();
    expect(planMigrationFirstSurfaced(fiveHours, NOW_MS)).toEqual({
      label: "first surfaced 5 hours ago",
      toneClass: "text-gray-400",
    });
  });

  it("uses amber 'N days ago' label between 1 day and 7 days", () => {
    // Exactly 1 day → amber, singular.
    const oneDay = new Date(NOW_MS - 24 * 60 * 60 * 1000).toISOString();
    expect(planMigrationFirstSurfaced(oneDay, NOW_MS)).toEqual({
      label: "first surfaced 1 day ago",
      toneClass: "text-amber-400",
    });
    // 3 days → amber, plural.
    const threeDays = new Date(NOW_MS - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(planMigrationFirstSurfaced(threeDays, NOW_MS)).toEqual({
      label: "first surfaced 3 days ago",
      toneClass: "text-amber-400",
    });
  });

  it("uses red 'N days ago' label at or beyond 7 days", () => {
    // Exactly 7 days → red.
    const sevenDays = new Date(NOW_MS - 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(planMigrationFirstSurfaced(sevenDays, NOW_MS)).toEqual({
      label: "first surfaced 7 days ago",
      toneClass: "text-red-400",
    });
    // 30 days → still red, just a bigger number.
    const thirtyDays = new Date(NOW_MS - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(planMigrationFirstSurfaced(thirtyDays, NOW_MS)).toEqual({
      label: "first surfaced 30 days ago",
      toneClass: "text-red-400",
    });
  });

  it("clamps future timestamps to 'just now' rather than producing negative ages", () => {
    const future = new Date(NOW_MS + 60 * 60 * 1000).toISOString();
    expect(planMigrationFirstSurfaced(future, NOW_MS)).toEqual({
      label: "first surfaced just now",
      toneClass: "text-gray-400",
    });
  });
});

describe("Plan Migration audit panel — first-surfaced age cue", () => {
  // Compute timestamps relative to real `Date.now()` rather than freezing
  // the clock. We deliberately avoid `vi.useFakeTimers()` here because it
  // also halts the timers React Query uses internally, which would stall
  // the panel's data load. The deltas are large enough (e.g. "2 days +
  // 1 hour ago") that the assertions can't flip into the wrong bucket
  // even on a slow CI machine, so the labels stay deterministic.
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const ONE_DAY_MS = 24 * ONE_HOUR_MS;
  const startNow = Date.now();
  const isoMinus = (ms: number) => new Date(startNow - ms).toISOString();

  // Five entries that exercise each visible bucket + the fallback + the
  // acknowledged-row suppression:
  //   - Row 30: digested 30m ago → grey "just now"
  //   - Row 31: digested 2 days + 1h ago → amber, "2 days ago" label
  //   - Row 32: digested 10 days ago → red, "10 days ago" label
  //   - Row 33: never digested (firstDigestedAt=null) but createdAt is
  //             3h ago → grey fallback uses createdAt.
  //   - Row 34: acknowledged row — must NOT show the age cue.
  const entries: MigrationEntry[] = [
    makeEntry({
      id: 30,
      firstDigestedAt: isoMinus(30 * 60 * 1000),
    }),
    makeEntry({
      id: 31,
      firstDigestedAt: isoMinus(2 * ONE_DAY_MS + ONE_HOUR_MS),
    }),
    makeEntry({
      id: 32,
      firstDigestedAt: isoMinus(10 * ONE_DAY_MS),
    }),
    makeEntry({
      id: 33,
      firstDigestedAt: null,
      createdAt: isoMinus(3 * ONE_HOUR_MS),
    }),
    makeEntry({
      id: 34,
      firstDigestedAt: isoMinus(5 * ONE_DAY_MS),
      acknowledged: true,
      acknowledgedAt: new Date(startNow).toISOString(),
      acknowledgedByUserId: 9,
      acknowledgedByName: "Casey Closer",
      acknowledgedVia: "dashboard",
    }),
  ];

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith("/api/super-admin/dashboard") && method === "GET") {
        return jsonResponse({
          totalClubs: 0, activeClubs: 0, totalUsers: 0, totalTournaments: 0,
          activeTournaments: 0,
          tierBreakdown: { free: 0, starter: 0, pro: 0, enterprise: 0 },
          estimatedMrr: 0, bookingsThisMonth: 0, bookingRevenueThisMonth: 0,
          bookingsByClub: [],
        });
      }
      if (url.startsWith("/api/super-admin/caddie-prompt-metrics") && method === "GET") {
        return jsonResponse({
          total: 0, windowStart: null, windowEnd: null,
          byMode: { shots: 0, rounds: 0 },
          avgEstimatedInputTokens: 0, p50EstimatedInputTokens: 0,
          p95EstimatedInputTokens: 0, maxEstimatedInputTokens: 0,
          avgTotalTrackedShots: 0, avgRoundCount: 0, recent: [],
        });
      }
      if (url.startsWith("/api/super-admin/watch-position-metrics") && method === "GET") {
        const emptyWindow = {
          totalMessages: 0, bucketCount: 0, activeSessionCount: 0,
          avgMessagesPerSessionMinute: 0, p50MessagesPerSessionMinute: 0,
          p95MessagesPerSessionMinute: 0, maxMessagesPerSessionMinute: 0,
        };
        return jsonResponse({
          windows: { "24h": emptyWindow, "7d": emptyWindow, "30d": emptyWindow },
          seriesByWindow: { "24h": [], "7d": [], "30d": [] },
          seriesBucketSeconds: { "24h": 60, "7d": 3600, "30d": 86400 },
          recent: [],
        });
      }
      if (url.startsWith("/api/super-admin/legacy-slug-mappings") && method === "GET") {
        return jsonResponse({ mappings: [] });
      }
      if (url.startsWith("/api/super-admin/plan-migration-audit") && method === "GET") {
        // Show acknowledged is off by default — but row 34 is included so
        // we can also assert that acknowledged rows omit the age cue when
        // someone toggles "Show acknowledged" on. Since the test needs to
        // see the acknowledged row without toggling, return everything:
        // the route filter respects ?includeAcknowledged but the filter
        // happens server-side, so the mock just returns the full list.
        return jsonResponse({
          entries,
          total: entries.length,
          page: 1,
          limit: 500,
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("renders the first-surfaced line on each unacknowledged row with the right label, and omits it on acknowledged rows", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /plan migrations/i }));
    await screen.findByText("Club 30");

    // Row 30 — digested 30m ago → grey "just now".
    const row30 = screen.getByTestId("first-surfaced-30");
    expect(row30).toHaveTextContent("first surfaced just now");
    expect(row30.className).toContain("text-gray-400");

    // Row 31 — digested 2 days ago → amber "2 days ago".
    const row31 = screen.getByTestId("first-surfaced-31");
    expect(row31).toHaveTextContent("first surfaced 2 days ago");
    expect(row31.className).toContain("text-amber-400");

    // Row 32 — digested 10 days ago → red "10 days ago".
    const row32 = screen.getByTestId("first-surfaced-32");
    expect(row32).toHaveTextContent("first surfaced 10 days ago");
    expect(row32.className).toContain("text-red-400");

    // Row 33 — never digested, falls back to createdAt (3h ago, grey).
    const row33 = screen.getByTestId("first-surfaced-33");
    expect(row33).toHaveTextContent("first surfaced 3 hours ago");
    expect(row33.className).toContain("text-gray-400");
    // The tooltip should make it clear the fallback was used.
    expect(row33.getAttribute("title")).toMatch(/Not yet included in a digest/);

    // Row 30's tooltip should reference the actual digest dispatch time
    // (we don't pin the exact rendered locale string, but it must include
    // the "First included in a super-admin digest" prefix).
    expect(row30.getAttribute("title")).toMatch(/First included in a super-admin digest/);

    // Row 34 — acknowledged → the age cue must NOT render even though the
    // mock entry has a non-null firstDigestedAt.
    expect(screen.queryByTestId("first-surfaced-34")).toBeNull();
    // Sanity: row 34 still appears in the table (the panel's default filter
    // hides acked rows server-side, but our mock returns the full list so
    // we can verify the conditional render).
    const ackRow = screen.getByText("Club 34").closest("tr") as HTMLElement;
    expect(within(ackRow).getByText(/Reviewed/i)).toBeInTheDocument();
  });
});
