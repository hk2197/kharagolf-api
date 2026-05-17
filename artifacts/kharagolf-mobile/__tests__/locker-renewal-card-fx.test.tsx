/**
 * Regression test for Task #820 — the mobile profile locker renewal card
 * must show a converted "Approx." amount alongside the booked annual fee
 * whenever the member's preferred display currency differs from the booked
 * currency.
 *
 * Mounts the extracted `<LockerRenewalCard />` (split out of the 2300-line
 * profile screen so the FX-aware row can be tested in isolation) against a
 * stubbed /currency-tax/quote endpoint. Mirrors the web coverage in
 * artifacts/kharagolf-web/src/tests/locker-renewal-card-fx.test.tsx.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown> | string) => {
      if (typeof vars === "string") return vars;
      if (vars && typeof vars === "object") {
        let out = key;
        for (const [k, v] of Object.entries(vars)) out += ` ${k}=${String(v)}`;
        return out;
      }
      return key;
    },
    i18n: { language: "en", changeLanguage: async () => {} },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("@/i18n", () => ({
  getLocale: () => "en-US",
}));

vi.mock("@/utils/api", () => ({
  BASE_URL: "",
}));

import { LockerRenewalCard } from "../components/LockerRenewalCard";

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

describe("LockerRenewalCard (mobile) — converted price (Task #820)", () => {
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

    render(
      <LockerRenewalCard
        assignment={ASSIGNMENT}
        orgId={ORG_ID}
        token="test-token"
      />,
    );

    const feeRow = await screen.findByTestId("locker-renewal-fee");
    expect(feeRow).toHaveTextContent(/\$1,000/);

    await waitFor(() => {
      expect(feeRow).toHaveTextContent(/Approx\./);
    });
    expect(feeRow).toHaveTextContent(/₹85,000/);
    expect(feeRow).toHaveTextContent(/source: openExchangeRates/);
    expect(feeRow).toHaveTextContent(/1 USD = 85/);

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

    render(
      <LockerRenewalCard
        assignment={ASSIGNMENT}
        orgId={ORG_ID}
        token="test-token"
      />,
    );

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
