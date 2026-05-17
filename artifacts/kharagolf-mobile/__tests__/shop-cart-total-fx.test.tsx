/**
 * Regression test for Task #955 — the pro shop cart drawer total must
 * show a converted "Approx." amount alongside the booked total when the
 * member's preferred display currency differs from the cart currency.
 * Mirrors the locker renewal pattern (Task #820).
 *
 * Mounts the extracted `<ShopCartTotalRow />` against a stubbed
 * /currency-tax/quote endpoint. If a future refactor silently swapped
 * the total back to the booked-currency-only `fmtPrice` helper (the
 * original bug), the assertions below would fail because `Approx.` and
 * the converted amount would no longer appear.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/utils/api", () => ({ BASE_URL: "" }));

import { ShopCartTotalRow } from "../components/ShopCartTotalRow";

const ORG_ID = 11;
const BOOKED_TOTAL = 4250;
const BOOKED_CURRENCY = "USD";

interface QuoteOptions {
  display: {
    currency: string;
    totalAmount: number;
    fxRate: number;
    fxSource: string;
    isFallback: boolean;
    fxMarkupPct: number;
  } | null;
}

function buildFetchMock(opts: QuoteOptions) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/currency-tax/quote") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        amount: number; currency: string; productClass?: string;
      };
      return new Response(
        JSON.stringify({
          booking: { currency: body.currency, totalAmount: body.amount },
          display: opts.display,
          baseCurrency: BOOKED_CURRENCY,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ShopCartTotalRow — converted cart total (Task #955)", () => {
  it("shows an 'Approx.' converted amount alongside the booked total", async () => {
    const fetchMock = buildFetchMock({
      display: {
        currency: "INR", totalAmount: 361250, fxRate: 85,
        fxSource: "openExchangeRates", isFallback: false, fxMarkupPct: 0,
      },
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(
      <ShopCartTotalRow
        orgId={ORG_ID}
        token="test-token"
        total={BOOKED_TOTAL}
        currency={BOOKED_CURRENCY}
        totalLabel="Total"
      />,
    );

    const row = await screen.findByTestId("shop-cart-total-row");
    expect(row).toHaveTextContent(/\$4,250/);

    await waitFor(() => {
      expect(row).toHaveTextContent(/Approx\./);
    });
    expect(row).toHaveTextContent(/₹3,61,250|₹361,250/);

    const quoteCalls = fetchMock.mock.calls.filter(c =>
      String(c[0]).includes("/currency-tax/quote"),
    );
    expect(quoteCalls.length).toBeGreaterThan(0);
    const body = JSON.parse(String((quoteCalls[0][1] as RequestInit).body));
    expect(body.amount).toBe(BOOKED_TOTAL);
    expect(body.currency).toBe(BOOKED_CURRENCY);
    expect(body.productClass).toBe("shop");
  });

  it("renders only the booked-currency total (no 'Approx.' line) when no display block", async () => {
    const fetchMock = buildFetchMock({ display: null });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(
      <ShopCartTotalRow
        orgId={ORG_ID}
        token="test-token"
        total={BOOKED_TOTAL}
        currency={BOOKED_CURRENCY}
        totalLabel="Total"
      />,
    );

    const row = await screen.findByTestId("shop-cart-total-row");
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(c =>
        String(c[0]).includes("/currency-tax/quote"),
      );
      expect(calls.length).toBeGreaterThan(0);
    });
    expect(row).toHaveTextContent(/\$4,250/);
    expect(row).not.toHaveTextContent(/Approx\./);
  });
});
