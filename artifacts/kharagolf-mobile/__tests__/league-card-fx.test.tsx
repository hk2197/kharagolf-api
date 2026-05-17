/**
 * Regression test for Task #955 — the league card on the public Leagues
 * screen must show a converted "Approx." amount alongside the booked entry
 * fee whenever the member's preferred display currency differs from the
 * booked currency. Mirrors the locker renewal pattern (Task #820).
 *
 * Mounts the extracted `<LeagueCard />` against a stubbed
 * /currency-tax/quote endpoint. If a future refactor silently swapped the
 * fee row back to the booked-currency-only `fmtFee` helper (the original
 * bug), the assertions below would fail because `Approx.` and the
 * converted amount would no longer appear.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/i18n", () => ({ getLocale: () => "en-US" }));
vi.mock("@/utils/api", () => ({ BASE_URL: "" }));

import { LeagueCard } from "../components/LeagueCard";

const ORG_ID = 42;
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

const LEAGUE = {
  id: 9,
  name: "Spring Match Play",
  description: "Friendly weekend league",
  format: "match_play",
  type: "season",
  status: "active",
  seasonStart: new Date().toISOString(),
  seasonEnd: new Date(Date.now() + 90 * 86400000).toISOString(),
  maxMembers: 32,
  entryFee: String(BOOKED_AMOUNT),
  currency: BOOKED_CURRENCY,
  handicapAllowance: 90,
  roundsCount: 8,
  organizationId: ORG_ID,
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("LeagueCard — converted entry fee (Task #955)", () => {
  it("shows an 'Approx.' converted amount alongside the booked entry fee when the member has a different preferred currency", async () => {
    const fetchMock = buildFetchMock({
      display: {
        currency: "INR", totalAmount: 127500, fxRate: 85,
        fxSource: "openExchangeRates", isFallback: false, fxMarkupPct: 0,
      },
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<LeagueCard item={LEAGUE} onPress={() => {}} token="test-token" />);

    const feeRow = await screen.findByTestId("league-card-fee-row");
    expect(feeRow).toHaveTextContent(/\$1,500/);

    await waitFor(() => {
      expect(feeRow).toHaveTextContent(/Approx\./);
    });
    expect(feeRow).toHaveTextContent(/₹1,27,500|₹127,500/);

    const quoteCalls = fetchMock.mock.calls.filter(c =>
      String(c[0]).includes("/currency-tax/quote"),
    );
    expect(quoteCalls.length).toBeGreaterThan(0);
    const body = JSON.parse(String((quoteCalls[0][1] as RequestInit).body));
    expect(body.amount).toBe(BOOKED_AMOUNT);
    expect(body.currency).toBe(BOOKED_CURRENCY);
    expect(body.productClass).toBe("league_entry");
  });

  it("renders only the booked-currency amount (no 'Approx.' line) when the quote response has no display block", async () => {
    const fetchMock = buildFetchMock({ display: null });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<LeagueCard item={LEAGUE} onPress={() => {}} token="test-token" />);

    const feeRow = await screen.findByTestId("league-card-fee-row");
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(c =>
        String(c[0]).includes("/currency-tax/quote"),
      );
      expect(calls.length).toBeGreaterThan(0);
    });
    expect(feeRow).toHaveTextContent(/\$1,500/);
    expect(feeRow).not.toHaveTextContent(/Approx\./);
  });
});
