/**
 * Regression test for Task #820 — the portal locker renewal card must show a
 * converted "Approx." amount alongside the booked annual fee whenever the
 * member's preferred display currency differs from the booked currency.
 *
 * Mounts the extracted `<LockerRenewalCard />` (split out of the 3000-line
 * `PlayerPortal` so the FX-aware row can be tested in isolation) against a
 * stubbed /currency-tax/quote endpoint. If a future refactor silently
 * swapped the row back to a booked-currency-only `<span>` (the original
 * bug), the assertions below would fail because `Approx.` and the converted
 * amount would no longer appear.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { LockerRenewalCard } from "../pages/portal/LockerRenewalCard";

const ORG_ID = 42;
const BOOKED_AMOUNT = 1000;
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
        amount: number;
        currency: string;
        productClass?: string;
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

const ASSIGNMENT = {
  id: 5,
  lockerNumber: "A-12",
  bay: "Front",
  expiryDate: new Date(Date.now() + 60 * 86400000).toISOString(),
  startDate: new Date().toISOString(),
  status: "active",
  annualFee: String(BOOKED_AMOUNT),
  currency: BOOKED_CURRENCY,
  paymentStatus: "paid",
  paymentLinkUrl: null,
};

beforeEach(() => {
  // Each test stubs fetch via vi.stubGlobal.
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LockerRenewalCard — converted price (Task #820)", () => {
  it("shows an 'Approx.' converted amount alongside the booked annual fee when the member has a different preferred currency", async () => {
    const fetchMock = buildFetchMock({
      display: {
        currency: "INR",
        totalAmount: 85000,
        fxRate: 85,
        fxSource: "openExchangeRates",
        isFallback: false,
        fxMarkupPct: 0,
      },
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<LockerRenewalCard assignment={ASSIGNMENT} orgId={ORG_ID} />);

    // Booked amount renders right away from props.
    const feeRow = await screen.findByTestId("locker-renewal-fee");
    expect(feeRow).toHaveTextContent(/\$1,000/);

    // Once the quote resolves, the FX block shows the "Approx." line with the
    // converted INR amount and the rate disclosure.
    await waitFor(() => {
      expect(feeRow).toHaveTextContent(/Approx\./);
    });
    expect(feeRow).toHaveTextContent(/₹85,000/);
    expect(feeRow).toHaveTextContent(/source: openExchangeRates/);
    expect(feeRow).toHaveTextContent(/1 USD = 85/);

    // The quote endpoint was hit with the locker fee + product class.
    const quoteCalls = fetchMock.mock.calls.filter(c =>
      String(c[0]).includes("/currency-tax/quote"),
    );
    expect(quoteCalls.length).toBeGreaterThan(0);
    const body = JSON.parse(String((quoteCalls[0][1] as RequestInit).body));
    expect(body.amount).toBe(BOOKED_AMOUNT);
    expect(body.currency).toBe(BOOKED_CURRENCY);
    expect(body.productClass).toBe("locker_rental");
  });

  it("renders only the plain booked-currency amount (no 'Approx.' line) when the quote response has no display block", async () => {
    const fetchMock = buildFetchMock({ display: null });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<LockerRenewalCard assignment={ASSIGNMENT} orgId={ORG_ID} />);

    const feeRow = await screen.findByTestId("locker-renewal-fee");
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(c =>
        String(c[0]).includes("/currency-tax/quote"),
      );
      expect(calls.length).toBeGreaterThan(0);
    });
    expect(feeRow).toHaveTextContent(/\$1,000/);
    expect(feeRow).not.toHaveTextContent(/Approx\./);
    expect(feeRow).not.toHaveTextContent(/source:/);
  });
});
