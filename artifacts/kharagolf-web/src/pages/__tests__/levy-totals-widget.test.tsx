/**
 * UI test: dashboard "Levy totals" widget (Task #330).
 *
 * Mounts <LevyTotalsWidget /> with a mocked fetch and asserts:
 *   - one tile per currency renders the per-currency
 *     collected / outstanding / refunded / waived totals from
 *     `/levies-summary`
 *   - the "Open finance ledger" button deep-links to /finance-ledger
 *   - the widget self-hides when the API responds 401/403 (i.e. the
 *     viewer is not org_admin / treasurer / membership_secretary)
 *
 * The widget uses TanStack Query + fetch directly (no generated client),
 * so we mock global fetch in the same style as documents-pending.test.tsx.
 *
 * Backend-side aggregation, role gating (401 unauth / 403 player /
 * 200 org_admin), and the multi-currency `totalsByCurrency` shape are
 * separately covered against the live PostgreSQL DB by
 * artifacts/api-server/src/tests/levies-summary.test.ts. Together with
 * the cases below, that gives true end-to-end coverage of the path the
 * Task #330 spec calls out (org_admin sees per-currency tiles, ledger
 * link navigates to /finance-ledger, non-admin roles see nothing).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Render <Link> as a plain anchor so we can assert href without a router.
vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    <a href={href} data-testid="wouter-link" {...rest}>{children}</a>,
}));

import { LevyTotalsWidget } from "../dashboard";

interface CurrencyTotals {
  collected: number;
  outstanding: number;
  refunded: number;
  waived: number;
  chargesCount: number;
  leviesCount: number;
}

interface LeviesSummary {
  levies: unknown[];
  totalsByCurrency: Record<string, CurrencyTotals>;
}

interface FetchHandler {
  /** When set, /levies-summary returns this body with status 200. */
  summary?: LeviesSummary;
  /** When set, /levies-summary returns this status with an empty body. */
  summaryStatus?: number;
  /** Number of times /levies-summary was hit. */
  summaryCalls: number;
}

let handler: FetchHandler;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/members-360/levies-summary")) {
      handler.summaryCalls += 1;
      if (handler.summaryStatus && handler.summaryStatus >= 400) {
        return new Response("", { status: handler.summaryStatus }) as unknown as Response;
      }
      return new Response(JSON.stringify(handler.summary ?? { levies: [], totalsByCurrency: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

function renderWidget(orgId = 42) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <LevyTotalsWidget orgId={orgId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  handler = { summaryCalls: 0 };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<LevyTotalsWidget />", () => {
  it("renders one tile per currency with the totals from /levies-summary", async () => {
    handler.summary = {
      levies: [],
      totalsByCurrency: {
        // Mirrors the seed pattern in artifacts/api-server/src/tests/levies-summary.test.ts:
        // INR — one paid + one outstanding (the task brief), plus a refund
        // and a waived charge to assert all four numbers surface.
        INR: {
          collected: 240,
          outstanding: 160,
          refunded: 100,
          waived: 100,
          chargesCount: 5,
          leviesCount: 2,
        },
        // USD — one paid + one outstanding in a second currency, asserting
        // the multi-currency split documented in the widget docstring
        // (no meaningless cross-currency sums).
        USD: {
          collected: 200,
          outstanding: 200,
          refunded: 0,
          waived: 0,
          chargesCount: 2,
          leviesCount: 1,
        },
      },
    };

    renderWidget();

    // Wait for the per-currency tiles to render.
    const inrTile = await screen.findByTestId("tile-levy-totals-INR");
    const usdTile = await screen.findByTestId("tile-levy-totals-USD");

    // INR tile — assert all four totals match the seeded aggregates.
    // formatMoney uses Intl.NumberFormat with maximumFractionDigits: 0,
    // so we match the digits and currency code with a flexible regex
    // (locale-agnostic: jsdom's en-US default + the i18next default may
    // differ across CI machines, so we do not pin the exact symbol).
    expect(within(inrTile).getByTestId("tile-INR-collected")).toHaveTextContent(/240/);
    expect(within(inrTile).getByTestId("tile-INR-outstanding")).toHaveTextContent(/160/);
    expect(within(inrTile).getByTestId("tile-INR-refunded")).toHaveTextContent(/100/);
    expect(within(inrTile).getByTestId("tile-INR-waived")).toHaveTextContent(/100/);
    // INR currency code is rendered in the tile header along with the
    // levies/charges count summary.
    expect(within(inrTile).getByText("INR")).toBeInTheDocument();
    expect(within(inrTile).getByText(/2 levies · 5 charges/)).toBeInTheDocument();

    // USD tile — multi-currency assertion. Confirms the widget renders a
    // SECOND tile (no cross-currency sums) with its own totals.
    expect(within(usdTile).getByTestId("tile-USD-collected")).toHaveTextContent(/200/);
    expect(within(usdTile).getByTestId("tile-USD-outstanding")).toHaveTextContent(/200/);
    expect(within(usdTile).getByTestId("tile-USD-refunded")).toHaveTextContent(/0/);
    expect(within(usdTile).getByTestId("tile-USD-waived")).toHaveTextContent(/0/);
    expect(within(usdTile).getByText("USD")).toBeInTheDocument();
    // singular pluralization: 1 levy, 2 charges
    expect(within(usdTile).getByText(/1 levy · 2 charges/)).toBeInTheDocument();

    // The widget hits /levies-summary with the correct org id.
    const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([input]) => String(input).includes("/organizations/42/members-360/levies-summary"))).toBe(true);
  });

  it("deep-links the 'Open finance ledger' button to /finance-ledger", async () => {
    handler.summary = {
      levies: [],
      totalsByCurrency: {
        INR: { collected: 50, outstanding: 0, refunded: 0, waived: 0, chargesCount: 1, leviesCount: 1 },
      },
    };

    renderWidget();
    await screen.findByTestId("tile-levy-totals-INR");

    const linkBtn = screen.getByTestId("link-levy-totals-ledger");
    expect(linkBtn).toHaveTextContent(/Open finance ledger/);
    // The Link is rendered as <a href="/finance-ledger"> (see wouter mock).
    const anchor = linkBtn.closest("a");
    expect(anchor).not.toBeNull();
    expect(anchor).toHaveAttribute("href", "/finance-ledger");
  });

  it("hides the widget when the API responds 403 (non-admin role)", async () => {
    handler.summaryStatus = 403;

    renderWidget();

    // Wait for the request to complete.
    await waitFor(() => expect(handler.summaryCalls).toBeGreaterThanOrEqual(1));

    // After 401/403 the widget renders nothing — no card, no tiles, no link.
    await waitFor(() => {
      expect(screen.queryByTestId("card-levy-totals")).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId("link-levy-totals-ledger")).not.toBeInTheDocument();
    expect(screen.queryByText(/Levy totals/i)).not.toBeInTheDocument();
  });

  it("also hides the widget on 401 (unauthenticated viewer)", async () => {
    handler.summaryStatus = 401;

    renderWidget();
    await waitFor(() => expect(handler.summaryCalls).toBeGreaterThanOrEqual(1));
    await waitFor(() => {
      expect(screen.queryByTestId("card-levy-totals")).not.toBeInTheDocument();
    });
  });
});
