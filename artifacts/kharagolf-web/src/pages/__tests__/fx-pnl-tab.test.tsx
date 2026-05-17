/**
 * UI test: FX P&L tab on the Currency & Tax Settings page (Task #495).
 *
 * Mounts <ReportTab /> with a mocked /currency-tax/fx-gain-loss response
 * shaped like the API contract surfaced by
 * artifacts/api-server/src/lib/fx.ts → summariseFxGainLossSplit, then asserts:
 *   - the realised section renders one row per booked→settled pair from the
 *     API payload, including the txCount and gain/loss amount,
 *   - the unrealised section renders one row per open exposure, including the
 *     outstanding amount, booked vs spot rates, and the mark-to-market value,
 *   - the empty-state placeholders surface when both arrays are empty.
 *
 * The backend SQL + per-org rate refresh logic is covered against the live
 * PostgreSQL DB by artifacts/api-server/src/tests/fx-cron-and-pnl.test.ts.
 * Together with the cases below, that gives end-to-end coverage of the tab
 * the task brief calls out — the API returns realised + unrealised, and the
 * tab renders both sections.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ReportTab } from "../currency-tax-settings";

interface FxGainLossRow {
  bookedCurrency: string; settledCurrency: string;
  totalBooked: string; totalSettled: string;
  totalGainLoss: string; txCount: number;
}
interface FxUnrealisedRow {
  exposureCurrency: string; baseCurrency: string;
  outstandingAmount: number; bookedRate: number; currentRate: number;
  currentRateSource: string;
  baseValueNow: number; baseValueBooked: number;
  unrealisedGainLoss: number; chargeCount: number;
}
interface FxGainLossPayload {
  summary?: FxGainLossRow[];
  realised: FxGainLossRow[];
  unrealised: FxUnrealisedRow[];
  recent: Array<{
    id: number; bookedCurrency: string; settledCurrency: string;
    bookedAmount: string; settledAmount: string; gainLoss: string;
    sourceType: string; createdAt: string;
  }>;
}

let payload: FxGainLossPayload;
let calls = 0;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/currency-tax/fx-gain-loss")) {
      calls += 1;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

function renderTab(orgId = 99) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ReportTab orgId={orgId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls = 0;
  payload = { realised: [], unrealised: [], recent: [] };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<ReportTab /> — FX P&L tab", () => {
  it("renders both realised and unrealised sections from seeded data", async () => {
    payload = {
      realised: [
        {
          bookedCurrency: "USD", settledCurrency: "INR",
          totalBooked: "100.00", totalSettled: "8000.00",
          totalGainLoss: "2.44", txCount: 1,
        },
        {
          bookedCurrency: "EUR", settledCurrency: "INR",
          totalBooked: "50.00", totalSettled: "4400.00",
          totalGainLoss: "-1.20", txCount: 2,
        },
      ],
      unrealised: [
        {
          exposureCurrency: "USD", baseCurrency: "INR",
          outstandingAmount: 200, bookedRate: 80, currentRate: 84,
          currentRateSource: "open.er-api.com",
          baseValueBooked: 16000, baseValueNow: 16800,
          unrealisedGainLoss: 800, chargeCount: 1,
        },
      ],
      recent: [],
    };

    renderTab();

    // Realised section — both pairs render with their txCount + gain/loss.
    const usdInr = await screen.findByTestId("realised-USD-INR");
    expect(within(usdInr).getByText(/1 tx/)).toBeInTheDocument();
    expect(within(usdInr).getByText(/2\.44 USD/)).toBeInTheDocument();

    const eurInr = await screen.findByTestId("realised-EUR-INR");
    expect(within(eurInr).getByText(/2 tx/)).toBeInTheDocument();
    expect(within(eurInr).getByText(/-1\.20 EUR/)).toBeInTheDocument();

    // Unrealised section — exposure row renders with outstanding, rates, and
    // mark-to-market value (positive → green text + TrendingUp icon).
    const exposure = await screen.findByTestId("unrealised-USD-INR");
    expect(within(exposure).getByText(/1 open · 200\.00 USD/)).toBeInTheDocument();
    expect(within(exposure).getByText(/booked @ 80 · spot @ 84 \(open\.er-api\.com\)/)).toBeInTheDocument();
    expect(within(exposure).getByText(/800\.00 INR/)).toBeInTheDocument();

    // Empty-state placeholders should NOT be present when data is provided.
    expect(screen.queryByTestId("text-no-realised")).not.toBeInTheDocument();
    expect(screen.queryByTestId("text-no-unrealised")).not.toBeInTheDocument();

    // The tab pulls from the FX gain/loss endpoint exactly once for orgId=99.
    expect(calls).toBe(1);
    const fetchCalls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(fetchCalls.some(([input]) => String(input).includes("/organizations/99/currency-tax/fx-gain-loss"))).toBe(true);
  });

  it("falls back to the legacy `summary` field when `realised` is missing", async () => {
    // Older API responses (pre-Task #495) only returned `summary`. The tab
    // must still render those rows in the realised section so existing
    // deployments don't regress.
    payload = {
      summary: [
        {
          bookedCurrency: "GBP", settledCurrency: "INR",
          totalBooked: "10.00", totalSettled: "1080.00",
          totalGainLoss: "0.00", txCount: 1,
        },
      ],
      // `realised` deliberately omitted to mimic a legacy server response
      // that only knew about `summary`.
      unrealised: [],
      recent: [],
    } as unknown as FxGainLossPayload;

    renderTab();
    const row = await screen.findByTestId("realised-GBP-INR");
    expect(within(row).getByText(/1 tx/)).toBeInTheDocument();
    expect(within(row).getByText(/0\.00 GBP/)).toBeInTheDocument();
    // Unrealised side empty → placeholder visible.
    expect(await screen.findByTestId("text-no-unrealised")).toBeInTheDocument();
  });

  it("shows empty-state placeholders when both arrays are empty", async () => {
    payload = { realised: [], unrealised: [], recent: [] };
    renderTab();
    expect(await screen.findByTestId("text-no-realised")).toBeInTheDocument();
    expect(await screen.findByTestId("text-no-unrealised")).toBeInTheDocument();
  });
});
