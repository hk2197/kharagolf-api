/**
 * Regression test for Task #955 — the tournament registration sheet's
 * payment step (Step3) must show a converted "Approx." amount alongside
 * the booked entry fee whenever the member's preferred display currency
 * differs from the booked currency. Mirrors the locker renewal pattern
 * (Task #820).
 *
 * Mounts the exported `<Step3Payment />` against a stubbed
 * /currency-tax/quote endpoint. If a future refactor silently swapped
 * the payment amount back to the booked-currency-only `formatFee`
 * helper, the assertions below would fail because `Approx.` and the
 * converted amount would no longer appear.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/utils/api", () => ({ BASE_URL: "" }));
vi.mock("@/components/StripeCheckoutModal", () => ({
  StripeCheckoutModal: () => null,
  stripeModuleAvailable: () => false,
}));

import { Step3Payment } from "../components/TournamentRegistrationSheet";

const ORG_ID = 77;
const BOOKED_AMOUNT = 2000;
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

describe("TournamentRegistrationSheet Step3Payment — converted entry fee (Task #955)", () => {
  it("shows an 'Approx.' converted amount alongside the booked entry fee", async () => {
    const fetchMock = buildFetchMock({
      display: {
        currency: "INR", totalAmount: 170000, fxRate: 85,
        fxSource: "openExchangeRates", isFallback: false, fxMarkupPct: 0,
      },
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(
      <Step3Payment
        entryFee={String(BOOKED_AMOUNT)}
        currency={BOOKED_CURRENCY}
        orgId={ORG_ID}
        payLoading={false}
        token="test-token"
        onPayNow={() => {}}
        onPayLater={() => {}}
        onBack={() => {}}
      />,
    );

    const card = await screen.findByTestId("tournament-payment-card");
    expect(card).toHaveTextContent(/\$2,000/);

    await waitFor(() => {
      expect(card).toHaveTextContent(/Approx\./);
    });
    expect(card).toHaveTextContent(/₹1,70,000|₹170,000/);

    const quoteCalls = fetchMock.mock.calls.filter(c =>
      String(c[0]).includes("/currency-tax/quote"),
    );
    expect(quoteCalls.length).toBeGreaterThan(0);
    const body = JSON.parse(String((quoteCalls[0][1] as RequestInit).body));
    expect(body.amount).toBe(BOOKED_AMOUNT);
    expect(body.currency).toBe(BOOKED_CURRENCY);
    expect(body.productClass).toBe("tournament_entry");
  });

  it("renders only the booked-currency amount (no 'Approx.' line) when no display block", async () => {
    const fetchMock = buildFetchMock({ display: null });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(
      <Step3Payment
        entryFee={String(BOOKED_AMOUNT)}
        currency={BOOKED_CURRENCY}
        orgId={ORG_ID}
        payLoading={false}
        token="test-token"
        onPayNow={() => {}}
        onPayLater={() => {}}
        onBack={() => {}}
      />,
    );

    const card = await screen.findByTestId("tournament-payment-card");
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(c =>
        String(c[0]).includes("/currency-tax/quote"),
      );
      expect(calls.length).toBeGreaterThan(0);
    });
    expect(card).toHaveTextContent(/\$2,000/);
    expect(card).not.toHaveTextContent(/Approx\./);
  });
});
