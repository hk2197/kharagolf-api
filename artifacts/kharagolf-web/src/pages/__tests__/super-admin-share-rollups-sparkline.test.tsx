/**
 * Task #1821 — UI smoke test for the 7-day savings sparkline on the
 * super-admin badge-share storage-savings panel.
 *
 * Companion to artifacts/api-server/src/tests/badge-share-events.test.ts
 * (which pins down the API contract). This file covers the UI half:
 * that super-admin-share-rollups.tsx actually renders the chart
 * container + label when the badge-share endpoint returns >= 2 history
 * points, and that it falls back to an explanatory empty state
 * otherwise.
 *
 * Catches regressions like a `data-testid` rename, a conditional flip
 * that hides the chart, or accidentally rendering the sparkline for
 * the profile-share variant whose endpoint doesn't return history.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cloneElement, isValidElement } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: 1, organizationId: 1, role: "super_admin" },
    isLoading: false,
  }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/", vi.fn()],
}));

// Recharts uses ResponsiveContainer which measures its parent for layout —
// jsdom has no real layout, so stub it out and inject explicit width /
// height into the chart child. Without this the LineChart never renders
// its <Line> + dots and the test can't assert on the chart presence.
vi.mock("recharts", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) =>
      isValidElement(children)
        ? cloneElement(children as React.ReactElement<Record<string, unknown>>, {
            width: 320,
            height: 64,
          })
        : <>{children}</>,
  };
});

import SuperAdminShareRollupsPage from "../super-admin-share-rollups";

interface BadgeHistoryPoint {
  ranAt: string;
  savingsPercent: number | null;
  savingsRatio: number | null;
}

function makeBadgeSummary(history: BadgeHistoryPoint[] | undefined) {
  return {
    lastRun: {
      ranAt: "2026-04-29T00:00:00Z",
      rolledUpEvents: 100,
      upsertedAggregateRows: 4,
      prunedAggregateRows: 0,
    },
    currentRawEventCount: 0,
    currentAggregateRowCount: 4,
    storageSavings: {
      aggregatedEventCount: 100,
      estimatedRowsSaved: 96,
      estimatedBytesSaved: 9216,
      estimatedBytesPerRawRow: 96,
      savingsPercent: 96,
      savingsRatio: 25,
    },
    ...(history === undefined ? {} : { history, historyDays: 7 }),
    isStale: false,
    staleThresholdMs: 36 * 60 * 60 * 1000,
    rollupAgeMs: 30 * 24 * 60 * 60 * 1000,
    generatedAt: "2026-04-29T00:00:01Z",
  };
}

function makeProfileSummary() {
  // Profile-share endpoint doesn't expose `history` — the sparkline
  // must NOT render for this variant.
  return {
    lastRun: {
      ranAt: "2026-04-29T00:00:00Z",
      rolledUpEvents: 50,
      upsertedAggregateRows: 2,
      prunedAggregateRows: 0,
    },
    currentRawEventCount: 0,
    currentAggregateRowCount: 2,
    storageSavings: {
      aggregatedEventCount: 50,
      estimatedRowsSaved: 48,
      estimatedBytesSaved: 4608,
      estimatedBytesPerRawRow: 96,
      savingsPercent: 96,
      savingsRatio: 25,
    },
    isStale: false,
    staleThresholdMs: 36 * 60 * 60 * 1000,
    rollupAgeMs: 30 * 24 * 60 * 60 * 1000,
    generatedAt: "2026-04-29T00:00:01Z",
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

function installFetch(history: BadgeHistoryPoint[] | undefined) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/super-admin/badge-share-rollup/summary")) {
        return jsonResponse(makeBadgeSummary(history));
      }
      if (url.endsWith("/api/super-admin/profile-share-rollup/summary")) {
        return jsonResponse(makeProfileSummary());
      }
      return jsonResponse({}, 200);
    }),
  );
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SuperAdminShareRollupsPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function buildHistory(days: number, percents: number[]): BadgeHistoryPoint[] {
  if (percents.length !== days) {
    throw new Error(`buildHistory: expected ${days} percents, got ${percents.length}`);
  }
  const day = 24 * 60 * 60 * 1000;
  const now = new Date("2026-04-30T00:00:00Z").getTime();
  const out: BadgeHistoryPoint[] = [];
  for (let i = 0; i < days; i++) {
    const ranAt = new Date(now - (days - 1 - i) * day);
    const pct = percents[i];
    out.push({
      ranAt: ranAt.toISOString(),
      savingsPercent: pct,
      savingsRatio: pct < 100 ? 100 / (100 - pct) : null,
    });
  }
  return out;
}

describe("super-admin-share-rollups.tsx — savings sparkline (Task #1821)", () => {
  it("renders the chart with a per-run data point and the trend label when the API returns >= 2 history points", async () => {
    installFetch(buildHistory(7, [95.1, 95.4, 95.6, 95.9, 96.0, 96.2, 96.3]));
    renderPage();

    const chart = await screen.findByTestId("panel-savings-sparkline-badge-share");
    expect(chart).toBeInTheDocument();
    // Label surfaces the window admins are looking at — keeps the
    // sparkline self-explanatory without needing a separate caption.
    expect(screen.getByTestId("label-sparkline-badge-share")).toHaveTextContent(
      /Trend over last 7 days \(7 runs\)/,
    );

    // The empty state must NOT also render once the chart is up.
    expect(screen.queryByTestId("text-sparkline-empty-badge-share")).toBeNull();
  });

  it("falls back to the empty state when the API returns fewer than two non-null points", async () => {
    installFetch(buildHistory(1, [96.0]));
    renderPage();

    // The savings panel itself is the parent we wait on — once it's in
    // the DOM the sparkline branch has rendered (or chosen not to).
    await screen.findByTestId("panel-storage-savings-badge-share");
    expect(screen.getByTestId("text-sparkline-empty-badge-share")).toHaveTextContent(
      /Trend chart will appear once the rollup has at least two days of history/,
    );
    expect(screen.queryByTestId("panel-savings-sparkline-badge-share")).toBeNull();
  });

  it("does not render the sparkline (or its empty state) when the API omits the history field", async () => {
    // The badge-share variant returns no history field at all — e.g.
    // an older API server that hasn't yet been upgraded. The chart
    // must stay hidden rather than throw on `undefined.length`.
    installFetch(undefined);
    renderPage();

    await screen.findByTestId("panel-storage-savings-badge-share");
    expect(screen.queryByTestId("panel-savings-sparkline-badge-share")).toBeNull();
    expect(screen.queryByTestId("text-sparkline-empty-badge-share")).toBeNull();
  });

  it("does not render the sparkline on the profile-share panel (history not exposed by that endpoint)", async () => {
    installFetch(buildHistory(7, [95.1, 95.4, 95.6, 95.9, 96.0, 96.2, 96.3]));
    renderPage();

    // Profile-share storage-savings panel renders, but no sparkline
    // for it — the history field is intentionally badge-only for now.
    await screen.findByTestId("panel-storage-savings-profile-share");
    expect(screen.queryByTestId("panel-savings-sparkline-profile-share")).toBeNull();
    expect(screen.queryByTestId("text-sparkline-empty-profile-share")).toBeNull();
  });
});
