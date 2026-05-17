/**
 * Task #1811 — regression test for the wallet FX rate hover disclosure
 * (mobile parallel of
 * `artifacts/kharagolf-web/src/components/__tests__/PriceWithFx.disclosureOnHover.test.tsx`).
 *
 * The mobile wallet screen renders each withdrawal row via
 * `WithdrawalRowView` (in `artifacts/kharagolf-mobile/app/wallet.tsx`),
 * whose right-aligned amount is:
 *
 *   <PriceWithFx
 *     orgId={...}
 *     token={...}
 *     amount={w.amount}
 *     currency={w.currency}
 *     productClass="wallet"
 *     showDisclosure={false}
 *     disclosureOnHover
 *   />
 *
 * Task #1473 added the on-tap FX disclosure: when `showDisclosure=false`
 * + `disclosureOnHover` are set *and* the quote response includes a
 * `display` block, the "Approx." line becomes a Pressable that toggles a
 * disclosure block containing the FX rate, source, fallback flag (when
 * set) and markup (when set). This test mounts `<PriceWithFx />` in that
 * exact configuration against a mocked `/currency-tax/quote` endpoint
 * and asserts the toggle behaviour.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

vi.mock("@/utils/api", () => ({
  BASE_URL: "",
}));

import { PriceWithFx } from "../components/PriceWithFx";

const ORG_ID = 9;
const BOOKED_AMOUNT = 5000;
const BOOKED_CURRENCY = "INR";

interface QuoteFixture {
  display:
    | {
        currency: string;
        totalAmount: number;
        fxRate: number;
        fxSource: string;
        isFallback: boolean;
        fxMarkupPct: number;
      }
    | null;
}

function buildFetchMock(opts: QuoteFixture) {
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PriceWithFx (mobile) — wallet tap-to-reveal FX disclosure (Task #1811)", () => {
  it("renders the booked + Approx. amount but hides the disclosure inline; tapping the trigger toggles the disclosure block on then off", async () => {
    const fetchMock = buildFetchMock({
      display: {
        currency: "USD",
        totalAmount: 60,
        fxRate: 0.012,
        fxSource: "openExchangeRates",
        isFallback: false,
        fxMarkupPct: 1.5,
      },
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(
      <PriceWithFx
        orgId={ORG_ID}
        token="test-token"
        amount={BOOKED_AMOUNT}
        currency={BOOKED_CURRENCY}
        productClass="wallet"
        showDisclosure={false}
        disclosureOnHover
      />,
    );

    const trigger = await screen.findByTestId("fx-disclosure-trigger");
    expect(trigger).toHaveTextContent(/Approx\./);
    expect(trigger).toHaveTextContent(/\$60/);
    // Booked amount in INR is rendered alongside the trigger.
    expect(screen.getByText(/₹5,000/)).toBeInTheDocument();
    // Disclosure block is hidden until tapped.
    expect(screen.queryByTestId("fx-disclosure-tooltip")).not.toBeInTheDocument();

    // First tap reveals the disclosure block with rate + source + markup.
    fireEvent.click(trigger);
    const tooltip = await screen.findByTestId("fx-disclosure-tooltip");
    expect(tooltip).toHaveTextContent(/1 INR = 0\.012 USD/);
    expect(tooltip).toHaveTextContent(/source: openExchangeRates/);
    expect(tooltip).toHaveTextContent(/includes 1\.5% FX markup/);
    // Fallback marker is omitted because isFallback=false.
    expect(tooltip.textContent ?? "").not.toMatch(/fallback/);

    // Tapping again hides it.
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.queryByTestId("fx-disclosure-tooltip")).not.toBeInTheDocument();
    });

    // The component called the quote endpoint with the wallet
    // product-class so the FX markup pulled from the wallet bucket
    // is what gets disclosed (not e.g. the bookings bucket).
    const quoteCalls = fetchMock.mock.calls.filter(c =>
      String(c[0]).includes("/currency-tax/quote"),
    );
    expect(quoteCalls.length).toBeGreaterThan(0);
    const body = JSON.parse(String((quoteCalls[0][1] as RequestInit).body));
    expect(body.amount).toBe(BOOKED_AMOUNT);
    expect(body.currency).toBe(BOOKED_CURRENCY);
    expect(body.productClass).toBe("wallet");
  });

  it("includes the (fallback) marker in the disclosure when the quote response says the FX rate came from the fallback table", async () => {
    const fetchMock = buildFetchMock({
      display: {
        currency: "USD",
        totalAmount: 60,
        fxRate: 0.012,
        fxSource: "stale-cache",
        isFallback: true,
        fxMarkupPct: 0,
      },
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(
      <PriceWithFx
        orgId={ORG_ID}
        token="test-token"
        amount={BOOKED_AMOUNT}
        currency={BOOKED_CURRENCY}
        productClass="wallet"
        showDisclosure={false}
        disclosureOnHover
      />,
    );

    const trigger = await screen.findByTestId("fx-disclosure-trigger");
    fireEvent.click(trigger);
    const tooltip = await screen.findByTestId("fx-disclosure-tooltip");
    expect(tooltip).toHaveTextContent(/source: stale-cache \(fallback\)/);
    // Markup line is omitted when fxMarkupPct=0.
    expect(tooltip.textContent ?? "").not.toMatch(/FX markup/);
  });

  it("does NOT render the Approx. trigger or disclosure block when the quote response has no display block (no preferred currency conversion needed)", async () => {
    const fetchMock = buildFetchMock({ display: null });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(
      <PriceWithFx
        orgId={ORG_ID}
        token="test-token"
        amount={BOOKED_AMOUNT}
        currency={BOOKED_CURRENCY}
        productClass="wallet"
        showDisclosure={false}
        disclosureOnHover
      />,
    );

    // Wait for the quote to resolve before asserting the negatives.
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(c =>
        String(c[0]).includes("/currency-tax/quote"),
      );
      expect(calls.length).toBeGreaterThan(0);
    });

    expect(screen.queryByTestId("fx-disclosure-trigger")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fx-disclosure-tooltip")).not.toBeInTheDocument();
    expect(screen.queryByText(/Approx\./)).not.toBeInTheDocument();
    // Booked amount still rendered in the row's currency.
    expect(screen.getByText(/₹5,000/)).toBeInTheDocument();
  });
});
