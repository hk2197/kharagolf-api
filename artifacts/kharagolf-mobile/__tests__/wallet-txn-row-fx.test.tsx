/**
 * Regression test for Task #1110 — the mobile wallet transaction row must
 * show a converted "Approx." amount alongside the booked-currency amount
 * whenever the member's preferred display currency differs from the
 * transaction currency.
 *
 * Mounts the extracted `<WalletTxnRow />` (split out of
 * `app/wallet.tsx` so the FX-aware row can be tested in isolation, mirroring
 * the locker-renewal pattern from Task #820) against a stubbed
 * /currency-tax/quote endpoint. If a future refactor silently swapped the
 * amount back to the booked-currency-only `INR` prefix (the original bug),
 * the assertions below would fail because `Approx.` and the converted amount
 * would no longer appear.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/utils/api", () => ({ BASE_URL: "" }));

import { WalletTxnRow, type WalletTxnRowData } from "../components/WalletTxnRow";

const ORG_ID = 77;
const BOOKED_AMOUNT = 1500;
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

const TXN: WalletTxnRowData = {
  id: 4242,
  kind: "credit",
  amount: BOOKED_AMOUNT,
  currency: BOOKED_CURRENCY,
  sourceType: "wallet_topup_razorpay",
  paymentRef: null,
  note: null,
  balanceAfter: 5000,
  createdAt: new Date("2026-04-01T12:00:00Z").toISOString(),
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("WalletTxnRow — converted amount (Task #1110)", () => {
  it("shows an 'Approx.' converted amount alongside the booked transaction amount", async () => {
    const fetchMock = buildFetchMock({
      display: {
        currency: "INR", totalAmount: 127500, fxRate: 85,
        fxSource: "openExchangeRates", isFallback: false, fxMarkupPct: 0,
      },
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<WalletTxnRow txn={TXN} orgId={ORG_ID} token="test-token" />);

    const row = await screen.findByTestId(`wallet-txn-row-${TXN.id}`);
    expect(row).toHaveTextContent(/\$1,500/);

    await waitFor(() => {
      expect(row).toHaveTextContent(/Approx\./);
    });
    expect(row).toHaveTextContent(/₹1,27,500|₹127,500/);

    const quoteCalls = fetchMock.mock.calls.filter(c =>
      String(c[0]).includes("/currency-tax/quote"),
    );
    expect(quoteCalls.length).toBeGreaterThan(0);
    const body = JSON.parse(String((quoteCalls[0][1] as RequestInit).body));
    expect(body.amount).toBe(BOOKED_AMOUNT);
    expect(body.currency).toBe(BOOKED_CURRENCY);
    expect(body.productClass).toBe("wallet");
  });

  it("renders only the booked-currency amount (no 'Approx.' line) when no display block", async () => {
    const fetchMock = buildFetchMock({ display: null });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<WalletTxnRow txn={TXN} orgId={ORG_ID} token="test-token" />);

    const row = await screen.findByTestId(`wallet-txn-row-${TXN.id}`);
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(c =>
        String(c[0]).includes("/currency-tax/quote"),
      );
      expect(calls.length).toBeGreaterThan(0);
    });
    expect(row).toHaveTextContent(/\$1,500/);
    expect(row).not.toHaveTextContent(/Approx\./);
  });
});
